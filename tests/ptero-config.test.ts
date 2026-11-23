// Pterodactyl のサーバーでプラグインを外す・入れ替えるときの設定フォルダの退避は、1 つの圧縮ファイルにまとめる
// (ファイルごとに読んで書くと 1 ファイル 2 回の問い合わせになり、回数の上限に当たるため)。元に戻すと展開して戻す
import { beforeAll, describe, expect, it } from "vitest";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const disk = new Map<string, string | null>(); // パス → 中身(null = フォルダ)
const calls: string[] = [];
const norm = (p: string) => p.replace(/^\/+|\/+$/g, "");
const join = (a: string, b: string) => norm(`${norm(a)}/${b}`);
let compressFails = false;

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  const body = init?.body && typeof init.body === "string" ? (() => { try { return JSON.parse(init.body as string); } catch { return {}; } })() : {};
  if (u.host === "wings.example.com") return new Response(disk.get(u.searchParams.get("file")!) ?? "");
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234(\/.*)?$/);
  if (!m) return json({}, 404);
  const sub = m[1] ?? "";
  calls.push(`${init?.method ?? "GET"} ${sub}`);
  if (sub === "") return json({ attributes: { limits: { disk: 0 } } });
  if (sub === "/network/allocations") return json({ data: [{ attributes: { ip: "203.0.113.10", ip_alias: "", port: 25565, notes: "", is_default: true } }] });
  if (sub === "/resources") return json({ attributes: { current_state: "offline", resources: {} } });
  if (sub === "/files/list") {
    const dir = norm(u.searchParams.get("directory") ?? "/");
    const names = new Map<string, boolean>();
    for (const [p, v] of disk) {
      if (dir && !p.startsWith(dir + "/")) continue;
      const rest = dir ? p.slice(dir.length + 1) : p;
      if (!rest) continue;
      const [first, ...more] = rest.split("/");
      names.set(first, more.length === 0 && v !== null);
    }
    if (dir && !names.size && !disk.has(dir)) return json({}, 404);
    return json({ data: [...names].map(([name, isFile]) => ({ attributes: { name, size: isFile ? (disk.get(dir ? `${dir}/${name}` : name) ?? "").length : 0, is_file: isFile } })) });
  }
  if (sub === "/files/contents") { const f = norm(u.searchParams.get("file")!); return disk.has(f) ? new Response(disk.get(f)!) : json({}, 404); }
  if (sub === "/files/download") return json({ attributes: { url: `https://wings.example.com/dl?file=${encodeURIComponent(norm(u.searchParams.get("file")!))}` } });
  if (sub === "/files/write") { disk.set(norm(u.searchParams.get("file")!), String(init?.body ?? "")); return new Response(null, { status: 204 }); }
  if (sub === "/files/upload") return json({ attributes: { url: "https://wings.example.com/up" } });
  if (sub === "/files/compress") {
    if (compressFails) return json({}, 500);
    const out: Record<string, string> = {};
    for (const f of body.files) { const t = join(body.root, f); for (const [p, v] of disk) if (v !== null && (p === t || p.startsWith(t + "/"))) out[p.slice(norm(body.root).length + (norm(body.root) ? 1 : 0))] = v; }
    const name = `archive-${calls.length}.tar.gz`;
    disk.set(join(body.root, name), JSON.stringify(out));
    return json({ object: "file_object", attributes: { name, is_file: true } });
  }
  if (sub === "/files/decompress") {
    const arc = JSON.parse(disk.get(join(body.root, body.file))!) as Record<string, string>;
    for (const [p, v] of Object.entries(arc)) disk.set(join(body.root, p), v);
    return new Response(null, { status: 204 });
  }
  if (sub === "/files/rename") {
    for (const f of body.files) {
      const from = join(body.root, f.from);
      const to = join(body.root, f.to);
      if (![...disk.keys()].some((p) => p === from || p.startsWith(from + "/"))) return json({}, 404);
      for (const [p, v] of [...disk]) if (p === from || p.startsWith(from + "/")) { disk.delete(p); disk.set(to + p.slice(from.length), v); }
    }
    return new Response(null, { status: 204 });
  }
  if (sub === "/files/delete") {
    for (const f of body.files) for (const p of [...disk.keys()]) { const t = join(body.root, f); if (p === t || p.startsWith(t + "/")) disk.delete(p); }
    return new Response(null, { status: 204 });
  }
  return json({}, 404);
};

describe("Pterodactyl の設定フォルダの退避", () => {
  let lib: ReturnType<typeof libraryService>;
  let owner: Headers;
  let id: string;
  let servers: ReturnType<typeof serverService>;
  let conn: string;
  beforeAll(async () => {
    const t = await setup();
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
    servers = serverService(deps);
    lib = libraryService(deps);
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    disk.set("paper-1.21.4-1.jar", "");
    disk.set("server.properties", "level-name=world\n");
    const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: "ptlc_0123456789abcdefghij" });
    await servers.addServers(owner, c.id, ["abcd1234"]);
    conn = c.id;
    id = (await servers.listServers(owner))[0].id;
  });
  const reset = () => {
    for (const k of [...disk.keys()]) if (k.startsWith("plugins")) disk.delete(k);
    disk.set("plugins/LuckPerms-5.4.0.jar", "jar");
    disk.set("plugins/LuckPerms/config.yml", "a: 1\n");
    disk.set("plugins/LuckPerms/data/users.json", "[]");
    for (let i = 0; i < 30; i++) disk.set(`plugins/LuckPerms/data/u${i}.json`, "{}");
    calls.length = 0;
  };

  it("外すと 1 つの圧縮ファイルに退避し(ファイルごとには写さない)、元に戻すと展開して設定が戻る", async () => {
    reset();
    await lib.remove(owner, id, "LuckPerms-5.4.0.jar");
    expect((await lib.changes(owner, id))[0]).toMatchObject({ action: "外す", config: true });
    expect(calls.filter((c) => c === "POST /files/compress")).toHaveLength(1);
    expect(calls.filter((c) => c === "GET /files/upload")).toHaveLength(0);
    expect(calls.length).toBeLessThan(15); // 32 ファイルを写すと 60 回を超える
    const archive = [...disk.keys()].find((k) => k.startsWith("plugins/.craftshelf-config/") && k.endsWith("/LuckPerms.tar.gz"));
    expect(archive).toBeTruthy();
    expect([...disk.keys()].some((k) => /^plugins\/archive-/.test(k))).toBe(false); // 作った場所には残さない

    disk.set("plugins/LuckPerms/config.yml", "a: 2\n");
    disk.set("plugins/LuckPerms/data/users.json", "[1]");
    await lib.undo(owner, id, (await lib.changes(owner, id))[0].id);
    expect(disk.get("plugins/LuckPerms/config.yml")).toBe("a: 1\n");
    expect(disk.get("plugins/LuckPerms/data/users.json")).toBe("[]");
    expect(disk.has("plugins/LuckPerms-5.4.0.jar")).toBe(true);
    expect(disk.has(archive!)).toBe(true); // 圧縮ファイルは元の場所に戻す(もう一度戻すときにも使える)
    expect([...disk.keys()].some((k) => k.startsWith("plugins/.craftshelf-extract-"))).toBe(false);
  });

  it("圧縮できないパネルでは、前と同じくファイルごとに写す", async () => {
    reset();
    compressFails = true;
    try {
      await lib.remove(owner, id, "LuckPerms-5.4.0.jar");
    } finally {
      compressFails = false;
    }
    const [c] = await lib.changes(owner, id);
    expect(c).toMatchObject({ action: "外す" });
    expect(calls.filter((x) => x === "GET /files/upload").length).toBeGreaterThan(0);
  });

  it("接続を確かめる: 読む・書く・圧縮して移す・展開するを試し、試したものは片付ける", async () => {
    reset();
    const before = [...disk.keys()].sort();
    const r = await servers.checkConnection(owner, conn);
    expect(r.server).toBe("ロビー");
    expect(r.steps.filter((x) => x.ok === false)).toEqual([]);
    expect(r.steps.map((x) => x.label)).toContain("展開して元に戻す(設定フォルダの復元)");
    expect([...disk.keys()].sort()).toEqual(before); // 隠しフォルダ・ファイルは残さない
  });

  it("圧縮できないパネルでは、そこで失敗と出し、後の手順は試さない", async () => {
    reset();
    compressFails = true;
    try {
      const r = await servers.checkConnection(owner, conn);
      expect(r.steps.find((x) => x.label.startsWith("圧縮して"))).toMatchObject({ ok: false });
      expect(r.steps.find((x) => x.label.startsWith("展開して"))).toMatchObject({ ok: null });
      expect([...disk.keys()].some((k) => k.includes("craftshelf-check"))).toBe(false);
    } finally {
      compressFails = false;
    }
  });
});
