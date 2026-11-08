// エージェントが取りに来る(POST /api/agent/poll、Authorization: Bearer ca_…)。本文で、版と扱えるサーバーを知らせる。
// 頼みごとがあればすぐ、無ければしばらく待って返す
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/agent/poll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { agents, hub } = await import("~/server/instance");
        const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
        const body = await request.json().catch(() => ({}));
        const id = await agents.checkIn(token, body ?? {});
        if (!id) return Response.json({ message: "トークンが正しくありません" }, { status: 401 });
        return Response.json({ requests: await hub.poll(id) }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
