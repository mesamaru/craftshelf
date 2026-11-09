// 処理の一覧: 実行中・待ち・成功・失敗を残す。見えるのは同じチームの人だけ(サーバーを割り当てられた人は、そのサーバーのものと自分の操作だけ)
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import { jobService } from "~/server/jobs";
import { setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let jobs: ReturnType<typeof jobService>;
let owner: Headers;
let viewer: Headers;
let other: Headers;
let teamId: string;
let ownerId: string;
const sid = { a: "srv-a", b: "srv-b" };

beforeAll(async () => {
  t = await setup();
  jobs = jobService({ db: t.db, auth: t.auth, secret: "x", fetch: (() => { throw new Error("no fetch"); }) as never });
  const oc = await t.signUp("オーナー", "owner@example.com");
  owner = t.headers(oc);
  const s = (await t.auth.api.getSession({ headers: owner }))!;
  teamId = s.session.activeOrganizationId!;
  ownerId = s.user.id;
  for (const [k, id] of Object.entries(sid)) await t.db.insert(schema.server).values({ id, teamId, kind: "ptero", name: `サーバー ${k.toUpperCase()}` });
  const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, oc)).json();
  const vc = await t.signUp("閲覧者", "viewer@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, vc);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, vc);
  viewer = t.headers(vc);
  other = t.headers(await t.signUp("ほかのチーム", "other@example.com"));
});

describe("処理の一覧", () => {
  it("成功・失敗を、結果のまとめ・エラーと一緒に残す。失敗はそのまま投げ直す", async () => {
    expect(await jobs.track({ teamId, userId: ownerId, serverId: sid.a, action: "セットでそろえる", target: "ロビー用" }, async () => ({ n: 3 }), (r) => `入れた ${r.n}`)).toEqual({ n: 3 });
    await expect(jobs.track({ teamId, userId: null, serverId: sid.b, action: "自動更新" }, async () => { throw new HttpError(502, "パネルにつながりません"); })).rejects.toThrow("パネルにつながりません");
    const list = await jobs.list(owner);
    expect(list.map((j) => [j.action, j.state, j.detail, j.serverName])).toEqual([
      ["自動更新", "failed", "パネルにつながりません", "サーバー B"],
      ["セットでそろえる", "done", "入れた 3", "サーバー A"],
    ]);
    expect(list[1]).toMatchObject({ userName: "オーナー", target: "ロビー用" });
    expect(list[1].startedAt && list[1].finishedAt).toBeTruthy();
  });

  it("まとめての処理は、先に「待ち」として並び、動かすと実行中・終わったものになる。途中で止まったら残りを失敗にする", async () => {
    const q = await jobs.queue([sid.a, sid.b, sid.a].map((serverId) => ({ teamId, userId: ownerId, serverId, action: "まとめて最新にする" })));
    let seen: string[] = [];
    await q.run(0, async () => { seen = (await jobs.list(owner)).filter((j) => j.action === "まとめて最新にする").map((j) => j.state); });
    expect(seen.sort()).toEqual(["queued", "queued", "running"]);
    await q.skipRest(0);
    const states = (await jobs.list(owner)).filter((j) => j.action === "まとめて最新にする").map((j) => j.state).sort();
    expect(states).toEqual(["done", "failed", "failed"]);
  });

  it("閲覧者も見られる。ほかのチームからは見えない", async () => {
    expect((await jobs.list(viewer)).length).toBe((await jobs.list(owner)).length);
    expect(await jobs.list(other)).toEqual([]);
  });

  it("サーバーを割り当てられた人は、そのサーバーのものと自分の操作だけ", async () => {
    const vid = (await t.auth.api.getSession({ headers: viewer }))!.user.id;
    await t.db.insert(schema.memberServerLimit).values({ teamId, userId: vid });
    await t.db.insert(schema.memberServer).values({ teamId, userId: vid, serverId: sid.b });
    const list = await jobs.list(viewer);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((j) => j.serverName === "サーバー B")).toBe(true);
    await t.db.delete(schema.memberServerLimit).where(eq(schema.memberServerLimit.userId, vid));
  });

  it("起動したときに、待ち・実行中のまま残ったものを失敗にする", async () => {
    let release = () => {};
    const p = jobs.track({ teamId, userId: ownerId, action: "バックアップを作る" }, () => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 50));
    expect((await jobs.list(owner))[0].state).toBe("running");
    await jobs.recover();
    expect((await jobs.list(owner))[0]).toMatchObject({ state: "failed", detail: "パネルが再起動したため、途中で止まりました" });
    release();
    await p;
  });
});
