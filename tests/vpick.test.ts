// サーバーのバージョンに合わせた版の選び方(03.73.00): 古いサーバーには「そのバージョンに対応する最新の版」を入れ、
// 版の一覧は配布元の版と保存した版を合わせて対応の印(対応 / 非対応 / 不明)を付けて返す。
// フォルダのサーバー(Minecraft 1.20.4。jar の名前で決まる)と偽の Modrinth・SpigotMC で確かめる
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { supportOf } from "~/lib/platforms";
import { member, organization, session, user } from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import { LATEST_MEMO, forgetLatest, libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { savedService } from "~/server/saved";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const LP = "Vebnzrzj"; // 最新版は 1.21 専用
const NEW = "NewOnly1"; // 1.21 専用の版しか無い
const OLD = "SavedPrj"; // 1.20.4 の版を保存してあり、配布元からは消えた
const dataDir = mkdtempSync(join(tmpdir(), "cs-vp-data-"));
const root = mkdtempSync(join(tmpdir(), "cs-vp-srv-"));
writeFileSync(join(root, "paper-1.20.4-123.jar"), "");
mkdirSync(join(root, "plugins"));
const root2 = mkdtempSync(join(tmpdir(), "cs-vp-srv2-"));
writeFileSync(join(root2, "paper-1.21.4-9.jar"), "");
mkdirSync(join(root2, "plugins"));

const jar = (name: string, v: string) => makeZip({ "plugin.yml": `name: ${name}\nversion: ${v}\nmain: a.B\n` }, false);
const ver = (pid: string, id: string, n: string, mc: string[], date: string, type = "release") => ({
  id, project_id: pid, version_number: n, version_type: type, date_published: date, loaders: ["paper"], game_versions: mc,
  files: [{ primary: true, filename: `${pid}-${n}.jar`, url: `https://cdn.modrinth.com/data/${pid}/${pid}-${n}.jar`, size: 1, hashes: {} }],
});
const versions: Record<string, ReturnType<typeof ver>[]> = {
  [LP]: [ver(LP, "lp000052", "5.2.0", ["1.19.4", "1.20.4"], "2026-01-01"), ver(LP, "lp000532", "5.3.2", ["1.20.4", "1.20.6"], "2026-02-01"),
    ver(LP, "lp000541", "5.4.1", ["1.21", "1.21.1"], "2026-03-01"), ver(LP, "lp000550", "5.5.0-beta", ["1.21.4"], "2026-04-01", "beta")],
  [NEW]: [ver(NEW, "nw000002", "2.0", ["1.21"], "2026-03-01")],
  [OLD]: [ver(OLD, "ol000015", "1.5", ["1.20.4"], "2026-01-01"), ver(OLD, "ol000020", "2.0", ["1.21"], "2026-03-01")],
};
const TITLE: Record<string, string> = { [LP]: "LuckPerms", [NEW]: "NewOnly", [OLD]: "SavedOne" };
// 偽の SpigotMC: 試した版 = 1.20・1.21(対応)/ 1.21 だけ(古いサーバーには非対応)/ 空(対応不明)
const SPIGOT: Record<number, number[] | string[]> = { 1001: ["1.20", "1.21"], 1002: ["1.21"], 1003: [] };
let down = false;
let cdnHits = 0;
const stat = { modrinth: 0 };

const fake: FetchLike = async (url) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    stat.modrinth++;
    if (down) return json({}, 503);
    if (u.pathname === "/v2/search") { // 本物と同じく、バージョンで絞れば合うものだけ
      const hit = (id: string) => ({ project_id: id, slug: id, title: TITLE[id], description: "", downloads: 1, icon_url: null });
      return json({ hits: (u.searchParams.get("facets") ?? "").includes("versions:") ? [hit(LP)] : [hit(LP), hit(NEW)] });
    }
    const m = u.pathname.match(/^\/v2\/project\/(\w+)(\/version)?$/);
    if (m && versions[m[1]]) {
      if (m[2]) {
        const mc = u.searchParams.get("game_versions"); // 本物の Modrinth と同じく、指定があれば絞る
        return json(versions[m[1]].filter((v) => !mc || v.game_versions.some((x) => JSON.parse(mc).includes(x))));
      }
      return json({ id: m[1], title: TITLE[m[1]], slug: TITLE[m[1]].toLowerCase(), project_type: "plugin" });
    }
    const v = u.pathname.match(/^\/v2\/version\/(\w+)$/);
    const hit = v && Object.values(versions).flat().find((x) => x.id === v[1]);
    return hit ? json(hit) : json({}, 404);
  }
  if (u.host === "api.spiget.org") {
    if (u.pathname === "/v2/resources") return json(Object.keys(SPIGOT).map((id) => ({ id: Number(id), name: `Spig${id}`, tag: "", downloads: 1, external: false, premium: false, category: { id: 15 }, version: { id: 7 }, testedVersions: SPIGOT[Number(id)] })));
    const m = u.pathname.match(/^\/v2\/resources\/(\d+)(\/versions\/latest|\/download)?$/);
    if (!m || !(Number(m[1]) in SPIGOT)) return json({}, 404);
    if (m[2] === "/download") return new Response(new Uint8Array(jar(`Spig${m[1]}`, "1.0")));
    if (m[2]) return json({ id: 7, name: "1.0" });
    return json({ id: Number(m[1]), name: `Spig${m[1]}`, tag: "", downloads: 1, external: false, premium: false, category: { id: 15 }, version: { id: 7 }, testedVersions: SPIGOT[Number(m[1])], updateDate: 1_770_000_000 });
  }
  if (u.host === "cdn.modrinth.com") {
    cdnHits++;
    const [, pid, n] = u.pathname.match(/\/(\w+)\/\w+-([\w.-]+)\.jar$/) ?? [];
    return pid ? new Response(new Uint8Array(jar(pid, n))) : new Response(null, { status: 404 });
  }
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let saved: ReturnType<typeof savedService>;
let sets: ReturnType<typeof setService>;
let owner: Headers;
let viewer: Headers;
let outsider: Headers;
let S: string; // Paper 1.20.4
let S2: string; // Paper 1.21.4
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const plugins = (r = root) => readdirSync(join(r, "plugins")).filter((f) => f.includes(".jar")).sort();
const teamOf = async (h: Headers) => (await t.auth.api.getSession({ headers: h }))!.session.activeOrganizationId!;
const unsupported = async (id: string, projectId: string) => (await lib.versions(owner, id, "modrinth", projectId)).map((v) => [v.versionNumber, v.support]);

const memoMs = LATEST_MEMO.ms;
beforeAll(async () => {
  LATEST_MEMO.ms = 0; // 配布元の版を途中で変えて確かめるので、覚えた結果は使わない(覚えるのは下の 1 つだけ)
  t = await setup({ mode: "self" });
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } };
  lib = libraryService(deps);
  saved = savedService(deps);
  sets = setService(deps);
  const servers = serverService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("閲覧者", "viewer@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  viewer = t.headers(cookie);
  // ほかのチーム(自分用の版はチームが 1 つなので、データベースに直接作って移す)
  const inv2 = await (await t.call("/organization/invite-member", { email: "outsider@example.com", role: "admin" }, owner.get("cookie")!)).json();
  const oc = await t.signUp("部外者", "outsider@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv2.id }, oc);
  outsider = t.headers(oc);
  await t.db.insert(organization).values({ id: "team-other", name: "ほかのチーム", slug: "other", createdAt: new Date() });
  const [u] = await t.db.select().from(user).where(eq(user.email, "outsider@example.com"));
  await t.db.update(member).set({ organizationId: "team-other" }).where(eq(member.userId, u.id));
  await t.db.update(session).set({ activeOrganizationId: "team-other" }).where(eq(session.userId, u.id));
  S = (await servers.addLocal(owner, { rootDir: root, name: "古い" })).id;
  S2 = (await servers.addLocal(owner, { rootDir: root2, name: "新しい" })).id;
});

describe("対応の印", () => {
  it("細かい番号まで書いてある版は一致するものだけ対応。一覧が空・サーバーが決まっていなければ不明", () => {
    expect(supportOf("1.20.4", ["1.20.4", "1.21"])).toBe("ok");
    expect(supportOf("1.20.4", ["1.20", "1.21"])).toBe("no");
    expect(supportOf("1.20.4", [])).toBe("unknown");
    expect(supportOf(null, ["1.21"])).toBe("unknown");
  });
  it("「試した版」のような粗い一覧は 1.20 が 1.20.x を含み、全部より古いサーバーだけ非対応。それ以外の外れは不明", () => {
    expect(supportOf("1.20.4", ["1.19", "1.20"], true)).toBe("ok");
    expect(supportOf("1.20.4", ["1.21"], true)).toBe("no");
    expect(supportOf("1.20.4", ["1.8", "1.12"], true)).toBe("unknown");
  });
});

describe("版を選ばずに入れる(合う最新版)", () => {
  it("1.20.4 のサーバーには、最新版(1.21 専用)でなく 1.20.4 に対応する前の版が入る", async () => {
    const r = await lib.install(owner, S, LP, "modrinth");
    expect(r.versionNumber).toBe("5.3.2");
    expect(plugins()).toEqual([`${LP}-5.3.2.jar`]);
    // 新しいサーバーには最新(ベータでない)の 5.4.1 ではなく、1.21.4 に対応するベータしか無いので、対応するベータが入る
    expect((await lib.install(owner, S2, LP, "modrinth")).versionNumber).toBe("5.5.0-beta");
  });

  it("更新の確かめも、そのサーバーに合う版で見る(最新版があるように見せない)", async () => {
    expect(await lib.updates(owner, S)).toEqual([]);
    versions[LP].push(ver(LP, "lp000533", "5.3.3", ["1.20.4"], "2026-02-15"));
    expect((await lib.updates(owner, S)).map((u) => u.latest)).toEqual(["5.3.3"]);
    expect((await sets.updateServers(owner, [S]))[0].results.map((x) => x.detail)).toEqual(["5.3.2 → 5.3.3"]);
    expect(plugins()).toEqual([`${LP}-5.3.3.jar`]);
  });

  it("手で決めた対応 MC がサーバーのバージョンを含めば、配布元の対応 MC では絞らない", async () => {
    const item = (await lib.catalog(owner)).items.find((i) => i.projectId === LP)!;
    await lib.editItem(owner, item.id, { projectType: "plugin", loaders: null, mcVersions: ["1.20", "1.21"], channel: "" });
    const list = await unsupported(S, LP);
    expect(list.every(([, s]) => s === "ok")).toBe(true);
    await lib.editItem(owner, item.id, { projectType: "plugin", loaders: null, mcVersions: null, channel: "" });
  });

  it("対応する版が配布元にも保存した版にも無ければ、理由(対応する最新の Minecraft)つきで断る", async () => {
    const r = await lib.install(owner, S, NEW, "modrinth").catch((e) => e);
    expect(r).toBeInstanceOf(HttpError);
    expect((r as HttpError).status).toBe(404);
    expect((r as HttpError).message).toContain("(1.20.4)に合う版がありません");
    expect((r as HttpError).message).toContain("対応する最新の Minecraft は 1.21 です");
    expect(plugins()).toEqual([`${LP}-5.3.3.jar`]);
  });

  it("配布元に合う版が無く、ライブラリに保存した版があれば、保存先から入る(配布元につながらなくても)", async () => {
    await lib.addItem(owner, OLD, "modrinth");
    const itemId = (await lib.catalog(owner)).items.find((i) => i.projectId === OLD)!.id;
    await saved.save(owner, itemId, "ol000015"); // 1.20.4 に対応する 1.5 を保存
    versions[OLD].shift(); // 配布元からは消える(2.0 は 1.21 専用)
    const list = await lib.versions(owner, S, "modrinth", OLD);
    expect(list.map((v) => [v.versionNumber, v.support, v.upstream, v.saved, v.suggested])).toEqual([
      ["2.0", "no", true, false, false],
      ["1.5", "unknown", false, true, true], // 保存した版の jar には対応 MC の記載が無いので、対応不明(はっきり対応する版が無いときに使う)
    ]);
    const hits = cdnHits;
    down = true;
    try {
      expect((await lib.install(owner, S, OLD, "modrinth")).versionNumber).toBe("1.5");
    } finally {
      down = false;
    }
    expect(cdnHits).toBe(hits); // 配布元から取っていない
    expect(plugins()).toEqual([`${LP}-5.3.3.jar`, `${OLD}-1.5.jar`].sort());
  });
});

describe("探す(合うものを先に)", () => {
  it("合うもの(対応)を先に、合わないもの(非対応)をあとに並べる。SpigotMC は試した版で、分からなければ対応不明", async () => {
    expect((await lib.search(owner, S, "")).map((h) => [h.title, h.support])).toEqual([["LuckPerms", "ok"], ["NewOnly", "no"]]);
    expect((await lib.search(owner, S, "", "spigot")).map((h) => [h.title, h.support])).toEqual([["Spig1001", "ok"], ["Spig1003", "unknown"], ["Spig1002", "no"]]);
  });
});

describe("版の一覧", () => {
  it("版を全部、新しい順に。対応の印・配布元の版か・保存してあるか・選ばれる版を付ける", async () => {
    const list = await lib.versions(owner, S, "modrinth", LP);
    expect(list.map((v) => [v.versionNumber, v.support, v.type, v.upstream, v.saved, v.suggested])).toEqual([
      ["5.5.0-beta", "no", "beta", true, false, false],
      ["5.4.1", "no", "release", true, false, false],
      ["5.3.3", "ok", "release", true, false, true],
      ["5.3.2", "ok", "release", true, false, false],
      ["5.2.0", "ok", "release", true, false, false],
    ]);
    expect(list.find((v) => v.versionNumber === "5.4.1")!.mcVersions).toEqual(["1.21", "1.21.1"]);
    // サーバーが違えば印も違う(1.21.4 のサーバーでは、ベータだけが対応)
    expect((await lib.versions(owner, S2, "modrinth", LP)).filter((v) => v.support === "ok").map((v) => v.versionNumber)).toEqual(["5.5.0-beta"]);
  });

  it("保存した版は、同じ版なら配布元の版と 1 行にまとめて「保存済み」にする", async () => {
    const itemId = (await lib.catalog(owner)).items.find((i) => i.projectId === LP)!.id;
    await saved.save(owner, itemId, "lp000532");
    const row = (await lib.versions(owner, S, "modrinth", LP)).find((v) => v.versionNumber === "5.3.2")!;
    expect(row).toMatchObject({ upstream: true, saved: true });
    expect((await lib.versions(owner, S, "modrinth", LP)).filter((v) => v.versionNumber === "5.3.2")).toHaveLength(1);
  });

  it("配布元につながらなくても、保存した版だけは出る。何も無ければ理由を返す", async () => {
    down = true;
    try {
      expect((await lib.versions(owner, S, "modrinth", LP)).map((v) => [v.versionNumber, v.upstream, v.saved])).toEqual([["5.3.2", false, true]]);
      expect(await code(lib.versions(owner, S, "modrinth", NEW))).toBe(502);
    } finally {
      down = false;
    }
  });

  it("問い合わせは覚える(同じサーバーの種類・バージョンなら続けて開いても配布元に問い合わせ直さない)。入れたあとは捨てる", async () => {
    LATEST_MEMO.ms = memoMs;
    try {
      forgetLatest(await teamOf(owner));
      await lib.versions(owner, S2, "modrinth", NEW);
      const n = stat.modrinth;
      await lib.versions(owner, S2, "modrinth", NEW);
      expect(stat.modrinth).toBe(n);
      await lib.versions(owner, S, "modrinth", NEW); // サーバーのバージョンが違えば別
      expect(stat.modrinth).toBeGreaterThan(n);
      const m = stat.modrinth;
      await lib.install(owner, S2, NEW, "modrinth", "nw000002", undefined, true); // 入れたあとは捨てる
      await lib.versions(owner, S2, "modrinth", NEW);
      expect(stat.modrinth).toBeGreaterThan(m);
    } finally {
      LATEST_MEMO.ms = 0;
    }
  });
});

describe("選んだ版を入れる", () => {
  it("合う版でない版を選ぶと断り、確かめたうえ(unsupported)なら入れて「更新を止める」にする。選んだ版が合う最新版なら止めない", async () => {
    expect(await code(lib.install(owner, S, LP, "modrinth", "lp000541"))).toBe(400);
    const r = await lib.install(owner, S, LP, "modrinth", "lp000541", undefined, true);
    expect(r).toMatchObject({ versionNumber: "5.4.1", held: true });
    const r2 = await lib.install(owner, S, LP, "modrinth", "lp000533");
    expect(r2).toMatchObject({ versionNumber: "5.3.3", held: false });
    expect(await code(lib.install(owner, S, LP, "modrinth", "nw000002"))).toBe(400); // 一覧に無い版
  });

  it("保存した版を選べば、配布元につながらなくても入る", async () => {
    down = true;
    try {
      expect((await lib.install(owner, S, LP, "modrinth", "lp000532")).versionNumber).toBe("5.3.2");
    } finally {
      down = false;
    }
  });

  it("閲覧者は入れられないが一覧は見られる。ほかのチームのサーバーは見えない", async () => {
    expect(await code(lib.install(viewer, S, LP, "modrinth"))).toBe(403);
    expect(await code(lib.versions(viewer, S, "modrinth", LP))).toBe(200);
    expect(await code(lib.versions(outsider, S, "modrinth", LP))).toBe(404);
    expect(await code(lib.install(outsider, S, LP, "modrinth"))).toBe(404);
  });
});

describe("SpigotMC は対応不明でも選べる", () => {
  it("試した版に含まれれば対応、空なら対応不明で、どちらもそのまま入る。古いサーバーより新しい版だけを試したものは非対応で、確かめたうえでだけ入る", async () => {
    expect((await lib.versions(owner, S, "spigot", "1001")).map((v) => [v.support, v.upstream, v.suggested])).toEqual([["ok", true, true]]);
    expect((await lib.versions(owner, S, "spigot", "1003")).map((v) => [v.support, v.suggested])).toEqual([["unknown", true]]);
    expect((await lib.versions(owner, S, "spigot", "1002")).map((v) => [v.support, v.suggested])).toEqual([["no", false]]);
    expect((await lib.install(owner, S, "1001", "spigot")).filename).toBe("Spig1001-1.0.jar");
    expect((await lib.install(owner, S, "1003", "spigot")).filename).toBe("Spig1003-1.0.jar");
    const e = await lib.install(owner, S, "1002", "spigot").catch((x) => x);
    expect(e).toMatchObject({ status: 404 });
    expect(await code(lib.install(owner, S, "1002", "spigot", "7"))).toBe(400);
    expect((await lib.install(owner, S, "1002", "spigot", "7", undefined, true)).filename).toBe("Spig1002-1.0.jar");
    expect(plugins()).toContain("Spig1002-1.0.jar");
  });
});
