// 保存した版をまとめて zip でダウンロードする: GET /api/library/zip?ids=<ID,ID…> か ?set=<セットの ID>。
// 数が多いと URL に入らないので、画面からはフォームの POST(ids・set)でも受け付ける
import { createFileRoute } from "@tanstack/react-router";

async function send(headers: Headers, input: { ids: string; set: string }) {
  const { saved } = await import("~/server/instance");
  const { isHttpError } = await import("~/server/guard");
  try {
    const itemIds = input.ids.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
    const z = await saved.zip(headers, input.set ? { setId: input.set } : { itemIds });
    const { Readable } = await import("node:stream");
    return new Response(Readable.toWeb(z.stream) as ReadableStream, { headers: {
      "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${z.filename}"`, "Cache-Control": "no-store",
    } });
  } catch (e) {
    if (isHttpError(e)) return Response.json({ message: e.message }, { status: e.status });
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
        // フォーム(application/x-www-form-urlencoded)。ログインを確かめてから、上限付きで読む
        const { auth } = await import("~/server/instance");
        const { isHttpError, readBody, requireTeam } = await import("~/server/guard");
        let f: URLSearchParams;
        try {
          await requireTeam(auth, request.headers);
          f = new URLSearchParams(new TextDecoder().decode(await readBody(request, 1024 * 1024, "選んだものが多すぎます")));
        } catch (e) {
          if (isHttpError(e)) return Response.json({ message: e.message }, { status: e.status });
          throw e;
        }
        return send(request.headers, { ids: f.get("ids") ?? "", set: f.get("set") ?? "" });
      },
    },
  },
});
