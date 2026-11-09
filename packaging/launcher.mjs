#!/usr/bin/env node
// CraftShelf v03 を Docker なしで起動する(Windows・macOS の配布物と、Linux の install.sh)。v02 の launcher.py の代わり。
//
//   node launcher.mjs [--data-dir <フォルダ>] [--host 0.0.0.0] [--port 8765] [--no-browser]
//   node launcher.mjs reset-owner <メールアドレスか名前> [--data-dir <フォルダ>]   … ログインを戻す(下)
//
// - データの場所: --data-dir → 環境変数 DATA_DIR → v02 のインストーラー版と同じ場所(Windows は %LOCALAPPDATA%\CraftShelf、
//   macOS は ~/Library/Application Support/CraftShelf、Linux は ~/.local/share/craftshelf)。v02 のデータがあれば、初めての起動で取り込む。
// - 待ち受け: --host・--port → 環境変数 HOST・PORT → データの場所の launcher.json({"host": "0.0.0.0", "port": 8765})→ 127.0.0.1:8765(v02 と同じ)。
// - 版: パネルで選んだ版(<データ>/v03/versions/current)があればそれを、無ければ一緒に入っている版(app/)を起動する。
//   選んだ版が前回うまく起動しなかった(.starting が消えていない)ときは、入っている版に戻す(docker/start.sh と同じ)。
// - パネルが終了したら(版の切り替え・バックアップから戻すなどの再起動)、もう一度起動する。続けて落ちるときはあきらめる。
// - reset-owner: 二段階認証の端末も予備のコードもなくしたとき、その人の二段階認証とパスキーを外し、新しいパスワードを出す。
//   データの場所に頼みごとのファイルを置き、動いているパネルが数秒で片付ける(パネルが止まっていれば、次に起動したとき)。
//   Docker では  docker exec <コンテナ> node /app/launcher.mjs reset-owner <メールアドレスか名前>
// 外のパッケージは使わない(Node.js だけで動く)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = /^\d{2}\.\d{2}\.\d{2}$/;

function parse(argv) {
  const o = { cmd: "", rest: [], dataDir: "", host: "", port: 0, browser: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") o.dataDir = argv[++i] ?? "";
    else if (a === "--host") o.host = argv[++i] ?? "";
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--no-browser") o.browser = false;
    else if (!o.cmd && a === "reset-owner") o.cmd = a;
    else o.rest.push(a);
  }
  return o;
}

export function defaultDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "CraftShelf");
  if (platform === "darwin") return join(home, "Library", "Application Support", "CraftShelf");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "craftshelf");
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};
const readVersion = (dir) => {
  try {
    return readFileSync(join(dir, "VERSION"), "utf8").trim();
  } catch {
    return "";
  }
};

/** 起動する版のフォルダ(docker/start.sh と同じ決め方) */
export function pickApp(dataDir, appDir, log = console.log) {
  const root = join(dataDir, "v03", "versions");
  const cur = join(root, "current");
  if (existsSync(cur)) {
    const v = readFileSync(cur, "utf8").trim();
    const d = join(root, v);
    if (!VERSION.test(v) || existsSync(join(d, ".starting")) || !existsSync(join(d, ".output", "server", "index.mjs"))) {
      log(`[版] ${v} を起動できなかったので、入っている版(${readVersion(appDir)})に戻します`);
      rmSync(cur, { force: true });
      if (VERSION.test(v)) rmSync(join(d, ".starting"), { force: true });
    } else {
      writeFileSync(join(d, ".starting"), "");
      return d;
    }
  }
  return appDir;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch { /* 開けなくても動かし続ける */ }
}

async function healthy(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resetOwner(dataDir, login) {
  if (!login) {
    console.error("使い方: reset-owner <メールアドレスか名前>");
    process.exit(2);
  }
  const v03 = join(dataDir, "v03");
  if (!existsSync(v03)) {
    console.error(`${v03} がありません。--data-dir でデータの場所を指定してください`);
    process.exit(1);
  }
  const password = randomBytes(12).toString("base64url");
  const result = join(v03, "reset-owner-result.json");
  rmSync(result, { force: true });
  writeFileSync(join(v03, "reset-owner.json"), JSON.stringify({ login, password, at: new Date().toISOString() }), { mode: 0o600 });
  console.log("パネルが片付けるのを待っています…(パネルが止まっているときは、次に起動したときに片付けます)");
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (!existsSync(result)) continue;
    const r = readJson(result);
    rmSync(result, { force: true });
    if (!r.ok) {
      console.error(`できませんでした: ${r.error}`);
      process.exit(1);
    }
    console.log(`「${r.user}」の二段階認証とパスキーを外し、ほかのログインを切りました。`);
    console.log(`新しいパスワード: ${password}`);
    console.log("このパスワードでログインし、すぐに「アカウント」でパスワードを変えて、二段階認証を設定し直してください。");
    return;
  }
  console.log("まだ片付いていません。パネルを起動(再起動)すると片付けます。そのときのパスワード:");
  console.log(`新しいパスワード: ${password}`);
  console.log("(10 分以内にパネルが片付けなかったときは使えません。もう一度コマンドを動かしてください)");
}

async function main() {
  const o = parse(process.argv.slice(2));
  const dataDir = resolve(o.dataDir || process.env.DATA_DIR || defaultDataDir());
  if (o.cmd === "reset-owner") return resetOwner(dataDir, o.rest.join(" ").trim());

  mkdirSync(dataDir, { recursive: true });
  const conf = readJson(join(dataDir, "launcher.json"));
  const host = o.host || process.env.HOST || conf.host || "127.0.0.1";
  const port = Number(o.port || process.env.PORT || conf.port || 8765);
  const url = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}/`;
  const appDir = resolve(process.env.CRAFTSHELF_APP_DIR || join(HERE, "app"));
  if (!existsSync(join(appDir, ".output", "server", "index.mjs"))) {
    console.error(`${appDir} に CraftShelf の一式がありません`);
    process.exit(1);
  }
  if (await healthy(port)) {
    console.log(`すでに起動しています: ${url}`);
    if (o.browser) openBrowser(url);
    return;
  }

  const logFile = createWriteStream(join(dataDir, "craftshelf.log"), { flags: "a" });
  const log = (s) => {
    process.stdout.write(s + "\n");
    logFile.write(s + "\n");
  };
  log(`CraftShelf ${readVersion(appDir)}: ${url}(データ: ${dataDir})`);
  if (process.stdout.isTTY && process.platform !== "linux") {
    log(process.platform === "win32"
      ? "止めるときは、このウィンドウを閉じます。パソコンの起動時に動かすには、Win+R で shell:startup を開き、CraftShelf.cmd のショートカットを置いてください。"
      : "止めるときは、このウィンドウを閉じます。ログインしたときに動かすには、「システム設定」→「一般」→「ログイン項目」に CraftShelf.command を足してください。");
  }

  let stopping = false;
  let child = null;
  let fails = 0;
  let opened = !o.browser;
  const stop = () => {
    stopping = true;
    child?.kill();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const dir = pickApp(dataDir, appDir, log);
    const started = Date.now();
    child = spawn(process.execPath, [join(dir, ".output", "server", "index.mjs")], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NODE_ENV: "production", CRAFTSHELF_MODE: "self", DATA_DIR: dataDir, HOST: host, PORT: String(port),
        MIGRATIONS_DIR: join(dir, "drizzle"), CRAFTSHELF_APP_DIR: appDir, CRAFTSHELF_DIST: process.env.CRAFTSHELF_DIST || "installer" },
    });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { process.stdout.write(d); logFile.write(d); });
    if (!opened) {
      opened = true;
      (async () => {
        for (let i = 0; i < 120 && !stopping; i++) {
          if (await healthy(port)) return openBrowser(url);
          await sleep(1000);
        }
      })();
    }
    const code = await new Promise((r) => child.on("exit", (c) => r(c)));
    if (stopping) break;
    // 起動してすぐ落ちるのが続くときはあきらめる(ポートが使われている・一式が壊れているなど)
    fails = Date.now() - started < 30_000 ? fails + 1 : 0;
    if (fails >= 5) {
      log(`[起動] 続けて終了したので止めます(終了コード ${code})。${join(dataDir, "craftshelf.log")} を見てください`);
      process.exitCode = 1;
      break;
    }
    log(code === 0 ? "[起動] パネルを再起動します" : `[起動] パネルが終了しました(終了コード ${code})。もう一度起動します`);
    await sleep(1000);
  }
  logFile.end();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
