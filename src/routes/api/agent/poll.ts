// エージェントが取りに来る(POST /api/agent/poll、Authorization: Bearer ca_…)。本文で、版と扱えるサーバーを知らせる。
// 頼みごとがあればすぐ、無ければしばらく待って返す
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/agent/poll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { agents, hub } = await import("~/server/instance");
        const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
        // トークンを確かめてから、上限付きで読む
        if (!(await agents.verify(token))) return Response.json({ message: "トークンが正しくありません" }, { status: 401 });
        const { readBody } = await import("~/server/guard");
        const body = await readBody(request, 1024 * 1024).then((b) => JSON.parse(new TextDecoder().decode(b)), () => ({}));
        const id = await agents.checkIn(token, body ?? {});
        if (!id) return Response.json({ message: "トークンが正しくありません" }, { status: 401 });
        return Response.json({ requests: await hub.poll(id) }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
