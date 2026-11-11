// 認証でデータベースを引く回数(1 回の呼び出しで認証を繰り返さない)と、守りを弱めていないこと
// (権限・メンバーかどうかは毎回データベースで確かめる。セッションの記憶(cookieCache)は、外された人・権限を引かれた人の操作を通さない)
import { beforeAll, describe, expect, it } from "vitest";
import { eventService } from "~/server/events";
import { fileService } from "~/server/files";
import { HttpError } from "~/server/guard";
import { prefService } from "~/server/prefs";
import { serverService } from "~/server/servers";
import { teamService } from "~/server/teams";
import { setup } from "./helpers";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const fake = async () => new Response("{}", { status: 404 });
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

type Setup = Awaited<ReturnType<typeof setup>>;
async function world() {
  const t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake as never };
  const owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const join = async (email: string, role: string) => {
    const inv = await (await t.call("/organization/invite-member", { email, role }, owner.get("cookie")!)).json();
    const cookie = await t.signUp(email, email);
    await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
    const res = await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
    // 画面(ブラウザ)は、返ってきた Cookie に置き換える
    const merged = new Map((cookie + "; " + t.cookieOf(res)).split("; ").map((c) => [c.split("=")[0], c]));
    return { headers: t.headers([...merged.values()].join("; ")), inv };
  };
  return { t, deps, owner, join };
}
// 問い合わせの数を数える(PGlite の query・exec をかぶせる)
function counter(t: Setup) {
  const c = (t.db as unknown as { $client: { query: (...a: unknown[]) => Promise<unknown> } }).$client;
  const orig = c.query.bind(c);
  let n = 0;
  c.query = (...a: unknown[]) => { n++; return orig(...a); };
  return async <T>(fn: () => Promise<T>) => {
    n = 0;
    const r = await fn();
    return { n, r };
  };
}

describe("認証の問い合わせ回数(1 回の呼び出しで認証を繰り返さない)", () => {
  let w: Awaited<ReturnType<typeof world>>;
  let count: ReturnType<typeof counter>;
  beforeAll(async () => {
    w = await world();
    count = counter(w.t);
  });

  it("お知らせ(recent + seen)は認証 1 回(セッション・ユーザー・メンバーの 3 回)+ 記録 + どこまで読んだか", async () => {
    const ev = eventService(w.deps);
    const { n, r } = await count(() => ev.feed(w.owner));
    expect(r).toMatchObject({ items: [], seenAt: null });
    expect(n).toBeLessThanOrEqual(5); // 前は 11 回
  });

  it("設定ファイルを見られるか(files.access)・自分の権限(myPerms)は、認証 1 回", async () => {
    const files = fileService(w.deps);
    const a = await count(() => files.access(w.owner));
    expect(a.r).toMatchObject({ allowed: true });
    expect(a.n).toBeLessThanOrEqual(4); // 前は 7 回
    const teams = teamService(w.deps);
    const p = await count(() => teams.myPerms(w.owner));
    expect(p.r.perms).toContain("library:edit");
    expect(p.n).toBeLessThanOrEqual(3); // 前は 4 回
  });

  it("サーバーの一覧は、役割を読み直さない(serverScope が requireTeam の役割を使う)", async () => {
    const servers = serverService(w.deps);
    const { n } = await count(() => servers.listServers(w.owner));
    expect(n).toBeLessThanOrEqual(4); // 前は 5 回
  });

  it("見た目・背景・ウィジェットの並びは 1 回で読み、個別に読んだ値と同じ", async () => {
    const prefs = prefService(w.deps);
    const owner = (await w.t.auth.api.getSession({ headers: w.owner }))!.user.id;
    const { n, r } = await count(() => prefs.appState(owner));
    expect(n).toBe(1);
    expect(r).toEqual({ theme: await prefs.theme(owner), dash: await prefs.dash(owner), background: await prefs.backgroundUrl(owner) });
  });
});

describe("守りを弱めていない(権限・メンバーは毎回データベースで確かめる)", () => {
  it("チームから外された人は、すぐ断られる(同じ Cookie のまま)。権限を引かれた人も、次の呼び出しから", async () => {
    const w = await world();
    const { headers, inv } = await w.join("viewer@example.com", "member");
    const ev = eventService(w.deps);
    const files = fileService(w.deps);
    expect(await code(ev.feed(headers))).toBe(200);
    expect(await code(files.access(headers))).toBe(200);
    // 権限の足し引き(メンバーごと)は、次の呼び出しで効く
    const teams = teamService(w.deps);
    const viewerId = (await w.t.auth.api.getSession({ headers }))!.user.id;
    expect((await teams.myPerms(headers)).perms).not.toContain("server:control");
    await teams.setMemberGrants(w.owner, viewerId, ["server:control"]);
    expect((await teams.myPerms(headers)).perms).toContain("server:control");
    await teams.setMemberGrants(w.owner, viewerId, []);
    expect((await teams.myPerms(headers)).perms).not.toContain("server:control");
    // 外す
    await w.t.call("/organization/remove-member", { memberIdOrEmail: "viewer@example.com", organizationId: inv.organizationId }, w.owner.get("cookie")!);
    expect(await code(ev.feed(headers))).toBe(403);
    expect(await code(files.access(headers))).toBe(403);
    expect(await code(teams.myPerms(headers))).toBe(403);
    expect(await code(serverService(w.deps).listServers(headers))).toBe(403);
  });

  it("ログインしていないものは 401。外された人の Cookie は、セッションが残っていても使えない", async () => {
    const w = await world();
    const { headers, inv } = await w.join("viewer@example.com", "member");
    const ev = eventService(w.deps);
    await w.t.call("/organization/remove-member", { memberIdOrEmail: "viewer@example.com", organizationId: inv.organizationId }, w.owner.get("cookie")!);
    expect(await code(ev.feed(headers))).toBe(403);
    expect(await code(ev.feed(w.t.headers("")))).toBe(401);
  });
});
