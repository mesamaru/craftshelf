// ポート管理: チームのサーバーのポートを、Pterodactyl の割り当てと設定ファイルから読み取り、重複・範囲外を見つける。
// 種類(表の列)とグループ(表の行)はチームごとに決める。どの処理も、選んでいるチームの中だけを読み書きする
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DEFAULT_KINDS, PORT_CATALOG, type Port, type ServerPorts, findProblems, isPort } from "~/lib/ports";
import { portGroup, portKind, server, serverPort, serverPortInfo } from "./db/schema";
import { HttpError, requireTeam } from "./guard";
import { eventService } from "./events";
import { portLike, readPort, writePort } from "./port-config";
import { type Deps, remote, serverOf, serverScope } from "./servers";

export const PORT_LIMITS = { kindsPerTeam: 30, groupsPerTeam: 50, manualPerServer: 30, scanPluginFolders: 40 };

const MODES = ["group", "fixed", "free"] as const;
const PROTOS = ["TCP", "UDP", "両方"] as const;
const txt = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);
const intOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isInteger(Number(v)) ? Number(v) : null);
// 設定ファイルの場所: サーバーのフォルダーの中の相対パスだけ(.. や先頭の / は認めない)
const safePath = (p: string) => {
  const f = txt(p, 200).replace(/\\/g, "/");
  if (f && (f.startsWith("/") || f.split("/").some((x) => x === ".." || x === ""))) throw new HttpError(400, "ファイルの場所が正しくありません");
  return f;
};

export type RuleInput = {
  kinds: { id?: string; name: string; mode: string; start?: number | null; size?: number | null; rangeFrom?: number | null; rangeTo?: number | null; proto: string; file: string; key: string }[];
  groups: { id?: string; number: string; name: string }[];
};
export type PortChange = { id?: string; kindId?: string | null; port?: number; memo?: string; remove?: boolean; ignore?: boolean };

export function portService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);

  // 初めて開いたチームには、よく使う種類を用意する
  async function ensureKinds(teamId: string) {
    const [k] = await db.select({ id: portKind.id }).from(portKind).where(eq(portKind.teamId, teamId)).limit(1);
    if (k) return;
    await db.insert(portKind).values(DEFAULT_KINDS.map((x, i) => ({ id: randomUUID(), teamId, name: x.name, mode: "free", proto: x.proto, file: x.file, key: x.key, position: i })));
  }

  async function overviewOf(teamId: string) {
    await ensureKinds(teamId);
    const kinds = await db.select().from(portKind).where(eq(portKind.teamId, teamId)).orderBy(asc(portKind.position));
    const groups = await db.select().from(portGroup).where(eq(portGroup.teamId, teamId)).orderBy(asc(portGroup.position));
    const rows = await db.select({ id: server.id, name: server.name, groupId: serverPortInfo.groupId, memo: serverPortInfo.memo, machine: serverPortInfo.machine, scannedAt: serverPortInfo.scannedAt })
      .from(server).leftJoin(serverPortInfo, eq(serverPortInfo.serverId, server.id)).where(eq(server.teamId, teamId)).orderBy(asc(server.name));
    const ports = rows.length ? await db.select().from(serverPort).where(inArray(serverPort.serverId, rows.map((r) => r.id))).orderBy(asc(serverPort.port)) : [];
    const servers = rows.map((r) => ({
      ...r, memo: r.memo ?? "", machine: r.machine ?? "",
      ports: ports.filter((p) => p.serverId === r.id).map((p): Port => ({ id: p.id, kindId: p.kindId, port: p.port, source: p.source, file: p.file, key: p.key, label: p.label, memo: p.memo, ignored: p.ignored })),
    }));
    return { kinds, groups, servers, problems: findProblems(servers, kinds, groups), catalog: PORT_CATALOG };
  }

  const serverInTeam = async (teamId: string, id: string) => {
    const [s] = await db.select({ id: server.id }).from(server).where(and(eq(server.id, id), eq(server.teamId, teamId)));
    if (!s) throw new HttpError(404, "サーバーが見つかりません");
  };

  // * を含むファイルの場所は、フォルダーの中から名前が合うものを探す(Geyser-Spigot など)
  async function resolveFile(client: Awaited<ReturnType<typeof serverOf>>["client"], ident: string, file: string) {
    if (!file.includes("*")) return file;
    const parts = file.split("/");
    const i = parts.findIndex((x) => x.includes("*"));
    const re = new RegExp("^" + parts[i].split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
    const hit = (await client.listFiles(ident, parts.slice(0, i).join("/") || "/")).find((f) => re.test(f.name));
    return hit ? [...parts.slice(0, i), hit.name, ...parts.slice(i + 1)].join("/") : null;
  }

  /** 1 台を読み取る: 割り当て・種類のファイル・プラグインの設定(ポートらしい項目)。手入力と「管理から外す」はそのまま残す */
  async function scanOne(teamId: string, id: string, kinds: (typeof portKind.$inferSelect)[], nodes: Map<string, string>) {
    const target = await serverOf(deps, teamId, id);
    const { client, remoteId } = target;
    const keep = await db.select().from(serverPort).where(eq(serverPort.serverId, id));
    const ignored = new Set(keep.filter((p) => p.ignored).map((p) => `${p.file}|${p.key}|${p.port}`));
    // 見つけて「管理する」を選んだもの: 同じファイル・項目を読み直して、番号だけ新しくする
    const adopted = keep.filter((p) => p.source === "adopted");
    const adoptedKeys = new Set(adopted.map((p) => `${p.file}|${p.key}`));
    const found: (typeof serverPort.$inferInsert)[] = [];
    const add = (p: Omit<typeof serverPort.$inferInsert, "id" | "serverId">) => {
      if (p.file && adoptedKeys.has(`${p.file}|${p.key}`)) return;
      if (!ignored.has(`${p.file}|${p.key}|${p.port}`) && !found.some((f) => f.file === p.file && f.key === p.key && f.port === p.port)) found.push({ id: randomUUID(), serverId: id, ...p });
    };
    const texts = new Map<string, string | null>();
    const read = async (f: string) => { if (!texts.has(f)) texts.set(f, await client.readFile(remoteId, f)); return texts.get(f)!; };

    for (const k of kinds.filter((x) => x.file && x.key)) {
      const file = await resolveFile(client, remoteId, k.file);
      const text = file ? await read(file) : null;
      const hit = text && file ? readPort(file, text, k.key) : null;
      if (hit && file) add({ kindId: k.id, port: hit.port, source: "file", file, key: hit.key, label: k.name });
    }
    const refreshed: { id: string; port: number }[] = [];
    for (const a of adopted) {
      const text = await read(a.file);
      const hit = text ? readPort(a.file, text, a.key) : null;
      if (hit && hit.port !== a.port) refreshed.push({ id: a.id, port: hit.port });
    }
    // Pterodactyl の割り当てのうち、設定ファイルで見つかっていないもの(メモがあれば名前に使う)
    for (const a of await client.allocations(remoteId)) {
      if (found.some((f) => f.port === a.port) || adopted.some((f) => f.port === a.port)) continue;
      const game = a.isDefault ? kinds.find((k) => k.file === "server.properties" && k.key === "server-port") : undefined;
      add({ kindId: game?.id ?? kinds.find((k) => !k.file)?.id ?? null, port: a.port, source: "allocation", label: a.notes || (a.isDefault ? "ゲーム" : "割り当て") });
    }
    // 知らないプラグインの設定から、ポートらしい項目を探す(聞いて、管理するか決めてもらう)
    const known = new Set(kinds.map((k) => k.file.split("/")[1]?.toLowerCase()).filter(Boolean));
    const folders = (await client.listFiles(remoteId, "plugins")).filter((f) => !f.isFile && !known.has(f.name.toLowerCase())).slice(0, PORT_LIMITS.scanPluginFolders);
    for (const dir of folders) {
      const file = `plugins/${dir.name}/config.yml`;
      const text = await read(file);
      for (const e of text ? portLike(file, text) : []) add({ kindId: null, port: e.port, source: "found", file, key: e.key, label: dir.name });
    }

    await db.transaction(async (tx) => {
      await tx.delete(serverPort).where(and(eq(serverPort.serverId, id), inArray(serverPort.source, ["file", "allocation", "found"]), eq(serverPort.ignored, false)));
      if (found.length) await tx.insert(serverPort).values(found);
      for (const r of refreshed) await tx.update(serverPort).set({ port: r.port, updatedAt: new Date() }).where(eq(serverPort.id, r.id));
      await tx.insert(serverPortInfo).values({ serverId: id, machine: nodes.get(remoteId) ?? "", scannedAt: new Date() })
        .onConflictDoUpdate({ target: serverPortInfo.serverId, set: { machine: nodes.get(remoteId) ?? "", scannedAt: new Date() } });
    });
  }

  return {
    /** 表に出すもの: 種類・グループ・サーバーごとのポート・問題 */
    async overview(headers: Headers) {
      const who = await requireTeam(auth, headers);
      const scope = await serverScope(deps, who);
      const ov = await overviewOf(who.teamId);
      return scope ? { ...ov, servers: ov.servers.filter((s) => scope.has(s.id)) } : ov;
    },

    /** 読み取り直す(serverId を渡すとその 1 台、無ければチームの全部)。失敗したサーバーは理由を返し、残りは続ける */
    async scan(headers: Headers, serverId?: string) {
      // 読み取りは Pterodactyl への問い合わせが多い(1 台でプラグインの設定を何十も読む)ので、管理者以上だけ
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const { teamId } = who;
      await ensureKinds(teamId);
      const kinds = await db.select().from(portKind).where(eq(portKind.teamId, teamId));
      const list = await db.select().from(server).where(serverId ? and(eq(server.teamId, teamId), eq(server.id, serverId)) : eq(server.teamId, teamId));
      if (serverId && !list.length) throw new HttpError(404, "サーバーが見つかりません");
      // どのマシン(Pterodactyl のノード)で動くか: パネルの一覧から
      const nodes = new Map<string, string>();
      for (const connId of new Set(list.map((s) => s.pteroConnectionId).filter((x): x is string => !!x))) {
        const any = list.find((s) => s.pteroConnectionId === connId)!;
        try {
          const { client } = await serverOf(deps, who, any.id);
          for (const r of await client.servers()) nodes.set(r.identifier, `${connId}/${r.node}`);
        } catch { /* ノードが分からなくても読み取りは続ける(同じマシンとみなす) */ }
      }
      const failed: { name: string; message: string }[] = [];
      for (const s of list) {
        try {
          await remote(() => scanOne(teamId, s.id, kinds, nodes));
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          failed.push({ name: s.name, message: e.message });
        }
      }
      return { failed, ...(await overviewOf(teamId)) };
    },

    /** 種類とグループを並び順ごと保存する(無くなったものは消す) */
    async saveRules(headers: Headers, input: RuleInput) {
      const { teamId, user } = await requireTeam(auth, headers, { server: ["update"] });
      if (input.kinds.length > PORT_LIMITS.kindsPerTeam) throw new HttpError(400, `種類は ${PORT_LIMITS.kindsPerTeam} 個までです`);
      if (input.groups.length > PORT_LIMITS.groupsPerTeam) throw new HttpError(400, `グループは ${PORT_LIMITS.groupsPerTeam} 個までです`);
      const kinds = input.kinds.map((k, i) => {
        const name = txt(k.name, 40);
        if (!name) throw new HttpError(400, "種類の名前を入力してください");
        const mode = (MODES as readonly string[]).includes(k.mode) ? k.mode : "free";
        const v = { start: intOrNull(k.start), size: intOrNull(k.size), rangeFrom: intOrNull(k.rangeFrom), rangeTo: intOrNull(k.rangeTo) };
        if (mode === "group" && (!isPort(v.start) || !v.size || v.size < 1 || v.size > 1000)) throw new HttpError(400, `「${name}」の開始番号と個数を入力してください`);
        if (mode === "fixed" && (!isPort(v.rangeFrom) || !isPort(v.rangeTo) || v.rangeFrom! > v.rangeTo!)) throw new HttpError(400, `「${name}」の範囲を 1〜65535 の小さい順で入力してください`);
        const file = safePath(k.file);
        return { id: k.id || randomUUID(), teamId, name, mode, ...v, proto: (PROTOS as readonly string[]).includes(k.proto) ? k.proto : "TCP", file, key: file ? txt(k.key, 100) : "", position: i };
      });
      const groups = input.groups.map((g, i) => {
        const number = txt(g.number, 6);
        if (!/^\d{1,6}$/.test(number)) throw new HttpError(400, "グループの番号は数字で入力してください");
        return { id: g.id || randomUUID(), teamId, number, name: txt(g.name, 40) || number, position: i };
      });
      await db.transaction(async (tx) => {
        const ownK = new Set((await tx.select({ id: portKind.id }).from(portKind).where(eq(portKind.teamId, teamId))).map((x) => x.id));
        const ownG = new Set((await tx.select({ id: portGroup.id }).from(portGroup).where(eq(portGroup.teamId, teamId))).map((x) => x.id));
        // ほかのチームの ID を書き換えないよう、知らない ID は新しく作る
        for (const k of kinds) if (!ownK.has(k.id) && input.kinds.some((x) => x.id === k.id)) k.id = randomUUID();
        for (const g of groups) if (!ownG.has(g.id) && input.groups.some((x) => x.id === g.id)) g.id = randomUUID();
        const keepK = new Set(kinds.map((k) => k.id)), keepG = new Set(groups.map((g) => g.id));
        const dropK = [...ownK].filter((id) => !keepK.has(id)), dropG = [...ownG].filter((id) => !keepG.has(id));
        if (dropK.length) await tx.delete(portKind).where(inArray(portKind.id, dropK));
        if (dropG.length) await tx.delete(portGroup).where(inArray(portGroup.id, dropG));
        for (const k of kinds) await tx.insert(portKind).values(k).onConflictDoUpdate({ target: portKind.id, set: { ...k, id: undefined, teamId: undefined } });
        for (const g of groups) await tx.insert(portGroup).values(g).onConflictDoUpdate({ target: portGroup.id, set: { ...g, id: undefined, teamId: undefined } });
      });
      await record({ teamId, userId: user.id, kind: "admin", action: "ポートの種類とグループを変更", detail: `種類 ${kinds.length} 個・グループ ${groups.length} 個` });
      return overviewOf(teamId);
    },

    /** サーバーのグループとメモ */
    async setServerInfo(headers: Headers, serverId: string, input: { groupId: string | null; memo: string }) {
      const { teamId } = await requireTeam(auth, headers, { server: ["update"] });
      await serverInTeam(teamId, serverId);
      if (input.groupId) {
        const [g] = await db.select({ id: portGroup.id }).from(portGroup).where(and(eq(portGroup.id, input.groupId), eq(portGroup.teamId, teamId)));
        if (!g) throw new HttpError(404, "グループが見つかりません");
      }
      const set = { groupId: input.groupId || null, memo: txt(input.memo, 100) };
      await db.insert(serverPortInfo).values({ serverId, ...set }).onConflictDoUpdate({ target: serverPortInfo.serverId, set });
      return overviewOf(teamId);
    },

    /**
     * サーバーのポートをまとめて変える。設定ファイルから読んだものは、そのファイルの番号も書き換える
     * (動いているサーバーは、再起動すると新しい番号になる)。同じマシンで重複する番号にはしない
     */
    async savePorts(headers: Headers, serverId: string, changes: PortChange[]) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const { teamId, user } = who;
      await serverInTeam(teamId, serverId);
      const ov = await overviewOf(teamId);
      const me = ov.servers.find((s) => s.id === serverId)!;
      const kindIds = new Set(ov.kinds.map((k) => k.id));
      const byId = new Map(me.ports.map((p) => [p.id, p]));
      // 変えたあとの姿で、重複を確かめる
      const next: ServerPorts = { ...me, ports: me.ports.map((p) => ({ ...p })) };
      const writes: { file: string; key: string; port: number }[] = [];
      for (const c of changes) {
        if (c.kindId && !kindIds.has(c.kindId)) throw new HttpError(400, "種類が見つかりません");
        if (c.port !== undefined && !isPort(c.port)) throw new HttpError(400, "ポートは 1〜65535 の番号にしてください");
        if (!c.id) {
          if (c.remove || c.port === undefined) continue;
          next.ports.push({ id: `new-${randomUUID()}`, kindId: c.kindId ?? null, port: c.port, source: "manual", file: "", key: "", label: "", memo: txt(c.memo, 100), ignored: false });
          continue;
        }
        const p = next.ports.find((x) => x.id === c.id);
        if (!p) throw new HttpError(404, "ポートが見つかりません");
        if (c.remove) {
          if (p.source !== "manual") throw new HttpError(400, "読み取ったポートは消せません(「管理から外す」を使ってください)");
          next.ports = next.ports.filter((x) => x !== p);
          continue;
        }
        if (c.ignore !== undefined) p.ignored = c.ignore;
        if (c.memo !== undefined) p.memo = txt(c.memo, 100);
        if (c.kindId !== undefined) p.kindId = c.kindId;
        if (c.port !== undefined && c.port !== p.port) {
          if (p.source === "allocation") throw new HttpError(400, "Pterodactyl の割り当てのポートは、パネルの「ネットワーク」で変えてください");
          if (p.source === "file" || p.source === "adopted") writes.push({ file: p.file, key: p.key, port: c.port });
          p.port = c.port;
        }
      }
      if (next.ports.filter((p) => p.source === "manual").length > PORT_LIMITS.manualPerServer) throw new HttpError(400, `手入力のポートは 1 台 ${PORT_LIMITS.manualPerServer} 個までです`);
      // 新しく足した・番号を変えたものが、同じマシンのほかのポートと重ならないか
      const checked = next.ports.filter((p) => !p.ignored && (p.id.startsWith("new-") || changes.some((c) => c.id === p.id && c.port !== undefined)));
      const all = ov.servers.filter((s) => s.machine === me.machine).flatMap((s) => (s.id === serverId ? next.ports : s.ports).map((p) => ({ s, p })))
        .filter(({ p }) => !p.ignored && p.source !== "found");
      for (const c of checked) {
        const hit = all.find(({ p }) => p.id !== c.id && p.port === c.port);
        if (hit) throw new HttpError(400, `${c.port} は「${hit.s.id === serverId ? me.name : hit.s.name}」${hit.p.label ? `の ${hit.p.label}` : ""}が使っています`);
      }

      if (writes.length) {
        const { client, remoteId } = await serverOf(deps, who, serverId);
        await remote(async () => {
          for (const w of writes) {
            const text = await client.readFile(remoteId, w.file);
            const out = text === null ? null : writePort(w.file, text, w.key, w.port);
            if (out === null) throw new HttpError(409, `${w.file} に ${w.key} が見つかりません(読み取り直してください)`);
            await client.writeFile(remoteId, w.file, out);
          }
        });
      }
      await db.transaction(async (tx) => {
        for (const c of changes.filter((x) => x.id && !x.remove)) {
          const p = next.ports.find((x) => x.id === c.id)!;
          await tx.update(serverPort).set({ port: p.port, memo: p.memo, kindId: p.kindId, ignored: p.ignored, updatedAt: new Date() }).where(eq(serverPort.id, p.id));
        }
        const removed = changes.filter((c) => c.id && c.remove).map((c) => c.id!).filter((id) => byId.has(id));
        if (removed.length) await tx.delete(serverPort).where(and(eq(serverPort.serverId, serverId), inArray(serverPort.id, removed)));
        const added = next.ports.filter((p) => p.id.startsWith("new-"));
        if (added.length) await tx.insert(serverPort).values(added.map((p) => ({ id: randomUUID(), serverId, kindId: p.kindId, port: p.port, source: "manual", memo: p.memo })));
      });
      const wroteFiles = [...new Set(writes.map((w) => w.file))];
      await record({ teamId, userId: user.id, kind: "admin", action: "ポートを変更", target: me.name,
        detail: writes.map((w) => `${w.file} の ${w.key} → ${w.port}`).join("\n") || `${changes.length} 件` });
      return { wroteFiles, ...(await overviewOf(teamId)) };
    },

    /** 見つけたポートを管理する(種類を選ぶか、新しい種類を作る)。同じファイル・項目は、ほかのサーバーでも読むようになる */
    async adoptFound(headers: Headers, portId: string, input: { kindId?: string; newKindName?: string }) {
      const { teamId } = await requireTeam(auth, headers, { server: ["update"] });
      const [p] = await db.select({ p: serverPort, teamId: server.teamId }).from(serverPort).innerJoin(server, eq(serverPort.serverId, server.id))
        .where(and(eq(serverPort.id, portId), eq(server.teamId, teamId)));
      if (!p || p.p.source !== "found") throw new HttpError(404, "見つけたポートが見つかりません");
      let kindId = input.kindId ?? null;
      if (input.newKindName) {
        const kinds = await db.select({ id: portKind.id }).from(portKind).where(eq(portKind.teamId, teamId));
        if (kinds.length >= PORT_LIMITS.kindsPerTeam) throw new HttpError(400, `種類は ${PORT_LIMITS.kindsPerTeam} 個までです`);
        kindId = randomUUID();
        await db.insert(portKind).values({ id: kindId, teamId, name: txt(input.newKindName, 40) || p.p.label, mode: "free", file: p.p.file, key: p.p.key, position: kinds.length });
      } else if (kindId) {
        const [k] = await db.select({ id: portKind.id }).from(portKind).where(and(eq(portKind.id, kindId), eq(portKind.teamId, teamId)));
        if (!k) throw new HttpError(404, "種類が見つかりません");
      }
      // 新しい種類はファイル・項目を持つので、次からは種類として読む。既存の種類に入れたものは、このサーバーで覚えて読み直す
      await db.update(serverPort).set({ source: input.newKindName ? "file" : "adopted", kindId, updatedAt: new Date() }).where(eq(serverPort.id, portId));
      return overviewOf(teamId);
    },
  };
}
