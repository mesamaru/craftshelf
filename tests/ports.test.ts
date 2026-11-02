// ポート管理の通しテスト(Pterodactyl は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { findProblems, rangeOf } from "~/lib/ports";
import { HttpError } from "~/server/guard";
import type { FetchLike } from "~/server/net";
import { numericEntries, portLike, readPort, writePort } from "~/server/port-config";
import { portService } from "~/server/ports";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";

// 2 台とも同じノード。Voice Chat の番号が重なっている
const disk: Record<string, Record<string, string>> = {
  lobby0001: {
    "server.properties": "motd=hi\nserver-port=20500\nrcon.port=25575\n",
    "plugins/voicechat/voicechat-server.properties": "# voice\nport=20453\nbind_address=\n",
    "plugins/Plan/config.yml": "Server:\n  Name: lobby\nWebserver:\n  Port: 8801\n  Alternative_IP:\n    Port: 8801\n",
    "plugins/Pl3xMap/config.yml": "settings:\n  internal-webserver:\n    enabled: true\n    port: 8080\n",
  },
  build0002: {
    "server.properties": "server-port=20512\n",
    "plugins/voicechat/voicechat-server.properties": "port=20453\n",
  },
};
const allocations: Record<string, { port: number; notes: string; is_default: boolean }[]> = {
  lobby0001: [{ port: 20500, notes: "", is_default: true }, { port: 20453, notes: "voice", is_default: false }],
  build0002: [{ port: 20512, notes: "", is_default: true }, { port: 19132, notes: "geyser", is_default: false }],
};
const writes: string[] = [];

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先");
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${KEY}`) return json({}, 401);
  if (u.pathname === "/api/client") {
    return json({ data: [{ attributes: { identifier: "lobby0001", name: "00-ロビー", node: "node-a" } }, { attributes: { identifier: "build0002", name: "22-建築", node: "node-a" } }], meta: { pagination: { total_pages: 1 } } });
  }
  const m = u.pathname.match(/^\/api\/client\/servers\/(\w+)\/(.+)$/);
  if (!m || !disk[m[1]]) return json({}, 404);
  const files = disk[m[1]];
  if (m[2] === "network/allocations") return json({ data: allocations[m[1]].map((a) => ({ attributes: { ip: "0.0.0.0", ip_alias: null, ...a } })) });
  if (m[2] === "files/contents") { const f = u.searchParams.get("file")!; return f in files ? new Response(files[f]) : json({}, 404); }
  if (m[2] === "files/write") { const f = u.searchParams.get("file")!; files[f] = String(init?.body); writes.push(`${m[1]}:${f}`); return new Response(null, { status: 204 }); }
  if (m[2] === "files/list") {
    const dir = u.searchParams.get("directory")!.replace(/^\/$/, "");
    const names = new Map<string, boolean>();
    for (const f of Object.keys(files)) if (f.startsWith(dir + "/")) { const rest = f.slice(dir.length + 1); names.set(rest.split("/")[0], !rest.includes("/")); }
    return json({ data: [...names].map(([name, isFile]) => ({ attributes: { name, size: 1, is_file: isFile } })) });
  }
  return json({}, 404);
};

const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

describe("設定ファイルの読み書き", () => {
  it("properties・YAML の入れ子・TOML のアドレス", () => {
    expect(readPort("a.properties", "port=20453\n", "port")?.port).toBe(20453);
    const yml = "Webserver:\n  Port: 8801\n  Alternative_IP:\n    Port: 9000\n";
    expect(readPort("c.yml", yml, "Webserver.Port")?.port).toBe(8801);
    expect(readPort("c.yml", yml, "Webserver.Alternative_IP.Port")?.port).toBe(9000);
    expect(readPort("velocity.toml", 'bind = "0.0.0.0:25577"\n[servers]\nlobby = "127.0.0.1:30066"\n', "bind")?.port).toBe(25577);
    expect(numericEntries("c.yml", "a: 99999\nb: notanumber\n")).toEqual([]);
  });
  it("書き換えは、その行の番号だけを変える", () => {
    const yml = "Webserver:\n  Port: 8801 # web\n  Alternative_IP:\n    Port: 8801\n";
    expect(writePort("c.yml", yml, "Webserver.Port", 8805)).toBe("Webserver:\n  Port: 8805 # web\n  Alternative_IP:\n    Port: 8801\n");
    expect(writePort("c.yml", yml, "Nope.Port", 1)).toBeNull();
  });
  it("ポートらしい項目だけを拾う", () => {
    expect(portLike("x.yml", "web:\n  port: 8123\n  threads: 4\nmax-players: 20\n").map((e) => e.key)).toEqual(["web.port"]);
  });
});

describe("範囲と重複", () => {
  const k = (o: object) => ({ id: "k", name: "ゲーム", mode: "free", start: null, size: null, rangeFrom: null, rangeTo: null, proto: "TCP", file: "", key: "", ...o });
  it("グループごとの範囲", () => {
    expect(rangeOf(k({ mode: "group", start: 20500, size: 10 }), { id: "g", number: "90", name: "Proxy" })).toEqual([20590, 20599]);
    expect(rangeOf(k({ mode: "fixed", rangeFrom: 8800, rangeTo: 8899 }), undefined)).toEqual([8800, 8899]);
  });
  it("別のマシンなら同じ番号でも重複にしない", () => {
    const p = (id: string, port: number) => ({ id, kindId: null, port, source: "manual", file: "", key: "", label: "", memo: "", ignored: false });
    const servers = [
      { id: "a", name: "A", groupId: null, machine: "m1", ports: [p("1", 25565)] },
      { id: "b", name: "B", groupId: null, machine: "m2", ports: [p("2", 25565)] },
      { id: "c", name: "C", groupId: null, machine: "m1", ports: [p("3", 25565)] },
    ];
    const probs = findProblems(servers, [], []);
    expect(probs.map((x) => x.serverId)).toEqual(["c"]);
  });
});

describe("ポート管理(サーバーから読み取る)", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let ports: ReturnType<typeof portService>;
  let owner: Headers;
  let viewer: Headers;
  let outsider: Headers;

  beforeAll(async () => {
    t = await setup();
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
    const servers = serverService(deps);
    ports = portService(deps);
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
    await servers.addServers(owner, c.id, ["lobby0001", "build0002"]);
    const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
    const cookie = await t.signUp("閲覧者", "viewer@example.com");
    await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
    await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
    viewer = t.headers(cookie);
    outsider = t.headers(await t.signUp("ほかの人", "other@example.com"));
  });

  it("初めは、よく使う種類が用意されている", async () => {
    const o = await ports.overview(owner);
    expect(o.kinds.map((k) => k.name)).toEqual(["ゲーム", "Bedrock", "Plan", "Voice Chat", "BlueMap", "RCON", "そのほか"]);
  });

  it("割り当て・設定ファイル・知らないプラグインから読み取り、同じノードの重複を見つける", async () => {
    const o = await ports.scan(owner);
    expect(o.failed).toEqual([]);
    const lobby = o.servers.find((s) => s.name === "00-ロビー")!;
    const kindName = (id: string | null) => o.kinds.find((k) => k.id === id)?.name;
    const live = lobby.ports.filter((p) => p.source !== "found").map((p) => `${kindName(p.kindId)}:${p.port}:${p.source}`).sort();
    expect(live).toEqual(["Plan:8801:file", "RCON:25575:file", "Voice Chat:20453:file", "ゲーム:20500:file"]);
    expect(lobby.ports.filter((p) => p.source === "found").map((p) => `${p.label}:${p.key}:${p.port}`)).toEqual(["Pl3xMap:settings.internal-webserver.port:8080"]);
    expect(lobby.machine).toBe(o.servers.find((s) => s.name === "22-建築")!.machine);
    // 22-建築 の割り当て 19132 は、設定ファイルに無いので「そのほか」
    const build = o.servers.find((s) => s.name === "22-建築")!;
    expect(build.ports.some((p) => p.port === 19132 && p.source === "allocation" && kindName(p.kindId) === "そのほか")).toBe(true);
    expect(o.problems.map((p) => `${p.type}:${p.port}`)).toEqual(["dup:20453"]);
  });

  it("番号を変えると設定ファイルも書き換え、重複する番号にはできない", async () => {
    let o = await ports.overview(owner);
    const build = o.servers.find((s) => s.name === "22-建築")!;
    const vc = build.ports.find((p) => p.port === 20453)!;
    expect(await code(ports.savePorts(owner, build.id, [{ id: vc.id, port: 25575 }]))).toBe(400); // ロビーの RCON と重なる
    o = await ports.savePorts(owner, build.id, [{ id: vc.id, port: 20455, memo: "建築用" }]);
    expect(disk.build0002["plugins/voicechat/voicechat-server.properties"]).toBe("port=20455\n");
    expect(o.problems).toEqual([]);
    // 割り当てのポートは、パネルで変える
    const alloc = build.ports.find((p) => p.source === "allocation")!;
    expect(await code(ports.savePorts(owner, build.id, [{ id: alloc.id, port: 19133 }]))).toBe(400);
    // 読み取り直すと、書き換えたファイルの番号が出る
    o = await ports.scan(owner, build.id);
    expect(o.servers.find((s) => s.id === build.id)!.ports.some((p) => p.port === 20455)).toBe(true);
  });

  it("手入力のポート・管理から外す", async () => {
    let o = await ports.overview(owner);
    const lobby = o.servers.find((s) => s.name === "00-ロビー")!;
    o = await ports.savePorts(owner, lobby.id, [{ port: 9225, memo: "用途不明" }]);
    const manual = o.servers.find((s) => s.id === lobby.id)!.ports.find((p) => p.source === "manual")!;
    expect(manual.port).toBe(9225);
    const rcon = o.servers.find((s) => s.id === lobby.id)!.ports.find((p) => p.port === 25575)!;
    await ports.savePorts(owner, lobby.id, [{ id: rcon.id, ignore: true }, { id: manual.id, remove: true }]);
    o = await ports.scan(owner, lobby.id);
    const after = o.servers.find((s) => s.id === lobby.id)!.ports;
    expect(after.filter((p) => p.port === 25575).map((p) => p.ignored)).toEqual([true]); // 読み直しても出てこない(外したまま)
    expect(after.some((p) => p.port === 9225)).toBe(false);
  });

  it("見つけたポートを、新しい種類として管理する", async () => {
    let o = await ports.overview(owner);
    const found = o.servers.flatMap((s) => s.ports).find((p) => p.source === "found")!;
    o = await ports.adoptFound(owner, found.id, { newKindName: "Pl3xMap" });
    const k = o.kinds.find((x) => x.name === "Pl3xMap")!;
    expect([k.file, k.key]).toEqual(["plugins/Pl3xMap/config.yml", "settings.internal-webserver.port"]);
    o = await ports.scan(owner);
    expect(o.servers.flatMap((s) => s.ports).filter((p) => p.kindId === k.id).map((p) => `${p.port}:${p.source}`)).toEqual(["8080:file"]);
  });

  it("種類とグループを並び順ごと保存し、グループごとの範囲で範囲外を見つける", async () => {
    let o = await ports.overview(owner);
    const game = o.kinds.find((k) => k.name === "ゲーム")!;
    o = await ports.saveRules(owner, {
      kinds: o.kinds.map((k) => (k.id === game.id ? { ...k, mode: "group", start: 20500, size: 10 } : k)).reverse(),
      groups: [{ number: "00", name: "ロビー" }, { number: "20", name: "開発鯖" }],
    });
    expect(o.kinds[0].name).not.toBe("ゲーム");
    const dev = o.groups.find((g) => g.name === "開発鯖")!;
    const build = o.servers.find((s) => s.name === "22-建築")!;
    o = await ports.setServerInfo(owner, build.id, { groupId: dev.id, memo: "きょうたん" });
    expect(o.problems.map((p) => `${p.type}:${p.port}`)).toContain("out:20512"); // 20 番台は 20520–20529
    expect(await code(ports.saveRules(owner, { kinds: [{ name: "x", mode: "fixed", rangeFrom: 9, rangeTo: 1, proto: "TCP", file: "", key: "" }], groups: [] }))).toBe(400);
    expect(await code(ports.saveRules(owner, { kinds: [{ name: "x", mode: "free", proto: "TCP", file: "../etc/passwd", key: "a" }], groups: [] }))).toBe(400);
  });

  it("権限とチーム", async () => {
    const o = await ports.overview(owner);
    const s = o.servers[0];
    expect(await code(ports.overview(viewer))).toBe(200);
    expect(await code(ports.savePorts(viewer, s.id, [{ port: 9000 }]))).toBe(403);
    expect(await code(ports.saveRules(viewer, { kinds: [], groups: [] }))).toBe(403);
    expect(await code(ports.savePorts(outsider, s.id, [{ port: 9000 }]))).toBe(404); // ほかのチームのサーバーは見つからない
    expect((await ports.overview(outsider)).servers).toEqual([]);
    expect(await code(ports.setServerInfo(outsider, s.id, { groupId: null, memo: "" }))).toBe(404);
  });
});
