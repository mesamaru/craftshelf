// 共有リンク(ログイン不要): /s/<トークン> か /s/<トークン>/<ファイル名>
import { createFileRoute } from "@tanstack/react-router";
import { attachment } from "~/lib/disposition";

export const Route = createFileRoute("/s/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { shares } = await import("~/server/instance");
        const token = String(params._splat ?? "").split("/")[0];
        const f = await shares.download(token);
        if (!f) return new Response("このリンクは無効か、有効期限が切れています。\nThis link is invalid or has expired.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        const { Readable } = await import("node:stream");
        const body = Readable.toWeb(f.stream) as ReadableStream;
        return new Response(body, { headers: {
          "Content-Type": f.filename.endsWith(".zip") ? "application/zip" : "application/java-archive", ...(f.size != null ? { "Content-Length": String(f.size) } : {}),
          "Content-Disposition": attachment(f.filename), "Cache-Control": "no-store", "X-Robots-Tag": "noindex",
        } });
      },
    },
  },
});
