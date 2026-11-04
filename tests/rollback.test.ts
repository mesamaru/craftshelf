// 前の版に戻す・前提(必須)も入れる(Pterodactyl と Modrinth は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const A = "AAAAAAAA"; // 本体(B を前提にする)
const B = "BBBBBBBB"; // 前提
const C = "CCCCCCCC"; // 入れられない前提
const D = "DDDDDDDD"; // 版を選んで入れるもの
const files = new Map<string, string[]>([["mods", []]]);
let aLatest = "1.0";

const ver = (project: string, n: string, deps: string[] = []) => ({
  id: `${project.slice(0, 4)}v${n.replace(".", "")}0`.padEnd(8, "0").slice(0, 8), project_id: project, version_number: n, version_type: "release", date_published: `2026-0${n[0]}-01`, loaders: ["fabric"],
  dependencies: deps.map((d) => ({ project_id: d, dependency_type: "required" })),
  files: [{ primary: true, filename: `${project}-${n}.jar`, url: `https://cdn.modrinth.com/data/${project}/${project}-${n}.jar`, size: 1, hashes: {} }],
});
const versions: Record<string, ReturnType<typeof ver>[]> = { [A]: [ver(A, "1.0", [B]), ver(A, "2.0", [B, C])], [B]: [ver(B, "3.0")], [C]: [], [D]: [ver(D, "1.0"), ver(D, "2.0")] };

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    const m = u.pathname.match(/^\/v2\/project\/(\w+)(\/version)?$/);
    if (m && versions[m[1]]) {
      if (!m[2]) return json({ title: `Mod${m[1][0]}`, slug: m[1].toLowerCase(), project_type: "mod" });
      return json(m[1] === A ? versions[A].filter((v) => v.version_number === aLatest) : versions[m[1]]);
    }
    const v = u.pathname.match(/^\/v2\/version\/(\w+)$/);
    const hit = v && Object.values(versions).flat().find((x) => x.id === v[1]);
    return hit ? json(hit) : json({}, 404);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "Mod のサーバー" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/\/files\/(list|pull|delete)$/);
  if (m?.[1] === "list") return json({ data: (files.get(u.searchParams.get("directory")!) ?? []).map((name) => ({ attributes: { name, size: 1, is_file: true } })) });
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (m?.[1] === "pull") { files.set(body.directory, [...(files.get(body.directory) ?? []), body.filename]); return new Response(null, { status: 204 }); }
  if (m?.[1] === "delete") { files.set(body.root, (files.get(body.root) ?? []).filter((x) => !body.files.includes(x))); return new Response(null, { status: 204 }); }
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let owner: Headers;
let id: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const row = async (projectId: string) => (await lib.installed(owner, id)).items.find((i) => i.projectId === projectId);

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  lib = libraryService(deps);
  const servers = serverService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  id = (await servers.listServers(owner))[0].id;
  await lib.setProfile(owner, id, { platform: "fabric", mcVersion: "" });
});

describe("前提", () => {
  it("入れると、まだ入っていない前提(必須)も入れる", async () => {
    const r = await lib.install(owner, id, A);
    expect(r.deps).toEqual([{ title: "ModB", ok: true, detail: "3.0" }]);
    expect(files.get("mods")?.sort()).toEqual([`${A}-1.0.jar`, `${B}-3.0.jar`]);
  });

  it("前提が入れられなくても、本体は入れる(理由を返す)。入っている前提は入れ直さない", async () => {
    aLatest = "2.0";
    const r = await lib.install(owner, id, A);
    expect(r.versionNumber).toBe("2.0");
    expect(r.deps).toEqual([{ title: C, ok: false, detail: "このサーバーの種類・バージョンに合う版がありません" }]);
  });
});

describe("前の版に戻す", () => {
  it("更新で入れ替えた前の版に戻し、「更新を止める」にする。続けて戻す前の版は無い", async () => {
    expect((await row(A))?.canRollback).toBe(true);
    expect((await row(B))?.canRollback).toBe(false);
    const r = await lib.rollback(owner, id, "modrinth", A);
    expect(r.versionNumber).toBe("1.0");
    expect(files.get("mods")?.sort()).toEqual([`${A}-1.0.jar`, `${B}-3.0.jar`]);
    expect(await row(A)).toMatchObject({ versionNumber: "1.0", held: true, canRollback: false });
    expect(await lib.updates(owner, id)).toEqual([]); // 止めているので、新しい版があっても出さない
    expect(await code(lib.rollback(owner, id, "modrinth", A))).toBe(404);
  });

  it("SpigotMC のものは戻せない", async () => {
    expect(await code(lib.rollback(owner, id, "spigot", "28140"))).toBe(400);
  });
});

describe("版を選んで入れる", () => {
  it("合う版を新しい順に出し、選んだ版を入れる。いちばん新しい版でなければ「更新を止める」にする", async () => {
    const list = await lib.versions(owner, id, "modrinth", D);
    expect(list.map((v) => v.versionNumber)).toEqual(["2.0", "1.0"]);
    const r = await lib.install(owner, id, D, "modrinth", list[1].versionId);
    expect(r).toMatchObject({ versionNumber: "1.0", held: true });
    expect(await row(D)).toMatchObject({ versionNumber: "1.0", held: true });
  });

  it("一覧に無い版(ほかのもの・合わないもの)と、SpigotMC の版は受け付けない", async () => {
    expect(await code(lib.install(owner, id, D, "modrinth", versions[A][0].id))).toBe(400);
    expect(await code(lib.install(owner, id, "28140", "spigot", "1"))).toBe(400);
    expect(await lib.versions(owner, id, "spigot", "28140")).toEqual([]);
  });
});
