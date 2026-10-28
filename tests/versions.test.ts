// パネルからの版の切り替え: GitHub のリリースから一式を取ってきて、確かめて、次の起動で使うようにする
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "~/server/net";
import { assetName, pickReleases, sumFor, versionService } from "~/server/versions";

const V = "03.09.00";
let tarball: Buffer;
let tampered = false;

beforeAll(() => {
  // CI と同じ形の一式(.output・drizzle・VERSION)を作る
  const src = mkdtempSync(join(tmpdir(), "cs-ver-src-"));
  mkdirSync(join(src, ".output", "server"), { recursive: true });
  mkdirSync(join(src, "drizzle"));
  writeFileSync(join(src, ".output", "server", "index.mjs"), "// app\n");
  writeFileSync(join(src, "VERSION"), V + "\n");
  const name = `${basename(src)}.tar.gz`;
  const out = join(src, "..", name);
  execFileSync("tar", ["-czf", join("..", name), ".output", "drizzle", "VERSION"], { cwd: src }); // 相対パス(GNU tar が C: をホストと読まないように)
  tarball = readFileSync(out);
});

const releases = () => [
  { tag_name: "dev-v02.21.00", assets: [{ name: "x", browser_download_url: "https://github.com/x" }] }, // v02 は出さない
  { tag_name: `dev-v${V}`, published_at: "2026-11-01T00:00:00Z", body: "新しい版",
    assets: [{ name: assetName(V), browser_download_url: "https://github.com/dl/app" }, { name: "SHA256SUMS", browser_download_url: "https://github.com/dl/sums" }] },
  { tag_name: "dev-v03.01.00", assets: [] }, // 一式が無いものは出さない
];

const fake: FetchLike = async (url) => {
  if (url.includes("/releases?")) return Response.json(releases());
  if (url === "https://github.com/dl/sums") return new Response(`${createHash("sha256").update(tarball).digest("hex")}  ${assetName(V)}\n`);
  if (url === "https://github.com/dl/app") return new Response(null, { status: 302, headers: { location: "https://objects.example.com/app" } });
  if (url === "https://objects.example.com/app") return new Response(new Uint8Array(tampered ? Buffer.concat([tarball, Buffer.from("x")]) : tarball));
  return new Response("", { status: 404 });
};

describe("GitHub のリリースの読み方", () => {
  it("v03 の版で、一式と SHA256SUMS がそろったものだけ", () => {
    expect(pickReleases(releases()).map((r) => r.version)).toEqual([V]);
    expect(pickReleases({ message: "rate limited" })).toEqual([]);
  });
  it("SHA256SUMS から値を読む", () => {
    const h = "a".repeat(64);
    expect(sumFor(`${h}  ${assetName(V)}\n${"b".repeat(64)} *other`, assetName(V))).toBe(h);
    expect(sumFor(`${h}  other`, assetName(V))).toBeNull();
  });
});

describe("版の切り替え", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cs-ver-data-"));
  const root = join(dataDir, "v03", "versions");
  const svc = versionService({ fetch: fake, dataDir, appDir: dataDir });

  it("ダウンロードして確かめ、展開して、次の起動で使うようにする(転送も追う)", async () => {
    await svc.install(V);
    expect(readFileSync(join(root, "current"), "utf8").trim()).toBe(V);
    expect(existsSync(join(root, V, ".output", "server", "index.mjs"))).toBe(true);
    expect(svc.state().selected).toBe(V);
  });

  it("チェックサムが合わない・無い版・形の違う版は断る", async () => {
    tampered = true;
    await expect(svc.install(V)).rejects.toThrow("チェックサム");
    tampered = false;
    await expect(svc.install("03.99.99")).rejects.toThrow("見つかりません");
    await expect(svc.install("../../x")).rejects.toThrow("形");
  });

  it("イメージの版に戻せる", () => {
    svc.useImage();
    expect(svc.state().selected).toBeNull();
  });

  it("起動できたしるしは、選んだ版のフォルダのときだけ消す", () => {
    const dir = join(root, V);
    writeFileSync(join(dir, ".starting"), "");
    versionService({ fetch: fake, dataDir, appDir: dir }).confirmStarted();
    expect(existsSync(join(dir, ".starting"))).toBe(false);
  });
});
