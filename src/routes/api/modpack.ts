// Modpack を受け取って、ライブラリとセットを作る(POST /api/modpack?filename=…、本文はファイルそのもの)
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/modpack")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { auth, modpacks } = await import("~/server/instance");
        const { HttpError, isHttpError, readBody, requireTeam } = await import("~/server/guard");
        const { MODPACK_MAX_BYTES } = await import("~/server/modpack");
        try {
          const filename = new URL(request.url).searchParams.get("filename") ?? "";
          if (!filename || filename.length > 200 || /[\\/]/.test(filename)) throw new HttpError(400, "ファイルの名前が正しくありません");
          await requireTeam(auth, request.headers, { library: ["edit"] }); // 読む前に確かめる(ログインしていない人の大きな本文をメモリに載せない)
          const server = new URL(request.url).searchParams.get("server") || undefined;
          return Response.json(await modpacks.import(request.headers, filename, await readBody(request, MODPACK_MAX_BYTES), server));
        } catch (e) {
          if (isHttpError(e)) return Response.json({ message: e.message }, { status: e.status });
          throw e;
        }
      },
    },
  },
});
