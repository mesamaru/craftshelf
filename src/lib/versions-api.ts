// 画面から呼ぶ版の切り替え(自分用の版。チームのオーナーと管理者だけ)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

async function svc() {
  const { auth, versions } = await import("~/server/instance");
  const { HttpError, requireTeam } = await import("~/server/guard");
  await requireTeam(auth, getRequest().headers, { organization: ["update"] });
  if (!versions) throw new HttpError(400, "この版では、パネルから切り替えられません");
  return versions;
}
// 応答を返してから終了する。Docker が再起動し、docker/start.sh が選んだ版を起動する
const restartSoon = () => setTimeout(() => process.exit(0), 800);

export const getVersions = createServerFn({ method: "GET" }).handler(async () => {
  const v = await svc();
  return { ...v.state(), releases: await v.list() };
});

export const installVersion = createServerFn({ method: "POST" })
  .validator(z.object({ version: z.string().regex(/^\d{2}\.\d{2}\.\d{2}$/) }))
  .handler(async ({ data }) => {
    await (await svc()).install(data.version);
    restartSoon();
  });

export const useImageVersion = createServerFn({ method: "POST" }).handler(async () => {
  (await svc()).useImage();
  restartSoon();
});
