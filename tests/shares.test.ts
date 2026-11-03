// 共有リンク(ログイン不要でダウンロード)と、チームの利用状況
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { shareLink } from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import { readZipTexts } from "~/server/jar";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { shareService } from "~/server/shares";
import { uploadService } from "~/server/uploads";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const fake: FetchLike = async () => Response.json({}, { status: 404 });
const plugin = (name: string) => makeZip({ "plugin.yml": `name: ${name}\nversion: 1.0\nmain: a.B\n` }, false);

let t: Awaited<ReturnType<typeof setup>>;
let shares: ReturnType<typeof shareService>;
let lib: ReturnType<typeof libraryService>;
let owner: Headers;
let editor: Headers;
let viewer: Headers;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const tokenOf = (url: string) => url.split("/s/")[1].split("/")[0];

async function join2(email: string, role: string) {
  const inv = await (await t.call("/organization/invite-member", { email, role }, owner.get("cookie")!)).json();
  const cookie = await t.signUp(email, email);
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  return t.headers(cookie);
}

beforeAll(async () => {
  t = await setup({ mode: "self" });
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir: mkdtempSync(join(tmpdir(), "cs-share-")) } };
  shares = shareService(deps);
  lib = libraryService(deps);
  const up = uploadService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  editor = await join2("editor@example.com", "editor");
  viewer = await join2("viewer@example.com", "viewer");
  await up.ingest(owner, "Alpha-1.0.jar", plugin("Alpha"));
  await up.ingest(owner, "Beta-1.0.jar", plugin("Beta"));
});

describe("共有リンク", () => {
  it("作れるのは編集者以上。1 つならそのファイルを、ログインせずにダウンロードできる", async () => {
    const [alpha] = (await lib.catalog(owner)).items;
    expect(await code(shares.create(viewer, { itemIds: [alpha.id], hours: 24, name: "" }, "https://panel.example.test"))).toBe(403);
    const r = await shares.create(editor, { itemIds: [alpha.id], hours: 24, name: "" }, "https://panel.example.test");
    expect(r.url).toMatch(/^https:\/\/panel\.example\.test\/s\/[A-Za-z0-9_-]+\/Alpha-1\.0\.jar$/);
    const f = await shares.download(tokenOf(r.url));
    expect(f?.filename).toBe("Alpha-1.0.jar");
    expect(readZipTexts(f!.data, ["plugin.yml"])?.get("plugin.yml")).toContain("name: Alpha");
    expect(await shares.download("wrong-token-0123456789abcd")).toBeNull();
  });

  it("いくつかなら zip にまとめる。ダウンロードの回数を数える。期限が切れたら渡さない", async () => {
    const ids = (await lib.catalog(owner)).items.map((i) => i.id);
    const r = await shares.create(owner, { itemIds: ids, hours: 1, name: "ロビー用" }, "https://panel.example.test");
    const f = await shares.download(tokenOf(r.url));
    expect(f?.filename).toBe("craftshelf.zip"); // 名前が日本語だけなら、決まった名前にする
    expect([...(readZipTexts(f!.data, ["Alpha-1.0.jar", "Beta-1.0.jar"])?.keys() ?? [])].sort()).toEqual(["Alpha-1.0.jar", "Beta-1.0.jar"]);
    const s = (await shares.list(owner)).find((x) => x.name === "ロビー用")!;
    expect([s.count, s.downloads, s.expired]).toEqual([2, 1, false]);
    await t.db.update(shareLink).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shareLink.id, s.id));
    expect(await shares.download(tokenOf(r.url))).toBeNull();
  });

  it("一覧は自分が作ったもの(管理者はすべて)。消せるのは作った人と管理者", async () => {
    expect((await shares.list(editor)).map((s) => s.name)).toEqual(["Alpha"]);
    expect((await shares.list(owner)).length).toBe(2);
    const mine = (await shares.list(owner)).find((s) => s.name === "ロビー用")!;
    expect(await code(shares.remove(editor, mine.id))).toBe(404);
    await shares.remove(owner, mine.id);
    expect((await shares.list(owner)).length).toBe(1);
  });
});

describe("利用状況", () => {
  it("管理者以上が、ライブラリ・アップロードした版・サーバー・メンバーなどの数を見られる", async () => {
    expect(await code(shares.usage(editor))).toBe(403);
    const u = await shares.usage(owner);
    expect(u.items).toEqual({ upload: 2 });
    expect(u.files.count).toBe(2);
    expect(u.files.bytes).toBeGreaterThan(0);
    expect(u.storage).toEqual([{ name: "パネルの中(既定)", count: 2, bytes: u.files.bytes }]);
    expect([u.servers, u.sets, u.members, u.shareLinks]).toEqual([0, 0, 3, 1]);
  });
});
