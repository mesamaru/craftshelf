// 共有リンク(ログイン不要): /s/<トークン> か /s/<トークン>/<ファイル名>
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/s/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { shares } = await import("~/server/instance");
        const token = String(params._splat ?? "").split("/")[0];
        const f = await shares.download(token);
        if (!f) return new Response("このリンクは無効か、有効期限が切れています。\nThis link is invalid or has expired.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        return new Response(new Uint8Array(f.data), { headers: {
          "Content-Type": f.filename.endsWith(".zip") ? "application/zip" : "application/java-archive",
          "Content-Disposition": `attachment; filename="${f.filename}"`, "Cache-Control": "no-store", "X-Robots-Tag": "noindex",
        } });
      },
    },
  },
});
