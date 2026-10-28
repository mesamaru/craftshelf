// パネルからの版の切り替え(自分用の版)。GitHub のリリースに付けた「ビルド済みの一式」を取ってきて
// /data/v03/versions/<版> に置き、docker/start.sh が次の起動でそれを使う
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { FetchLike } from "./net";

const REPO = "mesamaru/craftshelf";
const TAG = /^dev-v(03\.\d{2}\.\d{2})$/;
const VERSION = /^\d{2}\.\d{2}\.\d{2}$/;
const MAX_BYTES = 300 * 1024 * 1024;

export type Release = { version: string; publishedAt: string; notes: string; url: string; sumsUrl: string };

export const assetName = (v: string) => `craftshelf-v03-${v}.tar.gz`;

// GitHub のリリースの一覧から、v03 の版で一式と SHA256SUMS がそろっているものだけ(新しい順)
export function pickReleases(list: unknown): Release[] {
  const out: Release[] = [];
  for (const r of Array.isArray(list) ? list : []) {
    const m = String(r?.tag_name ?? "").match(TAG);
    if (!m) continue;
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const find = (name: string) => assets.find((a: { name?: string }) => a?.name === name)?.browser_download_url;
    const url = find(assetName(m[1]));
    const sumsUrl = find("SHA256SUMS");
    if (url && sumsUrl) out.push({ version: m[1], publishedAt: String(r.published_at ?? ""), notes: String(r.body ?? "").slice(0, 2000), url, sumsUrl });
  }
  return out.sort((a, b) => b.version.localeCompare(a.version));
}

// SHA256SUMS(sha256sum の形)から、そのファイルの値
export function sumFor(text: string, file: string): string | null {
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m && m[2] === file) return m[1];
  }
  return null;
}

export function versionService({ fetch, dataDir, appDir = process.cwd() }: { fetch: FetchLike; dataDir: string; appDir?: string }) {
  const root = join(dataDir, "v03", "versions");
  const imageDir = "/app";
  const readVersion = (dir: string) => {
    try {
      return readFileSync(join(dir, "VERSION"), "utf8").trim();
    } catch {
      return "";
    }
  };

  // GitHub からの転送(ダウンロードは別のホストに転送される)を、毎回確かめながら追う
  async function get(url: string): Promise<Response> {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(url, { headers: { "User-Agent": "CraftShelf", Accept: "application/octet-stream, application/json" } });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) throw new Error(`GitHub から取得できません(HTTP ${res.status})`);
      return res;
    }
    throw new Error("転送が多すぎます");
  }

  return {
    /** いま動いている版・イメージの版・パネルで選んだ版 */
    state() {
      return { current: readVersion(appDir), image: readVersion(imageDir), selected: existsSync(join(root, "current")) ? readFileSync(join(root, "current"), "utf8").trim() : null };
    },

    /** GitHub にある v03 の版 */
    async list() {
      return pickReleases(await (await get(`https://api.github.com/repos/${REPO}/releases?per_page=50`)).json());
    },

    /** その版を取ってきて確かめ、次の起動で使うようにする(再起動は呼ぶ側で) */
    async install(version: string) {
      if (!VERSION.test(version)) throw new Error("版の形が違います");
      const rel = (await this.list()).find((r) => r.version === version);
      if (!rel) throw new Error("その版は見つかりません");
      const want = sumFor(await (await get(rel.sumsUrl)).text(), assetName(version));
      if (!want) throw new Error("確かめるための値(SHA256SUMS)がありません");
      const res = await get(rel.url);
      if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("大きすぎます");
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_BYTES) throw new Error("大きすぎます");
      if (createHash("sha256").update(body).digest("hex") !== want) throw new Error("ダウンロードした一式が壊れています(チェックサムが合いません)");

      const dir = join(root, version);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const file = join(root, `${version}.tar.gz`);
      writeFileSync(file, body);
      try {
        // 相対パスで渡す(Windows の C: を、GNU tar がリモートのホストと読まないように)
        await promisify(execFile)("tar", ["-xzf", join("..", `${version}.tar.gz`)], { cwd: dir });
      } finally {
        rmSync(file, { force: true });
      }
      if (readVersion(dir) !== version || !existsSync(join(dir, ".output", "server", "index.mjs"))) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error("一式の中身が足りません");
      }
      writeFileSync(join(root, "current"), version + "\n");
    },

    /** パネルで選んだ版をやめて、イメージの版に戻す(再起動は呼ぶ側で) */
    useImage() {
      rmSync(join(root, "current"), { force: true });
    },

    /** 選んだ版がちゃんと起動できたしるし(docker/start.sh が次の起動で戻さないように) */
    confirmStarted() {
      const marker = join(appDir, ".starting");
      if (resolve(appDir).startsWith(resolve(root)) && existsSync(marker)) unlinkSync(marker);
    },
  };
}
