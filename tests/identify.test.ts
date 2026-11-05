// 配布元のわからない jar の配布元を中身から探す・ライブラリに取り込む(Pterodactyl・Wings・Modrinth は偽物の応答で代わりをする)
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cfFingerprint } from "~/server/fingerprint";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { uploadService } from "~/server/uploads";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const known = makeZip({ "plugin.yml": "name: Known\nversion: 1.0\nmain: a.B\n" }, false);
const mystery = makeZip({ "plugin.yml": "name: Mystery\nversion: 2.0\nmain: c.D\n" }, false);
const disk = new Map<string, Uint8Array>([["plugins/Known-1.0.jar", known], ["plugins/Mystery-2.0.jar", mystery]]);
const sha1 = (d: Uint8Array) => createHash("sha1").update(d).digest("hex");

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (u.pathname === "/v2/version_files") {
      const { hashes } = JSON.parse(String(init!.body));
      return json(Object.fromEntries((hashes as string[]).filter((h) => h === sha1(known)).map((h) => [h, { id: "VERSION1", project_id: "KNOWNPRJ", version_number: "1.0" }])));
    }
    if (u.pathname === "/v2/project/KNOWNPRJ") return json({ title: "Known", slug: "known", project_type: "mod" });
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
let up: ReturnType<typeof uploadService>;
let owner: Headers;
let id: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup({ mode: "self" });
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir: mkdtempSync(join(tmpdir(), "cs-ident-")) } };
  lib = libraryService(deps);
  up = uploadService(deps);
  const servers = serverService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  id = (await servers.listServers(owner))[0].id;
  await lib.setProfile(owner, id, { platform: "paper", mcVersion: "" });
});

describe("CurseForge のフィンガープリント", () => {
  it("空白類を除いた中身の MurmurHash2(v02 と同じ値)", () => {
    expect(cfFingerprint(new TextEncoder().encode("hello world\n\tabc def 12345"))).toBe(2490681306);
  });
});

describe("配布元を中身から探す", () => {
  it("Modrinth で見つかったものは、このアプリで入れたものとして記録し、ライブラリに載せる(プラグインのサーバーならプラグイン)", async () => {
    const r = await lib.identify(owner, id);
    expect(r).toMatchObject({ checked: 2, found: [{ filename: "Known-1.0.jar", title: "Known", source: "modrinth", versionNumber: "1.0" }], missing: ["Mystery-2.0.jar"] });
    const items = (await lib.installed(owner, id)).items;
    expect(items.find((i) => i.filename === "Known-1.0.jar")).toMatchObject({ source: "modrinth", projectId: "KNOWNPRJ" });
    expect((await lib.catalog(owner)).items.find((i) => i.title === "Known")).toMatchObject({ projectType: "plugin" });
    expect((await lib.identify(owner, id)).checked).toBe(1); // 見つけたものは、もう調べない
  });

  it("見つからなかったものは、アップロードしたものとしてライブラリに取り込める", async () => {
    expect(await code(up.fromServer(owner, id, "../x.jar"))).toBe(400);
    const r = await up.fromServer(owner, id, "Mystery-2.0.jar");
    expect(r).toMatchObject({ title: "Mystery", version: "2.0" });
    expect((await lib.installed(owner, id)).items.find((i) => i.filename === "Mystery-2.0.jar")).toMatchObject({ source: "upload", versionNumber: "2.0" });
    expect((await lib.identify(owner, id)).checked).toBe(0);
  });
});
