// 配布元のファイルを保存先に持つ: 保存・保存先から入れる(配布元が消えても)・古い版の整理・zip・共有リンク・
// 保存先の状況と中身・inbox からの取り込み・アドオンの整理。本物のフォルダ(パネルの中・フォルダのサーバー)と偽の Modrinth で確かめる
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { libraryFile, libraryItem, member, organization, session, user } from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import { readZipTexts } from "~/server/jar";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { savedService } from "~/server/saved";
import { serverService } from "~/server/servers";
import { UPDATE_CHECK_EVERY, setService } from "~/server/sets";
import { shareService } from "~/server/shares";
import { webdavStore } from "~/server/storage";
import { uploadService } from "~/server/uploads";
import { zipStream } from "~/server/zip";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const PID = "AAAAaaaa";
const PID2 = "BBBBbbbb";
const dataDir = mkdtempSync(join(tmpdir(), "cs-sv-data-"));
const root = mkdtempSync(join(tmpdir(), "cs-sv-srv-"));
writeFileSync(join(root, "paper-1.21.4-123.jar"), "");
mkdirSync(join(root, "plugins"));

const jar = (name: string, v: string) => makeZip({ "plugin.yml": `name: ${name}\nversion: ${v}\nmain: a.B\n` }, false);
const JARS: Record<string, Uint8Array> = { "Alpha-1.0.jar": jar("Alpha", "1.0"), "Alpha-2.0.jar": jar("Alpha", "2.0"), "Beta-1.0.jar": jar("Beta", "1.0") };
const ver = (pid: string, id: string, n: string, file: string, date: string) => ({ id, project_id: pid, version_number: n, version_type: "release", date_published: date, loaders: ["paper"],
  game_versions: ["1.21.4"], files: [{ primary: true, filename: file, url: `https://cdn.modrinth.com/data/${pid}/${file}`, size: 1, hashes: {} }] });
const versions: Record<string, ReturnType<typeof ver>[]> = {
  // 同じ日の Velocity 向けの版もある(保存するときは Paper 向けを選ぶ)
  [PID]: [{ ...ver(PID, "ver0000v", "1.0-velocity", "Alpha-1.0-velocity.jar", "2026-01-01T01:00:00Z"), loaders: ["velocity"] }, ver(PID, "ver00001", "1.0", "Alpha-1.0.jar", "2026-01-01")],
  [PID2]: [ver(PID2, "ver00003", "1.0", "Beta-1.0.jar", "2026-01-01")],
};
let down = false; // 配布元につながらない
let cdnHits = 0;
const sha1 = (d: Uint8Array) => createHash("sha1").update(d).digest("hex");

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (down) return json({}, 503);
    if (u.pathname === "/v2/version_files") {
      const { hashes } = JSON.parse(String(init?.body)) as { hashes: string[] };
      return json(Object.fromEntries(hashes.filter((h) => h === sha1(JARS["Beta-1.0.jar"])).map((h) => [h, versions[PID2][0]])));
    }
    if (u.pathname.startsWith("/v2/projects")) return json([{ id: PID, title: "Alpha", slug: "alpha", updated: "2020-01-01T00:00:00Z" }, { id: PID2, title: "Beta", slug: "beta", updated: "2026-11-01T00:00:00Z" }]);
    const m = u.pathname.match(/^\/v2\/project\/(\w+)(\/version)?$/);
    if (m && versions[m[1]]) return m[2] ? json(versions[m[1]]) : json({ id: m[1], title: m[1] === PID ? "Alpha" : "Beta", slug: m[1] === PID ? "alpha" : "beta", project_type: "plugin" });
    const v = u.pathname.match(/^\/v2\/version\/(\w+)$/);
    if (v) return json(Object.values(versions).flat().find((x) => x.id === v[1]) ?? null, Object.values(versions).flat().some((x) => x.id === v[1]) ? 200 : 404);
    return json({}, 404);
  }
  if (u.host === "cdn.modrinth.com") {
    cdnHits++;
    const f = JARS[u.pathname.split("/").pop()!];
    return f ? new Response(new Uint8Array(f)) : new Response(null, { status: 404 });
  }
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let saved: ReturnType<typeof savedService>;
let lib: ReturnType<typeof libraryService>;
let up: ReturnType<typeof uploadService>;
let shares: ReturnType<typeof shareService>;
let sets: ReturnType<typeof setService>;
let owner: Headers;
let editor: Headers;
let viewer: Headers;
let other: Headers;
let sid: string;
let alpha: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const plugins = () => readdirSync(join(root, "plugins")).filter((f) => f.endsWith(".jar")).sort();

beforeAll(async () => {
  t = await setup({ mode: "self" });
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } };
  saved = savedService(deps);
  lib = libraryService(deps);
  up = uploadService(deps);
  shares = shareService(deps);
  sets = setService(deps);
  const servers = serverService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  for (const [role, email] of [["editor", "editor@example.com"], ["viewer", "viewer@example.com"], ["admin", "other@example.com"]] as const) {
    const inv = await (await t.call("/organization/invite-member", { email, role }, owner.get("cookie")!)).json();
    const cookie = await t.signUp(role, email);
    await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
    await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
    if (role === "editor") editor = t.headers(cookie);
    else if (role === "viewer") viewer = t.headers(cookie);
    else {
      // 自分用の版はチームが 1 つなので、ほかのチームはデータベースに直接作って移す
      other = t.headers(cookie);
      await t.db.insert(organization).values({ id: "team-other", name: "ほかのチーム", slug: "other", createdAt: new Date() });
      const [u] = await t.db.select().from(user).where(eq(user.email, email));
      await t.db.update(member).set({ organizationId: "team-other" }).where(eq(member.userId, u.id));
      await t.db.update(session).set({ activeOrganizationId: "team-other" }).where(eq(session.userId, u.id));
    }
  }
  sid = (await servers.addLocal(owner, { rootDir: root, name: "家" })).id;
  alpha = (await lib.addItem(owner, PID, "modrinth")).id;
});

describe("配布元の版を保存する", () => {
  it("保存するのは編集者以上。ほかのチームのアイテムは見えない", async () => {
    expect(await code(saved.save(viewer, alpha))).toBe(403);
    expect(await code(saved.save(other, alpha))).toBe(404);
  });

  it("いちばん新しい版を取ってきて保存先に置く。版の一覧に「保存した版」として出て、ダウンロードできる", async () => {
    const r = await saved.save(editor, alpha);
    expect(r).toMatchObject({ filename: "Alpha-1.0.jar", version: "1.0" });
    const files = await up.files(viewer, alpha);
    expect(files.map((f) => [f.filename, f.saved, f.loaders])).toMatchObject([["Alpha-1.0.jar", true, expect.arrayContaining(["paper"])]]);
    const d = await up.download(viewer, r.fileId);
    expect(Buffer.concat(await d.stream.toArray()).equals(Buffer.from(JARS["Alpha-1.0.jar"]))).toBe(true);
    expect((await saved.save(editor, alpha)).fileId).toBe(r.fileId); // 同じ版は 2 度取ってこない
    expect((await lib.catalog(owner)).items.find((i) => i.id === alpha)?.files).toBe(1);
  });

  it("保存した版があれば、サーバーへは配布元から取らずに保存先から送る。配布元につながらなくても入れられる", async () => {
    const before = cdnHits;
    await lib.install(owner, sid, PID, "modrinth");
    expect(plugins()).toEqual(["Alpha-1.0.jar"]);
    expect(cdnHits).toBe(before);
    await lib.remove(owner, sid, "Alpha-1.0.jar");
    down = true;
    try {
      await lib.install(owner, sid, PID, "modrinth");
    } finally {
      down = false;
    }
    expect(plugins()).toEqual(["Alpha-1.0.jar"]);
  });

  it("チームの既定を決めるのは保存先を扱える人(管理者以上)。「保存する」なら、入れたときに保存する", async () => {
    expect(await code(saved.setOptions(editor, { keepFiles: true, keepVersions: 0 }))).toBe(403);
    expect(await code(saved.setOptions(owner, { keepFiles: true, keepVersions: 101 }))).toBe(400);
    await saved.setOptions(owner, { keepFiles: true, keepVersions: 0 });
    expect(await saved.options(viewer)).toMatchObject({ local: true, keepFiles: true, keepVersions: 0 });
    await lib.install(editor, sid, PID2, "modrinth");
    const beta = (await lib.catalog(owner)).items.find((i) => i.projectId === PID2)!;
    expect(beta.files).toBe(1);
    // アイテムごとに「保存しない」にもできる
    expect(await code(saved.setItem(viewer, beta.id, { keepFiles: "off", keepVersions: null }))).toBe(403);
    await saved.setItem(editor, beta.id, { keepFiles: "off", keepVersions: null });
    expect((await lib.catalog(owner)).items.find((i) => i.id === beta.id)).toMatchObject({ keepFiles: "off", keepVersions: null });
  });

  it("古い版の自動整理: 新しい方から N 個残す。サーバーで使っている版・セットで固定した版は消さない", async () => {
    versions[PID].unshift(ver(PID, "ver00002", "2.0", "Alpha-2.0.jar", "2026-02-01"));
    await saved.save(editor, alpha); // 2.0
    expect((await up.files(owner, alpha)).map((f) => f.version)).toEqual(["2.0", "1.0"]);
    // 1.0 はサーバーに入っているので、1 個残すにしても消さない
    expect((await saved.setItem(editor, alpha, { keepFiles: "", keepVersions: 1 })).removed).toEqual([]);
    await lib.install(owner, sid, PID, "modrinth"); // 2.0 に更新(保存先から)
    expect(plugins()).toEqual(["Alpha-2.0.jar", "Beta-1.0.jar"]);
    const set = await sets.create(owner, "固定");
    await sets.toggleItem(owner, set.id, alpha, true);
    await sets.pin(owner, set.id, alpha, "ver00001");
    expect((await saved.setItem(editor, alpha, { keepFiles: "", keepVersions: 1 })).removed).toEqual([]);
    await sets.pin(owner, set.id, alpha, null);
    expect((await saved.setItem(editor, alpha, { keepFiles: "", keepVersions: 1 })).removed).toEqual(["1.0"]);
    expect((await up.files(owner, alpha)).map((f) => f.version)).toEqual(["2.0"]);
    await saved.setItem(editor, alpha, { keepFiles: "", keepVersions: null });
  });
});

describe("まとめて zip・共有リンク", () => {
  it("選んだものを保存した版から zip にする(種類ごとのフォルダ)。保存していないものは入れずに知らせる", async () => {
    const gamma = (await lib.addFromUrl(owner, "https://modrinth.com/plugin/AAAAaaab").catch(() => null)); // 配布元に無いものは足せない
    expect(gamma).toBeNull();
    const [none] = await t.db.insert(libraryItem).values({ id: "item-none", teamId: (await t.db.select().from(libraryItem).where(eq(libraryItem.id, alpha)))[0].teamId,
      source: "modrinth", projectId: "CCCCcccc", title: "Gamma", projectType: "plugin" }).returning();
    const ids = (await lib.catalog(owner)).items.map((i) => i.id);
    const plan = await saved.zipPlan(viewer, { itemIds: ids });
    expect(plan).toMatchObject({ count: 2, missing: ["Gamma"], tooBig: false });
    const z = await saved.zip(viewer, { itemIds: ids });
    const data = Buffer.concat(await z.stream.toArray());
    const names = [...(readZipTexts(data, (n) => n.endsWith(".jar"))?.keys() ?? [])].sort();
    expect(names).toEqual(["plugins/Alpha-2.0.jar", "plugins/Beta-1.0.jar"]);
    expect(await code(saved.zip(other, { itemIds: ids }))).toBe(400); // ほかのチームのものは入れない
    await t.db.delete(libraryItem).where(eq(libraryItem.id, none.id));
  });

  it("セットの zip は、固定した版を使う", async () => {
    await saved.save(editor, alpha, "ver00001"); // 1.0 をもう一度保存
    const set = (await sets.list(owner)).find((s) => s.name === "固定")!;
    await sets.pin(owner, set.id, alpha, "ver00001");
    const z = await saved.zip(owner, { setId: set.id });
    const data = Buffer.concat(await z.stream.toArray());
    expect([...(readZipTexts(data, (n) => n.endsWith(".jar"))?.keys() ?? [])]).toEqual(["plugins/Alpha-1.0.jar"]);
    expect(z.filename).toBe("craftshelf.zip");
    expect(await code(saved.zip(other, { setId: set.id }))).toBe(404);
  });

  it("保存した版も共有リンクにできる", async () => {
    const r = await shares.create(editor, { itemIds: [alpha], hours: 1, name: "" }, "https://panel.example.test");
    expect(r.filename).toMatch(/^Alpha-\d\.0\.jar$/);
    const f = await shares.download(r.url.split("/s/")[1].split("/")[0]);
    expect(Buffer.concat(await f!.stream.toArray()).length).toBeGreaterThan(0);
  });

  it("zip は少しずつ作り、中身が元と同じになる", async () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);
    const parts = [{ name: "a.txt", data: new TextEncoder().encode("hello") }, { name: "a.txt", data: big }];
    const z = Buffer.concat(await zipStream(parts.map((p) => ({ name: p.name, open: async () => [p.data] }))).toArray());
    const got = readZipTexts(z, () => true)!;
    expect(got.get("a.txt")).toBe("hello");
    expect(got.has("a-2.txt")).toBe(true);
  });
});

describe("保存先の状況・中身・取り込み", () => {
  it("見るのは保存先を扱える人だけ。つながる・容量・使っている数を返す", async () => {
    expect(await code(saved.status(editor, null))).toBe(403);
    const s = await saved.status(owner, null);
    expect(s).toMatchObject({ connected: true, error: "" });
    expect(s.files).toBeGreaterThanOrEqual(3);
    expect(s.space === null || s.space.total > 0).toBe(true);
    expect(await code(saved.status(owner, "nope"))).toBe(404);
  });

  it("中身の一覧に、登録しているものはアイテムの名前が付く", async () => {
    const c = await saved.contents(owner, null);
    const alphaFiles = c.entries.filter((e) => !e.dir && e.item === "Alpha");
    expect(alphaFiles.length).toBe(2);
    expect(alphaFiles.every((e) => e.saved && e.path.startsWith("plugin/"))).toBe(true);
  });

  it("inbox/ の jar を取り込む: 配布元が見つかれば保存した版に、見つからなければアップロードしたものに。読めないものは残す", async () => {
    const lib0 = join(dataDir, "v03", "library");
    await saved.status(owner, null);
    // Beta の 1.0 は保存していないことにする(保存しないにしたので、消してから)
    const beta = (await lib.catalog(owner)).items.find((i) => i.projectId === PID2)!;
    for (const f of await up.files(owner, beta.id)) await up.removeFile(owner, f.id);
    expect(await code(saved.scan(editor, null))).toBe(403);
    mkdirSync(join(lib0, "inbox", "sub"), { recursive: true });
    writeFileSync(join(lib0, "inbox", "Beta-1.0.jar"), JARS["Beta-1.0.jar"]);
    writeFileSync(join(lib0, "inbox", "sub", "Mine.jar"), jar("MinePlugin", "0.1"));
    writeFileSync(join(lib0, "inbox", "broken.jar"), "not a zip");
    const r = await saved.scan(owner, null);
    expect(r.checked).toBe(3);
    expect(r.added.map((a) => [a.name, a.title, a.source]).sort()).toEqual([["Beta-1.0.jar", "Beta", "modrinth"], ["Mine.jar", "MinePlugin", "upload"]]);
    expect(r.failed.map((f) => f.name)).toEqual(["inbox/broken.jar"]);
    expect(existsSync(join(lib0, "inbox", "Beta-1.0.jar"))).toBe(false);
    expect(existsSync(join(lib0, "inbox", "broken.jar"))).toBe(true);
    const files = await up.files(owner, beta.id);
    expect(files.map((f) => [f.filename, f.saved])).toEqual([["Beta-1.0.jar", true]]);
    const [row] = await t.db.select().from(libraryFile).where(eq(libraryFile.id, files[0].id));
    expect(row.upstreamVersionId).toBe("ver00003");
  });
});

describe("アドオンの整理", () => {
  it("編集者以上。古い版・同じ版の重複・長く更新の無いもの・どのサーバーにも入っていないものを抜き出す", async () => {
    expect(await code(saved.cleanup(viewer, "old", 1))).toBe(403);
    // Alpha: 1.0(あとから保存し直した・固定)と 2.0(サーバーで使っている)。どちらも消さない
    expect(await saved.cleanup(editor, "old", 1)).toEqual([]);
    // サーバーから外し、固定をやめると、先に足した 2.0 が古い版
    await lib.remove(owner, sid, "Alpha-2.0.jar");
    const set = (await sets.list(owner)).find((s) => s.name === "固定")!;
    await sets.pin(owner, set.id, alpha, null);
    expect((await saved.cleanup(editor, "old", 1)).map((r) => [r.title, r.version])).toEqual([["Alpha", "2.0"]]);
    expect(await saved.cleanup(editor, "dup", 1)).toEqual([]);
    expect((await saved.cleanup(editor, "stale", 12)).map((r) => r.title)).toEqual(["Alpha"]); // 配布元の最後の更新が 2020 年
    const unused = await saved.cleanup(editor, "unused", 1);
    expect(unused.map((r) => [r.title, r.checked])).toEqual([["Alpha", false], ["MinePlugin", true]]); // セットに入っているものは、最初は選ばない
    const old = (await saved.cleanup(editor, "old", 1))[0];
    const r = await saved.cleanupRemove(editor, { fileIds: [old.fileId!], itemIds: [unused[1].itemId] });
    expect(r).toEqual({ files: 1, items: 1, failed: [] });
    expect((await up.files(owner, alpha)).map((f) => f.version)).toEqual(["1.0"]);
    expect((await lib.catalog(owner)).items.some((i) => i.title === "MinePlugin")).toBe(false);
    // ほかのチームのものは消せない
    expect((await saved.cleanupRemove(other, { fileIds: [], itemIds: [alpha] })).failed.length).toBe(1);
  });
});

describe("WebDAV の中身と空き", () => {
  it("PROPFIND の答えから、ファイルとフォルダ・大きさを読む。quota があれば容量と空き", async () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/lib/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/dav/lib/inbox/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/dav/lib/A%20b.jar</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1234</d:getcontentlength></d:prop></d:propstat></d:response>
    </d:multistatus>`;
    const dav: FetchLike = async (url, init) => {
      if ((init?.headers as Record<string, string>).Depth === "0") return new Response("<d:quota-available-bytes>100</d:quota-available-bytes><d:quota-used-bytes>50</d:quota-used-bytes>", { status: 207 });
      return new Response(new URL(url).pathname === "/dav/lib/" ? xml : "", { status: 207 });
    };
    const s = webdavStore("https://dav.example.test/dav/lib", "", "", dav);
    expect(await s.ls("")).toEqual([{ name: "inbox", dir: true, size: 0 }, { name: "A b.jar", dir: false, size: 1234 }]);
    expect(await s.space()).toEqual({ total: 150, free: 100 });
  });
});

describe("保存を有効にしたアイテムの見回り", () => {
  it("保存を有効にしたものは、1 日 1 回いちばん新しい版を取ってくる(「保存しない」のものは取ってこない)", async () => {
    const now = new Date("2030-01-01T00:00:00Z");
    versions[PID].unshift(ver(PID, "ver00009", "3.0", "Alpha-3.0.jar", "2026-03-01"));
    JARS["Alpha-3.0.jar"] = jar("Alpha", "3.0");
    versions[PID2].unshift(ver(PID2, "ver00004", "2.0", "Beta-2.0.jar", "2026-02-01"));
    JARS["Beta-2.0.jar"] = jar("Beta", "2.0");
    // Alpha はチームの既定(保存する)のまま、Beta は「保存しない」にしてある
    expect(await saved.tick(now)).toEqual([alpha]);
    expect((await up.files(owner, alpha))[0].version).toBe("3.0");
    const beta = (await lib.catalog(owner)).items.find((i) => i.projectId === PID2)!;
    expect((await up.files(owner, beta.id)).map((f) => f.version)).not.toContain("2.0");
    // 1 日たつまでは確かめない。たっても、保存してあれば取ってこない
    const hits = cdnHits;
    expect(await saved.tick(new Date(now.getTime() + 60_000))).toEqual([]);
    expect(await saved.tick(new Date(now.getTime() + UPDATE_CHECK_EVERY + 60_000))).toEqual([]);
    expect(cdnHits).toBe(hits);
    // アイテムで「保存する」にすれば、チームの既定が「保存しない」でも取ってくる
    await saved.setOptions(owner, { keepFiles: false, keepVersions: 0 });
    await saved.setItem(editor, beta.id, { keepFiles: "on", keepVersions: null });
    expect(await saved.tick(new Date(now.getTime() + 2 * UPDATE_CHECK_EVERY + 120_000))).toEqual([beta.id]);
    expect((await up.files(owner, beta.id))[0].version).toBe("2.0");
    await saved.setItem(editor, beta.id, { keepFiles: "off", keepVersions: null });
    await saved.setOptions(owner, { keepFiles: true, keepVersions: 0 });
  });
});
