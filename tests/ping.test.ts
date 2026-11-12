// Minecraft の Server List Ping(人数・名前の一部・応答の速さ)。偽の Minecraft サーバーを手元のポートで動かして確かめる
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handle, loadConf, makeClients } from "~/agent/main";
import { HttpError } from "~/server/guard";
import { gamePort, parseStatus, ping } from "~/server/mcping";
import { isPublicAddress } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const varint = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
const STATUS = { version: { name: "Paper 1.21.4" }, players: { online: 2, max: 20, sample: [{ name: "Steve" }, { name: "Alex" }, { name: "<b>悪い名前</b>" }] }, description: { text: "§aようこそ", extra: [{ text: " ロビー" }] } };
let mc: Server;
let port = 0;
let handshakes = 0;

beforeAll(async () => {
  // 受け取ったものは読み捨て、状態の JSON を 2 つに分けて返す(途中で切れた応答を待てるか)
  mc = createServer((sock) => {
    sock.once("data", () => {
      handshakes++;
      const body = Buffer.from(JSON.stringify(STATUS), "utf8");
      const payload = Buffer.concat([varint(0), varint(body.length), body]);
      const packet = Buffer.concat([varint(payload.length), payload]);
      sock.write(packet.subarray(0, 10));
      setTimeout(() => sock.end(packet.subarray(10)), 20);
    });
  });
  await new Promise<void>((r) => mc.listen(0, "127.0.0.1", () => r()));
  port = (mc.address() as { port: number }).port;
});
afterAll(() => mc.close());

describe("Server List Ping", () => {
  it("人数・最大・名前の一部・バージョン・MOTD・応答の速さを読む(名前に使えない文字のものは出さない)", async () => {
    const p = await ping("127.0.0.1", port);
    expect(p).toMatchObject({ online: 2, max: 20, sample: ["Steve", "Alex"], version: "Paper 1.21.4", motd: "ようこそ ロビー" });
    expect(p.latency).toBeGreaterThanOrEqual(0);
  });

  it("サービス版は、公開されていないアドレスにはつながない", async () => {
    const before = handshakes;
    await expect(ping("127.0.0.1", port, { publicOnly: isPublicAddress })).rejects.toThrow("公開されていない");
    await expect(ping("localhost", port, { publicOnly: isPublicAddress })).rejects.toThrow();
    expect(handshakes).toBe(before);
  });

  it("つながらない・ポートが正しくないときは失敗する", async () => {
    await expect(ping("127.0.0.1", 0)).rejects.toThrow("ポート");
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const p = (closed.address() as { port: number }).port;
    closed.close();
    await expect(ping("127.0.0.1", p, { timeoutMs: 1000 })).rejects.toThrow();
  });

  it("server.properties のポート・応答の JSON の読み方", () => {
    expect(gamePort("motd=x\nserver-port=25570\n")).toBe(25570);
    expect(gamePort(null)).toBe(25565);
    expect(parseStatus(JSON.stringify({ description: "§l太字" }), 5)).toMatchObject({ online: 0, max: 0, sample: [], motd: "太字", latency: 5 });
  });
});

describe("サーバーの状態に人数を出す", () => {
  const root = mkdtempSync(join(tmpdir(), "cs-ping-"));
  it("フォルダのサーバーは 127.0.0.1 の server.properties のポートに問い合わせ、応答があれば動いているとみなす", async () => {
    writeFileSync(join(root, "server.properties"), `server-port=${port}\n`);
    const t = await setup();
    const servers = serverService({ db: t.db, auth: t.auth, secret: "test-secret-0123456789-0123456789-abcd", fetch: async () => { throw new Error("つながない"); }, local: { dataDir: mkdtempSync(join(tmpdir(), "cs-pdata-")) } });
    const owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    const { id } = await servers.addLocal(owner, { rootDir: root, name: "家" });
    const st = await servers.status(owner, id);
    expect(st.state).toBe("running");
    expect(st.ping).toMatchObject({ online: 2, max: 20, sample: ["Steve", "Alex"] });
    const outsider = t.headers(await t.signUp("ほか", "other@example.com"));
    await expect(servers.status(outsider, id)).rejects.toSatisfy((e) => e instanceof HttpError && e.status === 404);
    writeFileSync(join(root, "server.properties"), "server-port=1\n");
    vi.useFakeTimers({ toFake: ["Date"] }); // 状態は 5 秒覚えている。覚えが切れたあとは、ポートの変更が見える
    vi.setSystemTime(Date.now() + 6000);
    expect(await servers.status(owner, id)).toMatchObject({ state: "offline", ping: null });
    vi.useRealTimers();
  });

  it("エージェントは、自分のサーバーのポートにだけ問い合わせる", async () => {
    writeFileSync(join(root, "server.properties"), `server-port=${port}\n`);
    const token = "ca_" + "a".repeat(43);
    const clients = makeClients(loadConf(JSON.stringify({ url: "https://x.example.com", token, servers: [{ key: "home", root }] })));
    expect(await handle(clients, "ping", { key: "home", host: "203.0.113.1", port: 1 })).toMatchObject({ online: 2 });
  });
});
