// 自分用の版(CRAFTSHELF_MODE=self): 最初の 1 人が管理者・あとは招待された人だけ・チームは 1 つ
import { beforeAll, describe, expect, it } from "vitest";
import { count } from "drizzle-orm";
import { signupOpen } from "~/server/auth";
import { organization } from "~/server/db/schema";
import { setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup({ mode: "self" });
});

const teams = async () => (await t.db.select({ n: count() }).from(organization))[0].n;

describe("自分用の版", () => {
  let owner: string;

  it("はじめは登録できる。最初の 1 人がチーム「CraftShelf」のオーナーになる", async () => {
    expect(await signupOpen(t.db, "self")).toBe(true);
    owner = await t.signUp("管理者", "admin@example.com");
    const team = await (await t.get("/organization/get-full-organization", owner)).json();
    expect(team.name).toBe("CraftShelf");
    expect(team.members[0].role).toBe("owner");
    expect(await signupOpen(t.db, "self")).toBe(false);
  });

  it("招待されていない人は登録できない", async () => {
    const r = await t.call("/sign-up/email", { name: "x", email: "stranger@example.com", password: "correct horse battery" }, "", "10.8.0.1");
    expect(r.status).toBe(403);
    expect((await r.json()).message).toContain("招待");
  });

  it("招待された人は登録でき、同じチームに入る(チームは増えない)", async () => {
    const inv = await (await t.call("/organization/invite-member", { email: "member@example.com", role: "editor" }, owner)).json();
    const cookie = await t.signUp("メンバー", "member@example.com");
    expect((await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie)).status).toBe(200);
    expect(await teams()).toBe(1);
    const team = await (await t.get("/organization/get-full-organization", owner)).json();
    expect(team.members.map((m: { role: string }) => m.role).sort()).toEqual(["editor", "owner"]);
  });

  it("チームは増やせない", async () => {
    const r = await t.call("/organization/create", { name: "別のチーム", slug: "another" }, owner);
    expect(r.status).not.toBe(200);
    expect(await teams()).toBe(1);
  });
});
