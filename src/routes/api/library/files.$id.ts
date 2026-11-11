// アップロードした版をダウンロードする(GET /api/library/files/<版の ID>)
import { createFileRoute } from "@tanstack/react-router";
import { attachment } from "~/lib/disposition";

export const Route = createFileRoute("/api/library/files/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { uploads } = await import("~/server/instance");
        const { isHttpError } = await import("~/server/guard");
        try {
          const f = await uploads.download(request.headers, params.id);
          const { Readable } = await import("node:stream");
          return new Response(Readable.toWeb(f.stream) as ReadableStream, { headers: {
            "Content-Type": "application/java-archive", "Content-Length": String(f.size), "Content-Disposition": attachment(f.filename), "Cache-Control": "no-store",
          } });
        } catch (e) {
          if (isHttpError(e)) return Response.json({ message: e.message }, { status: e.status });
          throw e;
        }
      },
    },
  },
});
