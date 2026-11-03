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
