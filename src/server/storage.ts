// アップロードしたアドオンの保存先: フォルダ(NAS をマウントしたものでもよい)・WebDAV・SMB(NAS に直接)。
// 中の場所(key)はこのアプリが作る相対パスだけ(.. や先頭の / は断る)
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import smb2 from "node-smb2";
import type { FetchLike } from "./net";

export class StorageError extends Error {}
export type StorageConfig =
  | { kind: "local"; path: string }
  | { kind: "webdav"; url: string; user: string; password: string }
  | { kind: "smb"; host: string; share: string; path: string; user: string; password: string; domain: string };
// putFile・read は大きいファイル(バックアップ)を、メモリに読み込まずに少しずつ送る・読む。list はフォルダの中のファイルの名前(無ければ空)
export type Store = {
  put(key: string, data: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array>; remove(key: string): Promise<void>; test(): Promise<void>;
  putFile(key: string, path: string): Promise<void>; read(key: string): Promise<Readable>; list(dir: string): Promise<string[]>;
  // 03.61.00 から。ls はフォルダの中(ファイルとフォルダ。"" はいちばん上。無ければ空)、space は容量と空き(取れなければ null)
  ls(dir: string): Promise<Entry[]>; space(): Promise<{ total: number; free: number } | null>;
};
export type Entry = { name: string; dir: boolean; size: number };
const LONG = 6 * 60 * 60_000; // 大きいファイルを送る・読むときに待つ長さ

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
    async putFile(key, path) {
      const f = full(key);
      await mkdir(dirname(f), { recursive: true });
      const tmp = `${f}.part`;
      try {
        await pipeline(createReadStream(path), createWriteStream(tmp));
        await rename(tmp, f);
      } catch {
        await rm(tmp, { force: true });
        throw new StorageError("保存先に書き込めませんでした(空きと、書き込みの権限を確かめてください)");
      }
    },
    async read(key) {
      const f = full(key);
      const s = await stat(f).catch(() => null);
      if (!s?.isFile()) throw new StorageError("保存先にファイルが見つかりません");
      return createReadStream(f);
    },
    async list(dir) {
      const d = await readdir(full(dir), { withFileTypes: true }).catch(() => []);
      return d.filter((x) => x.isFile()).map((x) => x.name);
    },
    async ls(dir) {
      const at = dir ? full(dir) : root;
      const d = await readdir(at, { withFileTypes: true }).catch(() => []);
      const out: Entry[] = [];
      for (const x of d) {
        if (x.isDirectory()) out.push({ name: x.name, dir: true, size: 0 });
        else if (x.isFile()) out.push({ name: x.name, dir: false, size: (await stat(join(at, x.name)).catch(() => null))?.size ?? 0 });
      }
      return out;
    },
    async space() {
      const s = await statfs(root).catch(() => null);
      return s ? { total: s.blocks * s.bsize, free: s.bavail * s.bsize } : null;
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
  const call = async (method: string, target: string, body?: Uint8Array | ReadableStream, headers: Record<string, string> = {}, wait = 120_000) => {
    try {
      return await fetch(target, { method, headers: { ...auth, ...headers }, body, signal: AbortSignal.timeout(wait), ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
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
    async putFile(key, path) {
      await mkdirs(key);
      check(await call("PUT", at(key), Readable.toWeb(createReadStream(path)) as ReadableStream, { "Content-Type": "application/octet-stream" }, LONG), "保存");
    },
    async read(key) {
      const res = await call("GET", at(key), undefined, {}, LONG);
      if (res.status === 404) throw new StorageError("保存先にファイルが見つかりません");
      check(res, "読み込み");
      if (!res.body) throw new StorageError("WebDAV で読み込みできませんでした");
      return Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    },
    // PROPFIND(Depth: 1)の答えから、フォルダの中のファイル(最後が / でないもの)の名前を取り出す
    async list(dir) {
      const url = new URL(cleanKey(dir).split("/").map(encodeURIComponent).join("/") + "/", base);
      const res = await call("PROPFIND", url.toString(), undefined, { Depth: "1" });
      if (res.status === 404) return [];
      check(res, "一覧の読み込み");
      const hrefs = [...(await res.text()).matchAll(/<(?:[A-Za-z0-9]+:)?href>([^<]+)<\/(?:[A-Za-z0-9]+:)?href>/g)].map((m) => m[1].trim());
      return hrefs.filter((h) => !h.endsWith("/")).map((h) => { try { return decodeURIComponent(h.split("/").pop() ?? ""); } catch { return ""; } }).filter(Boolean);
    },
    // PROPFIND(Depth: 1)の <response> ごとに、場所・大きさ・フォルダか を読む(自分自身は除く)
    async ls(dir) {
      const url = dir ? new URL(cleanKey(dir).split("/").map(encodeURIComponent).join("/") + "/", base) : base;
      const res = await call("PROPFIND", url.toString(), undefined, { Depth: "1" });
      if (res.status === 404) return [];
      check(res, "一覧の読み込み");
      const self = decodeURIComponent(url.pathname).replace(/\/+$/, "");
      const out: Entry[] = [];
      for (const block of (await res.text()).split(/<(?:[A-Za-z0-9]+:)?response[\s>]/).slice(1)) {
        const href = block.match(/<(?:[A-Za-z0-9]+:)?href>([^<]+)</)?.[1]?.trim();
        if (!href) continue;
        let path: string;
        try {
          path = decodeURIComponent(new URL(href, url).pathname).replace(/\/+$/, "");
        } catch {
          continue;
        }
        const name = path.split("/").pop() ?? "";
        if (!name || path === self) continue;
        const isDir = /<(?:[A-Za-z0-9]+:)?collection\s*\/?>/.test(block);
        out.push({ name, dir: isDir, size: isDir ? 0 : Number(block.match(/getcontentlength>\s*(\d+)/)?.[1] ?? 0) });
      }
      return out;
    },
    // RFC 4331 の quota(答えない WebDAV もある)
    async space() {
      const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>';
      const res = await call("PROPFIND", base.toString(), new TextEncoder().encode(body), { Depth: "0", "Content-Type": "application/xml" }).catch(() => null);
      if (!res?.ok) return null;
      const text = await res.text();
      const free = Number(text.match(/quota-available-bytes>\s*(\d+)/)?.[1] ?? NaN);
      const used = Number(text.match(/quota-used-bytes>\s*(\d+)/)?.[1] ?? NaN);
      return Number.isFinite(free) && free >= 0 ? { total: free + (Number.isFinite(used) ? used : 0), free } : null;
    },
    async test() {
      const key = ".craftshelf-test";
      check(await call("PUT", at(key), new TextEncoder().encode("ok")), "書き込み");
      await call("DELETE", at(key));
    },
  };
}

// SMB(SMB 2.0・2.1、NTLMv2)。通信への署名・SMB 3 には対応していないので、それを求める NAS・Windows のサーバーにはつながらない
// (そのときは NAS をマウントしてフォルダとして使う)。1 回の操作ごとにつないで、終わったら切る
export function smbStore(c: { host: string; share: string; path: string; user: string; password: string; domain: string }): Store {
  const host = c.host.trim();
  const share = c.share.trim().replace(/^[\\/]+|[\\/]+$/g, "");
  const base = c.path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new StorageError("SMB のサーバー名(または IP アドレス)を入力してください(\\\\ や / は要りません)");
  if (!share || /[\\/]/.test(share)) throw new StorageError("SMB の共有フォルダの名前を入力してください");
  if (base && base.split("/").some((x) => !x || x === "." || x === "..")) throw new StorageError("共有フォルダの中の場所が正しくありません");
  const at = (key: string) => [base, cleanKey(key)].filter(Boolean).join("/");

  type Tree = Awaited<ReturnType<Awaited<ReturnType<InstanceType<typeof smb2.Client>["authenticate"]>>["connectTree"]>>;
  async function connect() {
    const client = new smb2.Client(host, { connectTimeout: 10_000, requestTimeout: 120_000 });
    try {
      // NTLMv1 は安全でないので、いつも NTLMv2 を使う(サーバーの返事しだいで v1 に落ちないように)
      const session = await client.authenticate({ domain: c.domain, username: c.user, password: c.password, forceNtlmVersion: "v2" });
      return { client, tree: await session.connectTree(share) };
    } catch {
      await client.close().catch(() => {});
      throw new StorageError("SMB の NAS につなげません(サーバー名・共有フォルダ・ユーザー名・パスワードと、NAS が SMB 2 を受け付けるか・署名を必須にしていないかを確かめてください)");
    }
  }
  async function withTree<T>(fn: (tree: Tree) => Promise<T>) {
    const { client, tree } = await connect();
    try {
      return await fn(tree);
    } finally {
      await client.close().catch(() => {});
    }
  }
  const mkdirs = async (tree: Parameters<Parameters<typeof withTree>[0]>[0], key: string) => {
    const parts = at(key).split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!(await tree.exists(dir))) await tree.createDirectory(dir);
    }
  };
  return {
    put: (key, data) => withTree(async (tree) => {
      await mkdirs(tree, key);
      try {
        if (await tree.exists(at(key))) await tree.removeFile(at(key));
        await tree.createFile(at(key), Buffer.from(data));
      } catch {
        throw new StorageError("SMB の NAS に書き込めませんでした(書き込みの権限を確かめてください)");
      }
    }),
    get: (key) => withTree(async (tree) => {
      try {
        return new Uint8Array(await tree.readFile(at(key)));
      } catch {
        throw new StorageError("保存先にファイルが見つかりません");
      }
    }),
    remove: (key) => withTree(async (tree) => {
      if (!(await tree.exists(at(key)))) return;
      try {
        await tree.removeFile(at(key));
      } catch {
        throw new StorageError("保存先のファイルを消せませんでした");
      }
    }),
    putFile: (key, path) => withTree(async (tree) => {
      await mkdirs(tree, key);
      try {
        if (await tree.exists(at(key))) await tree.removeFile(at(key));
        await pipeline(createReadStream(path), await tree.createFileWriteStream(at(key)));
        // 書き終えたあとの大きさの設定と、ファイルを閉じるのを待ってから切る
        for (let i = 0; i < 300 && tree.openFiles.length; i++) await new Promise((r) => setTimeout(r, 100));
      } catch {
        throw new StorageError("SMB の NAS に書き込めませんでした(書き込みの権限と空きを確かめてください)");
      }
    }),
    // 読み終える(または途中でやめる)まで、つないだままにする
    async read(key) {
      const { client, tree } = await connect();
      try {
        const stream = await tree.createFileReadStream(at(key));
        stream.once("close", () => { setTimeout(() => client.close().catch(() => {}), 1000); });
        return stream;
      } catch {
        await client.close().catch(() => {});
        throw new StorageError("保存先にファイルが見つかりません");
      }
    },
    list: (dir) => withTree(async (tree) => {
      const d = [base, cleanKey(dir)].filter(Boolean).join("/");
      if (!(await tree.exists(d))) return [];
      return (await tree.readDirectory(d)).filter((e) => e.type === "File").map((e) => e.filename);
    }),
    ls: (dir) => withTree(async (tree) => {
      const d = [base, dir ? cleanKey(dir) : ""].filter(Boolean).join("/");
      if (d && !(await tree.exists(d))) return [];
      return (await tree.readDirectory(d)).filter((e) => e.filename !== "." && e.filename !== "..")
        .map((e) => ({ name: e.filename, dir: e.type === "Directory", size: e.type === "File" ? Number(e.fileSize) : 0 }));
    }),
    // shortcut: node-smb2 は空き容量を問い合わせられないので出さない(要るなら NAS をマウントしてフォルダとして使う)
    space: async () => null,
    test: () => withTree(async (tree) => {
      const key = ".craftshelf-test";
      try {
        if (base) await mkdirs(tree, key);
        if (await tree.exists(at(key))) await tree.removeFile(at(key));
        await tree.createFile(at(key), Buffer.from("ok"));
        await tree.removeFile(at(key));
      } catch {
        throw new StorageError("SMB の NAS に書き込めません(書き込みの権限を確かめてください)");
      }
    }),
  };
}

export function storeFor(c: StorageConfig, fetch: FetchLike): Store {
  return c.kind === "local" ? localStore(c.path) : c.kind === "webdav" ? webdavStore(c.url, c.user, c.password, fetch) : smbStore(c);
}
