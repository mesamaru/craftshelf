// エージェントが結果を返す(POST /api/agent/result、Authorization: Bearer ca_…)
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/agent/result")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { agents, hub } = await import("~/server/instance");
        const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
        if (Number(request.headers.get("content-length") ?? 0) > 150 * 1024 * 1024) return Response.json({ message: "大きすぎます" }, { status: 413 });
        const body = (await request.json().catch(() => null)) as { id?: unknown; ok?: unknown; value?: unknown; error?: unknown; version?: unknown; servers?: unknown } | null;
        const id = await agents.checkIn(token, body ?? {});
        if (!id) return Response.json({ message: "トークンが正しくありません" }, { status: 401 });
        if (!body || typeof body.id !== "string") return Response.json({ message: "形が違います" }, { status: 400 });
        const ok = hub.result(id, body.id, body.ok === true, body.value, typeof body.error === "string" ? body.error : undefined);
        return Response.json({ ok }, { status: ok ? 200 : 404 });
      },
    },
  },
});
