// ブラウザで画面を通しで操作して確かめる(npm run e2e)。
// ビルドしたサーバーを E2E_URL(既定 http://localhost:3123)で動かしておく。
// ブラウザは E2E_BROWSER(既定 msedge。chrome・chromium も可)。画面の写しは .e2e/ に保存する
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { makeZip } from "../tests/zip.ts"; // Node 24 は .ts をそのまま読める

const base = process.env.E2E_URL || "http://localhost:3123";
const channel = process.env.E2E_BROWSER || "msedge";
mkdirSync(".e2e", { recursive: true });

const browser = await chromium.launch({ channel: channel === "chromium" ? undefined : channel });
const page = await browser.newPage({ locale: "ja-JP" });
let fails = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log("ok  ", name);
  } catch (e) {
    fails++;
    console.log("FAIL", name, "-", e.message.split("\n")[0]);
    await page.screenshot({ path: `.e2e/fail-${fails}.png`, fullPage: true });
  }
};
const email = `e2e-${Date.now()}@example.com`;

await step("登録するとライブラリが開く", async () => {
  await page.goto(base + "/signup");
  await page.getByPlaceholder("表示名").fill("E2E");
  await page.getByPlaceholder("メールアドレス").fill(email);
  await page.getByPlaceholder("パスワード(10 文字以上)").fill("e2e-password-0123");
  await page.getByRole("button", { name: "作成" }).click();
  await page.waitForURL(base + "/");
  await page.getByRole("heading", { name: "ライブラリ" }).waitFor();
  await page.getByText(/まだ何もありません/).waitFor();
  await page.screenshot({ path: ".e2e/library.png", fullPage: true });
  // 配布元から足すのは「＋ 追加」のシート
  await page.locator(".top").getByRole("button", { name: "＋ 追加" }).click();
  await page.getByRole("tab", { name: "探す" }).waitFor();
  await page.getByPlaceholder("名前(空なら人気順)").waitFor();
  await page.getByRole("tab", { name: "URL" }).click();
  await page.getByPlaceholder("ページの URL(Modrinth・SpigotMC・CurseForge)").waitFor();
  await page.screenshot({ path: ".e2e/add.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.locator("aside.side a.nav", { hasText: "設定" }).waitFor();
});

await step("左のメニュー・スマホの下のタブで画面を移れる", async () => {
  await page.locator("aside.side a.nav", { hasText: "セット" }).click();
  await page.waitForURL(base + "/sets");
  await page.locator("aside.side a.nav", { hasText: "ホーム" }).click(); // ホーム(v02 のダッシュボード)
  await page.waitForURL(base + "/home");
  await page.getByText("登録しているもの").waitFor();
  await page.getByRole("heading", { name: "種類ごとの件数" }).waitFor();
  await page.screenshot({ path: ".e2e/home.png", fullPage: true });
  // ‹ で畳むとアイコンだけ(この端末に覚える)、› で戻る
  await page.getByRole("button", { name: "メニューを畳む" }).click();
  if (!(await page.evaluate(() => document.documentElement.classList.contains("side-mini")))) throw new Error("メニューが畳まれていません");
  if (await page.locator("aside.side .nav .t", { hasText: "ホーム" }).isVisible()) throw new Error("畳んでも名前が出ています");
  await page.screenshot({ path: ".e2e/side-mini.png" });
  await page.reload();
  await page.getByRole("button", { name: "メニューを広げる" }).click();
  await page.locator("aside.side .nav .t", { hasText: "ホーム" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".tabbar").getByRole("link", { name: "サーバー" }).click();
  await page.waitForURL(base + "/servers");
  await page.locator(".tabbar").getByRole("link", { name: "ホーム" }).click();
  await page.waitForURL(base + "/home");
  await page.locator(".top").getByRole("link", { name: "設定" }).click(); // スマホの設定は上のバー
  await page.waitForURL(base + "/settings");
  // スマホの設定は一覧から押して入り、「‹ 設定」で一覧に戻る
  await page.locator(".set-nav").getByRole("link", { name: "ユーザーと権限" }).click();
  await page.waitForURL(base + "/team");
  await page.getByText("E2E(自分)").waitFor();
  await page.screenshot({ path: ".e2e/phone.png" });
  await page.getByRole("link", { name: "‹ 設定" }).click();
  await page.waitForURL(base + "/settings");
  await page.locator(".set-nav .account-row").waitFor();
  await page.setViewportSize({ width: 1280, height: 720 });
});

await step("ホームのウィジェットを編集して、メモ・ToDo を足すとアカウントに残る", async () => {
  await page.goto(base + "/home");
  await page.getByRole("button", { name: "ウィジェットを編集" }).click();
  await page.getByRole("button", { name: "＋ ウィジェットを追加" }).click();
  await page.getByRole("group", { name: "足すウィジェット" }).getByRole("button", { name: "メモ" }).click();
  await page.getByRole("group", { name: "足すウィジェット" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "＋ ウィジェットを追加" }).click();
  await page.getByRole("group", { name: "足すウィジェット" }).getByRole("button", { name: "ToDo リスト" }).click();
  // 種類ごとの件数を隠す
  const cats = page.locator(".widget", { has: page.getByRole("heading", { name: "種類ごとの件数" }) });
  await cats.getByRole("button", { name: "非表示にする" }).click();
  await page.getByRole("button", { name: "完了", exact: true }).click();
  if (await page.getByRole("heading", { name: "種類ごとの件数" }).count()) throw new Error("隠したウィジェットが出ています");
  const todo = page.locator(".cw-todo");
  await todo.getByLabel("やることを追加").fill("牛乳を買う");
  await todo.getByRole("button", { name: "追加", exact: true }).click();
  await todo.getByText("牛乳を買う").waitFor();
  await todo.getByLabel("完了").check();
  const memo = page.locator(".cw-memo");
  await memo.getByRole("button", { name: "メモを直す" }).click();
  await page.getByRole("dialog").getByPlaceholder("内容").fill("# 買い物\n- パン");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await memo.getByRole("heading", { name: "買い物" }).waitFor();
  await page.screenshot({ path: ".e2e/home-widgets.png", fullPage: true });
  await page.waitForTimeout(1500); // 少し待ってから保存される
  await page.reload(); // アカウントに保存してあるので、読み直しても同じ
  await page.locator(".cw-memo").getByRole("heading", { name: "買い物" }).waitFor();
  await page.locator(".cw-todo").getByText("牛乳を買う").waitFor();
  if (await page.getByRole("heading", { name: "種類ごとの件数" }).count()) throw new Error("隠したウィジェットが戻っています");
  // 初期状態に戻しても、足したウィジェットは残る
  await page.getByRole("button", { name: "ウィジェットを編集" }).click();
  await page.getByRole("button", { name: "初期状態に戻す" }).click();
  await page.getByRole("heading", { name: "種類ごとの件数" }).waitFor();
  await page.locator(".cw-memo").waitFor();
  await page.getByRole("button", { name: "完了", exact: true }).click();
});

await step("セットを作ると一覧に出る", async () => {
  await page.goto(base + "/sets");
  await page.getByText(/まだセットがありません/).waitFor();
  await page.getByRole("button", { name: "＋ セットを作成" }).click(); // 作るのはシート
  await page.getByRole("dialog").getByPlaceholder("セットの名前(例 ロビー用)").fill("ロビー用");
  await page.getByRole("dialog").getByRole("button", { name: "作る", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.locator(".set-card", { hasText: "ロビー用" }).getByText("0 件", { exact: false }).waitFor();
  await page.screenshot({ path: ".e2e/sets.png", fullPage: true });
  await page.locator(".set-card", { hasText: "ロビー用" }).getByRole("button", { name: "サーバーに入れる" }).waitFor(); // カードの操作
  await page.locator(".set-card", { hasText: "ロビー用" }).getByRole("button", { name: "編集" }).click(); // 編集はシートで中身
  await page.getByRole("dialog").getByText(/まだ何も入っていません。先にライブラリ/).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "予約", exact: true }).click(); // 予約もシート
  await page.getByRole("dialog").getByText("予約を使う").waitFor();
  await page.keyboard.press("Escape");
});

await step("チームの画面に自分がオーナーとして出る", async () => {
  await page.goto(base + "/team");
  await page.getByText("E2E(自分)").waitFor();
  await page.locator(".member .trail", { hasText: "オーナー" }).waitFor();
  await page.getByRole("button", { name: "招待のリンクを作る" }).waitFor();
});

// 自分用の版は家の中のパネルも登録できるので、どちらの版でも断る URL(ftp)で確かめる
await step("設定の左の一覧から、操作の記録と Discord への通知を開ける", async () => {
  await page.goto(base + "/team");
  for (const g of ["セキュリティ", "管理", "連携", "運用", "サポート", "表示"]) await page.locator(".set-nav .gtitle", { hasText: g }).first().waitFor(); // v02 の設定の分け方
  await page.locator(".set-nav").getByRole("link", { name: "操作の記録と通知" }).click();
  await page.waitForURL(base + "/activity");
  await page.locator(".gtitle", { hasText: "Discord への通知" }).waitFor();
  await page.getByText("セットを作る").first().waitFor(); // さっき作ったセットが記録に出る
  await page.screenshot({ path: ".e2e/activity.png", fullPage: true });
});

await step("おかしな URL のパネルは登録できず、理由が出る", async () => {
  await page.goto(base + "/servers");
  await page.getByText("まだサーバーがありません。").waitFor();
  await page.getByRole("link", { name: "比較" }).waitFor(); // 上の行: 比較・サーバー本体・ファイル比較・ポート・処理
  await page.getByRole("link", { name: "サーバー本体" }).waitFor();
  await page.getByRole("link", { name: "処理" }).waitFor();
  await page.locator("main").getByRole("button", { name: "＋ サーバーを追加" }).click(); // つなぎ方は「＋ サーバーを追加」のシート
  await page.getByRole("dialog").getByRole("tab", { name: "Pterodactyl" }).waitFor();
  await page.getByPlaceholder("パネルの URL(https://…)").fill("ftp://panel.example.com");
  await page.getByPlaceholder("Client API キー(ptlc_…)").fill("ptlc_0123456789abcdef");
  await page.getByRole("button", { name: "パネルをつなぐ" }).click();
  await page.getByText(/の URL を入力してください/).waitFor();
  await page.screenshot({ path: ".e2e/servers.png", fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
});

await step("ポートの画面で、種類とグループを足して並べ替えられる", async () => {
  await page.goto(base + "/servers");
  await page.getByRole("link", { name: "ポート" }).click();
  await page.waitForURL(base + "/ports");
  await page.getByText(/サーバーがありません/).waitFor();
  await page.getByRole("button", { name: "種類とグループ" }).click();
  await page.getByRole("tab", { name: "グループ(行)" }).click();
  await page.getByRole("button", { name: "＋ グループを追加" }).click();
  await page.getByLabel("番号").last().fill("90");
  await page.getByLabel("名前").last().fill("Proxy");
  await page.getByRole("tab", { name: "ポートの種類(列)" }).click();
  await page.getByLabel("上へ").nth(1).click(); // 2 つ目の種類を一番上へ
  await page.screenshot({ path: ".e2e/ports-rules.png", fullPage: true });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const heads = await page.locator(".ports-table th").allTextContents().catch(() => []);
  await page.getByRole("button", { name: "種類とグループ" }).click();
  if ((await page.getByLabel("種類の名前").first().inputValue()) !== "Bedrock") throw new Error(`並び順が保存されていません ${heads}`);
  await page.getByRole("tab", { name: "グループ(行)" }).click();
  if ((await page.getByLabel("名前").first().inputValue()) !== "Proxy") throw new Error("グループが保存されていません");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: ".e2e/ports.png", fullPage: true });
});

// フォルダのサーバー(自分用の版だけ): jar の名前から種類が決まり、詳細のタブを URL で移れる
await step("フォルダのサーバーを足すと、一覧と詳細のタブで見られる", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-e2e-"));
  writeFileSync(join(dir, "paper-1.21.4.jar"), "");
  writeFileSync(join(dir, "server.properties"), "motd=e2e");
  await page.goto(base + "/servers");
  await page.locator("main").getByRole("button", { name: "＋ サーバーを追加" }).click();
  const sheet = page.getByRole("dialog");
  if (!(await sheet.getByRole("tab", { name: "フォルダ" }).count())) return console.log("     (フォルダのサーバーは自分用の版だけ)");
  await sheet.getByRole("tab", { name: "フォルダ" }).click();
  await sheet.getByRole("button", { name: "このフォルダを使う" }).waitFor(); // 一覧が出てから場所を入れる
  await sheet.getByPlaceholder("名前(空ならフォルダの名前)").fill("E2E");
  await sheet.getByLabel("フォルダの場所").fill(dir);
  await sheet.getByRole("button", { name: "開く" }).click();
  await sheet.getByRole("button", { name: /paper-1.21.4.jar/ }).click();
  await sheet.waitFor({ state: "detached" });
  await page.locator("main a.row", { hasText: "E2E" }).getByText(/Paper 1.21.4/).waitFor();
  await page.screenshot({ path: ".e2e/servers-list.png", fullPage: true });
  // 左に一覧、右に詳細(パソコンは一覧の先頭が開く)。左の 稼働・更新・人数と、右の タブ・起動 / 再起動 / 停止
  await page.waitForURL(/\/servers\/[^/?]+/);
  await page.locator(".srv-side .sstats").getByText("稼働").waitFor();
  await page.locator(".srv-main").getByRole("heading", { name: "E2E" }).waitFor();
  for (const t of ["概要", "アドオン", "ファイル", "保存", "設定"]) await page.getByRole("tab", { name: t }).waitFor(); // v02 の並びと名前(コンソールは操作できる人だけ)
  await page.locator(".srv-qacts").getByRole("button", { name: "起動", exact: true }).waitFor();
  await page.screenshot({ path: ".e2e/server-detail.png" });
  await page.getByText("やること", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "アドオン" }).click();
  await page.waitForURL(/tab=addons/);
  await page.getByText("まだ何も入っていません。").waitFor();
  await page.getByRole("tab", { name: "ファイル" }).click();
  await page.getByText("server.properties").waitFor();
  await page.goBack(); // 戻るボタンで前のタブへ
  await page.waitForURL(/tab=addons/);
  await page.getByRole("tab", { name: "保存" }).click(); // v02 の「保存」= ワールドのバックアップと変更の履歴
  await page.waitForURL(/tab=backup/);
  await page.getByText("変更の履歴", { exact: true }).first().waitFor();
  await page.getByRole("tab", { name: "設定" }).click();
  await page.getByText("種類とバージョン").click();
  await page.getByRole("dialog").getByLabel("サーバーの種類").waitFor();
  if ((await page.getByRole("dialog").getByLabel("サーバーの種類").inputValue()) !== "paper") throw new Error("jar の名前から種類が決まっていません");
  await page.screenshot({ path: ".e2e/server-settings.png" });
  await page.keyboard.press("Escape");
  await page.goto(base + "/servers/" + page.url().split("/servers/")[1].split("?")[0] + "/files"); // 前の URL はファイルのタブへ
  await page.waitForURL(/tab=files/);
  // スマホ(幅 390 px)は一覧 → 詳細の 2 画面。詳細の上に「‹ サーバー」
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + "/servers");
  await page.locator(".srv-side a.row", { hasText: "E2E" }).waitFor();
  if (await page.locator(".srv-main").isVisible()) throw new Error("スマホの一覧に詳細が出ています");
  await page.locator(".srv-side a.row", { hasText: "E2E" }).click();
  await page.locator(".srv-page .srv-back").waitFor();
  if (await page.locator(".srv-side").isVisible()) throw new Error("スマホの詳細に一覧が出ています");
  await page.screenshot({ path: ".e2e/server-phone.png" });
  await page.locator(".srv-page .srv-back").click();
  await page.locator(".srv-side").waitFor();
  await page.setViewportSize({ width: 1280, height: 720 });
});

// サーバーの一覧: 並べ替え(この端末に覚える)・名前と状態の絞り込み(5 台以上のとき)
await step("サーバーの一覧を並べ替え・絞り込める", async () => {
  await page.goto(base + "/servers");
  const probe = page.locator("main").getByRole("button", { name: "＋ サーバーを追加" });
  await probe.click();
  if (!(await page.getByRole("dialog").getByRole("tab", { name: "フォルダ" }).count())) { await page.keyboard.press("Escape"); return console.log("     (フォルダのサーバーは自分用の版だけ)"); }
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  for (const name of ["サーバー2", "サーバー10", "alpha", "Beta"]) {
    const dir = mkdtempSync(join(tmpdir(), "cs-e2e-"));
    writeFileSync(join(dir, "paper-1.21.4.jar"), "");
    await probe.click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("tab", { name: "フォルダ" }).click();
    await sheet.getByRole("button", { name: "このフォルダを使う" }).waitFor(); // 一覧が出てから場所を入れる
    await sheet.getByPlaceholder("名前(空ならフォルダの名前)").fill(name);
    await sheet.getByLabel("フォルダの場所").fill(dir);
    await sheet.getByRole("button", { name: "開く" }).click();
    await sheet.getByRole("button", { name: /paper-1.21.4.jar/ }).click();
    await sheet.waitFor({ state: "detached" });
  }
  const titles = () => page.locator(".srv-side a.row .ttl").allTextContents();
  const same = async (want, what) => {
    await page.waitForFunction(([w]) => JSON.stringify([...document.querySelectorAll(".srv-side a.row .ttl")].map((e) => e.textContent)) === JSON.stringify(w), [want], { timeout: 5000 })
      .catch(async () => { throw new Error(`${what}: ${JSON.stringify(await titles())}`); });
  };
  await page.goto(base + "/servers");
  await page.locator(".srv-side a.row", { hasText: "Beta" }).waitFor();
  const sort = page.locator(".srv-side").getByLabel("並べ替え");
  await sort.selectOption("name");
  await same(["alpha", "Beta", "E2E", "サーバー2", "サーバー10"], "名前順(数字は数として)");
  await sort.selectOption("nameDesc");
  await same(["サーバー10", "サーバー2", "E2E", "Beta", "alpha"], "名前の逆順");
  await page.screenshot({ path: ".e2e/servers-sort.png" });
  await page.reload(); // この端末に覚える
  await page.locator(".srv-side a.row", { hasText: "Beta" }).waitFor();
  if ((await page.locator(".srv-side").getByLabel("並べ替え").inputValue()) !== "nameDesc") throw new Error("並べ替えを覚えていません");
  await page.locator(".srv-side").getByLabel("名前で絞り込む").fill("サーバー");
  await same(["サーバー10", "サーバー2"], "名前で絞り込み");
  await page.locator(".srv-side").getByLabel("名前で絞り込む").fill("");
  await page.locator(".srv-side").getByRole("button", { name: "更新あり", exact: true }).click();
  await page.getByText("条件に合うサーバーはありません").waitFor(); // 更新のあるサーバーは無い
  await page.locator(".srv-side").getByRole("button", { name: "停止中", exact: true }).click();
  await same(["サーバー10", "サーバー2", "E2E", "Beta", "alpha"], "停止中で絞り込み");
  await page.locator(".srv-side").getByRole("button", { name: "稼働中", exact: true }).click();
  await page.getByText("条件に合うサーバーはありません").waitFor();
  await page.locator(".srv-side").getByRole("button", { name: "すべて", exact: true }).click();
  await page.locator(".srv-side").getByLabel("並べ替え").selectOption("name");
  await same(["alpha", "Beta", "E2E", "サーバー2", "サーバー10"], "名前順に戻す");
  // スマホ(幅 390 px)でも一覧の上が収まる
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".e2e/servers-sort-phone.png", fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("スマホで横にはみ出しています");
  await page.setViewportSize({ width: 1280, height: 720 });
});

// ライブラリはアドオンの管理(v02 と同じ形)。どのサーバーに入っているかは出さない
await step("ドラッグ&ドロップの欄から jar を足すと、一覧と詳しくのシートに出る(サーバーのことは出さない)", async () => {
  await page.goto(base + "/");
  await page.locator(".dropcard").waitFor({ timeout: 8000 }).catch(() => {}); // ライブラリを読んでから出る
  if (!(await page.locator(".dropcard").count())) return console.log("     (アップロードは自分用の版だけ)");
  await page.locator(".dropcard input[type=file]").first().setInputFiles({ name: "E2EPlugin-1.0.jar", mimeType: "application/java-archive",
    buffer: Buffer.from(makeZip({ "plugin.yml": "name: E2EPlugin\nversion: 1.0\nmain: a.B\n", "a/B.class": "x" }, false)) });
  const row = page.locator(".items .row", { hasText: "E2EPlugin" });
  await row.getByText(/^1\.0 · 1 バージョン · [\d.]+ (B|KB) · /).waitFor();
  if (await row.locator(".srvs").count()) throw new Error("一覧にサーバーの印が出ています");
  await page.screenshot({ path: ".e2e/library-item.png", fullPage: true });
  await row.click();
  await page.waitForURL(/item=/);
  const sheet = page.getByRole("dialog", { name: "E2EPlugin" });
  await sheet.getByText("保存しているバージョン(1)").waitFor();
  await sheet.getByText("配布元が未設定です").waitFor();
  if (await sheet.getByRole("tab", { name: "サーバー" }).count()) throw new Error("詳しくにサーバーのタブがあります");
  if (await sheet.getByText("E2E", { exact: true }).count()) throw new Error("詳しくにサーバーの名前が出ています");
  // サーバーに入れるのは ⋯ から、入れる先を選ぶ
  await sheet.getByRole("button", { name: "その他の操作" }).click();
  await page.getByRole("menuitem", { name: "サーバーに入れる…" }).click();
  await page.getByRole("dialog", { name: "サーバーに入れる" }).getByText("E2E").waitFor();
  await page.screenshot({ path: ".e2e/library-sheet.png" });
  await page.keyboard.press("Escape"); // 重ねたシートは上のものだけ閉じる
  await page.getByRole("dialog", { name: "サーバーに入れる" }).waitFor({ state: "detached" });
  await sheet.getByText("保存しているバージョン(1)").waitFor();
  await page.goBack(); // 戻るボタンで詳しくを閉じる
  await page.getByRole("dialog").waitFor({ state: "detached" });
  if (page.url().includes("item=")) throw new Error("閉じても URL にアイテムが残っています");
  // 数のカードに「サーバーで使用中」は無い
  if (await page.getByText("サーバーで使用中").count()) throw new Error("「サーバーで使用中」が出ています");
});

// 配布元に紐づいたものはアイコンの画像、紐づいていないもの(アップロード)は種類の図(本物の Modrinth につなぐ。つながらなければ飛ばす)
await step("配布元に紐づけたアドオンは、ライブラリ・検索でアイコンの画像を出す", async () => {
  await page.goto(base + "/");
  await page.locator(".top").getByRole("button", { name: "＋ 追加" }).click();
  await page.getByRole("tab", { name: "URL" }).click();
  await page.getByPlaceholder("ページの URL(Modrinth・SpigotMC・CurseForge)").fill("https://modrinth.com/plugin/luckperms");
  await page.getByRole("button", { name: "足す" }).click();
  await page.getByText(/足しました|ライブラリに足しました|すでに/).first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.keyboard.press("Escape");
  await page.goto(base + "/");
  const row = page.locator(".items .row", { hasText: "LuckPerms" });
  if (!(await row.waitFor({ timeout: 10000 }).then(() => true, () => false))) return console.log("     (Modrinth につながらないので飛ばします)");
  await row.locator(".ic img").waitFor();
  if (!/^https:\/\/cdn\.modrinth\.com\//.test(await row.locator(".ic img").getAttribute("src"))) throw new Error("配布元のアイコンではありません");
  await page.waitForFunction(() => { const i = document.querySelector(".items .row .ic img"); return i && i.complete && i.naturalWidth > 0; }); // 読めている
  if (await page.locator(".items .row", { hasText: "E2EPlugin" }).locator(".ic img").count()) throw new Error("アップロードしたものに配布元のアイコンが出ています");
  await page.locator(".items .row", { hasText: "E2EPlugin" }).locator(".ic .icon-ph").waitFor(); // 種類の図
  // 検索(Ctrl K)にも出る
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input").fill("LuckPerms");
  await page.locator(".palette-hit .ic img").waitFor();
  await page.screenshot({ path: ".e2e/icons.png" });
  await page.keyboard.press("Escape");
});

// ビルドしたものでは HttpError のクラスが 2 つの束に分かれるので、エラーが 500 にならず理由どおりに返るかを確かめる(03.67.01)
await step("API・アップロードのエラーが、理由どおりの番号と文で返る", async () => {
  const expectRes = async (what, res, status, text) => {
    const body = await res.json().catch(() => ({}));
    if (res.status() !== status || (text && !String(body.message ?? "").match(text))) throw new Error(`${what}: ${res.status()} ${body.message ?? ""}`);
  };
  // 読み取りだけの API トークンを作る(範囲は「読む」だけの既定のまま)
  await page.goto(base + "/settings?s=tokens");
  await page.getByPlaceholder("名前(使い道。例 毎朝の更新の確認)").fill("e2e");
  await page.getByRole("button", { name: "トークンを作る" }).click();
  const key = await page.getByLabel("作ったトークン").inputValue();
  const api = (path, init = {}) => page.request.fetch(base + "/api/v1" + path, { ...init, headers: { "x-api-key": key, "content-type": "application/json", ...init.headers } });
  await expectRes("無いサーバー", await api("/servers/nonexistent"), 404, /見つかりません/);
  await expectRes("権限が足りない", await api("/servers/nonexistent/power", { method: "POST", data: { signal: "start" } }), 403, /読み取りだけ/);
  await expectRes("正しくないトークン", await api("/servers", { headers: { "x-api-key": "cs_wrong" } }), 401, /正しくない/);
  // ログインの Cookie で、壊れた jar のアップロード・無いサーバーのワールド
  await expectRes("壊れた jar", await page.request.post(base + "/api/library/upload?filename=broken.jar", { data: Buffer.from("not a jar"), headers: { "content-type": "application/octet-stream" } }), 400, /読めません/);
  await expectRes("無いサーバーのワールド", await page.request.get(base + "/api/worlds/nonexistent/world-20200101-000000.tar.gz"), 404, /見つかりません/);
  // ログインしていなければ、本文を読む前に断る
  const anon = await page.context().browser().newContext();
  await expectRes("ログインしていない Modpack", await anon.request.post(base + "/api/modpack?filename=a.mrpack", { data: Buffer.alloc(1024) }), 401);
  await anon.close();
});

await step("ログアウトはアカウントの設定にあり、押すとログイン画面に戻る", async () => {
  await page.goto(base + "/settings");
  await page.locator(".set-nav .account-row").waitFor();
  await page.getByLabel("表示名").waitFor(); // パソコンは何も選ばないとプロフィール
  await page.screenshot({ path: ".e2e/settings.png", fullPage: true });
  await page.getByRole("button", { name: "ログアウト" }).click();
  await page.waitForURL(base + "/login");
});

await browser.close();
console.log(`FAILS: ${fails}`);
process.exit(fails ? 1 : 0);
