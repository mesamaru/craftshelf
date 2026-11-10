// エージェントが結果を返す(POST /api/agent/result、Authorization: Bearer ca_…)
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/agent/result")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { agents, hub } = await import("~/server/instance");
        const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
        // トークンを確かめてから、上限付きで読む
        if (!(await agents.verify(token))) return Response.json({ message: "トークンが正しくありません" }, { status: 401 });
        const { readBody } = await import("~/server/guard");
        let raw: Uint8Array;
        try {
          raw = await readBody(request, 150 * 1024 * 1024, "大きすぎます");
        } catch {
          return Response.json({ message: "大きすぎます" }, { status: 413 });
        }
        const body = (await Promise.resolve().then(() => JSON.parse(new TextDecoder().decode(raw))).catch(() => null)) as { id?: unknown; ok?: unknown; value?: unknown; error?: unknown; version?: unknown; servers?: unknown } | null;
        const id = await agents.checkIn(token, body ?? {});
        if (!id) return Response.json({ message: "トークンが正しくありません" }, { status: 401 });
        if (!body || typeof body.id !== "string") return Response.json({ message: "形が違います" }, { status: 400 });
        const ok = hub.result(id, body.id, body.ok === true, body.value, typeof body.error === "string" ? body.error : undefined);
        return Response.json({ ok }, { status: ok ? 200 : 404 });
      },
    },
  },
});
