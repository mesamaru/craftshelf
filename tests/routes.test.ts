// 独自のルート(src/routes/api/**)と REST API の、エラーの返し方・本文の読み方。
// ビルドすると束が 2 つに分かれて HttpError のクラスも 2 つでき、instanceof では見分けられない(03.67.01 まで、エラーがみな 500 になっていた)。
// テストは束ねずに動くので、別の束の HttpError は「同じ名前の別のクラス」で代わりをする
import { beforeAll, describe, expect, it, vi } from "vitest";
import { HttpError, isHttpError, readBody } from "~/server/guard";
import { handleRest } from "~/server/rest";
import { setup } from "./helpers";

// 別の束にある HttpError の代わり
class OtherHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

// ルートが読む ~/server/instance の代わり(認証だけ本物)
const inst = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock("~/server/instance", () => ({
  get auth() { return inst.auth; },
  get modpacks() { return inst.modpacks; },
  get backups() { return inst.backups; },
  get saved() { return inst.saved; },
  get agents() { return inst.agents; },
  get hub() { return inst.hub; },
}));

let t: Awaited<ReturnType<typeof setup>>;
let owner: Headers;
const calls: string[] = [];

beforeAll(async () => {
  t = await setup();
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  inst.auth = t.auth;
  inst.modpacks = { import: async (_h: Headers, _f: string, data: Uint8Array) => { calls.push(`modpack:${data.byteLength}`); throw new OtherHttpError(400, "Modpack として読めません"); } };
  inst.backups = { restoreUpload: async () => { calls.push("restore"); throw new OtherHttpError(400, "CraftShelf v03 のバックアップではありません"); } };
  inst.saved = { zip: async () => { throw new OtherHttpError(404, "セットが見つかりません"); } };
  inst.agents = { verify: async () => null, checkIn: async () => null };
});

// 読まれた分を数える本文(chunk ずつ、total まで)
function counted(total: number, chunk = 64 * 1024) {
  const state = { read: 0 };
  const piece = new Uint8Array(chunk);
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.read >= total) return c.close();
      state.read += chunk;
      c.enqueue(piece);
    },
  });
  return { body, state };
}
const post = (url: string, body: ReadableStream<Uint8Array> | string, headers: Headers = new Headers()) =>
  new Request(`http://localhost:3000${url}`, { method: "POST", body, headers, duplex: "half" } as RequestInit);
const handlerOf = async (path: string) => {
  const m = (await import(path)) as { Route: { options: { server: { handlers: { POST: (x: { request: Request }) => Promise<Response> } } } } };
  return m.Route.options.server.handlers.POST;
};

describe("HttpError の見分け方", () => {
  it("名前と status で見分ける(別の束のクラスでも)。ほかのエラーは HttpError にしない", () => {
    expect(isHttpError(new HttpError(404, "x"))).toBe(true);
    expect(isHttpError(new OtherHttpError(403, "x"))).toBe(true);
    expect(isHttpError(new Error("x"))).toBe(false);
    expect(isHttpError(Object.assign(new Error("x"), { status: "404" }))).toBe(false);
    expect(isHttpError(null)).toBe(false);
  });

  it("REST API は、別の束の HttpError でもその status で返す", async () => {
    const services = { library: { outdatedServers: async () => { throw new OtherHttpError(404, "見つかりません"); } } } as unknown as Parameters<typeof handleRest>[0];
    const r = await handleRest(services, new Request("http://x/api/v1/library/outdated-servers", { headers: { "x-api-key": "cs_x" } }), "/library/outdated-servers");
    expect(r.status).toBe(404);
    expect((await r.json()).message).toBe("見つかりません");
  });
});

describe("アップロードを受け取るルート", () => {
  it("ログインしていなければ、本文を読む前に断る(Modpack・バックアップ)", async () => {
    for (const path of ["~/routes/api/modpack", "~/routes/api/backup/restore"]) {
      const { body, state } = counted(20 * 1024 * 1024);
      const res = await (await handlerOf(path))({ request: post("/api/modpack?filename=a.mrpack", body) });
      expect(res.status, path).toBe(401);
      expect(state.read, path).toBeLessThan(1024 * 1024);
    }
    expect(calls).toEqual([]);
  });

  it("上限を超えたら、大きさを知らせていなくても途中で読むのをやめる", async () => {
    const { body, state } = counted(200 * 1024 * 1024);
    await expect(readBody(post("/x", body), 1024 * 1024)).rejects.toMatchObject({ status: 400 });
    expect(state.read).toBeLessThan(2 * 1024 * 1024);
    expect(new TextDecoder().decode(await readBody(post("/x", "abc"), 10))).toBe("abc");
  });

  it("中身の間違いは、別の束の HttpError でも理由の文で返す", async () => {
    const res = await (await handlerOf("~/routes/api/modpack"))({ request: post("/api/modpack?filename=a.mrpack", "not a zip", owner) });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("Modpack として読めません");
    expect(calls).toEqual(["modpack:9"]);
  });

  it("zip のフォームも、ログインを確かめてから読む", async () => {
    const { body, state } = counted(20 * 1024 * 1024);
    const zip = (await import("~/routes/api/library/zip")) as unknown as { Route: { options: { server: { handlers: { POST: (x: { request: Request }) => Promise<Response> } } } } };
    const res = await zip.Route.options.server.handlers.POST({ request: post("/api/library/zip", body) });
    expect(res.status).toBe(401);
    expect(state.read).toBeLessThan(1024 * 1024);
    const h = new Headers(owner);
    h.set("content-type", "application/x-www-form-urlencoded");
    const ok = await zip.Route.options.server.handlers.POST({ request: post("/api/library/zip", "set=abc", h) });
    expect(ok.status).toBe(404);
  });

  it("エージェントの口も、トークンを確かめてから読む", async () => {
    for (const path of ["~/routes/api/agent/poll", "~/routes/api/agent/result"]) {
      const { body, state } = counted(20 * 1024 * 1024);
      const res = await (await handlerOf(path))({ request: post("/api/agent/poll", body, new Headers({ authorization: "Bearer ca_wrong" })) });
      expect(res.status, path).toBe(401);
      expect(state.read, path).toBeLessThan(1024 * 1024);
    }
  });
});
