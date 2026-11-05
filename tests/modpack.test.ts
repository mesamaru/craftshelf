// Modpack からライブラリとセットを作る(Modrinth は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import { modpackService } from "~/server/modpack";
import type { FetchLike } from "~/server/net";
import { setService } from "~/server/sets";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  if (u.host !== "api.modrinth.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/v2/version_files") {
    const { hashes } = JSON.parse(String(init!.body));
    return Response.json(Object.fromEntries((hashes as string[]).filter((h) => h === "a".repeat(40)).map((h) => [h, { id: "VERSIONA", project_id: "SODIUMAA", version_number: "0.6" }])));
  }
  if (u.pathname === "/v2/projects") return Response.json([{ id: "SODIUMAA", title: "Sodium", slug: "sodium", icon_url: "" }]);
  return Response.json({}, { status: 404 });
};
const mrpack = makeZip({
  "modrinth.index.json": JSON.stringify({
    formatVersion: 1, game: "minecraft", name: "My Pack", versionId: "1.0",
    files: [
      { path: "mods/sodium.jar", hashes: { sha1: "a".repeat(40) }, env: { client: "required", server: "required" } },
      { path: "mods/unknown.jar", hashes: { sha1: "b".repeat(40) } },
      { path: "mods/menu.jar", hashes: { sha1: "c".repeat(40) }, env: { client: "required", server: "unsupported" } },
      { path: "resourcepacks/x.zip", hashes: { sha1: "d".repeat(40) } },
    ],
  }),
});

let t: Awaited<ReturnType<typeof setup>>;
let packs: ReturnType<typeof modpackService>;
let owner: Headers;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup();
  packs = modpackService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake });
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
});

describe("Modpack", () => {
  it(".mrpack の Mod を Modrinth で探してライブラリに載せ、同じ名前のセットを作る。サーバーで動かないものは飛ばす", async () => {
    const r = await packs.import(owner, "pack.mrpack", mrpack);
    expect(r).toMatchObject({ name: "My Pack 1.0", added: 1, missing: ["unknown.jar"], skipped: 1 });
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
    expect((await libraryService(deps).catalog(owner)).items.map((i) => [i.title, i.projectType, i.source])).toEqual([["Sodium", "mod", "modrinth"]]);
    const sets = await setService(deps).list(owner);
    expect(sets.map((s) => [s.name, s.items.map((i) => i.title)])).toEqual([["My Pack 1.0", ["Sodium"]]]);
  });

  it("CurseForge の Modpack は API キーが要る。Modpack でないファイルは断る", async () => {
    const cf = makeZip({ "manifest.json": JSON.stringify({ name: "CF", version: "1", files: [{ projectID: 238222, fileID: 1 }] }) });
    expect(await code(packs.import(owner, "cf.zip", cf))).toBe(400);
    expect(await code(packs.import(owner, "x.zip", makeZip({ "readme.txt": "x" })))).toBe(400);
    expect(await code(packs.import(owner, "x.zip", new TextEncoder().encode("not zip")))).toBe(400);
  });
});
