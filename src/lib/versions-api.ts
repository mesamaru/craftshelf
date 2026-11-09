// 画面から呼ぶ版の切り替え・自動アップデート・更新の前に戻す(自分用の版。権限の確認は src/server/updates.ts でも行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

async function svc() {
  const { auth, versions, updates } = await import("~/server/instance");
  const { HttpError, requireTeam } = await import("~/server/guard");
  await requireTeam(auth, getRequest().headers, { panel: ["manage"] });
  if (!versions || !updates) throw new HttpError(400, "この版では、パネルから切り替えられません");
  return { versions, updates };
}
const headers = () => getRequest().headers;
// 応答を返してから終了する。Docker・install.sh・インストーラー版のランチャーが再起動し、選んだ版を起動する
const restartSoon = () => setTimeout(() => process.exit(0), 800);

export const getVersions = createServerFn({ method: "GET" }).handler(async () => {
  const { versions, updates } = await svc();
  // GitHub につながらなくても、自動アップデートの設定と更新の記録は出す
  let listError = "";
  const releases = await versions.list().catch((e) => { listError = e instanceof Error ? e.message : String(e); return []; });
  return { ...versions.state(), releases, listError, updates: await updates.settings(headers()) };
});

/** その版に切り替える(前にパネルのバックアップを作る) */
export const installVersion = createServerFn({ method: "POST" })
  .validator(z.object({ version: z.string().regex(/^\d{2}\.\d{2}\.\d{2}$/) }))
  .handler(async ({ data }) => {
    await (await svc()).updates.update(headers(), data.version);
    restartSoon();
  });

export const useImageVersion = createServerFn({ method: "POST" }).handler(async () => {
  const { versions, updates } = await svc();
  await updates.update(headers(), versions.state().image);
  restartSoon();
});

export const setAutoUpdate = createServerFn({ method: "POST" })
  .validator(z.object({ auto: z.boolean(), channel: z.enum(["stable", "dev"]) }))
  .handler(async ({ data }) => (await svc()).updates.setAuto(headers(), data));

/** この更新の前に戻す(データと版の両方。次の起動で) */
export const rollbackUpdate = createServerFn({ method: "POST" })
  .validator(z.object({ at: z.string().max(40) }))
  .handler(async ({ data }) => {
    await (await svc()).updates.rollback(headers(), data.at);
    restartSoon();
  });
