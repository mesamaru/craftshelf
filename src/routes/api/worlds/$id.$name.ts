// ワールドのバックアップをダウンロードする(GET /api/worlds/<サーバーの ID>/<名前>)。編集者以上。
// Pterodactyl のバックアップは、Wings のダウンロード先(しばらくだけ使える URL)へ移る
import { Readable } from "node:stream";
import { createFileRoute } from "@tanstack/react-router";
import { attachment } from "~/lib/disposition";

export const Route = createFileRoute("/api/worlds/$id/$name")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { worlds } = await import("~/server/instance");
        const { isHttpError } = await import("~/server/guard");
        try {
          const f = await worlds.open(request.headers, params.id, params.name);
          if ("url" in f) return new Response(null, { status: 302, headers: { Location: f.url, "Cache-Control": "no-store" } });
          return new Response(Readable.toWeb(f.stream) as ReadableStream, { headers: {
            "Content-Type": "application/gzip", "Content-Disposition": attachment(params.name), "Cache-Control": "no-store",
            ...(f.size !== null ? { "Content-Length": String(f.size) } : {}),
          } });
        } catch (e) {
          if (isHttpError(e)) return Response.json({ message: e.message }, { status: e.status });
          throw e;
        }
      },
    },
  },
});
