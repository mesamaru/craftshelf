// API トークンと、外から呼べる API(/api/v1)。Pterodactyl は偽物の応答で代わりをする
import { beforeAll, describe, expect, it } from "vitest";
import { eventService } from "~/server/events";
import { fileService } from "~/server/files";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { ROUTES, handleRest } from "~/server/rest";
import { backupService } from "~/server/backup";
import { jobService } from "~/server/jobs";
import { scheduleService } from "~/server/schedule";
import { softwareService } from "~/server/software";
import { worldService } from "~/server/worlds";
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
  const sets = setService(deps);
  services = { servers, library: libraryService(deps), sets, files: fileService(deps), events: eventService(deps), software: softwareService(deps), worlds: worldService(deps),
    backups: backupService(deps), schedules: scheduleService(deps, sets), jobs: jobService(deps) } as never;
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
    expect(await code(tokens.create(owner, { name: "", scopes: [], days: 0 }))).toBe(400);
    full = (await tokens.create(owner, { name: "自動化", scopes: ["library", "control", "admin"], days: 30 })).key;
    readOnly = (await tokens.create(owner, { name: "見るだけ", scopes: [], days: 0 })).key;
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

  it("閲覧者のトークンは、閲覧者の権限まで。役割を超える範囲は作れない", async () => {
    expect(await code(tokens.create(viewer, { name: "超える", scopes: ["control"], days: 0 }))).toBe(403);
    expect(await code(tokens.create(viewer, { name: "知らない範囲", scopes: ["root"], days: 0 }))).toBe(400);
    const vk = (await tokens.create(viewer, { name: "閲覧者の", scopes: [], days: 0 })).key;
    expect((await call("GET", "/library", vk)).status).toBe(200);
    expect((await call("POST", `/servers/${id}/power`, vk, { signal: "start" })).status).toBe(403);
  });

  it("範囲を選んだトークンは、その範囲の操作だけができる", async () => {
    const lib = (await tokens.create(owner, { name: "Mod だけ", scopes: ["library"], days: 0 })).key;
    expect((await tokens.list(owner)).find((k) => k.name === "Mod だけ")?.scopes).toEqual(["read", "library"]);
    const r = await call("POST", `/servers/${id}/power`, lib, { signal: "stop" });
    expect(r.status).toBe(403);
    expect((await r.json()).message).toContain("この API トークンの範囲では");
    expect((await call("POST", "/sets", lib, { name: "API のセット" })).status).toBe(200);
    expect((await call("GET", "/events", lib)).status).toBe(403); // 管理の範囲が要る
    const ctl = (await tokens.create(owner, { name: "電源だけ", scopes: ["control"], days: 0 })).key;
    expect((await call("POST", `/servers/${id}/power`, ctl, { signal: "start" })).status).toBe(200);
    expect((await call("POST", "/sets", ctl, { name: "作れない" })).status).toBe(403);
    expect(power.at(-1)).toBe("start");
  });

  it("03.56 までのトークン(範囲が無い)は、読み取りだけか役割のとおりに動く", async () => {
    const team = (await t.auth.api.getSession({ headers: owner }))!.session.activeOrganizationId;
    const me = (await t.auth.api.getSession({ headers: owner }))!.user.id;
    const old = await t.auth.api.createApiKey({ body: { name: "前の形", userId: me, prefix: "cs_", metadata: { teamId: team, readOnly: false } } });
    expect((await call("POST", `/servers/${id}/power`, old.key, { signal: "restart" })).status).toBe(200);
    expect((await call("GET", "/events", old.key)).status).toBe(200);
    const ro = await t.auth.api.createApiKey({ body: { name: "前の読み取り", userId: me, prefix: "cs_", metadata: { teamId: team, readOnly: true } } });
    expect((await call("POST", `/servers/${id}/power`, ro.key, { signal: "restart" })).status).toBe(403);
  });

  it("トークンが無い・違う・消したものは使えない。トークンでトークンは作れない", async () => {
    expect((await call("GET", "/servers", null)).status).toBe(401);
    expect((await call("GET", "/servers", "cs_wrongwrongwrong")).status).toBe(401);
    expect(await code(tokens.create(withKey(full), { name: "x", scopes: [], days: 0 }))).toBe(403);
    const id2 = (await tokens.list(owner)).find((k) => k.name === "見るだけ")!.id;
    await tokens.remove(owner, id2);
    expect((await call("GET", "/servers", readOnly)).status).toBe(401);
  });

  it("一覧(GET /api/v1)と、無い API", async () => {
    const r = await (await call("GET", "", null)).json();
    expect(r.routes.some((x: { path: string }) => x.path === "/api/v1/servers/:id/sync")).toBe(true);
    expect((await call("GET", "/nope", full)).status).toBe(404);
  });

  it("説明に書いた範囲が無いトークンでは、どの API も 403 になる(説明と中身がずれていないか)", async () => {
    const ro = (await tokens.create(owner, { name: "見回り", scopes: [], days: 0 })).key;
    for (const r of ROUTES) {
      const path = r.path.replace(":id", id).replace(/:[a-zA-Z]+/g, "x");
      const status = (await call(r.method, path, ro, r.method === "POST" ? r.example ?? {} : undefined)).status;
      if (r.scope === "read") expect.soft(status, `${r.method} ${r.path}`).not.toBe(403);
      else expect.soft(status, `${r.method} ${r.path}`).toBe(403);
    }
  });

  it("チームを抜けた人のトークンは使えない", async () => {
    const vk = (await tokens.create(viewer, { name: "抜ける前", scopes: [], days: 0 })).key;
    const team = await (await t.get("/organization/get-full-organization", owner.get("cookie")!)).json();
    const m = team.members.find((x: { user: { email: string } }) => x.user.email === "viewer@example.com");
    await t.call("/organization/remove-member", { memberIdOrEmail: m.id }, owner.get("cookie")!);
    expect((await call("GET", "/servers", vk)).status).toBe(401);
  });
});
