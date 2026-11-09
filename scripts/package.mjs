// Docker なしで動かす配布物を作る(GitHub Actions のリリースで動かす。手元でも動かせる)。先に npm run build しておく。
//
//   node scripts/package.mjs            … 動かしている OS 向けだけ
//   node scripts/package.mjs all        … 全部(Linux で動かす。zip・unzip・xz を使う)
//   node scripts/package.mjs win-x64 linux-arm64 …
//
// dist/craftshelf-v03-<版>-<OS>-<CPU>.zip / .tar.gz ができる。中身は CraftShelf/ の下に
//   node/(公式の Node.js。チェックサムで確かめる)・app/(.output・drizzle・VERSION)・launcher.mjs・起動するファイル・README.txt と、
//   タスクトレイのアイコン(Windows は tray.ps1。macOS は packaging/craftshelf-tray〔CI の macOS で tray-macos.swift からビルドしたもの〕があれば)
// Node.js の版は、このスクリプトを動かしている Node と同じ(NODE_DIST_VERSION で変えられる)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const VERSION = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
const NODE = process.env.NODE_DIST_VERSION || process.version;
const TARGETS = {
  "win-x64": { archive: "zip", out: "zip" },
  "darwin-arm64": { archive: "tar.gz", out: "tar.gz" },
  "darwin-x64": { archive: "tar.gz", out: "tar.gz" },
  "linux-x64": { archive: "tar.xz", out: "tar.gz" },
  "linux-arm64": { archive: "tar.xz", out: "tar.gz" },
};
const here = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
// Windows では Git の GNU tar ではなく、zip も扱える Windows の tar を使う
const TAR = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const README = `CraftShelf v03 ${VERSION}

起動: Windows は CraftShelf.cmd、macOS は CraftShelf.command をダブルクリックします(macOS で開けないときは、右クリック →「開く」)。
      Linux は ./craftshelf.sh(サーバーで常駐させるなら install.sh を使ってください)。
      ブラウザで http://127.0.0.1:8765/ が開きます。Windows はタスクトレイ、macOS はメニューバーに CraftShelf のアイコンが出ます
      (「CraftShelf を開く」「保存先フォルダを開く」「終了」)。止めるときは、アイコンの「終了」か、出てきたウィンドウを閉じます。
      アイコンを出さないときは --no-tray を付けて起動します(Windows は、そのときはウィンドウが出たままになります)。
      macOS でアイコンが出ないときは、ターミナルで xattr -dr com.apple.quarantine <CraftShelf のフォルダ> を動かしてから起動し直します(署名していないため)。
データ: Windows は %LOCALAPPDATA%\\CraftShelf、macOS は ~/Library/Application Support/CraftShelf、Linux は ~/.local/share/craftshelf
        (v02 のインストーラー版と同じ場所。v02 のデータがあれば、初めての起動で取り込みます。v02 は先に終了してください)
        ほかの場所にするときは --data-dir <フォルダ> を付けて起動します。
待ち受け: データの場所の launcher.json に {"host": "0.0.0.0", "port": 8765} と書くと、LAN のほかの端末からも開けます。
自動起動: Windows は Win+R で shell:startup を開いて CraftShelf.cmd のショートカットを置く。
          macOS は「システム設定」→「一般」→「ログイン項目」に CraftShelf.command を足す。
更新: パネルの「アカウント」→「パネルのバージョン」から(自動アップデートも選べます)。
ログインを戻す(二段階認証の端末も予備のコードもなくしたとき):
      Windows: CraftShelf.cmd reset-owner <メールアドレスか名前>   macOS・Linux: ./craftshelf.sh reset-owner <メールアドレスか名前>
説明: https://github.com/mesamaru/craftshelf/tree/dev/docs/INSTALL.md
`;

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function build(target, sums) {
  const t = TARGETS[target];
  if (!t) throw new Error(`知らない OS です: ${target}(${Object.keys(TARGETS).join(" / ")})`);
  const file = `node-${NODE}-${target}.${t.archive}`;
  const want = sums.split("\n").map((l) => l.trim().split(/\s+/)).find(([, f]) => f === file)?.[0];
  if (!want) throw new Error(`SHASUMS256.txt に ${file} がありません`);
  const body = await get(`https://nodejs.org/dist/${NODE}/${file}`);
  if (createHash("sha256").update(body).digest("hex") !== want) throw new Error(`${file} のチェックサムが合いません`);

  const work = mkdtempSync(join(tmpdir(), "cs-pkg-"));
  try {
    writeFileSync(join(work, file), body);
    if (t.archive === "zip" && process.platform !== "win32") run("unzip", ["-q", file], work);
    else run(TAR, [t.archive === "tar.xz" ? "-xJf" : "-xf", file], work);
    const nodeDir = join(work, `node-${NODE}-${target}`);
    const stage = join(work, "out", "CraftShelf");
    const win = target.startsWith("win");
    mkdirSync(join(stage, "node", win ? "" : "bin"), { recursive: true });
    copyFileSync(join(nodeDir, win ? "node.exe" : join("bin", "node")), join(stage, "node", win ? "node.exe" : join("bin", "node")));
    copyFileSync(join(nodeDir, "LICENSE"), join(stage, "node", "LICENSE"));
    for (const p of [".output", "drizzle", "VERSION"]) cpSync(join(ROOT, p), join(stage, "app", p), { recursive: true });
    copyFileSync(join(ROOT, "packaging", "launcher.mjs"), join(stage, "launcher.mjs"));
    copyFileSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
    writeFileSync(join(stage, "README.txt"), win ? README.replace(/\n/g, "\r\n") : README);
    if (win) copyFileSync(join(ROOT, "packaging", "tray.ps1"), join(stage, "tray.ps1"));
    const macTray = join(ROOT, "packaging", "craftshelf-tray");
    if (target.startsWith("darwin")) {
      if (existsSync(macTray)) {
        copyFileSync(macTray, join(stage, "craftshelf-tray"));
        chmodSync(join(stage, "craftshelf-tray"), 0o755);
      } else if (process.env.CI) throw new Error(`${macTray} がありません(.github/workflows の tray-macos のジョブで作ります)`);
      else console.warn(`${macTray} が無いので、${target} にはメニューバーのアイコンを入れません(macOS で swiftc を使って作ります。.github/workflows の tray-macos)`);
    }
    if (win) {
      writeFileSync(join(stage, "CraftShelf.cmd"), `@echo off\r\ntitle CraftShelf\r\n"%~dp0node\\node.exe" "%~dp0launcher.mjs" %*\r\nif errorlevel 1 pause\r\n`);
    } else {
      const sh = `#!/bin/sh\nD="$(cd "$(dirname "$0")" && pwd)"\nexec "$D/node/bin/node" "$D/launcher.mjs" "$@"\n`;
      const name = target.startsWith("darwin") ? "CraftShelf.command" : "craftshelf.sh";
      writeFileSync(join(stage, name), sh);
      chmodSync(join(stage, name), 0o755);
      chmodSync(join(stage, "node", "bin", "node"), 0o755);
    }
    mkdirSync(DIST, { recursive: true });
    const out = join(DIST, `craftshelf-v03-${VERSION}-${target}.${t.out}`);
    rmSync(out, { force: true });
    const outDir = join(work, "out");
    if (t.out === "zip") {
      if (process.platform === "win32") run(TAR, ["-a", "-cf", out, "CraftShelf"], outDir);
      else run("zip", ["-qr", out, "CraftShelf"], outDir);
    } else {
      // macOS・Linux で実行の印(chmod)を残すため tar にする(Windows で作ると印が残らないので、CI の Linux で作る)
      run(TAR, ["-czf", out, "CraftShelf"], outDir);
    }
    console.log("作りました:", out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (!existsSync(join(ROOT, ".output", "server", "index.mjs"))) throw new Error("先に npm run build してください");
const args = process.argv.slice(2);
const targets = args[0] === "all" ? Object.keys(TARGETS) : args.length ? args : [here];
const sums = (await get(`https://nodejs.org/dist/${NODE}/SHASUMS256.txt`)).toString("utf8");
for (const target of targets) await build(target, sums);
