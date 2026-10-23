// サーバーと Pterodactyl の接続の通しテスト(Pterodactyl は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { pteroConnection } from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";

// 偽の Pterodactyl パネル: KEY のときだけ答え、電源の操作を記録する
const powered: { ident: string; signal: string }[] = [];
const fakePtero: FetchLike = async (url, init) => {
  const u = new URL(url);
  if (u.origin !== "https://panel.example.com") throw new Error("想定外の接続先");
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${KEY}`) return new Response("{}", { status: 401 });
  if (u.pathname === "/api/client") {
    return Response.json({
      data: [
        { attributes: { identifier: "abcd1234", name: "サバイバル", node: "node-1" } },
        { attributes: { identifier: "efgh5678", name: "クリエイティブ", node: "node-1" } },
        { attributes: { identifier: "../../evil", name: "変な ID" } },
      ],
      meta: { pagination: { total_pages: 1 } },
    });
  }
  const m = u.pathname.match(/^\/api\/client\/servers\/([a-z0-9-]+)\/(resources|power)$/);
  if (m?.[2] === "resources") return Response.json({ attributes: { current_state: "running", resources: { memory_bytes: 2 ** 31 } } });
  if (m?.[2] === "power" && init?.method === "POST") {
    powered.push({ ident: m[1], signal: JSON.parse(String(init.body)).signal });
    return new Response(null, { status: 204 });
  }
  return new Response("{}", { status: 404 });
};

let t: Awaited<ReturnType<typeof setup>>;
let svc: ReturnType<typeof serverService>;
beforeAll(async () => {
  t = await setup();
  svc = serverService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fakePtero });
});

const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

describe("Pterodactyl パネル", () => {
  let owner: Headers;
  let viewer: Headers;
  let outsider: Headers;
  let connectionId: string;
  let serverId: string;

  it("オーナーがパネルを登録できる。キーは暗号化して保存される", async () => {
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    const r = await svc.addConnection(owner, { name: "ホスティング", url: "panel.example.com/", apiKey: KEY });
    connectionId = r.id;
    expect(r.servers.map((s) => s.identifier)).toEqual(["abcd1234", "efgh5678"]); // 変な ID は捨てる
    const [row] = await t.db.select().from(pteroConnection);
    expect(row.url).toBe("https://panel.example.com");
    expect(row.apiKeySealed).not.toContain(KEY);
    expect(row.apiKeyHint).toBe("…ghij");
    expect(JSON.stringify(await svc.listConnections(owner))).not.toContain(KEY);
  });

  it("キーの形・LAN の中の URL・効かないキーは断る", async () => {
    expect(await code(svc.addConnection(owner, { name: "", url: "panel.example.com", apiKey: "abc" }))).toBe(400);
    expect(await code(svc.addConnection(owner, { name: "", url: "https://192.168.1.5", apiKey: KEY }))).toBe(400);
    expect(await code(svc.addConnection(owner, { name: "", url: "panel.example.com", apiKey: "ptlc_wrongwrongwrong" }))).toBe(502);
  });

  it("パネルのサーバーを追加して、状態を見て、起動と停止ができる", async () => {
    const remote = await svc.remoteServers(owner, connectionId);
    expect(remote.every((s) => !s.added)).toBe(true);
    expect((await svc.addServers(owner, connectionId, ["abcd1234", "abcd1234", "not-on-panel"])).added).toBe(1);
    expect((await svc.remoteServers(owner, connectionId)).find((s) => s.identifier === "abcd1234")?.added).toBe(true);

    const list = await svc.listServers(owner);
    expect(list).toHaveLength(1);
    serverId = list[0].id;
    expect((await svc.status(owner, serverId)).state).toBe("running");
    await svc.power(owner, serverId, "restart");
    expect(powered.at(-1)).toEqual({ ident: "abcd1234", signal: "restart" });
  });

  it("閲覧者は見られるが、起動・停止・登録はできない", async () => {
    const inv = await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!);
    const { id, organizationId } = await inv.json();
    const cookie = await t.signUp("閲覧者", "viewer@example.com");
    await t.call("/organization/accept-invitation", { invitationId: id }, cookie);
    await t.call("/organization/set-active", { organizationId }, cookie);
    viewer = t.headers(cookie);

    expect(await svc.listServers(viewer)).toHaveLength(1);
    expect(await code(svc.status(viewer, serverId))).toBe(200);
    const before = powered.length;
    expect(await code(svc.power(viewer, serverId, "stop"))).toBe(403);
    expect(powered.length).toBe(before);
    expect(await code(svc.addConnection(viewer, { name: "", url: "panel.example.com", apiKey: KEY }))).toBe(403);
    expect(await code(svc.remoteServers(viewer, connectionId))).toBe(403);
    expect(await code(svc.removeServer(viewer, serverId))).toBe(403);
  });

  it("別のチームの人には、サーバーも接続も見えない", async () => {
    outsider = t.headers(await t.signUp("部外者", "outsider@example.com"));
    expect(await svc.listServers(outsider)).toHaveLength(0);
    expect(await svc.listConnections(outsider)).toHaveLength(0);
    // 部外者は自分のチームのオーナーなので権限はあるが、ID を知っていても別のチームのものは 404
    expect(await code(svc.status(outsider, serverId))).toBe(404);
    expect(await code(svc.power(outsider, serverId, "stop"))).toBe(404);
    expect(await code(svc.removeServer(outsider, serverId))).toBe(404);
    expect(await code(svc.remoteServers(outsider, connectionId))).toBe(404);
    expect(await code(svc.addServers(outsider, connectionId, ["efgh5678"]))).toBe(404);
    expect(await code(svc.removeConnection(outsider, connectionId))).toBe(404);
  });

  it("パネルの登録を消すと、そこから追加したサーバーも外れる", async () => {
    await svc.removeConnection(owner, connectionId);
    expect(await svc.listServers(owner)).toHaveLength(0);
  });
});
