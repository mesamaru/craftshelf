// 手でサーバーに置いた jar: 中の plugin.yml などから名前・版・前提(depend)を読む(読むのは 1 回。Pterodactyl・Wings は偽物の応答)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { jarMeta } from "~/server/jar";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const yml = (s: string) => makeZip({ "plugin.yml": s }, false);
const disk = new Map<string, Uint8Array>([
  ["plugins/shop-final-v2.jar", yml("name: ShopPlugin\nversion: 2.1.0\nmain: a.B\ndepend: [Vault, Essentials]\nsoftdepend: [PlaceholderAPI]\n")],
  ["plugins/Essentials.jar", yml("name: Essentials\nversion: 2.20\nmain: c.D\n")],
]);
const reads: string[] = [];

const fake: FetchLike = async (url) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "wings.example.test") { reads.push(u.searchParams.get("file")!); return new Response(new Uint8Array(disk.get(u.searchParams.get("file")!)!)); }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname.endsWith("/files/list")) {
    const dir = (u.searchParams.get("directory") ?? "/").replace(/^\/+|\/+$/g, "");
    return json({ data: [...disk].filter(([p]) => p.startsWith(dir + "/")).map(([p, d]) => ({ attributes: { name: p.slice(dir.length + 1), size: d.byteLength, is_file: true } })) });
  }
  if (u.pathname.endsWith("/files/download")) return json({ attributes: { url: `https://wings.example.test/download/file?file=${encodeURIComponent(u.searchParams.get("file")!.replace(/^\/+/, ""))}` } });
  return json({}, 404);
};

let lib: ReturnType<typeof libraryService>;
let owner: Headers;
let id: string;

beforeAll(async () => {
  const t = await setup({ mode: "self" });
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir: mkdtempSync(join(tmpdir(), "cs-man-")) } };
  lib = libraryService(deps);
  const servers = serverService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  id = (await servers.listServers(owner))[0].id;
  await lib.setProfile(owner, id, { platform: "paper", mcVersion: "" });
});

describe("jar の説明ファイル", () => {
  it("plugin.yml の depend・paper-plugin.yml の必須の前提・fabric.mod.json の depends を読む(任意の前提・本体は除く)", () => {
    expect(jarMeta(disk.get("plugins/shop-final-v2.jar")!)).toEqual({ key: "plugin:shopplugin", name: "ShopPlugin", version: "2.1.0", depends: [{ key: "plugin:vault", name: "Vault" }, { key: "plugin:essentials", name: "Essentials" }], provides: [] });
    const paper = makeZip({ "paper-plugin.yml": "name: P\nversion: '1'\ndependencies:\n  server:\n    Vault:\n      load: BEFORE\n      required: true\n    Opt:\n      required: false\n" }, false);
    expect(jarMeta(paper).depends).toEqual([{ key: "plugin:vault", name: "Vault" }]);
    const fabric = makeZip({ "fabric.mod.json": '{"id":"m","name":"M","version":"1","depends":{"minecraft":">=1.21","fabric-api":"*"}}' }, false);
    expect(jarMeta(fabric)).toMatchObject({ key: "mod:m", depends: [{ key: "mod:fabric-api", name: "fabric-api" }] });
    expect(jarMeta(new TextEncoder().encode("zipではない"))).toEqual({ key: "", name: "", version: "", depends: [], provides: [] });
  });
});

describe("手で置いた jar", () => {
  it("名前・版・見分ける名前を、ファイル名ではなく中身から出す。2 回目からは読み直さない", async () => {
    const r = await lib.installed(owner, id);
    expect(r.items.find((i) => i.filename === "shop-final-v2.jar")).toMatchObject({ name: "ShopPlugin", version: "2.1.0", key: "plugin:shopplugin" });
    const before = reads.length;
    expect(before).toBeGreaterThan(0);
    await lib.installed(owner, id);
    expect(reads.length).toBe(before); // 場所と大きさが同じなら、キャッシュを使う
  });

  it("depend の前提が入っていなければ「前提不足」に出し、入れたら消える(任意の前提は数えない)", async () => {
    let d = await lib.serverDeps(owner, id);
    expect(d.unmet).toEqual([{ name: "Vault", by: ["ShopPlugin"] }]);
    disk.set("plugins/Vault-1.7.jar", yml("name: Vault\nversion: 1.7\nmain: v.V\n"));
    d = await lib.serverDeps(owner, id);
    expect(d.unmet).toEqual([]);
  });
});
