// 更新の確かめで、配布元の「いちばん新しい版」を短く覚える(outdatedServers・updatesOf が同じ組を何度も問い合わせない)。
// 覚えた結果が使われる・捨てたあとは取り直す・チームが違えば別。Pterodactyl と Modrinth は偽物の応答で代わりをする
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LATEST_MEMO, forgetLatest, libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const PID = "Vebnzrzj";

const files = new Map<string, string[]>([["plugins", []]]);
let latest = { id: "ver00001", number: "1.0.0" };
let upstream = 0; // 配布元(Modrinth)の「版の一覧」への問い合わせ

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (u.pathname === `/v2/project/${PID}`) return json({ title: "LuckPerms", slug: "luckperms", project_type: "plugin" });
    if (u.pathname === `/v2/project/${PID}/version`) {
      upstream++;
      const filename = `LuckPerms-${latest.number}.jar`;
      return json([{ id: latest.id, version_number: latest.number, version_type: "release", date_published: "2026-01-01",
        files: [{ primary: true, filename, url: `https://cdn.modrinth.com/data/${PID}/versions/${latest.id}/${filename}`, size: 1, hashes: { sha512: "x" } }] }]);
    }
    return json({}, 404);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先");
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${KEY}`) return json({}, 401);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "サバイバル" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/files\/(list|pull|delete|rename)$/);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (m?.[1] === "list") return json({ data: (files.get(u.searchParams.get("directory")!) ?? []).map((name) => ({ attributes: { name, size: 1, is_file: true } })) });
  if (m?.[1] === "pull") {
    files.set(body.directory, [...(files.get(body.directory) ?? []).filter((f) => !f.startsWith("LuckPerms-")), body.filename]);
    return new Response(null, { status: 204 });
  }
  if (m?.[1] === "delete") {
    files.set(body.root, (files.get(body.root) ?? []).filter((f) => !body.files.includes(f)));
    return new Response(null, { status: 204 });
  }
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let owner: Headers;
let other: Headers; // 別のチーム
let id: string;
let otherId: string;
let itemId: string;
const teamOf = async (h: Headers) => (await t.auth.api.getSession({ headers: h }))!.session.activeOrganizationId!;

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  const servers = serverService(deps);
  lib = libraryService(deps);
  const connect = async (h: Headers) => {
    const c = await servers.addConnection(h, { name: "", url: "panel.example.com", apiKey: KEY });
    await servers.addServers(h, c.id, ["abcd1234"]);
    const sid = (await servers.listServers(h))[0].id;
    await lib.setProfile(h, sid, { platform: "paper", mcVersion: "1.21.1" });
    return sid;
  };
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  other = t.headers(await t.signUp("別のチーム", "other@example.com"));
  id = await connect(owner);
  otherId = await connect(other);
});

const keep = LATEST_MEMO.ms;
afterEach(() => {
  LATEST_MEMO.ms = keep;
  vi.useRealTimers();
});
// いちばん新しい版を version にして、サーバーに入れ(入れる版は覚えたものを使わない)、覚えたものを捨てて、数え直す
async function start(version: string, ...who: [Headers, string][]) {
  latest = { id: `ver${version}`, number: version };
  for (const [h, sid] of who.length ? who : [[owner, id] as [Headers, string]]) {
    await lib.install(h, sid, PID);
    forgetLatest(await teamOf(h));
  }
  itemId = (await lib.catalog(owner)).items[0].id;
  upstream = 0;
}

describe("配布元の「いちばん新しい版」の記憶", () => {
  it("outdatedServers と updates は、同じ組を 1 回だけ問い合わせる。覚えたあとは問い合わせない", async () => {
    await start("1.0.0");
    expect(await lib.outdatedServers(owner)).toEqual([]);
    expect(upstream).toBe(1);
    expect(await lib.updates(owner, id)).toEqual([]);
    expect(await lib.outdatedServers(owner)).toEqual([]);
    expect(await lib.outdated(owner)).toEqual([]);
    expect(upstream).toBe(1);
  });

  it("覚えているあいだに新しい版が出ても、記憶の長さが過ぎたら取り直して「更新あり」にする", async () => {
    await start("1.0.1");
    vi.useFakeTimers({ toFake: ["Date"] });
    await lib.updates(owner, id);
    expect(upstream).toBe(1);
    latest = { id: "ver1.1.0", number: "1.1.0" };
    vi.advanceTimersByTime(LATEST_MEMO.ms - 1000);
    expect(await lib.updates(owner, id)).toEqual([]); // まだ覚えたものを使う
    expect(upstream).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(await lib.updates(owner, id)).toMatchObject([{ current: "1.0.1", latest: "1.1.0" }]);
    expect(upstream).toBe(2);
  });

  it("今すぐ確認(fresh)は覚えたものを使わず、取り直した結果を覚える", async () => {
    await start("1.2.0");
    await lib.outdatedServers(owner);
    latest = { id: "ver1.3.0", number: "1.3.0" };
    expect(await lib.outdatedServers(owner)).toEqual([]);
    expect(await lib.outdatedServers(owner, true)).toEqual([{ itemId, serverIds: [id] }]);
    expect(await lib.outdated(owner)).toEqual([itemId]);
    expect(upstream).toBe(2);
  });

  it("入れる・更新するあと、更新を止める・やめるあと、受け取る版・ライブラリの情報を変えたあとは、捨てて取り直す", async () => {
    await start("1.4.0");
    await lib.updates(owner, id);
    expect(upstream).toBe(1);
    await lib.install(owner, id, PID); // 入れる版は覚えたものを使わず選ぶ
    expect(upstream).toBe(2);
    latest = { id: "ver1.5.0", number: "1.5.0" };
    expect(await lib.updates(owner, id)).toMatchObject([{ latest: "1.5.0" }]); // 入れたあとに捨てたので取り直す
    expect(upstream).toBe(3);
    latest = { id: "ver1.6.0", number: "1.6.0" };
    await lib.setHold(owner, id, "modrinth", PID, true);
    await lib.setHold(owner, id, "modrinth", PID, false);
    expect(await lib.updates(owner, id)).toMatchObject([{ latest: "1.6.0" }]);
    latest = { id: "ver1.7.0", number: "1.7.0" };
    await lib.setChannel(owner, "all");
    expect(await lib.updates(owner, id)).toMatchObject([{ latest: "1.7.0" }]);
    await lib.setChannel(owner, "release");
    latest = { id: "ver1.8.0", number: "1.8.0" };
    await lib.editItem(owner, itemId, { projectType: "plugin", loaders: null, mcVersions: null, channel: "" });
    expect(await lib.updates(owner, id)).toMatchObject([{ latest: "1.8.0" }]);
  });

  it("チームが違えば別(ほかのチームの結果を使わない・捨てない)", async () => {
    await start("2.0.0", [owner, id], [other, otherId]);
    await lib.updates(owner, id);
    expect(upstream).toBe(1);
    await lib.updates(other, otherId);
    expect(upstream).toBe(2); // ほかのチームが覚えたものは使わない
    latest = { id: "ver2.1.0", number: "2.1.0" };
    await lib.install(owner, id, PID); // owner のチームだけ捨てる(入れる版を選ぶ分で +1)
    expect(upstream).toBe(3);
    expect(await lib.updates(other, otherId)).toEqual([]); // other の記憶(2.0.0)はそのまま。取り直していれば「更新あり」になる
    expect(upstream).toBe(3);
    expect(await lib.updates(owner, id)).toEqual([]);
    expect(upstream).toBe(4);
  });

  it("記憶の長さが 0 なら使わない", async () => {
    await start("2.2.0");
    LATEST_MEMO.ms = 0;
    await lib.updates(owner, id);
    await lib.updates(owner, id);
    expect(upstream).toBe(2);
  });
});
