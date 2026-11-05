// Modpack を受け取って、ライブラリとセットを作る(POST /api/modpack?filename=…、本文はファイルそのもの)
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/modpack")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { modpacks } = await import("~/server/instance");
        const { HttpError } = await import("~/server/guard");
        const { MODPACK_MAX_BYTES } = await import("~/server/modpack");
        try {
          const filename = new URL(request.url).searchParams.get("filename") ?? "";
          if (!filename || filename.length > 200 || /[\\/]/.test(filename)) throw new HttpError(400, "ファイルの名前が正しくありません");
          if (Number(request.headers.get("content-length") ?? 0) > MODPACK_MAX_BYTES) throw new HttpError(400, "ファイルが大きすぎます");
          return Response.json(await modpacks.import(request.headers, filename, new Uint8Array(await request.arrayBuffer())));
        } catch (e) {
          if (e instanceof HttpError) return Response.json({ message: e.message }, { status: e.status });
          throw e;
        }
      },
    },
  },
});
