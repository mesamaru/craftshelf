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

  it("v02 から切り替えて動いているか: v02 が渡す V02_CONFIG_DIR があり、版を選んでいて、イメージが v03 でないときだけ", async () => {
    const image = mkdtempSync(join(tmpdir(), "cs-ver-img-"));
    const setImage = (v: string) => writeFileSync(join(image, "VERSION"), v + String.fromCharCode(10));
    setImage("02.25.04");
    const env = { ...process.env };
    try {
      process.env.CRAFTSHELF_APP_DIR = image; // イメージの場所は、作るときに読む
      delete process.env.V02_CONFIG_DIR;
      const v = versionService({ fetch: fake, dataDir, appDir: dataDir });
      await v.use(V);
      expect(v.state()).toMatchObject({ fromV02: false, image: "02.25.04" }); // v02 から起動していない
      process.env.V02_CONFIG_DIR = dataDir;
      expect(v.state().fromV02).toBe(true);
      setImage("03.60.00"); // v03 のイメージ(v03 のイメージに v02 のデータを読ませているとき)
      expect(v.state().fromV02).toBe(false);
      setImage("02.25.04");
      v.useImage(); // v02 に戻す = 選んだ版の印を消す
      expect(v.state()).toMatchObject({ fromV02: false, selected: null });
      expect(v.state().v02Data).toBe(false);
      writeFileSync(join(dataDir, "index.db"), "");
      expect(v.state().v02Data).toBe(true);
    } finally {
      process.env = env;
    }
  });

  it("use: 取ってきてある版は取り直さずに選ぶ(更新の前に戻すとき)", async () => {
    tampered = true; // 取りに行けば失敗する
    await svc.use(V);
    tampered = false;
    expect(svc.state().selected).toBe(V);
    svc.useImage();
  });

  it("起動できたしるしは、選んだ版のフォルダのときだけ消す", () => {
    const dir = join(root, V);
    writeFileSync(join(dir, ".starting"), "");
    versionService({ fetch: fake, dataDir, appDir: dir }).confirmStarted();
    expect(existsSync(join(dir, ".starting"))).toBe(false);
  });
});

describe("安定版と開発版", () => {
  it("v03.xx.xx は安定版、dev-v03.xx.xx は開発版。同じ版なら安定版を使う", () => {
    const rel = (tag: string, v: string) => ({ tag_name: tag, assets: [{ name: assetName(v), browser_download_url: `https://x/${tag}` }, { name: "SHA256SUMS", browser_download_url: "https://x/s" }] });
    const got = pickReleases([rel("dev-v03.40.00", "03.40.00"), rel("v03.40.00", "03.40.00"), rel("dev-v03.41.00", "03.41.00"), rel("v02.24.00", "02.24.00")]);
    expect(got.map((r) => [r.version, r.stable])).toEqual([["03.41.00", false], ["03.40.00", true]]);
    expect(got[1].url).toBe("https://x/v03.40.00");
  });
});
