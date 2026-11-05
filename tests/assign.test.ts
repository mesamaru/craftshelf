// ユーザーごとのサーバーの割り当て(Pterodactyl は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";

const fake: FetchLike = async (url) => {
  const u = new URL(url);
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") {
    return Response.json({ data: [{ attributes: { identifier: "aaaa1111", name: "ロビー" } }, { attributes: { identifier: "bbbb2222", name: "サバイバル" } }], meta: { pagination: { total_pages: 1 } } });
  }
  return Response.json({}, { status: 404 });
};

let t: Awaited<ReturnType<typeof setup>>;
let servers: ReturnType<typeof serverService>;
let lib: ReturnType<typeof libraryService>;
let sets: ReturnType<typeof setService>;
let owner: Headers;
let editor: Headers;
let editorId: string;
let lobby: string;
let survival: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  servers = serverService(deps);
  lib = libraryService(deps);
  sets = setService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["aaaa1111", "bbbb2222"]);
  const list = await servers.listServers(owner);
  lobby = list.find((s) => s.name === "ロビー")!.id;
  survival = list.find((s) => s.name === "サバイバル")!.id;
  const inv = await (await t.call("/organization/invite-member", { email: "editor@example.com", role: "editor" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("編集者", "editor@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  editor = t.headers(cookie);
  editorId = (await servers.assignments(owner)).members.find((m) => m.name === "編集者")!.userId;
});

describe("サーバーの割り当て", () => {
  it("はじめは、すべてのサーバーを使える。割り当てを決めるのは管理者以上。管理者・オーナーは制限できない", async () => {
    expect((await servers.listServers(editor)).length).toBe(2);
    const a = await servers.assignments(owner);
    expect(a.members.map((m) => [m.name, m.limited])).toEqual([["編集者", false]]);
    expect(await code(servers.assignments(editor))).toBe(403);
    expect(await code(servers.setAssignment(editor, editorId, true, []))).toBe(403);
    const ownerId = (await t.auth.api.getSession({ headers: owner }))!.user.id;
    expect(await code(servers.setAssignment(owner, ownerId, true, []))).toBe(400);
  });

  it("割り当てると、そのサーバーだけが一覧に出て、ほかのサーバーは操作できない", async () => {
    await servers.setAssignment(owner, editorId, true, [lobby, "not-in-team"]);
    expect((await servers.assignments(owner)).members[0]).toMatchObject({ limited: true, serverIds: [lobby] });
    expect((await servers.listServers(editor)).map((s) => s.name)).toEqual(["ロビー"]);
    expect((await lib.catalog(editor)).servers.map((s) => s.name)).toEqual(["ロビー"]);
    expect((await lib.detail(editor, lobby)).name).toBe("ロビー");
    expect(await code(lib.detail(editor, survival))).toBe(403);
    expect(await code(lib.setProfile(editor, survival, { platform: "paper", mcVersion: "" }))).toBe(403);
    expect(await code(sets.bind(editor, survival, null))).toBe(403);
    // 管理者・オーナーは変わらない
    expect((await servers.listServers(owner)).length).toBe(2);
  });

  it("「すべてのサーバーを使える」に戻すと、また全部を使える", async () => {
    await servers.setAssignment(owner, editorId, false, []);
    expect((await servers.listServers(editor)).length).toBe(2);
    expect((await lib.detail(editor, survival)).name).toBe("サバイバル");
  });
});
