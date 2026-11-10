// ブラウザで画面を通しで操作して確かめる(npm run e2e)。
// ビルドしたサーバーを E2E_URL(既定 http://localhost:3123)で動かしておく。
// ブラウザは E2E_BROWSER(既定 msedge。chrome・chromium も可)。画面の写しは .e2e/ に保存する
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

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
  await page.locator("aside.side a.nav", { hasText: "チーム" }).waitFor();
});

await step("左のメニュー・スマホの下のタブで画面を移れる", async () => {
  await page.locator("aside.side a.nav", { hasText: "セット" }).click();
  await page.waitForURL(base + "/sets");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".tabbar").getByRole("link", { name: "サーバー" }).click();
  await page.waitForURL(base + "/servers");
  await page.locator(".tabbar").getByRole("button", { name: "その他" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "チーム" }).click();
  await page.waitForURL(base + "/team");
  await page.screenshot({ path: ".e2e/phone.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
});

await step("セットを作ると一覧に出る", async () => {
  await page.goto(base + "/sets");
  await page.getByText(/まだセットがありません/).waitFor();
  await page.getByPlaceholder("セットの名前(例 ロビー用)").fill("ロビー用");
  await page.getByRole("button", { name: "作る" }).click();
  await page.getByText("ロビー用", { exact: true }).waitFor();
  await page.getByText(/まだ何も入っていません。先にライブラリ/).waitFor();
  await page.getByText("予約を使う").waitFor(); // 予約の欄も出る
  await page.screenshot({ path: ".e2e/sets.png", fullPage: true });
});

await step("チームの画面に自分がオーナーとして出る", async () => {
  await page.goto(base + "/team");
  await page.getByText("E2E(自分)").waitFor();
  await page.locator(".member .trail", { hasText: "オーナー" }).waitFor();
  await page.getByRole("button", { name: "招待のリンクを作る" }).waitFor();
});

// 自分用の版は家の中のパネルも登録できるので、どちらの版でも断る URL(ftp)で確かめる
await step("チームの画面から、操作の記録と Discord への通知を開ける", async () => {
  await page.goto(base + "/team");
  await page.getByRole("link", { name: "操作の記録と Discord への通知" }).click();
  await page.getByText("Discord への通知", { exact: true }).waitFor();
  await page.getByText("セットを作る").first().waitFor(); // さっき作ったセットが記録に出る
  await page.screenshot({ path: ".e2e/activity.png", fullPage: true });
});

await step("おかしな URL のパネルは登録できず、理由が出る", async () => {
  await page.goto(base + "/servers");
  await page.getByText("まだサーバーがありません。").waitFor();
  await page.locator("main").getByRole("button", { name: "＋ 追加" }).click(); // つなぎ方は「＋ 追加」のシート
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
  await page.getByRole("button", { name: "グループ(行)" }).click();
  await page.getByRole("button", { name: "＋ グループを追加" }).click();
  await page.getByLabel("番号").last().fill("90");
  await page.getByLabel("名前").last().fill("Proxy");
  await page.getByRole("button", { name: "ポートの種類(列)" }).click();
  await page.getByLabel("上へ").nth(1).click(); // 2 つ目の種類を一番上へ
  await page.screenshot({ path: ".e2e/ports-rules.png", fullPage: true });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const heads = await page.locator(".ports-table th").allTextContents().catch(() => []);
  await page.getByRole("button", { name: "種類とグループ" }).click();
  if ((await page.getByLabel("種類の名前").first().inputValue()) !== "Bedrock") throw new Error(`並び順が保存されていません ${heads}`);
  await page.getByRole("button", { name: "グループ(行)" }).click();
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
  await page.locator("main").getByRole("button", { name: "＋ 追加" }).click();
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
  await page.locator("main a.row", { hasText: "E2E" }).click();
  await page.getByRole("heading", { name: "E2E" }).waitFor();
  await page.getByText("要確認").waitFor();
  await page.getByRole("tab", { name: "アドオン" }).click();
  await page.waitForURL(/tab=addons/);
  await page.getByText("まだ何も入っていません。").waitFor();
  await page.getByRole("tab", { name: "ファイル" }).click();
  await page.getByText("server.properties").waitFor();
  await page.goBack(); // 戻るボタンで前のタブへ
  await page.waitForURL(/tab=addons/);
  await page.getByRole("tab", { name: "設定" }).click();
  await page.getByText("種類とバージョン").click();
  await page.getByRole("dialog").getByLabel("サーバーの種類").waitFor();
  if ((await page.getByRole("dialog").getByLabel("サーバーの種類").inputValue()) !== "paper") throw new Error("jar の名前から種類が決まっていません");
  await page.screenshot({ path: ".e2e/server-settings.png" });
  await page.keyboard.press("Escape");
  await page.goto(base + "/servers/" + page.url().split("/servers/")[1].split("?")[0] + "/files"); // 前の URL はファイルのタブへ
  await page.waitForURL(/tab=files/);
});

await step("ログアウトはアカウントの設定にあり、押すとログイン画面に戻る", async () => {
  await page.goto(base + "/settings");
  await page.screenshot({ path: ".e2e/settings.png", fullPage: true });
  await page.getByRole("button", { name: "ログアウト" }).click();
  await page.waitForURL(base + "/login");
});

await browser.close();
console.log(`FAILS: ${fails}`);
process.exit(fails ? 1 : 0);
