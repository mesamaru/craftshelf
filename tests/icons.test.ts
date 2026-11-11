// 配布元に紐づけたアドオンのアイコン: 紐づけたら iconUrl が入る・空のものは取り直しで補う・取り直しは上限を守る(Modrinth・Spiget は偽物の応答で代わりをする)
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { libraryItem, organization } from "~/server/db/schema";
import { libraryService, modTools } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { spigetClient } from "~/server/spiget";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const known = makeZip({ "plugin.yml": "name: Known\nversion: 1.0\nmain: a.B\n" }, false);
const disk = new Map<string, Uint8Array>([["plugins/Known-1.0.jar", known]]);
const sha1 = (d: Uint8Array) => createHash("sha1").update(d).digest("hex");
const ICON = (id: string) => `https://cdn.modrinth.com/data/${id}/icon.png`;
const pid = (n: number) => `P${String(n).padStart(7, "0")}`; // Modrinth の ID は 8 文字
const noIcon = new Set<string>(); // アイコンの無いプロジェクト
const asked: string[] = []; // Modrinth の「まとめて取る」への問い合わせ(ids)

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (u.pathname === "/v2/version_files") {
      const { hashes } = JSON.parse(String(init!.body));
      return json(Object.fromEntries((hashes as string[]).filter((h) => h === sha1(known)).map((h) => [h, { id: "VERSION1", project_id: "KNOWNPRJ", version_number: "1.0" }])));
    }
    if (u.pathname === "/v2/project/KNOWNPRJ") return json({ id: "KNOWNPRJ", title: "Known", slug: "known", project_type: "plugin", icon_url: ICON("KNOWNPRJ") });
    if (u.pathname === "/v2/projects") {
      const ids: string[] = JSON.parse(u.searchParams.get("ids")!);
      asked.push(...ids);
      return json(ids.map((id) => ({ id, title: id, slug: id, game_versions: [], icon_url: noIcon.has(id) ? null : ICON(id) })));
    }
    return json({}, 404);
  }
  if (u.host === "api.spiget.org") {
    if (u.pathname === "/v2/resources/9089") return json({ id: 9089, name: "EssentialsX", tag: "", downloads: 1, external: false, premium: false, category: { id: 15 }, testedVersions: [] });
    if (u.pathname.startsWith("/v2/search/resources/")) return json([{ id: 9089, name: "EssentialsX", tag: "", downloads: 1, external: false, premium: false, category: { id: 15 } }]);
    return json({}, 404);
  }
  if (u.host === "wings.example.test") return new Response(new Uint8Array(disk.get(u.searchParams.get("file")!)!));
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname.endsWith("/files/list")) {
    const dir = (u.searchParams.get("directory") ?? "/").replace(/^\/+|\/+$/g, "");
    return json({ data: [...disk].filter(([p]) => p.startsWith(dir + "/")).map(([p, d]) => ({ attributes: { name: p.slice(dir.length + 1), size: d.byteLength, is_file: true } })) });
  }
  if (u.pathname.endsWith("/files/download")) {
    return json({ attributes: { url: `https://wings.example.test/download/file?file=${encodeURIComponent(u.searchParams.get("file")!.replace(/^\/+/, ""))}` } });
  }
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let owner: Headers;
let teamId: string;
let serverId: string;
const itemBy = async (projectId: string) => (await t.db.select().from(libraryItem).where(eq(libraryItem.projectId, projectId)))[0];

beforeAll(async () => {
  t = await setup({ mode: "self" });
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir: mkdtempSync(join(tmpdir(), "cs-icon-")) } };
  lib = libraryService(deps);
  const servers = serverService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  serverId = (await servers.listServers(owner))[0].id;
  await lib.setProfile(owner, serverId, { platform: "paper", mcVersion: "" });
  teamId = (await t.db.select({ id: organization.id }).from(organization))[0].id;
});

describe("SpigotMC のアイコン", () => {
  it("探した結果・プロジェクトの情報に、Spiget のアイコンの URL が入る", async () => {
    const sp = spigetClient(fake);
    expect((await sp.searchAll("essentials"))[0].iconUrl).toBe("https://api.spiget.org/v2/resources/9089/icon");
    expect((await sp.project("9089"))?.iconUrl).toBe("https://api.spiget.org/v2/resources/9089/icon");
  });
});

describe("紐づけたときに保存する", () => {
  it("手で置いた jar を紐づけると、ライブラリにアイコンが入り、サーバーのアドオンの行にもアイコンが付く", async () => {
    await lib.identify(owner, serverId);
    expect((await itemBy("KNOWNPRJ")).iconUrl).toBe(ICON("KNOWNPRJ"));
    expect((await lib.installed(owner, serverId)).items.find((i) => i.filename === "Known-1.0.jar")).toMatchObject({ projectId: "KNOWNPRJ", iconUrl: ICON("KNOWNPRJ") });
  });

  it("配布元の問い合わせで名前だけ取れて(アイコンが空)も、すでにあるアイコンを消さない", async () => {
    const { remember } = modTools({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake });
    await remember(teamId, null, "modrinth", "KNOWNPRJ", { title: "Known", slug: "known", iconUrl: "", projectType: "plugin" });
    expect((await itemBy("KNOWNPRJ")).iconUrl).toBe(ICON("KNOWNPRJ"));
    await remember(teamId, null, "modrinth", "KNOWNPRJ", { title: "Known", slug: "known", iconUrl: "https://cdn.modrinth.com/new.png", projectType: "plugin" });
    expect((await itemBy("KNOWNPRJ")).iconUrl).toBe("https://cdn.modrinth.com/new.png"); // 新しいアイコンには変わる
  });
});

describe("空のアイコンを補う", () => {
  it("取り直し(1 分ごと)で、アイコンの空の紐づけ済みのものを補う。1 回の問い合わせは 50 件まで。アップロードしたもの・アイコンの無いものは空のまま、あるものは消さない", async () => {
    const rows = Array.from({ length: 60 }, (_, n) => ({ id: `item-${n}`, teamId, source: "modrinth", projectId: pid(n), title: `P${n}`, projectType: "plugin", iconUrl: "" }));
    await t.db.insert(libraryItem).values([
      ...rows,
      { id: "up-1", teamId, source: "upload", projectId: "up-1", title: "手で足した", projectType: "plugin", iconUrl: "" },
      { id: "have-1", teamId, source: "modrinth", projectId: "HAVEICON", title: "Have", projectType: "plugin", iconUrl: "https://cdn.modrinth.com/old.png" },
    ]);
    noIcon.add(pid(0)).add("HAVEICON");
    asked.length = 0;
    const now = new Date();
    await lib.refreshInfo(now);
    const first = asked.filter((id) => id.startsWith("P0"));
    expect(asked.length).toBeLessThanOrEqual(50);
    expect((await itemBy(pid(10))).iconUrl).toBe(ICON(pid(10))); // 補えた
    expect((await itemBy(pid(0))).iconUrl).toBe(""); // 配布元にアイコンが無い
    expect((await itemBy("up-1")).iconUrl).toBe("");
    // 残りは次の回に(同じものを続けて問い合わせない)
    const done = new Set(first);
    asked.length = 0;
    await lib.refreshInfo(new Date(now.getTime() + 60_000));
    for (const id of asked) expect(done.has(id)).toBe(false);
    for (let n = 1; n < 60; n++) expect((await itemBy(pid(n))).iconUrl).toBe(ICON(pid(n)));
    expect((await itemBy("HAVEICON")).iconUrl).toBe("https://cdn.modrinth.com/old.png"); // 配布元の応答が空でも、持っているアイコンは消さない
  });

  it("SpigotMC のものも取り直しで補う", async () => {
    await t.db.insert(libraryItem).values({ id: "sp-1", teamId, source: "spigot", projectId: "9089", title: "EssentialsX", projectType: "plugin", iconUrl: "" });
    await lib.refreshInfo(new Date(Date.now() + 120_000));
    expect((await itemBy("9089")).iconUrl).toBe("https://api.spiget.org/v2/resources/9089/icon");
  });

  it("前から紐づけてあってアイコンの空のものは、移行で取り直しの順番待ちに戻す(アップロードしたものは戻さない)", async () => {
    const file = iconMigration();
    await t.db.update(libraryItem).set({ iconUrl: "", infoAt: new Date() }).where(eq(libraryItem.id, "item-5"));
    await t.db.update(libraryItem).set({ infoAt: new Date() }).where(eq(libraryItem.id, "up-1"));
    for (const stmt of readFileSync(file, "utf8").split("--> statement-breakpoint")) await t.db.execute(sql.raw(stmt));
    expect((await itemBy(pid(5))).infoAt).toBeNull();
    expect((await itemBy("up-1")).infoAt).not.toBeNull();
  });
});

function iconMigration() {
  const dir = join(__dirname, "..", "drizzle");
  const name = readdirSync(dir).find((f) => f.endsWith("_icon_refill.sql"));
  return join(dir, name!);
}
