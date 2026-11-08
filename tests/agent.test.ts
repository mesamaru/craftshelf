// エージェント: やりとりの列・登録とトークン・エージェントのサーバーをいつもの処理で操作する(エージェントは同じプロセスで動かす)
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handle, loadConf, makeClients, reportOf } from "~/agent/main";
import { agentHub } from "~/server/agent-hub";
import { agentService } from "~/server/agents";
import { fileService } from "~/server/files";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import { PteroError } from "~/server/ptero";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const root = mkdtempSync(join(tmpdir(), "cs-agent-srv-"));
mkdirSync(join(root, "plugins"));
writeFileSync(join(root, "paper-1.21.4.jar"), "x");
writeFileSync(join(root, "server.properties"), "motd=Home\n");
writeFileSync(join(root, "plugins", "Manual.jar"), "jar");

let t: Awaited<ReturnType<typeof setup>>;
const hub = agentHub();
let agents: ReturnType<typeof agentService>;
let owner: Headers;
let token = "";
let stop = false;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

// 同じプロセスで動かすエージェント(本物は HTTPS で取りに来る。ここでは列から直接取る)
async function runAgent(agentId: string) {
  const clients = makeClients(loadConf(JSON.stringify({ url: "https://craftshelf.example.com", token, servers: [{ key: "home", name: "家のサーバー", root }] })));
  await agents.checkIn(token, { version: "1.0.0", servers: reportOf(clients) });
  while (!stop) {
    for (const r of await hub.poll(agentId, 200)) {
      try {
        hub.result(agentId, r.id, true, (await handle(clients, r.method, r.args)) ?? null);
      } catch (e) {
        hub.result(agentId, r.id, false, null, (e as Error).message);
      }
    }
  }
}

beforeAll(async () => {
  t = await setup({ mode: "service" });
  agents = agentService({ db: t.db, auth: t.auth, secret: SECRET, fetch, agents: hub });
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
});
afterAll(() => { stop = true; });

describe("やりとりの列", () => {
  it("つながっていないエージェントには頼めない。ほかのエージェントは答えられない。返事が無ければ時間切れ", async () => {
    const h = agentHub();
    await expect(h.call("a1", "listFiles", {})).rejects.toBeInstanceOf(PteroError);
    void h.poll("a1", 10);
    const p = h.call("a1", "listFiles", { directory: "" }, 300);
    const [r] = await h.poll("a1", 100);
    expect(r.method).toBe("listFiles");
    expect(h.result("a2", r.id, true, [])).toBe(false);
    expect(h.result("a1", r.id, true, ["ok"])).toBe(true);
    expect(await p).toEqual(["ok"]);
    const late = h.call("a1", "listFiles", {}, 50);
    await expect(late).rejects.toThrow("返事がありませんでした");
  });
});

describe("エージェント", () => {
  it("登録すると 1 度だけトークンを見せる。間違ったトークンでは取りに来られない", async () => {
    const r = await agents.create(owner, "家");
    token = r.token;
    expect(token).toMatch(/^ca_/);
    expect(await agents.checkIn("ca_" + "x".repeat(43), {})).toBeNull();
    expect(await agents.checkIn(token, {})).toBe(r.id);
    const [a] = await agents.list(owner);
    expect(a).toMatchObject({ name: "家", tokenHint: token.slice(-4) });
    expect(JSON.stringify(await agents.list(owner))).not.toContain(token);
    void runAgent(r.id);
  });

  it("知らせてきたサーバーを足すと、いつもの処理(入っているもの・設定ファイル)がエージェントを通して動く", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const [a] = await agents.list(owner);
    expect(a.online).toBe(true);
    expect(a.servers).toEqual([{ key: "home", name: "家のサーバー", platform: "paper", mcVersion: "1.21.4", added: false }]);
    expect(await code(agents.addServer(owner, a.id, "nope"))).toBe(404);
    const { id } = await agents.addServer(owner, a.id, "home");
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch, agents: hub };
    expect((await serverService(deps).listServers(owner)).find((s) => s.id === id)).toMatchObject({ name: "家のサーバー", connection: "エージェント" });
    expect((await libraryService(deps).installed(owner, id)).items.map((i) => i.filename)).toEqual(["Manual.jar"]);
    const f = await fileService(deps).read(owner, id, "server.properties");
    await fileService(deps).save(owner, id, f.path, "motd=Changed\n", f.content);
    expect(readFileSync(join(root, "server.properties"), "utf8")).toBe("motd=Changed\n");
  });

  it("エージェントは、決まった操作・設定ファイルにあるサーバー・配布元からの取り込みだけを受け付ける", async () => {
    const clients = makeClients(loadConf(JSON.stringify({ url: "https://x.example.com", token, servers: [{ key: "home", root }] })));
    await expect(handle(clients, "exec", { key: "home" })).rejects.toThrow("この操作はできません");
    await expect(handle(clients, "listFiles", { key: "other", directory: "" })).rejects.toThrow("設定ファイルにありません");
    await expect(handle(clients, "pull", { key: "home", url: "https://evil.example.com/x.jar", directory: "plugins", filename: "x.jar" })).rejects.toThrow("配布元の外");
    await expect(handle(clients, "readFile", { key: "home", file: "../outside.txt" })).rejects.toThrow();
    expect(() => loadConf(JSON.stringify({ url: "http://craftshelf.example.com", token, servers: [{ key: "a", root }] }))).toThrow("https");
  });

  it("エージェントを消すと、足したサーバーも一覧から外れる", async () => {
    const [a] = await agents.list(owner);
    await agents.remove(owner, a.id);
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch, agents: hub };
    expect((await serverService(deps).listServers(owner)).some((s) => s.connection === "エージェント")).toBe(false);
  });
});
