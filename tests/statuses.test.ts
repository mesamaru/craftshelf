// サーバーの状態をまとめて 1 回で取る(statuses): 割り当て・チーム・並列の上限・1 台の失敗・数秒の覚え(Pterodactyl は偽物で数える)
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpError } from "~/server/guard";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const BAD = "s0000013"; // このサーバーだけ、パネルが 500 を返す

const idents = Array.from({ length: 20 }, (_, i) => `s${String(i + 1).padStart(7, "0")}`);
const calls = { resources: 0, other: 0 };
const flight = { now: 0, max: 0 };
const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${KEY}`) return new Response("{}", { status: 401 });
  if (u.pathname === "/api/client") return Response.json({ data: idents.map((identifier, i) => ({ attributes: { identifier, name: `S${i + 1}` } })), meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/([a-z0-9-]+)\/resources$/);
  if (m) {
    calls.resources++;
    flight.now++;
    flight.max = Math.max(flight.max, flight.now);
    await new Promise((r) => setTimeout(r, 15));
    flight.now--;
    if (m[1] === BAD) return new Response("{}", { status: 500 });
    return Response.json({ attributes: { current_state: "running", resources: { memory_bytes: 1 } } });
  }
  calls.other++;
  return new Response("{}", { status: 404 }); // 割り当て(ping の先)も 404 = ping は null
};

let t: Awaited<ReturnType<typeof setup>>;
let svc: ReturnType<typeof serverService>;
let owner: Headers;
let viewer: Headers;
let limited: Headers;
let limitedId: string;
let outsider: Headers;
let ids: Record<string, string>; // 識別子 → サーバーの ID
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const join = async (role: string, email: string) => {
  const inv = await (await t.call("/organization/invite-member", { email, role }, owner.get("cookie")!)).json();
  const cookie = await t.signUp(role, email);
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  return t.headers(cookie);
};

beforeAll(async () => {
  t = await setup();
  svc = serverService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake, allowPrivate: true });
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await svc.addConnection(owner, { name: "P", url: "panel.example.com", apiKey: KEY });
  await svc.addServers(owner, c.id, idents);
  const list = await svc.listServers(owner);
  expect(list).toHaveLength(20);
  viewer = await join("viewer", "viewer@example.com");
  limited = await join("editor", "limited@example.com");
  limitedId = (await svc.assignments(owner)).members.find((m) => m.role === "editor")!.userId;
  outsider = t.headers(await t.signUp("部外者", "outsider@example.com"));
  ids = Object.fromEntries((await t.db.query.server.findMany()).map((s) => [s.remoteId!, s.id]));
});
afterEach(() => vi.useRealTimers());

// 覚えている状態(5 秒)を、時計を進めて捨てる
const later = (ms: number) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + ms); };

describe("サーバーの状態をまとめて 1 回で取る", () => {
  it("権限のあるサーバーすべての状態を、1 回の呼び出しで返す。1 台がつながらなくても、その台だけ理由つきのエラー", async () => {
    later(60_000);
    calls.resources = 0;
    const r = await svc.statuses(owner);
    expect(Object.keys(r)).toHaveLength(20);
    expect(calls.resources).toBe(20);
    const bad = r[ids[BAD]];
    expect(typeof bad).toBe("string");
    expect(bad).toContain("HTTP 500");
    const ok = r[ids[idents[0]]];
    expect(ok).toMatchObject({ state: "running", ping: null });
    expect(Object.values(r).filter((x) => typeof x === "object")).toHaveLength(19);
  });

  it("外部への問い合わせの同時の数は 8 まで", async () => {
    later(120_000);
    flight.max = 0;
    await svc.statuses(owner);
    expect(flight.max).toBeGreaterThan(1);
    expect(flight.max).toBeLessThanOrEqual(8);
  });

  it("5 秒のあいだは覚えている(別の人・同時の呼び出しも外へ重ねない)。5 秒を過ぎたら取り直す", async () => {
    later(240_000);
    calls.resources = 0;
    const [a, b] = await Promise.all([svc.statuses(owner), svc.statuses(viewer)]); // 同時
    expect(calls.resources).toBe(20);
    expect(Object.keys(a)).toEqual(Object.keys(b));
    await svc.statuses(owner);
    await svc.status(owner, ids[idents[0]]); // 1 台の読み取りも同じ覚えを使う
    expect(calls.resources).toBe(20);
    later(240_000 + 5_100);
    await svc.statuses(owner);
    expect(calls.resources).toBe(40);
  });

  it("ids で絞れる。知らない ID・別のチームのものは、返さない(エラーにもしない)", async () => {
    later(400_000);
    const r = await svc.statuses(owner, [ids[idents[0]], ids[idents[1]], "nope"]);
    expect(Object.keys(r).sort()).toEqual([ids[idents[0]], ids[idents[1]]].sort());
    expect(await svc.statuses(owner, [])).toEqual({});
    // 別のチームの人は、ID を知っていても(覚えがあっても)何も取れない
    expect(await svc.statuses(outsider)).toEqual({});
    expect(await svc.statuses(outsider, [ids[idents[0]]])).toEqual({});
    expect(await code(svc.status(outsider, ids[idents[0]]))).toBe(404);
  });

  it("閲覧者は全部見られる。割り当てた人は、割り当てたサーバーだけ(覚えがあっても、ほかのは返らない)", async () => {
    later(500_000);
    expect(Object.keys(await svc.statuses(viewer))).toHaveLength(20);
    await svc.setAssignment(owner, limitedId, true, [ids[idents[0]], ids[idents[1]]]);
    const r = await svc.statuses(limited);
    expect(Object.keys(r).sort()).toEqual([ids[idents[0]], ids[idents[1]]].sort());
    expect(Object.keys(await svc.statuses(limited, [ids[idents[2]], ids[idents[0]]]))).toEqual([ids[idents[0]]]);
    expect(await code(svc.status(limited, ids[idents[2]]))).toBe(403);
    await svc.setAssignment(owner, limitedId, false, []);
    expect(Object.keys(await svc.statuses(limited))).toHaveLength(20);
  });

  it("起動・停止のあとは、覚えを捨てて取り直す", async () => {
    later(600_000);
    const id = ids[idents[0]];
    await svc.statuses(owner, [id]);
    calls.resources = 0;
    await svc.statuses(owner, [id]);
    expect(calls.resources).toBe(0);
    await svc.power(owner, id, "restart").catch(() => {}); // 偽のパネルは電源の操作に 404 を返す。覚えは操作の前に捨てる
    await svc.statuses(owner, [id]);
    expect(calls.resources).toBe(1);
  });
});

describe("画面は状態をまとめて取る 1 か所だけを使う", () => {
  it("メニュー・サーバーの一覧・詳細が、1 台ごとの serverStatus を直接呼ばない(src/lib/server-status.ts だけが取る)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/lib/shell.tsx", "src/routes/servers.tsx", "src/routes/servers.$id.tsx", "src/routes/home.tsx", "src/routes/index.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\bserverStatus\b/);
    }
    expect(readFileSync("src/lib/server-status.ts", "utf8")).toContain("serverStatuses");
  });
});
