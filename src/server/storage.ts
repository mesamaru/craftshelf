// アップロードしたアドオンの保存先: フォルダ(NAS をマウントしたものでもよい)・WebDAV。
// 中の場所(key)はこのアプリが作る相対パスだけ(.. や先頭の / は断る)
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { FetchLike } from "./net";

export class StorageError extends Error {}
export type StorageConfig = { kind: "local"; path: string } | { kind: "webdav"; url: string; user: string; password: string };
export type Store = { put(key: string, data: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array>; remove(key: string): Promise<void>; test(): Promise<void> };

const cleanKey = (key: string) => {
  const k = key.replace(/\\/g, "/");
  if (!k || k.startsWith("/") || k.split("/").some((x) => !x || x === "." || x === "..")) throw new StorageError("保存先の中の場所が正しくありません");
  return k;
};

export function localStore(path: string): Store {
  if (!isAbsolute(path)) throw new StorageError("フォルダの場所は、/ から始まる絶対パスで入力してください");
  const root = resolve(path);
  const full = (key: string) => {
    const f = resolve(root, cleanKey(key));
    if (!f.startsWith(root + sep)) throw new StorageError("保存先の外は扱えません");
    return f;
  };
  return {
    async put(key, data) {
      const f = full(key);
      await mkdir(dirname(f), { recursive: true });
      const tmp = `${f}.part`;
      await writeFile(tmp, data);
      await rename(tmp, f);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(full(key)));
      } catch {
        throw new StorageError("保存先にファイルが見つかりません");
      }
    },
    async remove(key) {
      await unlink(full(key)).catch((e) => { if (e?.code !== "ENOENT") throw new StorageError("保存先のファイルを消せませんでした"); });
    },
    async test() {
      try {
        await mkdir(root, { recursive: true });
        const f = join(root, ".craftshelf-test");
        await writeFile(f, "ok");
        await rm(f, { force: true });
      } catch {
        throw new StorageError("このフォルダに書き込めません(場所と、書き込みの権限を確かめてください)");
      }
    },
  };
}

export function webdavStore(url: string, user: string, password: string, fetch: FetchLike): Store {
  let base: URL;
  try {
    base = new URL(url.endsWith("/") ? url : `${url}/`);
  } catch {
    throw new StorageError("WebDAV の URL が正しくありません");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new StorageError("WebDAV の URL は http(s)://… で、ユーザー名・パスワードは別に入力してください");
  const auth = user ? { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` } : {};
  const at = (key: string) => new URL(cleanKey(key).split("/").map(encodeURIComponent).join("/"), base).toString();
  const call = async (method: string, target: string, body?: Uint8Array, headers: Record<string, string> = {}) => {
    try {
      return await fetch(target, { method, headers: { ...auth, ...headers }, body, signal: AbortSignal.timeout(120_000) } as RequestInit);
    } catch {
      throw new StorageError("WebDAV に接続できません(URL を確かめてください)");
    }
  };
  const check = (res: Response, what: string) => {
    if (res.status === 401 || res.status === 403) throw new StorageError("WebDAV のユーザー名かパスワードが違うか、書き込む権限がありません");
    if (!res.ok) throw new StorageError(`WebDAV で${what}できませんでした(HTTP ${res.status})`);
  };
  // 上のフォルダを順に作る(あれば 405 が返るので気にしない)
  const mkdirs = async (key: string) => {
    const parts = cleanKey(key).split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const res = await call("MKCOL", new URL(parts.slice(0, i).map(encodeURIComponent).join("/") + "/", base).toString());
      if (res.status === 401 || res.status === 403) check(res, "フォルダを作成");
    }
  };
  return {
    async put(key, data) {
      await mkdirs(key);
      check(await call("PUT", at(key), data, { "Content-Type": "application/octet-stream" }), "保存");
    },
    async get(key) {
      const res = await call("GET", at(key));
      if (res.status === 404) throw new StorageError("保存先にファイルが見つかりません");
      check(res, "読み込み");
      return new Uint8Array(await res.arrayBuffer());
    },
    async remove(key) {
      const res = await call("DELETE", at(key));
      if (res.status !== 404) check(res, "削除");
    },
    async test() {
      const key = ".craftshelf-test";
      check(await call("PUT", at(key), new TextEncoder().encode("ok")), "書き込み");
      await call("DELETE", at(key));
    },
  };
}

export function storeFor(c: StorageConfig, fetch: FetchLike): Store {
  return c.kind === "local" ? localStore(c.path) : webdavStore(c.url, c.user, c.password, fetch);
}
