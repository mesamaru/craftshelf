// ライブラリのファイルの出どころ(library_file.origin): アップロード・サーバーから取り込み・配布元・v02 を取り込みの経路ごとに入れ、画面に区別して出す
// (Pterodactyl・Wings は偽物の応答で代わりをする。v02 の取り込みは tests/import.test.ts、inbox は tests/saved.test.ts でも確かめる)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog, libraryFile, libraryItem, server } from "~/server/db/schema";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { fileStore, uploadService } from "~/server/uploads";
import { ORIGIN_LABEL, originLabel } from "~/lib/origin";
import { sourceLabel } from "~/lib/sources";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const mine = makeZip({ "plugin.yml": "name: Mine\nversion: 1.0\nmain: a.B\n" }, false);
const mystery = makeZip({ "plugin.yml": "name: Mystery\nversion: 2.0\nmain: c.D\n" }, false);
const saved = makeZip({ "plugin.yml": "name: Saved\nversion: 3.0\nmain: e.F\n" }, false);
const disk = new Map<string, Uint8Array>([["plugins/Mystery-2.0.jar", mystery]]);

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") return json({}, 404);
  if (u.host === "wings.example.test") return new Response(new Uint8Array(disk.get(u.searchParams.get("file")!)!));
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname.endsWith("/files/list")) {
    const dir = (u.searchParams.get("directory") ?? "/").replace(/^\/+|\/+$/g, "");
    return json({ data: [...disk].filter(([p]) => p.startsWith(dir + "/")).map(([p, d]) => ({ attributes: { name: p.slice(dir.length + 1), size: d.byteLength, is_file: true } })) });
  }
  if (u.pathname.endsWith("/files/download")) return json({ attributes: { url: `https://wings.example.test/download/file?file=${encodeURIComponent(u.searchParams.get("file")!.replace(/^\/+/, ""))}` } });
  void init;
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let up: ReturnType<typeof uploadService>;
let sets: ReturnType<typeof setService>;
let deps: Parameters<typeof fileStore>[0];
let owner: Headers;
let id: string;
let teamId: string;
const originOf = async (title: string) => (await t.db.select({ o: libraryFile.origin, up: libraryFile.upstreamVersionId }).from(libraryFile)
  .innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id)).where(eq(libraryItem.title, title))).map((r) => r.o);
const itemOf = async (title: string) => (await lib.catalog(owner)).items.find((i) => i.title === title)!;

beforeAll(async () => {
  t = await setup({ mode: "self" });
  deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir: mkdtempSync(join(tmpdir(), "cs-origin-")) } };
  lib = libraryService(deps);
  up = uploadService(deps);
  sets = setService(deps);
  const servers = serverService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  id = (await servers.listServers(owner))[0].id;
  teamId = (await t.db.select().from(server))[0].teamId;
  await lib.setProfile(owner, id, { platform: "paper", mcVersion: "" });
});

describe("出どころは、取り込みの経路ごとに入る", () => {
  it("画面・API のアップロードは upload、サーバーから取り込んだものは server(操作の記録は「サーバーから取り込み」とサーバーの名前)", async () => {
    await up.ingest(owner, "Mine-1.0.jar", mine);
    await up.fromServer(owner, id, "Mystery-2.0.jar");
    expect(await originOf("Mine")).toEqual(["upload"]);
    expect(await originOf("Mystery")).toEqual(["server"]);
    const log = await t.db.select().from(auditLog);
    expect(log.find((r) => r.action === "アップロード")).toMatchObject({ target: "Mine" });
    expect(log.find((r) => r.target === "Mystery")).toMatchObject({ action: "サーバーから取り込み", detail: expect.stringContaining("ロビー") });
    expect(log.filter((r) => r.target === "Mystery" && r.action === "アップロード")).toHaveLength(0);
  });

  it("配布元の版を保存したものは upstream", async () => {
    const [item] = await t.db.insert(libraryItem).values({ id: "it-up", teamId, source: "modrinth", projectId: "SAVEDPRJ", title: "Saved", projectType: "plugin" }).returning();
    const tmp = join(deps.local!.dataDir, "saved.jar");
    writeFileSync(tmp, saved);
    await fileStore(deps).keepSaved(teamId, null, item, tmp, { versionId: "V3", versionNumber: "3.0", filename: "Saved-3.0.jar" });
    expect(await originOf("Saved")).toEqual(["upstream"]);
  });
});

describe("画面に出す出どころ", () => {
  it("ライブラリの一覧・版の一覧・セットの中身・版の選び(アップロードしたものの版)に、出どころが付く", async () => {
    expect(await itemOf("Mystery")).toMatchObject({ source: "upload", origin: "server" });
    expect(await itemOf("Mine")).toMatchObject({ origin: "upload" });
    expect(await itemOf("Saved")).toMatchObject({ origin: "upstream" });
    const mystery = await itemOf("Mystery");
    expect((await up.files(owner, mystery.id)).map((f) => f.origin)).toEqual(["server"]);
    const set = await sets.create(owner, "基本");
    await sets.toggleItem(owner, set.id, mystery.id, true);
    expect((await sets.list(owner))[0].items[0]).toMatchObject({ title: "Mystery", origin: "server" });
    const rows = await lib.versions(owner, id, "upload", mystery.projectId);
    expect(rows.map((r) => r.origin)).toEqual(["server"]);
  });

  it("古い行(出どころが空)は、今までどおりに表示する。表示の言葉は共通の関数 1 つ", async () => {
    await t.db.update(libraryFile).set({ origin: "" }).where(eq(libraryFile.sha256, (await t.db.select().from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id)).where(eq(libraryItem.title, "Mine")))[0].library_file.sha256));
    expect(await itemOf("Mine")).toMatchObject({ origin: "" });
    expect(originLabel("", false)).toBe("アップロード"); // 今までの表示
    expect(originLabel("", true)).toBe("配布元"); // 配布元の版を保存したもの
    expect(originLabel(null)).toBe("アップロード");
    expect(originLabel("server")).toBe("サーバーから取り込み");
    expect(originLabel("upload")).toBe("アップロード");
    expect(originLabel("upstream")).toBe("配布元");
    expect(originLabel("v02")).toBe("v02 から");
    expect(Object.keys(ORIGIN_LABEL).sort()).toEqual(["server", "upload", "upstream", "v02"]);
    // 配布元の名前を出すところ(アップロードのもの)は、出どころで言い分ける。空なら今までどおり「アップロード」
    expect(sourceLabel("upload", "server")).toBe("サーバーから取り込み");
    expect(sourceLabel("upload", "v02")).toBe("v02 から");
    expect(sourceLabel("upload", "")).toBe("アップロード");
    expect(sourceLabel("modrinth", "server")).toBe("Modrinth");
  });
});
