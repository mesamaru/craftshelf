// バックアップをダウンロードする(GET /api/backup/<名前>)。パネルの中か、置き場所の保存先のもの。管理者以上・自分用の版だけ
import { Readable } from "node:stream";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/backup/$name")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { backups } = await import("~/server/instance");
        const { HttpError } = await import("~/server/guard");
        try {
          const stream = await backups.open(request.headers, params.name);
          return new Response(Readable.toWeb(stream) as ReadableStream, { headers: {
            "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="${params.name}"`, "Cache-Control": "no-store",
          } });
        } catch (e) {
          if (e instanceof HttpError) return Response.json({ message: e.message }, { status: e.status });
          throw e;
        }
      },
    },
  },
});
