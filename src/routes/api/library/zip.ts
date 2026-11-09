// 保存した版をまとめて zip でダウンロードする: GET /api/library/zip?ids=<ID,ID…> か ?set=<セットの ID>。
// 数が多いと URL に入らないので、画面からはフォームの POST(ids・set)でも受け付ける
import { createFileRoute } from "@tanstack/react-router";

async function send(headers: Headers, input: { ids: string; set: string }) {
  const { saved } = await import("~/server/instance");
  const { HttpError } = await import("~/server/guard");
  try {
    const itemIds = input.ids.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
    const z = await saved.zip(headers, input.set ? { setId: input.set } : { itemIds });
    const { Readable } = await import("node:stream");
    return new Response(Readable.toWeb(z.stream) as ReadableStream, { headers: {
      "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${z.filename}"`, "Cache-Control": "no-store",
    } });
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ message: e.message }, { status: e.status });
    throw e;
  }
}

export const Route = createFileRoute("/api/library/zip")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const q = new URL(request.url).searchParams;
        return send(request.headers, { ids: q.get("ids") ?? "", set: q.get("set") ?? "" });
      },
      POST: async ({ request }) => {
        const f = await request.formData().catch(() => null);
        return send(request.headers, { ids: String(f?.get("ids") ?? ""), set: String(f?.get("set") ?? "") });
      },
    },
  },
});
