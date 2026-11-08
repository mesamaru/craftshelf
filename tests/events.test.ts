// 操作の記録と Discord への通知(Pterodactyl・Modrinth・Discord は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { teamNotify } from "~/server/db/schema";
import { eventService } from "~/server/events";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123456789";
const sent: { url: string; body: { content: string; allowed_mentions: unknown } }[] = [];
let discordDown = false;

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "discord.com") {
    if (discordDown) return json({}, 500);
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${KEY}`) return json({}, 401);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname.endsWith("/power")) return new Response(null, { status: 204 });
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let ev: ReturnType<typeof eventService>;
let servers: ReturnType<typeof serverService>;
let lib: ReturnType<typeof libraryService>;
let owner: Headers;
let editor: Headers;
let outsider: Headers;
let id: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  ev = eventService(deps);
  servers = serverService(deps);
  lib = libraryService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "家のパネル", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  id = (await servers.listServers(owner))[0].id;
  const inv = await (await t.call("/organization/invite-member", { email: "editor@example.com", role: "editor" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("編集者", "editor@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  editor = t.headers(cookie);
  outsider = t.headers(await t.signUp("部外者", "outsider@example.com"));
});

describe("操作の記録", () => {
  it("だれが何をしたかが新しい順に残る。見られるのは管理者以上で、ほかのチームのものは見えない", async () => {
    await servers.power(editor, id, "restart");
    await lib.setProfile(owner, id, { platform: "paper", mcVersion: "1.21.1" });
    const rows = await ev.list(owner);
    expect(rows.map((r) => [r.action, r.target, r.userName])).toEqual([
      ["サーバーの種類を設定", "ロビー", "オーナー"], ["再起動", "ロビー", "編集者"], ["サーバーを追加", "ロビー", "オーナー"], ["Pterodactyl パネルを登録", "家のパネル", "オーナー"]]);
    expect(rows[0].detail).toBe("Paper 1.21.1");
    expect(await code(ev.list(editor))).toBe(403);
    expect(await ev.list(outsider)).toEqual([]); // 部外者のチームには、まだ記録が無い
  });
});

describe("Discord への通知", () => {
  it("Discord の Webhook の URL だけを受け付け、暗号化して保存する。設定は管理者以上", async () => {
    expect(await code(ev.setNotify(owner, { url: "https://evil.example/api/webhooks/1/x", kinds: ["power"] }))).toBe(400);
    expect(await code(ev.setNotify(owner, { url: "", kinds: ["power"] }))).toBe(400); // まだ URL が無い
    expect(await code(ev.setNotify(editor, { url: HOOK, kinds: ["power"] }))).toBe(403);
    await ev.setNotify(owner, { url: HOOK, kinds: ["power", "nope"] });
    const [row] = await t.db.select().from(teamNotify);
    expect(row.webhookSealed).not.toContain("discord");
    expect(await ev.notifySettings(owner)).toMatchObject({ configured: true, hint: "…6789", selected: ["power"] });
  });

  it("選んだ種類だけを送り、メンションはさせない", async () => {
    sent.length = 0;
    await servers.power(editor, id, "start");
    await lib.setProfile(owner, id, { platform: "paper", mcVersion: "" }); // admin は選んでいない
    expect(sent.map((s) => s.body.content)).toEqual(["**起動** ロビー(編集者)"]);
    expect(sent[0].body.allowed_mentions).toEqual({ parse: [] });
  });

  it("Discord に送れなくても、もとの操作と記録は失敗しない。試しに送ると失敗がわかる", async () => {
    discordDown = true;
    await servers.power(editor, id, "stop");
    expect((await ev.list(owner))[0].action).toBe("停止");
    expect(await code(ev.testNotify(owner))).toBe(502);
    discordDown = false;
    await ev.testNotify(owner);
    expect(sent.at(-1)?.body.content).toContain("試しの通知");
  });

  it("URL を入れずに保存すると、いまの URL のまま種類だけ変わる。やめると消える", async () => {
    await ev.setNotify(owner, { url: "", kinds: ["changes", "sets"] });
    expect((await ev.notifySettings(owner)).selected).toEqual(["changes", "sets"]);
    await ev.setNotify(owner, { url: null, kinds: [] });
    expect((await ev.notifySettings(owner)).configured).toBe(false);
    expect(await t.db.select().from(teamNotify).where(eq(teamNotify.webhookHint, "…6789"))).toEqual([]);
  });
});

describe("お知らせ", () => {
  it("管理者以上はすべて、ほかの人はアドオン・セット・予約・起動と停止だけを見る", async () => {
    const all = await ev.recent(owner);
    expect(all.some((e) => e.kind === "admin")).toBe(true);
    const mine = await ev.recent(editor);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => ["changes", "sets", "schedule", "power"].includes(e.kind))).toBe(true);
    expect((await ev.recent(outsider)).length).toBe(0);
  });
});

describe("操作の記録を探す", () => {
  it("操作・対象・詳しく・人の名前で探せる。% や _ はそのままの文字として探す。ほかのチームのものは出ない", async () => {
    expect((await ev.list(owner, undefined, "再起動")).map((r) => r.action)).toEqual(["再起動"]);
    expect((await ev.list(owner, undefined, "編集者")).every((r) => r.userName === "編集者")).toBe(true);
    expect((await ev.list(owner, undefined, "paper")).map((r) => r.action)).toEqual(["サーバーの種類を設定", "サーバーの種類を設定"]); // 詳しく(大文字・小文字は問わない)
    expect(await ev.list(owner, undefined, "%")).toEqual([]);
    expect(await ev.list(outsider, undefined, "再起動")).toEqual([]);
    expect(await code(ev.list(editor, undefined, "再起動"))).toBe(403);
  });
});

describe("お知らせの既読", () => {
  it("利用者ごとにサーバーに残し、先へ進めるだけ", async () => {
    expect(await ev.seen(owner)).toBeNull();
    await ev.markSeen(owner, "2026-01-02T00:00:00.000Z");
    await ev.markSeen(owner, "2026-01-01T00:00:00.000Z"); // 戻らない
    expect(await ev.seen(owner)).toBe("2026-01-02T00:00:00.000Z");
    expect(await ev.seen(editor)).toBeNull(); // ほかの人は別
    const [latest] = await ev.recent(editor);
    await ev.markSeen(editor, latest.at); // 記録の時刻のまま残る(画面は、これより新しいものを未読と数える)
    expect(await ev.seen(editor)).toBe(latest.at);
    expect((await ev.recent(editor)).filter((e) => e.at > (latest.at)).length).toBe(0);
    expect(await code(ev.markSeen(owner, "nope"))).toBe(400);
  });
});

describe("パネルの新しい版", () => {
  it("すべてのチームに 1 度だけ知らせる。管理者だけのお知らせに出る", async () => {
    await ev.announcePanel("03.99.00");
    await ev.announcePanel("03.99.00");
    expect((await ev.list(owner)).filter((r) => r.kind === "panel").map((r) => r.target)).toEqual(["v03.99.00"]);
    expect((await ev.recent(owner)).some((e) => e.kind === "panel")).toBe(true);
    expect((await ev.recent(editor)).some((e) => e.kind === "panel")).toBe(false);
    expect((await ev.recent(outsider)).filter((e) => e.kind === "panel").length).toBe(1); // 部外者は自分のチームで受け取る
  });

  it("サービス版の通知の設定には、パネルの更新は出ない", async () => {
    expect(Object.keys((await ev.notifySettings(owner)).kinds)).not.toContain("panel");
    expect(Object.keys((await eventService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir: "." } }).notifySettings(owner)).kinds)).toContain("panel");
  });
});
