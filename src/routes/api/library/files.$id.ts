// アップロードした版をダウンロードする(GET /api/library/files/<版の ID>)
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/library/files/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { uploads } = await import("~/server/instance");
        const { HttpError } = await import("~/server/guard");
        try {
          const f = await uploads.download(request.headers, params.id);
          return new Response(new Uint8Array(f.data), { headers: {
            "Content-Type": "application/java-archive", "Content-Disposition": `attachment; filename="${f.filename}"`, "Cache-Control": "no-store",
          } });
        } catch (e) {
          if (e instanceof HttpError) return Response.json({ message: e.message }, { status: e.status });
          throw e;
        }
      },
    },
  },
});
