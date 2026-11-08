// 見張り用(GET /api/health): データベースまで答えられるか。ログインは要らず、中身は返さない
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { db } = await import("~/server/instance");
          const { sql } = await import("drizzle-orm");
          await db.execute(sql`select 1`);
          return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
        } catch {
          return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
      },
    },
  },
});
