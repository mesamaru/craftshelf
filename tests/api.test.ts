// API トークンと、外から呼べる API(/api/v1)。Pterodactyl は偽物の応答で代わりをする
import { beforeAll, describe, expect, it } from "vitest";
import { eventService } from "~/server/events";
import { fileService } from "~/server/files";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { handleRest } from "~/server/rest";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { tokenService } from "~/server/tokens";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const power: string[] = [];
const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname.endsWith("/power")) { power.push(JSON.parse(String(init?.body)).signal); return new Response(null, { status: 204 }); }
  if (u.pathname.endsWith("/resources")) return json({ attributes: { current_state: "running", resources: {} } });
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let tokens: ReturnType<typeof tokenService>;
let services: Parameters<typeof handleRest>[0];
let owner: Headers;
let viewer: Headers;
let viewerCookie: string;
let id: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const withKey = (key: string) => new Headers({ "x-api-key": key });
const call = (method: string, path: string, key: string | null, body?: unknown) =>
  handleRest(services, new Request(`http://x/api/v1${path}`, { method, headers: key ? { authorization: `Bearer ${key}`, "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }), path);

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  const servers = serverService(deps);
  tokens = tokenService(deps);
  services = { servers, library: libraryService(deps), sets: setService(deps), files: fileService(deps), events: eventService(deps) } as never;
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  id = (await servers.listServers(owner))[0].id;
  const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
  viewerCookie = await t.signUp("閲覧者", "viewer@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, viewerCookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, viewerCookie);
  viewer = t.headers(viewerCookie);
});

describe("API トークン", () => {
  let full: string;
  let readOnly: string;

  it("作ると cs_ で始まるトークンを一度だけ返す。一覧には頭の数文字だけ", async () => {
    expect(await code(tokens.create(owner, { name: "", readOnly: false, days: 0 }))).toBe(400);
    full = (await tokens.create(owner, { name: "自動化", readOnly: false, days: 30 })).key;
    readOnly = (await tokens.create(owner, { name: "見るだけ", readOnly: true, days: 0 })).key;
    expect(full.startsWith("cs_")).toBe(true);
    const list = await tokens.list(owner);
    expect(list.map((k) => [k.name, k.readOnly])).toEqual(expect.arrayContaining([["自動化", false], ["見るだけ", true]]));
    expect(JSON.stringify(list)).not.toContain(full);
    expect(await tokens.list(viewer)).toEqual([]); // ほかの人のトークンは見えない
  });

  it("トークンで、作った人の役割のとおりに操作できる。読み取りだけのトークンは変える操作ができない", async () => {
    const r = await call("GET", "/servers", full);
    expect(r.status).toBe(200);
    expect((await r.json()).map((s: { name: string }) => s.name)).toEqual(["ロビー"]);
    expect((await call("POST", `/servers/${id}/power`, full, { signal: "restart" })).status).toBe(200);
    expect(power).toEqual(["restart"]);
    expect((await call("GET", `/servers/${id}/status`, readOnly)).status).toBe(200);
    const ro = await call("POST", `/servers/${id}/power`, readOnly, { signal: "stop" });
    expect([ro.status, (await ro.json()).message]).toEqual([403, "読み取りだけの API トークンでは、この操作はできません"]);
    expect(power).toEqual(["restart"]);
  });

  it("閲覧者のトークンは、閲覧者の権限まで", async () => {
    const vk = (await tokens.create(viewer, { name: "閲覧者の", readOnly: false, days: 0 })).key;
    expect((await call("GET", "/library", vk)).status).toBe(200);
    expect((await call("POST", `/servers/${id}/power`, vk, { signal: "start" })).status).toBe(403);
  });

  it("トークンが無い・違う・消したものは使えない。トークンでトークンは作れない", async () => {
    expect((await call("GET", "/servers", null)).status).toBe(401);
    expect((await call("GET", "/servers", "cs_wrongwrongwrong")).status).toBe(401);
    expect(await code(tokens.create(withKey(full), { name: "x", readOnly: false, days: 0 }))).toBe(403);
    const id2 = (await tokens.list(owner)).find((k) => k.name === "見るだけ")!.id;
    await tokens.remove(owner, id2);
    expect((await call("GET", "/servers", readOnly)).status).toBe(401);
  });

  it("一覧(GET /api/v1)と、無い API", async () => {
    const r = await (await call("GET", "", null)).json();
    expect(r.routes.some((x: { path: string }) => x.path === "/api/v1/servers/:id/sync")).toBe(true);
    expect((await call("GET", "/nope", full)).status).toBe(404);
  });

  it("チームを抜けた人のトークンは使えない", async () => {
    const vk = (await tokens.create(viewer, { name: "抜ける前", readOnly: true, days: 0 })).key;
    const team = await (await t.get("/organization/get-full-organization", owner.get("cookie")!)).json();
    const m = team.members.find((x: { user: { email: string } }) => x.user.email === "viewer@example.com");
    await t.call("/organization/remove-member", { memberIdOrEmail: m.id }, owner.get("cookie")!);
    expect((await call("GET", "/servers", vk)).status).toBe(401);
  });
});
