// サーバーの操作: コンソールへのコマンドと、設定ファイルの閲覧・編集(保存する前の中身は履歴に残す)。
// 設定ファイルにはパスワードなどが入っていることがあるので、見る・直すのは権限 files:edit のある人(管理者以上・チームで決めれば編集者も・メンバーごとに足した人)。どの処理も、選んでいるチームの中だけ
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { serverFileHistory, teamOption, user } from "./db/schema";
import { eventService } from "./events";
import { HttpError, allowed, requireTeam } from "./guard";
import { type Deps, remote, serverOf } from "./servers";
import { alignAll, splitLines } from "~/lib/diff";

// 開いて直せるファイル(テキストの設定ファイルだけ)。大きすぎるものは開かない
const TEXT_FILE = /\.(properties|ya?ml|json|json5|toml|conf|cfg|ini|txt|hocon|sk|lang|md|csv|sh|env)$/i;
export const FILE_LIMITS = { maxBytes: 512 * 1024, historyPerFile: 30, commandLength: 500, logLines: 1000, logBytes: 20 * 1024 * 1024 };
export const LOG_FILE = "logs/latest.log";

/** サーバーのフォルダーの中の相対パスだけ(.. や先頭の / は認めない)。空は一番上のフォルダー */
export function cleanPath(input: string) {
  const p = String(input ?? "").replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (p.length > 300 || p.split("/").some((x) => x === ".." || x === "." || (x === "" && p !== "")) || /[\0\r\n]/.test(p)) {
    throw new HttpError(400, "ファイルの場所が正しくありません");
  }
  return p;
}
// ファイル比較で探す場所と深さ(v02 と同じ)。ワールド・ログなどは見ない
const CONFIG_SCAN: [string, number][] = [["", 0], ["plugins", 3], ["config", 4], ["mods/config", 3]];
const CONFIG_SKIP = new Set(["logs", "cache", "libraries", "crash-reports", "versions", "world", "world_nether", "world_the_end"]);
export const CONFIG_MAX = 400;
// Pterodactyl は API の回数に上限があるので、中身を読むのは大きさが違うものだけ・1 台あたりこの数まで
export const CONFIG_READ_MAX = 100;
export const editable = (path: string) => TEXT_FILE.test(path) || /(^|\/)(eula\.txt|server\.properties|\.env)$/i.test(path);

export function fileService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);

  const editorFiles = async (teamId: string) =>
    (await db.select({ on: teamOption.editorFiles }).from(teamOption).where(eq(teamOption.teamId, teamId)))[0]?.on ?? false;

  // 設定ファイルを見る・直してよいか(権限 files:edit): 管理者以上・チームが許していれば編集者・メンバーごとに足した人(03.60.00 から)
  const needFiles = (headers: Headers) => requireTeam(auth, headers, { files: ["edit"] });

  async function readText(target: Awaited<ReturnType<typeof serverOf>>, path: string) {
    const name = path.split("/").pop() ?? "";
    const dir = path.split("/").slice(0, -1).join("/");
    const entry = (await remote(() => target.client.listFiles(target.remoteId, dir || "/"))).find((f) => f.name === name && f.isFile);
    if (!entry) throw new HttpError(404, "ファイルが見つかりません");
    if (entry.size > FILE_LIMITS.maxBytes) throw new HttpError(400, `大きすぎるファイル(${Math.ceil(FILE_LIMITS.maxBytes / 1024)} KB まで)は、ここでは開けません`);
    const text = await remote(() => target.client.readFile(target.remoteId, path));
    if (text === null) throw new HttpError(404, "ファイルが見つかりません");
    return text;
  }

  return {
    /** 設定ファイルを見る・直せるか(画面でボタンを出すか決める)と、編集者にも許しているか */
    async access(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers);
      return { allowed: await allowed(auth, headers, { files: ["edit"] }), editors: await editorFiles(teamId) };
    },

    /** 編集者にも設定ファイルを見る・直すのを許す・やめる(管理者以上) */
    async setEditorFiles(headers: Headers, on: boolean) {
      const { teamId, user: me } = await requireTeam(auth, headers, { member: ["update"] });
      await db.insert(teamOption).values({ teamId, editorFiles: on }).onConflictDoUpdate({ target: teamOption.teamId, set: { editorFiles: on, updatedAt: new Date() } });
      await record({ teamId, userId: me.id, kind: "admin", action: on ? "編集者にも設定ファイルを許す" : "設定ファイルを管理者以上だけにする" });
    },

    /** コンソールにコマンドを送る(編集者以上)。結果はコンソールに出る(ここでは受け取らない) */
    async command(headers: Headers, serverId: string, command: string) {
      const who = await requireTeam(auth, headers, { server: ["control"] });
      const { teamId, user: me } = who;
      const cmd = String(command ?? "").trim().replace(/^\//, "");
      if (!cmd) throw new HttpError(400, "コマンドを入力してください");
      if (cmd.length > FILE_LIMITS.commandLength || /[\r\n]/.test(cmd)) throw new HttpError(400, `コマンドは 1 行・${FILE_LIMITS.commandLength} 文字までです`);
      const target = await serverOf(deps, who, serverId);
      await remote(() => target.client.command(target.remoteId, cmd));
      await record({ teamId, userId: me.id, kind: "power", action: "コマンドを送る", target: target.row.name, detail: cmd });
    },

    /** 最近のログ(logs/latest.log の最後の lines 行。編集者以上)。ファイルが無ければ found: false */
    async logs(headers: Headers, serverId: string, lines = 400) {
      const who = await requireTeam(auth, headers, { server: ["control"] });
      const { teamId } = who;
      const target = await serverOf(deps, who, serverId);
      const n = Math.max(20, Math.min(FILE_LIMITS.logLines, Math.floor(lines) || 400));
      const entry = (await remote(() => target.client.listFiles(target.remoteId, "logs")).catch(() => [])).find((f) => f.name === "latest.log" && f.isFile);
      if (!entry) return { file: LOG_FILE, found: false, lines: [] as string[] };
      // 大きすぎるログは取り寄せない(Pterodactyl はファイル全体を返すため)
      if (entry.size > FILE_LIMITS.logBytes) throw new HttpError(400, "ログが大きすぎて読めません(サーバーを再起動すると新しいログになります)");
      const text = (await remote(() => target.client.readFile(target.remoteId, LOG_FILE))) ?? "";
      // eslint-disable-next-line no-control-regex
      const all = text.replace(/\r\n/g, "\n").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
      while (all.length && !all[all.length - 1].trim()) all.pop();
      return { file: LOG_FILE, found: true, lines: all.slice(-n) };
    },

    /** フォルダーの中身(フォルダーと、開けるファイルが分かるように) */
    async list(headers: Headers, serverId: string, dir: string) {
      const who = await needFiles(headers);
      const { teamId } = who;
      const target = await serverOf(deps, who, serverId);
      const d = cleanPath(dir);
      const files = await remote(() => target.client.listFiles(target.remoteId, d || "/"));
      return {
        dir: d,
        entries: files.map((f) => ({ name: f.name, isFile: f.isFile, size: f.size, editable: f.isFile && editable(f.name) && f.size <= FILE_LIMITS.maxBytes }))
          .sort((a, b) => Number(a.isFile) - Number(b.isFile) || a.name.localeCompare(b.name)),
      };
    },

    /**
     * ファイル比較: 選んだサーバー(2〜8 台)の設定ファイルの一覧と、どのサーバーにあるか・基準と違う行の数。
     * 中身を読んで数える(Pterodactyl は大きさが違うものだけ。読まなかったものは lines: null で、大きさで見る)
     */
    async configs(headers: Headers, serverIds: string[]) {
      const who = await needFiles(headers);
      const { teamId } = who;
      const ids = [...new Set(serverIds)].slice(0, 8);
      if (ids.length < 2) throw new HttpError(400, "比べるサーバーを 2 台以上選んでください");
      const servers: { id: string; name: string; files: Map<string, number>; error: string; target: Awaited<ReturnType<typeof serverOf>> }[] = [];
      for (const id of ids) {
        const target = await serverOf(deps, who, id);
        const found = new Map<string, number>();
        const walk = async (dir: string, depth: number) => {
          if (found.size >= CONFIG_MAX) return;
          let entries;
          try {
            entries = await remote(() => target.client.listFiles(target.remoteId, dir || "/"));
          } catch {
            return; // 無いフォルダー(mods/config など)は飛ばす
          }
          for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
            const p = dir ? `${dir}/${e.name}` : e.name;
            if (e.isFile) {
              if (editable(e.name) && e.size <= FILE_LIMITS.maxBytes) found.set(p, e.size);
            } else if (depth > 0 && !CONFIG_SKIP.has(e.name) && !e.name.startsWith(".")) {
              await walk(p, depth - 1);
            }
            if (found.size >= CONFIG_MAX) return;
          }
        };
        let error = "";
        try {
          for (const [dir, depth] of CONFIG_SCAN) await walk(dir, depth);
        } catch (e) {
          error = e instanceof HttpError ? e.message : "読めませんでした";
        }
        servers.push({ id: target.row.id, name: target.row.name, files: found, error, target });
      }
      const paths = [...new Set(servers.flatMap((s) => [...s.files.keys()]))]
        .sort((a, b) => a.split("/").length - b.split("/").length || a.toLowerCase().localeCompare(b.toLowerCase()));
      // 2 台以上にあるファイルの中身を読み、最初のサーバー(基準)と違う行を数える(ファイルを開いて「違う行だけ」にしたときの行数)
      const reads = new Map<string, number>();
      const count = async (path: string): Promise<number | null> => {
        const have = servers.filter((s) => s.files.has(path));
        if (have.length < 2) return null;
        const sized = new Set(have.map((s) => s.files.get(path))).size > 1;
        if (have.some((s) => s.target.row.kind === "ptero" && (!sized || (reads.get(s.id) ?? 0) >= CONFIG_READ_MAX))) return null;
        for (const s of have) if (s.target.row.kind === "ptero") reads.set(s.id, (reads.get(s.id) ?? 0) + 1);
        try {
          const texts = await Promise.all(have.map((s) => remote(() => s.target.client.readFile(s.target.remoteId, path))));
          if (texts.some((t) => t === null)) return null;
          const [base, ...others] = texts.map((t) => splitLines(t!));
          return alignAll(base, others).filter((r) => r.diff).length;
        } catch {
          return null;
        }
      };
      const lines = new Map<string, number | null>();
      for (let i = 0; i < paths.length; i += 6) {
        await Promise.all(paths.slice(i, i + 6).map(async (p) => lines.set(p, await count(p))));
      }
      return {
        servers: servers.map((s) => ({ id: s.id, name: s.name, count: s.files.size, error: s.error })),
        files: paths.map((path) => {
          const have = servers.filter((s) => s.files.has(path));
          const n = lines.get(path) ?? null;
          const sameSize = new Set(have.map((s) => s.files.get(path))).size === 1;
          return {
            path, on: have.map((s) => s.id), lines: n,
            sizes: servers.map((s) => s.files.get(path) ?? null),
            same: have.length === servers.length && (n === null ? sameSize : n === 0),
          };
        }),
      };
    },

    /** ファイルを開く(と、その履歴) */
    async read(headers: Headers, serverId: string, path: string) {
      const who = await needFiles(headers);
      const { teamId } = who;
      const p = cleanPath(path);
      if (!p || !editable(p)) throw new HttpError(400, "ここで開けるのは、テキストの設定ファイルだけです");
      const target = await serverOf(deps, who, serverId);
      const content = await readText(target, p);
      const history = await db.select({ id: serverFileHistory.id, savedAt: serverFileHistory.savedAt, savedBy: user.name })
        .from(serverFileHistory).leftJoin(user, eq(serverFileHistory.savedBy, user.id))
        .where(and(eq(serverFileHistory.serverId, serverId), eq(serverFileHistory.path, p))).orderBy(desc(serverFileHistory.savedAt));
      return { path: p, content, history: history.map((h) => ({ id: h.id, savedAt: h.savedAt.toISOString(), savedBy: h.savedBy ?? "" })) };
    },

    /**
     * 保存する。開いたときの中身(base)と、いまのサーバーの中身が違えば保存しない(ほかの人・サーバーが書き換えていたら)。
     * 保存する前の中身は履歴に残す(1 つのファイルにつき新しい 30 件)
     */
    async save(headers: Headers, serverId: string, path: string, content: string, base: string) {
      const who = await needFiles(headers);
      const { teamId, user: me } = who;
      const p = cleanPath(path);
      if (!p || !editable(p)) throw new HttpError(400, "ここで直せるのは、テキストの設定ファイルだけです");
      if (Buffer.byteLength(content) > FILE_LIMITS.maxBytes) throw new HttpError(400, "大きすぎます");
      const target = await serverOf(deps, who, serverId);
      const now = await readText(target, p);
      if (now !== base) throw new HttpError(409, "開いたあとで、ファイルが書き換えられています。開き直してから直してください");
      if (now === content) return { saved: false };
      await remote(() => target.client.writeFile(target.remoteId, p, content));
      await db.insert(serverFileHistory).values({ id: randomUUID(), serverId, path: p, content: now, savedBy: me.id });
      const old = await db.select({ id: serverFileHistory.id }).from(serverFileHistory)
        .where(and(eq(serverFileHistory.serverId, serverId), eq(serverFileHistory.path, p))).orderBy(desc(serverFileHistory.savedAt)).offset(FILE_LIMITS.historyPerFile);
      if (old.length) await db.delete(serverFileHistory).where(inArray(serverFileHistory.id, old.map((x) => x.id)));
      await record({ teamId, userId: me.id, kind: "admin", action: "設定ファイルを直す", target: `${target.row.name} の ${p}` });
      return { saved: true };
    },

    /** 履歴の中身(戻す前に見る) */
    async historyContent(headers: Headers, serverId: string, historyId: string) {
      const who = await needFiles(headers);
      const { teamId } = who;
      await serverOf(deps, who, serverId); // ほかのチームのサーバーは「見つからない」
      const [h] = await db.select().from(serverFileHistory).where(and(eq(serverFileHistory.id, historyId), eq(serverFileHistory.serverId, serverId)));
      if (!h) throw new HttpError(404, "履歴が見つかりません");
      return { path: h.path, content: h.content, savedAt: h.savedAt.toISOString() };
    },
  };
}

