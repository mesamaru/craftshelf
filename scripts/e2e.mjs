// ブラウザで画面を通しで操作して確かめる(npm run e2e)。
// ビルドしたサーバーを E2E_URL(既定 http://localhost:3123)で動かしておく。
// ブラウザは E2E_BROWSER(既定 msedge。chrome・chromium も可)。画面の写しは .e2e/ に保存する
import { mkdirSync } from "node:fs";
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
  await page.locator('a.capsule[aria-label="チーム"]').waitFor(); // チームの名前は版によって違う(サービス版は「E2E のチーム」、自分用は「CraftShelf」)
});

await step("チームの画面に自分がオーナーとして出る", async () => {
  await page.goto(base + "/team");
  await page.getByText("E2E(自分)").waitFor();
  await page.locator(".member .trail", { hasText: "オーナー" }).waitFor();
  await page.getByRole("button", { name: "招待のリンクを作る" }).waitFor();
});

await step("LAN の中のパネルは登録できず、理由が出る", async () => {
  await page.goto(base + "/servers");
  await page.getByPlaceholder("パネルの URL(https://…)").fill("https://192.168.1.5");
  await page.getByPlaceholder("Client API キー(ptlc_…)").fill("ptlc_0123456789abcdef");
  await page.getByRole("button", { name: "パネルをつなぐ" }).click();
  await page.getByText("家の中・社内などのアドレスにはつなげません").waitFor();
  await page.screenshot({ path: ".e2e/servers.png", fullPage: true });
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
