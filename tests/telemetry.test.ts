// 開発者への利用状況の送信(同意したときだけ)とお問い合わせ(受け口は偽物の応答で代わりをする)
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import type { FetchLike } from "~/server/net";
import { telemetryService } from "~/server/telemetry";
import { setup } from "./helpers";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const sent: { path: string; body: Record<string, unknown> }[] = [];
const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  if (u.host !== "craftshelf-telemetry.mesamaru.workers.dev") throw new Error("想定外の接続先: " + url);
  sent.push({ path: u.pathname, body: JSON.parse(String(init!.body)) });
  return Response.json({ ok: true });
};
const dataDir = mkdtempSync(join(tmpdir(), "cs-tele-"));
mkdirSync(join(dataDir, "v03"), { recursive: true });

let t: Awaited<ReturnType<typeof setup>>;
let tele: ReturnType<typeof telemetryService>;
let owner: Headers;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup({ mode: "self" });
  tele = telemetryService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } });
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
});

describe("利用状況の送信", () => {
  it("同意するまでは送らない。送る内容は v02 と同じ項目だけ(名前などは入らない)", async () => {
    expect(await tele.sendIfDue()).toBe(false);
    const info = await tele.info(owner);
    expect(info).toMatchObject({ available: true, enabled: false, asked: false });
    expect(Object.keys(info.preview).sort()).toEqual(["arch", "categories", "channel", "features", "install_id", "items", "lang", "mode", "os", "servers", "sets", "storage", "users", "version"]);
    expect(info.preview).toMatchObject({ users: "1-9", servers: "0", channel: "dev", storage: ["local"] });
    expect(JSON.stringify(info.preview)).not.toContain("オーナー");
    expect(sent).toEqual([]);
  });

  it("同意するとすぐに 1 回送り、1 日たつまでは送らない。同じ ID を使い続ける", async () => {
    await tele.set(owner, true);
    expect(sent.map((s) => s.path)).toEqual(["/v1/ping"]);
    expect(await tele.sendIfDue()).toBe(false);
    const id = sent[0].body.install_id;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect((await tele.info(owner)).preview.install_id).toBe(id);
  });
});

describe("お問い合わせ", () => {
  it("内容が短すぎるものは断り、種類・内容・宛先を送る", async () => {
    expect(await code(tele.feedback(owner, { kind: "bug", message: " ", contact: "", includeEnv: false }))).toBe(400);
    await tele.feedback(owner, { kind: "bug", message: "動きません", contact: "me", includeEnv: false });
    expect(sent.at(-1)).toEqual({ path: "/v1/feedback", body: { kind: "bug", message: "動きません", contact: "me" } });
  });
});
