// バックアップをダウンロードする(GET /api/backup/<名前>)。管理者以上・自分用の版だけ
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/backup/$name")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { backups } = await import("~/server/instance");
        const { HttpError } = await import("~/server/guard");
        try {
          const path = await backups.file(request.headers, params.name);
          return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers: {
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
