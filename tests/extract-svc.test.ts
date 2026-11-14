// 圧縮ファイルの展開(サービス): 権限・同時・変更の履歴と元に戻す・REST・Pterodactyl(偽の応答)・エージェント
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handle, loadConf, makeClients } from "~/agent/main";
import { AGENT_METHODS, agentHub } from "~/server/agent-hub";
import { agentService } from "~/server/agents";
import { eventService } from "~/server/events";
import { extractService } from "~/server/extract";
import { type JobState, type Statfs, memorySource, scanZip, EXTRACT_LIMITS } from "~/server/extract-safe";
import { fileService } from "~/server/files";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { ROUTES, handleRest, routeDocs } from "~/server/rest";
import { serverService } from "~/server/servers";
import { tokenService } from "~/server/tokens";
import { setup } from "./helpers";
import { makeTar } from "./tar";
import { makeZip, makeZipEx } from "./zip";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const GiB = 1024 ** 3;
const plenty: Statfs = async () => ({ free: 500 * GiB, total: 1000 * GiB, block: 4096 });
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "cs-xd-")));
const mkroot = () => { const r = realpathSync(mkdtempSync(join(tmpdir(), "cs-xs-"))); writeFileSync(join(r, "server.properties"), "level-name=world\n"); return r; };
const wait = async (read: () => Promise<JobState | { phase: string }>) => {
  for (let i = 0; i < 1000; i++) {
    const s = await read();
    if (s.phase === "done" || s.phase === "failed" || s.phase === "cancelled") return s as JobState;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("終わりません");
};
const noFetch: FetchLike = async () => { throw new Error("使わない"); };

// ---- フォルダのサーバー ----
describe("フォルダのサーバー(サービス)", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let ex: ReturnType<typeof extractService>;
  let lib: ReturnType<typeof libraryService>;
  let ev: ReturnType<typeof eventService>;
  let files: ReturnType<typeof fileService>;
  let servers: ReturnType<typeof serverService>;
  let owner: Headers;
  let editor: Headers;
  let viewer: Headers;
  let outsider: Headers;
  let id: string;
  let id2: string;
  let editorId: string;
  let gate: Statfs = plenty; // 展開の途中で止めたいとき、差し替える
  let deps0: ConstructorParameters<never> | Record<string, unknown> = {};
  const root = mkroot();
  const root2 = mkroot();
  const put = (rel: string, data: string | Uint8Array, base = root) => { const p = join(base, ...rel.split("/")); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, data); };

  beforeAll(async () => {
    t = await setup();
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: noFetch, local: { dataDir, extract: { statfs: (p: string) => gate(p) } } };
    deps0 = deps;
    servers = serverService(deps);
    ex = extractService(deps);
    lib = libraryService(deps);
    ev = eventService(deps);
    files = fileService(deps);
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    id = (await servers.addLocal(owner, { rootDir: root, name: "A" })).id;
    id2 = (await servers.addLocal(owner, { rootDir: root2, name: "B" })).id;
    const join_ = async (email: string, name: string, role: string) => {
      const inv = await (await t.call("/organization/invite-member", { email, role }, owner.get("cookie")!)).json();
      const cookie = await t.signUp(name, email);
      await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
      await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
      return t.headers(cookie);
    };
    editor = await join_("editor@example.com", "編集者", "editor");
    viewer = await join_("viewer@example.com", "閲覧者", "viewer");
    outsider = t.headers(await t.signUp("部外者", "outsider@example.com"));
    editorId = (await servers.assignments(owner)).members.find((m) => m.name === "編集者")!.userId;
  });

  it("展開はファイルを書く権限が要る: 閲覧者・(許されていない)編集者は 403、ほかのチームは 404", async () => {
    put("Foo.zip", makeZip({ "a.txt": "a" }));
    for (const who of [viewer, editor]) {
      expect(await code(ex.plan(who, id, "Foo.zip", "folder"))).toBe(403);
      expect(await code(ex.start(who, id, "Foo.zip", "folder"))).toBe(403);
      expect(await code(ex.state(who, id, "x"))).toBe(403);
      expect(await code(ex.cancel(who, id, "x"))).toBe(403);
      expect(await code(ex.undo(who, id, "x"))).toBe(403);
    }
    expect(await code(ex.plan(outsider, id, "Foo.zip", "folder"))).toBe(404); // ほかのチームのサーバーは「見つからない」
    expect(readdirSync(root).sort()).toEqual(["Foo.zip", "server.properties"]);
  });

  it("編集者にも許したときは動く。ただし割り当てのないサーバーは 403。閲覧者は許しても 403", async () => {
    await files.setEditorFiles(owner, true);
    expect((await ex.plan(editor, id, "Foo.zip", "folder")).ok).toBe(true);
    await servers.setAssignment(owner, editorId, true, [id2]);
    expect(await code(ex.plan(editor, id, "Foo.zip", "folder"))).toBe(403);
    expect(await code(ex.start(editor, id, "Foo.zip", "folder"))).toBe(403);
    await servers.setAssignment(owner, editorId, false, []);
    expect(await code(ex.plan(viewer, id, "Foo.zip", "folder"))).toBe(403);
    await files.setEditorFiles(owner, false);
    expect(await code(ex.plan(editor, id, "Foo.zip", "folder"))).toBe(403);
  });

  it("確かめ → 展開 → 変更の履歴と操作の記録。元の圧縮ファイルは残る。違反は断って何も残さない", async () => {
    expect(await code(ex.plan(owner, id, "../x.zip", "folder"))).toBe(400);
    expect(await code(ex.plan(owner, id, "none.zip", "folder"))).toBe(502);
    const plan = await ex.plan(owner, id, "Foo.zip", "folder");
    expect(plan).toMatchObject({ ok: true, dest: "Foo", files: 1, how: "self", busy: false });
    const { jobId } = await ex.start(owner, id, "Foo.zip", "folder");
    const s = await wait(() => ex.state(owner, id, jobId) as never);
    expect(s.phase).toBe("done");
    expect(JSON.stringify(s)).not.toContain("created"); // 取り消しの一覧は画面に返さない
    await ex.settled(id);
    expect(readFileSync(join(root, "Foo", "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(root, "Foo.zip"))).toBe(true);
    const changes = await lib.changes(owner, id);
    expect(changes[0]).toMatchObject({ action: "展開", title: "Foo.zip", extract: true, undoable: false });
    expect(changes[0].added).toContain("Foo/");
    expect((await ev.list(owner))[0]).toMatchObject({ action: "圧縮ファイルを展開", target: "A" });
    expect(await code(lib.undo(owner, id, changes[0].id))).toBe(400); // アドオンの「元に戻す」では戻せない
    // 違反
    put("bad.zip", makeZip({ "ok.txt": "ok", "../evil.txt": "evil" }));
    const bad = await ex.plan(owner, id, "bad.zip", "folder");
    expect(bad.ok).toBe(false);
    const j = await ex.start(owner, id, "bad.zip", "folder");
    expect((await wait(() => ex.state(owner, id, j.jobId) as never)).phase).toBe("failed");
    await ex.settled(id);
    expect(readdirSync(root).filter((n) => n.startsWith(".craftshelf") || n === "bad").length).toBe(0);
    expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
    expect((await ev.list(owner))[0]).toMatchObject({ action: "圧縮ファイルを展開できなかった" });
  });

  it("同時に 2 つ目は「展開中です」と断る(409)", async () => {
    put("Big.zip", makeZip({ "x.bin": "x".repeat(10) }));
    const [a, b] = await Promise.allSettled([ex.start(owner, id, "Big.zip", "folder"), ex.start(owner, id, "Big.zip", "folder")]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect((rejected.reason as HttpError).status).toBe(409);
    await ex.settled(id);
    expect((await ex.plan(owner, id, "Big.zip", "folder")).busy).toBe(false); // 終わったら、また展開できる
  });

  it("展開を元に戻す: 作ったものだけを消す。展開のあとに足した・変えたファイルは残る", async () => {
    put("Pack.zip", makeZip({ "keep.txt": "orig", "edited.txt": "orig", "sub/inner.txt": "inner", "sub/deep/x.txt": "x", "empty/": "" }));
    const { jobId } = await ex.start(owner, id, "Pack.zip", "folder");
    await wait(() => ex.state(owner, id, jobId) as never);
    await ex.settled(id);
    const ch = (await lib.changes(owner, id)).find((c) => c.title === "Pack.zip")!;
    expect(ch.extract).toBe(true);
    writeFileSync(join(root, "Pack", "edited.txt"), "edited by user!"); // 大きさが変わった
    put("Pack/sub/mine.txt", "mine"); // 利用者が足した
    expect(await code(ex.undo(editor, id, ch.id))).toBe(403);
    const r = await ex.undo(owner, id, ch.id);
    expect(r).toMatchObject({ removed: 3, kept: 1 });
    expect(readdirSync(join(root, "Pack")).sort()).toEqual(["edited.txt", "sub"]);
    expect(readdirSync(join(root, "Pack", "sub"))).toEqual(["mine.txt"]); // 空でないフォルダは残す(deep と empty は消える)
    expect(existsSync(join(root, "Pack.zip"))).toBe(true);
    expect(await code(ex.undo(owner, id, ch.id))).toBe(400);
    expect((await lib.changes(owner, id)).find((c) => c.id === ch.id)).toMatchObject({ undone: true, extract: false });
    expect((await ev.list(owner))[0]).toMatchObject({ action: "展開を元に戻す" });
  });

  it("何も変えていなければ、展開で作ったフォルダごと消える。ここに展開は、もとからあったフォルダを消さない", async () => {
    put("Clean.zip", makeZip({ "a.txt": "a", "d/b.txt": "b" }));
    const a = await ex.start(owner, id, "Clean.zip", "folder");
    await wait(() => ex.state(owner, id, a.jobId) as never);
    await ex.settled(id);
    const ch = (await lib.changes(owner, id)).find((c) => c.title === "Clean.zip")!;
    expect(await ex.undo(owner, id, ch.id)).toMatchObject({ removed: 2, kept: 0 });
    expect(existsSync(join(root, "Clean"))).toBe(false);
    // ここに展開
    put("plugins/old.jar", "old");
    put("plugins/pack2.zip", makeZip({ "new.jar": "n", "cfg/a.yml": "a" }));
    const b = await ex.start(owner, id, "plugins/pack2.zip", "here");
    await wait(() => ex.state(owner, id, b.jobId) as never);
    await ex.settled(id);
    const ch2 = (await lib.changes(owner, id)).find((c) => c.title === "pack2.zip")!;
    await ex.undo(owner, id, ch2.id);
    expect(readdirSync(join(root, "plugins")).sort()).toEqual(["old.jar", "pack2.zip"]);
  });

  it("キャンセルできる(記録に残る)。知らない jobId は断る", async () => {
    put("Cx.zip", makeZip({ "a.txt": "a" }));
    expect(await code(ex.state(owner, id, "nope"))).toBe(502);
    const { jobId } = await ex.start(owner, id, "Cx.zip", "folder");
    await ex.cancel(owner, id, jobId).catch(() => {});
    await wait(() => ex.state(owner, id, jobId) as never);
    await ex.settled(id);
  });


  it("展開を始めると、変更の履歴に「展開中」の行が先に載り、終わると「展開」になる(再起動で結果が失われない根拠)", async () => {
    put("Run.zip", makeZip({ "a.txt": "a" }));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let calls = 0;
    gate = async () => { if (++calls === 2) await held; return { free: 500 * GiB, total: 1000 * GiB, block: 4096 }; };
    try {
      const { jobId } = await ex.start(owner, id, "Run.zip", "folder");
      const running = (await lib.changes(owner, id)).find((c) => c.title === "Run.zip")!;
      expect(running).toMatchObject({ action: "展開中", status: "running", undoable: false, extract: false });
      expect(await code(ex.start(owner, id, "Run.zip", "folder"))).toBe(409);
      release();
      await wait(() => ex.state(owner, id, jobId) as never);
      await ex.settled(id);
      const done = (await lib.changes(owner, id)).filter((c) => c.title === "Run.zip");
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ action: "展開", status: "done", extract: true });
    } finally {
      gate = plenty;
    }
  });

  it("別のプロセス(別のサービスのインスタンス)からも、同じサーバーの同時の展開は DB で 1 つだけ通る", async () => {
    put("Two.zip", makeZip({ "a.txt": "a" }));
    const other = extractService(deps0 as never);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let calls = 0;
    gate = async () => { if (++calls === 2) await held; return { free: 500 * GiB, total: 1000 * GiB, block: 4096 }; };
    try {
      const first = await ex.start(owner, id, "Two.zip", "folder");
      expect(await code(other.start(owner, id, "Two.zip", "folder"))).toBe(409); // other は自分のメモリでは知らないが、DB の「展開中」を見る
      release();
      await wait(() => ex.state(owner, id, first.jobId) as never);
      await ex.settled(id);
      const again = await other.start(owner, id, "Two.zip", "folder"); // 終われば、また始められる
      await wait(() => other.state(owner, id, again.jobId) as never);
      await other.settled(id);
    } finally {
      gate = plenty;
    }
  });

  it("起動のとき「展開中」のまま残った行は「中断(結果不明)」に直る。取り消しの対象にはならない", async () => {
    const { randomUUID } = await import("node:crypto");
    const { serverChange } = await import("~/server/db/schema");
    const rid = randomUUID();
    await t.db.insert(serverChange).values({ id: rid, serverId: id, userId: null, action: "展開中", title: "Lost.zip", added: "", removed: JSON.stringify({ jobId: "gone", path: "Lost.zip", mode: "folder" }) });
    const fresh = extractService(deps0 as never);
    await fresh.recover();
    const row = (await lib.changes(owner, id)).find((c) => c.id === rid)!;
    expect(row).toMatchObject({ action: "展開中断", status: "aborted", undoable: false, extract: false });
    expect(await code(fresh.undo(owner, id, rid))).toBe(404);
    expect((await ev.list(owner))[0]).toMatchObject({ action: "圧縮ファイルの展開が中断された" });
  });

  it("REST: 範囲は管理が要る。読み取り・操作だけのトークンは 403。説明がある", async () => {
    const tok = tokenService({ db: t.db, auth: t.auth, secret: SECRET, fetch: noFetch });
    const services = { extract: ex, servers, library: lib, files, events: ev } as never;
    const call = (method: string, path: string, key: string, body?: unknown) =>
      handleRest(services, new Request(`http://x/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), path.split("?")[0]);
    const admin = (await tok.create(owner, { name: "管理", scopes: ["library", "control", "admin"], days: 0 })).key;
    const control = (await tok.create(owner, { name: "操作", scopes: ["control"], days: 0 })).key;
    const read = (await tok.create(owner, { name: "読む", scopes: [], days: 0 })).key;
    put("Rest.zip", makeZip({ "r.txt": "r" }));
    expect((await call("GET", `/servers/${id}/extract/plan?path=Rest.zip&mode=folder`, read)).status).toBe(403);
    expect((await call("GET", `/servers/${id}/extract/plan?path=Rest.zip&mode=folder`, control)).status).toBe(403);
    expect((await call("POST", `/servers/${id}/extract`, control, { path: "Rest.zip", mode: "folder" })).status).toBe(403);
    const plan = await call("GET", `/servers/${id}/extract/plan?path=Rest.zip&mode=folder`, admin);
    expect(plan.status).toBe(200);
    expect((await plan.json()).ok).toBe(true);
    const started = await call("POST", `/servers/${id}/extract`, admin, { path: "Rest.zip", mode: "folder" });
    expect(started.status).toBe(200);
    const { jobId } = await started.json();
    const st = await wait(async () => (await call("GET", `/servers/${id}/extract/state?job=${jobId}`, admin)).json());
    expect(st.phase).toBe("done");
    await ex.settled(id);
    const docs = routeDocs().filter((r) => r.path.includes("/extract"));
    expect(docs.map((d) => d.path).sort()).toEqual(["/api/v1/servers/:id/extract", "/api/v1/servers/:id/extract/cancel", "/api/v1/servers/:id/extract/plan", "/api/v1/servers/:id/extract/state", "/api/v1/servers/:id/extract/undo"]);
    expect(ROUTES.filter((r) => r.path.includes("/extract")).every((r) => r.scope === "admin" && r.summary.length > 10)).toBe(true);
  });

  it("起動のときの掃除は、古い一時フォルダだけを片付ける", async () => {
    const old = new Date(Date.now() - 2 * 3600_000);
    mkdirSync(join(root, ".craftshelf-extract-old1"));
    const { utimesSync } = await import("node:fs");
    // こちらの印のある(持ち主がいない)一時フォルダ
    writeFileSync(join(root, ".craftshelf-extract-old1", ".craftshelf-extract.mark"), JSON.stringify({ v: 1, id: "old1", boot: "old-boot", pid: 2_147_483_000, at: 1, root: realpathSync(root) }));
    writeFileSync(join(root, ".craftshelf-extract-old1.job"), JSON.stringify({ id: "old1", tmp: ".craftshelf-extract-old1" }));
    utimesSync(join(root, ".craftshelf-extract-old1.job"), old, old);
    mkdirSync(join(root, ".craftshelf-extract-new1")); // 印の無い(利用者の)フォルダは消さない
    expect(await ex.cleanStale()).toBe(1);
    expect(existsSync(join(root, ".craftshelf-extract-old1"))).toBe(false);
    expect(existsSync(join(root, ".craftshelf-extract-new1"))).toBe(true);
  });
});

// ---- Pterodactyl(偽の Wings) ----
describe("Pterodactyl(事前の確かめだけがこちらで働く)", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let ex: ReturnType<typeof extractService>;
  let lib: ReturnType<typeof libraryService>;
  let servers: ReturnType<typeof serverService>;
  let owner: Headers;
  let id: string;
  const disk = new Map<string, Buffer | null>(); // パス → 中身(null = フォルダ)
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const downloads: string[] = [];
  let diskMb = 1000;
  let used = 1000;
  let decompressFails = false;
  let downloadGate: Promise<void> | null = null; // 圧縮ファイルの読み込みを止めておく
  const sizeOf = (p: string) => disk.get(p)?.length ?? 0;
  const norm = (p: string) => p.replace(/^\/+|\/+$/g, "");

  const fake: FetchLike = async (url, init) => {
    const u = new URL(url);
    const json = (b: unknown, status = 200) => Response.json(b, { status });
    const body = init?.body ? (() => { try { return JSON.parse(String(init.body)); } catch { return {}; } })() : {};
    if (u.host === "wings.example.com") { downloads.push(u.searchParams.get("file")!); if (downloadGate) await downloadGate; return new Response(new Uint8Array(disk.get(u.searchParams.get("file")!)!)); }
    if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
    if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
    const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234(\/.*)?$/);
    if (!m) return json({}, 404);
    const sub = m[1] ?? "";
    if (sub === "") return json({ attributes: { limits: { disk: diskMb } } });
    if (sub === "/resources") return json({ attributes: { current_state: "running", resources: { disk_bytes: used * 1024 * 1024 } } });
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
      return json({ data: [...names].map(([name, isFile]) => ({ attributes: { name, size: isFile ? sizeOf(dir ? `${dir}/${name}` : name) : 0, is_file: isFile } })) });
    }
    if (sub === "/files/contents") { const f = norm(u.searchParams.get("file")!); return disk.has(f) ? new Response(disk.get(f)!.toString()) : json({}, 404); }
    if (sub === "/files/download") return json({ attributes: { url: `https://wings.example.com/dl?file=${encodeURIComponent(norm(u.searchParams.get("file")!))}` } });
    calls.push({ path: sub, body });
    if (sub === "/files/create-folder") { disk.set(norm(`${norm(body.root)}/${body.name}`), null); return new Response(null, { status: 204 }); }
    if (sub === "/files/rename") {
      for (const f of body.files) {
        const from = norm(`${norm(body.root)}/${f.from}`);
        const to = norm(`${norm(body.root)}/${f.to}`);
        for (const [p, v] of [...disk]) if (p === from || p.startsWith(from + "/")) { disk.delete(p); disk.set(to + p.slice(from.length), v); }
      }
      return new Response(null, { status: 204 });
    }
    if (sub === "/files/delete") {
      for (const f of body.files) for (const p of [...disk.keys()]) { const t = norm(`${norm(body.root)}/${f}`); if (p === t || p.startsWith(t + "/")) disk.delete(p); }
      return new Response(null, { status: 204 });
    }
    if (sub === "/files/decompress") {
      if (decompressFails) return json({}, 500);
      const arc = disk.get(norm(`${norm(body.root)}/${body.file}`))!;
      const src = memorySource(arc);
      for (const e of scanZip(src, EXTRACT_LIMITS).entries) {
        const head = src.read(e.local, 30);
        const data = src.read(e.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), e.csize);
        disk.set(norm(`${norm(body.root)}/${e.name}`), e.dir ? null : Buffer.from(e.method === 8 ? inflateRawSync(data) : data));
      }
      return new Response(null, { status: 204 });
    }
    return json({}, 404);
  };

  beforeAll(async () => {
    t = await setup();
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
    servers = serverService(deps);
    ex = extractService(deps);
    lib = libraryService(deps);
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: "ptlc_0123456789abcdefghij" });
    await servers.addServers(owner, c.id, ["abcd1234"]);
    id = (await servers.listServers(owner))[0].id;
  });
  const reset = () => { disk.clear(); calls.length = 0; downloads.length = 0; diskMb = 1000; used = 100; decompressFails = false; disk.set("server.properties", Buffer.from("level-name=world\n")); };
  const decompressed = () => calls.filter((c) => c.path === "/files/decompress");
  const runExtract = async (path: string, mode: "folder" | "here") => {
    const { jobId } = await ex.start(owner, id, path, mode);
    const s = await wait(() => ex.state(owner, id, jobId) as never);
    await ex.settled(id);
    return s;
  };

  it("事前の確かめに違反があれば、decompress を呼ばない(何も作らない)", async () => {
    reset();
    disk.set("plugins/Evil.zip", Buffer.from(makeZip({ "ok.txt": "ok", "../evil.txt": "evil" })));
    const plan = await ex.plan(owner, id, "plugins/Evil.zip", "folder");
    expect(plan).toMatchObject({ ok: false, how: "panel" });
    expect(plan.reasons.join()).toContain("../evil.txt");
    const s = await runExtract("plugins/Evil.zip", "folder");
    expect(s.phase).toBe("failed");
    expect(calls).toEqual([]); // create-folder も rename も decompress も呼ばない
    expect([...disk.keys()].sort()).toEqual(["plugins/Evil.zip", "server.properties"]);
  });

  it("リンクの zip・暗号化の zip も、decompress を呼ばない", async () => {
    reset();
    disk.set("a.zip", Buffer.from(makeZipEx([{ name: "l", data: "/etc/passwd", mode: 0o120777 }])));
    expect((await runExtract("a.zip", "folder")).phase).toBe("failed");
    disk.set("b.tar", makeTar([{ name: "l", type: "2", linkname: "/etc/passwd" }]));
    expect((await runExtract("b.tar", "here")).phase).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("通れば呼ぶ: 新しいフォルダを作り、圧縮ファイルを一時的に移して展開し、元に戻す。履歴に載り、元に戻せる", async () => {
    reset();
    disk.set("plugins/Foo.zip", Buffer.from(makeZip({ "a.txt": "aaa", "d/b.txt": "bb" })));
    disk.set("plugins/Foo/keep.txt", Buffer.from("k")); // Foo は使われているので Foo-2 になる
    const plan = await ex.plan(owner, id, "plugins/Foo.zip", "folder");
    expect(plan).toMatchObject({ ok: true, dest: "plugins/Foo-2", files: 2 });
    expect(downloads).toEqual(["plugins/Foo.zip"]); // 確かめのために読んだ
    const s = await runExtract("plugins/Foo.zip", "folder");
    expect(s.phase, s.error).toBe("done");
    expect(decompressed()).toHaveLength(1);
    expect(decompressed()[0].body.root).toBe("/plugins/Foo-2");
    expect(String(decompressed()[0].body.file)).toMatch(/^\.craftshelf-extract-[0-9a-f]+\.zip$/);
    expect(disk.has("plugins/Foo.zip")).toBe(true); // 圧縮ファイルは元の場所に戻っている
    expect([...disk.keys()].filter((p) => p.includes(".craftshelf-extract"))).toEqual([]);
    expect(sizeOf("plugins/Foo-2/a.txt")).toBe(3);
    const ch = (await lib.changes(owner, id)).find((c) => c.title === "Foo.zip")!;
    expect(ch.extract).toBe(true);
    // 元に戻す: 作ったものだけ(展開のあとに足したものは残す)
    disk.set("plugins/Foo-2/mine.txt", Buffer.from("m"));
    const r = await ex.undo(owner, id, ch.id);
    expect(r.removed).toBe(2);
    expect([...disk.keys()].filter((p) => p.startsWith("plugins/Foo-2")).sort()).toEqual(["plugins/Foo-2", "plugins/Foo-2/mine.txt"]);
    expect(disk.has("plugins/Foo/keep.txt")).toBe(true);
  });

  it("decompress が失敗したら、作ったフォルダを消し、圧縮ファイルを元に戻す", async () => {
    reset();
    disk.set("Bar.zip", Buffer.from(makeZip({ "a.txt": "a" })));
    decompressFails = true;
    const s = await runExtract("Bar.zip", "folder");
    expect(s.phase).toBe("failed");
    expect(s.error).toContain("パネルが展開できませんでした");
    expect([...disk.keys()].sort()).toEqual(["Bar.zip", "server.properties"]);
  });

  it("ここに展開: 同じ名前があれば呼ばない。なければ、そのフォルダで decompress", async () => {
    reset();
    disk.set("plugins/a.jar", Buffer.from("mine"));
    disk.set("plugins/pack.zip", Buffer.from(makeZip({ "a.jar": "theirs", "b.jar": "b" })));
    expect((await runExtract("plugins/pack.zip", "here")).phase).toBe("failed");
    expect(decompressed()).toHaveLength(0);
    disk.set("plugins/ok.zip", Buffer.from(makeZip({ "new.jar": "n", "sub/x.yml": "x" })));
    const s = await runExtract("plugins/ok.zip", "here");
    expect(s.phase, s.error).toBe("done");
    expect(decompressed()).toHaveLength(1);
    expect(decompressed()[0].body).toEqual({ root: "/plugins", file: "ok.zip" });
    expect(disk.has("plugins/sub/x.yml")).toBe(true);
  });

  it("上限を超える圧縮ファイル(512 MiB)は、読まずに断る。パネルのファイルマネージャを案内する", async () => {
    reset();
    disk.set("big.zip", Buffer.from(makeZip({ "a.txt": "a" })));
    const real = disk.get("big.zip")!;
    Object.defineProperty(real, "length", { value: 600 * 1024 * 1024 }); // 一覧の大きさだけ大きく見せる
    const plan = await ex.plan(owner, id, "big.zip", "folder");
    expect(plan.ok).toBe(false);
    expect(plan.reasons.join()).toContain("ファイルマネージャ");
    expect(downloads).toEqual([]);
  });

  it("ディスクの上限: 使用中を引いた空き・予約領域(上限の 10%)・無制限は 1 GiB まで", async () => {
    reset();
    disk.set("a.zip", Buffer.from(makeZip({ "a.bin": "x".repeat(2 * 1024 * 1024) }, false)));
    diskMb = 100; used = 99; // 空き 1 MB・予約領域 10 MB
    let p = await ex.plan(owner, id, "a.zip", "folder");
    expect(p.ok).toBe(false);
    expect(p.space).toMatchObject({ free: 1024 * 1024, reserve: 10 * 1024 * 1024 });
    expect(p.reasons.join()).toContain("空き容量が足りません");
    diskMb = 100; used = 10; // 空き 90 MB − 予約 10 MB = 80 MB の 80% = 64 MB
    p = await ex.plan(owner, id, "a.zip", "folder");
    expect(p.ok).toBe(true);
    expect(p.space.usable).toBe(64 * 1024 * 1024);
    diskMb = 0; // 無制限: ボリュームが分からないので 1 GiB まで
    p = await ex.plan(owner, id, "a.zip", "folder");
    expect(p).toMatchObject({ ok: true, space: { unlimited: true } });
    const keep = EXTRACT_LIMITS.pteroUnlimitedBytes;
    EXTRACT_LIMITS.pteroUnlimitedBytes = 1024 * 1024; // 無制限のときの合計の上限(本当は 1 GiB)を小さくして確かめる
    try {
      p = await ex.plan(owner, id, "a.zip", "folder");
      expect(p.ok).toBe(false);
      expect(p.reasons.join()).toContain("ディスクの上限が決まっていない");
    } finally {
      EXTRACT_LIMITS.pteroUnlimitedBytes = keep;
    }
    expect(keep).toBe(GiB);
  });

  it("確かめの同時の読み込み(メモリに読む)は 2 つまで。3 つ目は「しばらくしてから」と断る", async () => {
    reset();
    for (const n of ["a", "b", "c"]) disk.set(`${n}.zip`, Buffer.from(makeZip({ "x.txt": "x" })));
    let release!: () => void;
    downloadGate = new Promise<void>((r) => { release = r; });
    try {
      const ps = ["a", "b", "c"].map((n) => ex.plan(owner, id, `${n}.zip`, "folder").then(() => 200, (e) => (e instanceof HttpError ? e.status : 500)));
      await new Promise((r) => setTimeout(r, 400));
      release();
      expect((await Promise.all(ps)).sort()).toEqual([200, 200, 502]);
    } finally {
      downloadGate = null;
      release();
    }
    // 終われば、また読める
    expect((await ex.plan(owner, id, "a.zip", "folder")).ok).toBe(true);
  });

  it("ワールドのフォルダへは展開しない(server.properties の level-name)", async () => {
    reset();
    disk.set("world/a.zip", Buffer.from(makeZip({ "x.txt": "x" })));
    const p = await ex.plan(owner, id, "world/a.zip", "here");
    expect(p.ok).toBe(false);
    expect(p.reasons.join()).toContain("守っている場所");
  });
});

// ---- エージェント ----
describe("エージェント(展開はエージェントの上で行う)", () => {
  const hub = agentHub();
  const root = mkroot();
  let t: Awaited<ReturnType<typeof setup>>;
  let agents: ReturnType<typeof agentService>;
  let ex: ReturnType<typeof extractService>;
  let lib: ReturnType<typeof libraryService>;
  let owner: Headers;
  let id: string;
  let stop = false;
  let token = "";
  afterAll(() => { stop = true; });

  beforeAll(async () => {
    t = await setup({ mode: "service" });
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch, agents: hub };
    agents = agentService(deps);
    ex = extractService(deps);
    lib = libraryService(deps);
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    const r = await agents.create(owner, "家");
    token = r.token;
    const clients = makeClients(loadConf(JSON.stringify({ url: "https://craftshelf.example.com", token, servers: [{ key: "home", name: "家", root }] })), fetch, { statfs: plenty });
    await agents.checkIn(token, { version: "1.2.0", servers: [{ key: "home", name: "家", platform: "paper", mcVersion: "1.21.4" }] });
    void (async () => {
      while (!stop) {
        for (const q of await hub.poll(r.id, 100)) {
          try { hub.result(r.id, q.id, true, (await handle(clients, q.method, q.args)) ?? null); } catch (e) { hub.result(r.id, q.id, false, null, (e as Error).message); }
        }
      }
    })();
    await new Promise((r2) => setTimeout(r2, 200));
    const [a] = await agents.list(owner);
    id = (await agents.addServer(owner, a.id, "home")).id;
  });

  it("AGENT_METHODS に extract がある。エージェント側でも、同じ確かめ(名前・リンク・容量・後片付け)が働く", async () => {
    expect(AGENT_METHODS).toContain("extract");
    expect(AGENT_METHODS).toEqual(expect.arrayContaining(["extractPlan", "extractState", "extractCancel"]));
    const clients = makeClients(loadConf(JSON.stringify({ url: "https://x.example.com", token, servers: [{ key: "home", root }] })), fetch, { statfs: async () => ({ free: 100, total: 1000, block: 4096 }) });
    writeFileSync(join(root, "evil.zip"), makeZip({ "../evil.txt": "x" }));
    const plan = (await handle(clients, "extractPlan", { key: "home", archive: "evil.zip", mode: "folder" })) as { ok: boolean; reasons: string[] };
    expect(plan.ok).toBe(false);
    // 呼ぶ側が嘘の確かめを持っていても、エージェントは自分でもう一度確かめて断る(空き容量も、エージェント自身が測る)
    const { jobId } = (await handle(clients, "extract", { key: "home", archive: "evil.zip", mode: "folder" })) as { jobId: string };
    const s = await wait(async () => (await handle(clients, "extractState", { key: "home", job: jobId })) as JobState);
    expect(s.phase).toBe("failed");
    expect(readdirSync(root).filter((n) => n !== "evil.zip" && n !== "server.properties")).toEqual([]);
    writeFileSync(join(root, "ok.zip"), makeZip({ "a.txt": "a" }));
    const poor = (await handle(clients, "extractPlan", { key: "home", archive: "ok.zip", mode: "folder" })) as { ok: boolean; reasons: string[] };
    expect(poor.reasons.join()).toContain("空き容量が足りません");
    await expect(handle(clients, "extractState", { key: "other", job: jobId })).rejects.toThrow("設定ファイルにありません");
    await expect(handle(clients, "exec", { key: "home" })).rejects.toThrow("この操作はできません");
  });


  it("サービスの再起動で見張りが途切れても、エージェントに状態を問い合わせて、終わっていれば履歴に反映する", async () => {
    const { randomUUID } = await import("node:crypto");
    const { serverChange } = await import("~/server/db/schema");
    writeFileSync(join(root, "Rec.zip"), makeZip({ "r.txt": "r", "d/s.txt": "s" }));
    // サービスを通さずにエージェントに頼む(= サービスが落ちたあとも、エージェントの展開は続く)
    const clients2 = makeClients(loadConf(JSON.stringify({ url: "https://x.example.com", token, servers: [{ key: "home", root }] })), fetch, { statfs: plenty });
    const { jobId } = (await handle(clients2, "extract", { key: "home", archive: "Rec.zip", mode: "folder" })) as { jobId: string };
    await wait(async () => (await handle(clients2, "extractState", { key: "home", job: jobId })) as JobState);
    const rid = randomUUID();
    await t.db.insert(serverChange).values({ id: rid, serverId: id, userId: null, action: "展開中", title: "Rec.zip", added: "", removed: JSON.stringify({ jobId, path: "Rec.zip", mode: "folder" }) });
    await extractService({ db: t.db, auth: t.auth, secret: SECRET, fetch, agents: hub }).recover();
    const row = (await lib.changes(owner, id)).find((c) => c.id === rid)!;
    expect(row).toMatchObject({ action: "展開", status: "done", extract: true });
    expect(await ex.undo(owner, id, rid)).toMatchObject({ removed: 2 });
    expect(existsSync(join(root, "Rec"))).toBe(false);
  });

  it("サービスは頼んで進みを見るだけ。エージェントの上で展開され、変更の履歴・記録に載る", async () => {
    writeFileSync(join(root, "Pack.zip"), makeZip({ "a.txt": "a", "b/c.txt": "c" }));
    expect((await ex.plan(owner, id, "Pack.zip", "folder")).ok).toBe(true);
    const { jobId } = await ex.start(owner, id, "Pack.zip", "folder");
    const s = await wait(() => ex.state(owner, id, jobId) as never);
    expect(s.phase, s.error).toBe("done");
    await ex.settled(id);
    expect(readFileSync(join(root, "Pack", "b", "c.txt"), "utf8")).toBe("c");
    const ch = (await lib.changes(owner, id)).find((c) => c.title === "Pack.zip")!;
    expect(ch.extract).toBe(true);
    expect(await ex.undo(owner, id, ch.id)).toMatchObject({ removed: 2 });
    expect(existsSync(join(root, "Pack"))).toBe(false);
  });
});
