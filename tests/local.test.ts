// フォルダでつなぐサーバー(自分用の版だけ)。本物のフォルダ・偽の Modrinth / Spiget・偽の RCON で確かめる
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileService } from "~/server/files";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import { detectFromJar } from "~/server/local";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const PID = "Vebnzrzj";
const dataDir = mkdtempSync(join(tmpdir(), "cs-data-"));
const root = mkdtempSync(join(tmpdir(), "cs-srv-"));
writeFileSync(join(root, "paper-1.21.4-123.jar"), "");
mkdirSync(join(root, "plugins"));

const fake: FetchLike = async (url) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (u.pathname === `/v2/project/${PID}`) return json({ title: "LuckPerms", slug: "luckperms", project_type: "plugin" });
    if (u.pathname === `/v2/project/${PID}/version`) {
      return json([{ id: "ver00001", version_number: "5.4.0", version_type: "release", date_published: "2026-01-01", loaders: ["paper"],
        files: [{ primary: true, filename: "LuckPerms-5.4.0.jar", url: `https://cdn.modrinth.com/data/${PID}/LuckPerms-5.4.0.jar`, size: 4, hashes: {} }] }]);
    }
  }
  if (u.host === "cdn.modrinth.com") return new Response("jar!");
  if (u.host === "api.spiget.org") {
    if (u.pathname === "/v2/resources/28140") return json({ id: 28140, name: "LuckPerms", tag: "", downloads: 1, external: false, premium: false, category: { id: 21 }, version: { id: 1 } });
    if (u.pathname === "/v2/resources/28140/versions/latest") return json({ id: 1, name: "5.5.71" });
    if (u.pathname === "/v2/resources/28140/download") return new Response(null, { status: 302, headers: { location: "https://cdn.spiget.org/file/spiget-resources/28140.jar" } });
  }
  if (u.host === "cdn.spiget.org") return new Response("spigot jar");
  return json({}, 404);
};

// 偽の RCON(パスワード "secret" のときだけ通し、受けたコマンドを覚える)
const rconGot: string[] = [];
const rconServer = createServer((sock) => {
  sock.on("data", (d: Buffer) => {
    const id = d.readInt32LE(4);
    const type = d.readInt32LE(8);
    const body = d.subarray(12, d.length - 2).toString();
    const reply = (rid: number, text: string) => {
      const b = Buffer.from(text);
      const p = Buffer.alloc(14 + b.length);
      p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(rid, 4); p.writeInt32LE(0, 8); b.copy(p, 12);
      sock.write(p);
    };
    if (type === 3) reply(body === "secret" ? id : -1, "");
    else { rconGot.push(body); reply(id, "ok"); }
  });
});
let rconPort = 0;

let t: Awaited<ReturnType<typeof setup>>;
let servers: ReturnType<typeof serverService>;
let lib: ReturnType<typeof libraryService>;
let files: ReturnType<typeof fileService>;
let owner: Headers;
let editor: Headers;
let id: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  await new Promise<void>((r) => rconServer.listen(0, "127.0.0.1", () => r()));
  rconPort = (rconServer.address() as { port: number }).port;
  writeFileSync(join(root, "server.properties"), `motd=Hello\nserver-port=25570\nrcon.port=${rconPort}\n`);
  t = await setup({ mode: "self" });
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } };
  servers = serverService(deps);
  lib = libraryService(deps);
  files = fileService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const inv = await (await t.call("/organization/invite-member", { email: "editor@example.com", role: "editor" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("編集者", "editor@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  editor = t.headers(cookie);
});
afterAll(() => rconServer.close());

describe("jar の名前から種類とバージョン", () => {
  it("よくある名前を読み取る", () => {
    expect(detectFromJar("paper-1.21.4-123.jar")).toEqual({ platform: "paper", mcVersion: "1.21.4" });
    expect(detectFromJar("fabric-server-mc.1.21.1-loader.0.16.9-launcher.1.0.1.jar")).toEqual({ platform: "fabric", mcVersion: "1.21.1" });
    expect(detectFromJar("purpur-26.3-2400.jar")).toEqual({ platform: "purpur", mcVersion: "26.3" });
    expect(detectFromJar("velocity-3.4.0.jar")).toEqual({ platform: "velocity", mcVersion: null });
    expect(detectFromJar("server.jar")).toEqual({ platform: null, mcVersion: null });
  });
});

describe("フォルダのサーバーを追加する", () => {
  it("管理者以上だけ。パネルのデータのフォルダ・無いフォルダ・相対パスは断る", async () => {
    expect(await code(servers.addLocal(editor, { rootDir: root, name: "" }))).toBe(403);
    expect(await code(servers.addLocal(owner, { rootDir: dataDir, name: "" }))).toBe(400);
    expect(await code(servers.addLocal(owner, { rootDir: join(root, "nope"), name: "" }))).toBe(400);
    expect(await code(servers.addLocal(owner, { rootDir: "relative/dir", name: "" }))).toBe(400);
  });

  it("jar から種類とバージョンを決める。同じフォルダは 2 度追加できない", async () => {
    const r = await servers.addLocal(owner, { rootDir: root, name: "家のサーバー" });
    id = r.id;
    expect(r.profile).toEqual({ platform: "paper", mcVersion: "1.21.4" });
    expect((await servers.listServers(owner)).map((s) => [s.name, s.connection])).toEqual([["家のサーバー", "フォルダ"]]);
    expect(await code(servers.addLocal(owner, { rootDir: root, name: "" }))).toBe(400);
    expect((await servers.browseHost(owner, root)).entries.map((e) => e.name)).toEqual(["plugins", "paper-1.21.4-123.jar"]);
  });

  it("自分用の版でなければ使えない", async () => {
    const svc = serverService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake });
    expect(await code(svc.addLocal(owner, { rootDir: root, name: "" }))).toBe(400);
    expect(await code(libraryService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake }).installed(owner, id))).toBe(400);
  });
});

describe("フォルダのサーバーのアドオンとファイル", () => {
  it("Modrinth・SpigotMC から取ってきて plugins に置き、外せる", async () => {
    await lib.install(owner, id, PID);
    expect(readFileSync(join(root, "plugins", "LuckPerms-5.4.0.jar"), "utf8")).toBe("jar!");
    await lib.install(owner, id, "28140", "spigot");
    expect(readFileSync(join(root, "plugins", "LuckPerms-5.5.71.jar"), "utf8")).toBe("spigot jar"); // Spiget → CDN の転送を追う
    expect((await lib.installed(owner, id)).items.map((i) => i.filename)).toEqual(["LuckPerms-5.4.0.jar", "LuckPerms-5.5.71.jar"]);
    await lib.remove(owner, id, "LuckPerms-5.4.0.jar");
    expect(existsSync(join(root, "plugins", "LuckPerms-5.4.0.jar"))).toBe(false);
  });

  it("設定ファイルを開いて直せる。フォルダの外は扱えない", async () => {
    const f = await files.read(owner, id, "server.properties");
    await files.save(owner, id, f.path, f.content.replace("Hello", "ようこそ"), f.content);
    expect(readFileSync(join(root, "server.properties"), "utf8")).toContain("motd=ようこそ");
    expect(await code(files.read(owner, id, "../etc/passwd.txt"))).toBe(400);
  });
});

describe("起動・停止・RCON", () => {
  it("設定は管理者以上。複数行のコマンドは断る。パスワードは返さない", async () => {
    expect(await code(servers.setLocalSettings(editor, id, { control: "command", startCmd: "x", stopCmd: "", container: "", rconPort: null }))).toBe(403);
    expect(await code(servers.setLocalSettings(owner, id, { control: "command", startCmd: "a\nb", stopCmd: "", container: "", rconPort: null }))).toBe(400);
    expect(await code(servers.setLocalSettings(owner, id, { control: "ssh", startCmd: "", stopCmd: "", container: "", rconPort: null }))).toBe(400);
    await servers.setLocalSettings(owner, id, { control: "command", startCmd: `node -e "require('fs').writeFileSync('started','1')"`, stopCmd: "", container: "", rconPort: null, rconPassword: "secret" });
    const s = await servers.localSettings(owner, id);
    expect(s).toMatchObject({ control: "command", hasRconPassword: true });
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("起動のコマンドをサーバーのフォルダで動かす。RCON でコマンド・停止・状態がわかる", async () => {
    await servers.power(editor, id, "start");
    for (let i = 0; i < 50 && !existsSync(join(root, "started")); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(join(root, "started"))).toBe(true);
    await files.command(editor, id, "say こんにちは");
    await servers.power(editor, id, "stop"); // 停止のコマンドが無ければ RCON の stop
    expect(rconGot).toEqual(["say こんにちは", "stop"]);
    expect((await servers.status(owner, id)).state).toBe("running");
  });
});

describe("ファイル比較(フォルダのサーバー)", () => {
  it("中身を読んで、基準と違う行を数える(大きさが同じでも)。1 台だけにあるものは数えない", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "cs-srv2-"));
    writeFileSync(join(root2, "paper-1.21.4-123.jar"), "");
    const props = readFileSync(join(root, "server.properties"), "utf8");
    writeFileSync(join(root2, "server.properties"), props.replace("server-port=25570", "server-port=25571"));
    writeFileSync(join(root, "bukkit.yml"), "a: 1\n");
    writeFileSync(join(root2, "bukkit.yml"), "a: 1\r\n");
    mkdirSync(join(root2, "plugins", "Foo"), { recursive: true });
    writeFileSync(join(root2, "plugins", "Foo", "config.yml"), "x: 1\n");
    const { id: id2 } = await servers.addLocal(owner, { rootDir: root2, name: "二台目" });
    const r = await files.configs(owner, [id, id2]);
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(by["server.properties"]).toMatchObject({ lines: 1, same: false });
    expect(by["bukkit.yml"]).toMatchObject({ lines: 0, same: true }); // 改行コードの違いは見ない
    expect(by["plugins/Foo/config.yml"]).toMatchObject({ on: [id2], lines: null, same: false, sizes: [null, 5] });
  });
});
