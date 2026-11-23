// パネルが URL からの取り込み(files/pull)を断ったとき、このアプリが取ってきてアップロードで送る。Pterodactyl・Modrinth・Wings は偽物の応答で代わりをする
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { pteroClient } from "~/server/ptero";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const jar = (s: string) => new TextEncoder().encode(`jar:${s}`);
const sha512 = (b: Uint8Array) => createHash("sha512").update(b).digest("hex");

let pulls = 0;
const uploads: { directory: string; name: string; text: string }[] = [];
const files = new Map<string, string[]>();
// プロジェクトごとの、CDN が返す中身と、Modrinth が記録している sha512
const projects: Record<string, { body: Uint8Array; sha: string }> = {
  AAAAAAAA: { body: jar("a"), sha: sha512(jar("a")) },
  BBBBBBBB: { body: jar("b"), sha: sha512(jar("b")) },
  CCCCCCCC: { body: jar("c-tampered"), sha: sha512(jar("c")) }, // 中身が記録と合わない
};

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    const m = u.pathname.match(/^\/v2\/project\/([A-Z]{8})(\/version)?$/);
    if (!m || !projects[m[1]]) return json({}, 404);
    if (!m[2]) return json({ title: `P-${m[1]}`, slug: m[1].toLowerCase(), project_type: "plugin" });
    return json([{ id: `v-${m[1]}`, version_number: "1.0", version_type: "release", date_published: "2026-01-01",
      files: [{ primary: true, filename: `${m[1]}-1.0.jar`, url: `https://cdn.modrinth.com/data/${m[1]}/x.jar`, size: 1, hashes: { sha512: projects[m[1]].sha } }] }]);
  }
  if (u.host === "cdn.modrinth.com") {
    if (u.pathname === "/away.jar") return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x.jar" } });
    return new Response(new Uint8Array(projects[u.pathname.split("/")[2]].body));
  }
  if (u.host === "wings.example.com") {
    const file = (init!.body as FormData).get("files") as File;
    const directory = u.searchParams.get("directory")!;
    uploads.push({ directory, name: file.name, text: Buffer.from(await file.arrayBuffer()).toString() });
    files.set(directory, [...(files.get(directory) ?? []), file.name]);
    return new Response(null, { status: 200 });
  }
  if (u.host !== "relay.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "サバイバル" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname.endsWith("/files/pull")) { pulls++; return json({ errors: [{ code: "BadRequestHttpException" }] }, 400); }
  if (u.pathname.endsWith("/files/upload")) return json({ attributes: { url: "https://wings.example.com/upload/file?token=t" } });
  if (u.pathname.endsWith("/files/list")) {
    const dir = u.searchParams.get("directory")!;
    return json({ data: (files.get(dir) ?? []).map((name) => ({ attributes: { name, size: 1, is_file: true } })) });
  }
  return json({}, 404);
};

describe("パネルが取り込みを断ったとき", () => {
  let lib: ReturnType<typeof libraryService>;
  let owner: Headers;
  let id: string;
  const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

  beforeAll(async () => {
    const t = await setup({ mode: "self" });
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
    lib = libraryService(deps);
    const servers = serverService(deps);
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    const c = await servers.addConnection(owner, { name: "", url: "relay.example.com", apiKey: KEY });
    await servers.addServers(owner, c.id, ["abcd1234"]);
    id = (await servers.listServers(owner))[0].id;
    await lib.setProfile(owner, id, { platform: "paper", mcVersion: "" });
  });

  it("このアプリが取ってきて送る。断られたことを覚え、次からは取り込みを頼まない", async () => {
    const r = await lib.install(owner, id, "AAAAAAAA");
    expect(r.filename).toBe("AAAAAAAA-1.0.jar");
    expect(pulls).toBe(1);
    expect(uploads).toEqual([{ directory: "plugins", name: "AAAAAAAA-1.0.jar", text: "jar:a" }]);
    await lib.install(owner, id, "BBBBBBBB");
    expect(pulls).toBe(1);
    expect(uploads.at(-1)).toEqual({ directory: "plugins", name: "BBBBBBBB-1.0.jar", text: "jar:b" });
    expect((await lib.installed(owner, id)).items.map((i) => i.filename).sort()).toEqual(["AAAAAAAA-1.0.jar", "BBBBBBBB-1.0.jar"]);
  });

  it("中身が配布元の記録(sha512)と合わなければ、送らずに失敗する", async () => {
    const before = uploads.length;
    await expect(lib.install(owner, id, "CCCCCCCC")).rejects.toThrow("配布元の記録と合わない");
    expect(uploads.length).toBe(before);
    expect((await lib.installed(owner, id)).items.some((i) => i.filename === "CCCCCCCC-1.0.jar")).toBe(false);
    expect(await code(lib.install(owner, id, "CCCCCCCC"))).toBe(502);
  });

  it("配布元の外へ転送されたら取ってこない", async () => {
    const c = pteroClient("https://relay.example.com", KEY, fake);
    const before = uploads.length;
    await expect(c.pull("abcd1234", "https://cdn.modrinth.com/away.jar", "plugins", "x.jar")).rejects.toThrow("配布元の外のファイルは取ってきません");
    await expect(c.pull("abcd1234", "https://evil.example.com/x.jar", "plugins", "x.jar")).rejects.toThrow("配布元の外のファイルは取ってきません");
    expect(uploads.length).toBe(before);
  });
});
