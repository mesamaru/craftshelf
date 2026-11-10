// 同じプラグインを 2 つ入れない: 手で置いた TestPlug-0.9.jar があるサーバーに TestPlug 1.0 を入れると、0.9 を外して入れ替える
// (Paper は同じ名前のプラグインが 2 つあると読み込めない)。フォルダのサーバーと偽の Modrinth で確かめる
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const TP = "TestPrjA";
const dataDir = mkdtempSync(join(tmpdir(), "cs-data-"));
const plugin = (name: string, version: string) => makeZip({ "plugin.yml": `name: ${name}\nversion: ${version}\nmain: x.Main\n` });
// 手で置いた TestPlug 0.9 と、別のプラグイン(名前が違うので触らない)
const folder = () => {
  const root = mkdtempSync(join(tmpdir(), "cs-srv-"));
  writeFileSync(join(root, "paper-1.21.4-1.jar"), "");
  mkdirSync(join(root, "plugins"));
  writeFileSync(join(root, "plugins", "TestPlug-0.9.jar"), plugin("TestPlug", "0.9"));
  writeFileSync(join(root, "plugins", "Other-2.0.jar"), plugin("OtherPlug", "2.0"));
  return root;
};
const rootA = folder();
const rootB = folder();
const rootC = folder();

const version = {
  id: "tpv10000", project_id: TP, version_number: "1.0", version_type: "release", date_published: "2026-01-01", loaders: ["paper"],
  files: [{ primary: true, filename: "TestPlug-1.0.jar", url: `https://cdn.modrinth.com/data/${TP}/TestPlug-1.0.jar`, size: 1, hashes: {} }],
};
const fake: FetchLike = async (url) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (u.pathname === "/v2/version_files") return json({});
    if (u.pathname === `/v2/project/${TP}`) return json({ title: "TestPlug", slug: "testplug", project_type: "plugin" });
    if (u.pathname === `/v2/project/${TP}/version`) return json([version]);
    if (u.pathname === `/v2/version/${version.id}`) return json(version);
    return json({}, 404);
  }
  if (u.host === "cdn.modrinth.com" && u.pathname.endsWith("/TestPlug-1.0.jar")) return new Response(new Uint8Array(plugin("TestPlug", "1.0")));
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let sets: ReturnType<typeof setService>;
let owner: Headers;
let A: string, B: string, C: string;
const names = (root: string) => readdirSync(join(root, "plugins")).filter((n) => n.includes(".jar")).sort();
const AFTER = ["Other-2.0.jar", "TestPlug-0.9.jar.craftshelf-removed", "TestPlug-1.0.jar"];

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } };
  const servers = serverService(deps);
  lib = libraryService(deps);
  sets = setService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  A = (await servers.addLocal(owner, { rootDir: rootA, name: "A" })).id;
  B = (await servers.addLocal(owner, { rootDir: rootB, name: "B" })).id;
  C = (await servers.addLocal(owner, { rootDir: rootC, name: "C" })).id;
});

describe("同じ名前のプラグイン", () => {
  it("入れるとき、同じ名前(plugin.yml の name)のものがあれば外して入れ替える。外したものは変更の履歴から戻せる", async () => {
    const r = await lib.install(owner, A, TP);
    expect(r.replaced).toEqual(["TestPlug-0.9.jar"]);
    expect(names(rootA)).toEqual(AFTER);
    const ch = (await lib.changes(owner, A)).find((c) => c.action === "外す");
    expect(ch).toMatchObject({ title: "TestPlug-0.9.jar", undoable: true });
    await lib.undo(owner, A, ch!.id);
    expect(names(rootA)).toContain("TestPlug-0.9.jar");
  });

  it("セットでそろえるときも、ほかのサーバーからそろえるときも入れ替える", async () => {
    const itemId = (await lib.catalog(owner)).items.find((i) => i.projectId === TP)!.id;
    const setId = (await sets.create(owner, "基本")).id;
    await sets.toggleItem(owner, setId, itemId, true);
    await sets.bind(owner, B, setId);
    await sets.sync(owner, B, "add");
    expect(names(rootB)).toEqual(AFTER);
    await sets.copy(owner, B, [C], "mirror");
    expect(names(rootC)).toEqual(AFTER);
  });
});
