// 自分の背景画像(GET /api/me/background?v=<変えた時刻>)。場所に時刻が付くので、変えるまでブラウザのキャッシュを使う
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/me/background")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { prefs } = await import("~/server/instance");
        const { HttpError } = await import("~/server/guard");
        try {
          const bg = await prefs.background(request.headers);
          if (!bg) return Response.json({ message: "背景画像はありません" }, { status: 404 });
          return new Response(new Uint8Array(bg.data), { headers: {
            "Content-Type": bg.type, "Content-Length": String(bg.data.length), "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
          } });
        } catch (e) {
          if (e instanceof HttpError) return Response.json({ message: e.message }, { status: e.status });
          throw e;
        }
      },
    },
  },
});
