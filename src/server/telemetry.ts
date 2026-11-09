// 開発者への匿名の利用状況(自分用の版・管理者が同意したパネルだけ。1 日 1 回)と、お問い合わせ・要望。
// 送り先は v02 と同じ受け口(v02 のリポジトリの telemetry/ の Worker)で、送る項目も v02 と同じ。名前・ファイル名・アドレス・IP などは含めない
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { count, eq } from "drizzle-orm";
import { addonSet, apikey, libraryItem, pteroConnection, server, shareLink, storageTarget, teamCurseforge, teamNotify, user } from "./db/schema";
import { eventService } from "./events";
import { HttpError, requireTeam, requireUser } from "./guard";
import type { Deps } from "./servers";

const DEFAULT_URL = "https://craftshelf-telemetry.mesamaru.workers.dev";
export const telemetryUrl = () => (process.env.CRAFTSHELF_TELEMETRY_URL ?? DEFAULT_URL).trim().replace(/\/+$/, "");
const DAY = 24 * 60 * 60 * 1000;
const bucket = (n: number) => (n <= 0 ? "0" : n < 10 ? "1-9" : n < 50 ? "10-49" : n < 200 ? "50-199" : "200+");
const versionOf = () => {
  try {
    return readFileSync(join(process.cwd(), "VERSION"), "utf8").trim();
  } catch {
    return "";
  }
};
const osOf = () => ({ linux: "linux", win32: "windows", darwin: "macos" })[process.platform as string] ?? "other";
export const FEEDBACK_KINDS = ["request", "bug", "question", "other"] as const;

type State = { enabled: boolean | null; installId: string; lastSent: string };

export function telemetryService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  const file = () => (deps.local ? join(deps.local.dataDir, "v03", "telemetry.json") : null);
  const write = (s: State) => {
    const f = file();
    if (f) writeFileSync(f, JSON.stringify(s));
  };
  const read = (): State => {
    const f = file();
    try {
      if (f && existsSync(f)) {
        const s = JSON.parse(readFileSync(f, "utf8"));
        if (/^[0-9a-f]{32}$/.test(s.installId)) return { enabled: typeof s.enabled === "boolean" ? s.enabled : null, installId: s.installId, lastSent: String(s.lastSent ?? "") };
      }
    } catch { /* 読めなければ作り直す */ }
    const fresh: State = { enabled: null, installId: randomBytes(16).toString("hex"), lastSent: "" };
    write(fresh); // 見せた ID と送る ID がそろうように、はじめに決めて残す
    return fresh;
  };
  const n = async (q: PromiseLike<{ c: number }[]>) => Number((await q)[0]?.c ?? 0);
  const all = (t: Parameters<ReturnType<typeof db.select>["from"]>[0]) => db.select({ c: count() }).from(t);

  /** 送る内容(これ以外は送らない) */
  async function payload() {
    const s = read();
    const features: Record<string, boolean> = {
      ptero: (await n(all(pteroConnection))) > 0, discord: (await n(all(teamNotify))) > 0, curseforge: (await n(all(teamCurseforge))) > 0,
      share_links: (await n(all(shareLink))) > 0, totp: (await n(all(user).where(eq(user.twoFactorEnabled, true)))) > 0, api_tokens: (await n(all(apikey))) > 0,
    };
    const kinds = new Set((await db.selectDistinct({ k: storageTarget.kind }).from(storageTarget)).map((r) => r.k));
    return {
      install_id: s.installId, version: versionOf(), channel: "dev", os: osOf(), arch: process.arch, mode: existsSync("/.dockerenv") ? "docker" : "source", lang: "ja",
      items: bucket(await n(all(libraryItem))), users: bucket(await n(all(user))), servers: bucket(await n(all(server))), sets: bucket(await n(all(addonSet))),
      storage: ["local", ...[...kinds].filter((k) => k === "smb" || k === "webdav")].sort(),
      features: Object.keys(features).filter((k) => features[k]).sort(),
      categories: (await db.selectDistinct({ t: libraryItem.projectType }).from(libraryItem)).map((r) => r.t).filter((t) => t === "plugin" || t === "mod").sort(),
    };
  }
  async function send() {
    const s = read();
    const res = await deps.fetch(`${telemetryUrl()}/v1/ping`, {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": `CraftShelf/${versionOf()}` }, body: JSON.stringify(await payload()), signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) write({ ...s, lastSent: new Date().toISOString() });
    return res.ok;
  }

  return {
    /** 送るかどうかの設定と、送る内容(管理者以上) */
    async info(headers: Headers) {
      await requireTeam(auth, headers, { panel: ["manage"] });
      const s = read();
      return { available: !!telemetryUrl() && !!deps.local, enabled: s.enabled === true, asked: s.enabled !== null, lastSent: s.lastSent, preview: await payload() };
    },

    /** 送るかどうかを決める(管理者以上)。送ると決めたら、すぐに 1 回送る */
    async set(headers: Headers, enabled: boolean) {
      const who = await requireTeam(auth, headers, { panel: ["manage"] });
      if (!deps.local) throw new HttpError(400, "自分用の版だけで使えます");
      write({ ...read(), enabled });
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: enabled ? "利用状況の送信をオンにする" : "利用状況の送信をオフにする" });
      if (enabled) await send().catch(() => false);
    },

    /** 1 日 1 回送る(起動時の定期処理から呼ぶ。同意していなければ何もしない) */
    async sendIfDue() {
      const s = read();
      if (!deps.local || !telemetryUrl() || s.enabled !== true) return false;
      if (s.lastSent && Date.now() - Date.parse(s.lastSent) < DAY) return false;
      return send();
    },

    /** お問い合わせ・要望を開発者に送る(ログインしている人) */
    async feedback(headers: Headers, input: { kind: string; message: string; contact: string; includeEnv: boolean }) {
      const me = await requireUser(auth, headers);
      if (!telemetryUrl()) throw new HttpError(503, "お問い合わせの送り先が設定されていません(GitHub の Issues からお送りください)");
      const message = String(input.message ?? "").trim().slice(0, 4000);
      if (message.length < 2) throw new HttpError(400, "内容を入力してください");
      const kind = (FEEDBACK_KINDS as readonly string[]).includes(input.kind) ? input.kind : "other";
      const body = {
        kind, message, contact: String(input.contact ?? "").trim().slice(0, 200),
        ...(input.includeEnv ? { version: versionOf(), os: osOf(), mode: existsSync("/.dockerenv") ? "docker" : "source" } : {}),
      };
      let res: Response;
      try {
        res = await deps.fetch(`${telemetryUrl()}/v1/feedback`, {
          method: "POST", headers: { "Content-Type": "application/json", "User-Agent": `CraftShelf/${versionOf()}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new HttpError(502, "送信できませんでした(インターネット接続を確認してください)");
      }
      if (!res.ok) {
        const msg = await res.json().then((j: { error?: string }) => j.error ?? "", () => "");
        throw new HttpError(502, msg || `送信できませんでした(HTTP ${res.status})`);
      }
      const teamId = (me.session as { activeOrganizationId?: string | null }).activeOrganizationId;
      if (teamId) await record({ teamId, userId: me.user.id, kind: "admin", action: "お問い合わせを送る", detail: { request: "要望", bug: "不具合", question: "質問" }[kind] ?? "その他" });
    },
  };
}
