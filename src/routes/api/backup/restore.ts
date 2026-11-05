// 手元のバックアップのファイルから戻す(POST /api/backup/restore、中身はそのまま送る)。管理者以上・自分用の版だけ。戻すのは次の起動で
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/backup/restore")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { backups } = await import("~/server/instance");
        const { HttpError } = await import("~/server/guard");
        const { BACKUP_MAX_BYTES } = await import("~/server/backup");
        try {
          if (Number(request.headers.get("content-length") ?? 0) > BACKUP_MAX_BYTES) throw new HttpError(400, "ファイルが大きすぎます");
          await backups.restoreUpload(request.headers, new Uint8Array(await request.arrayBuffer()));
          setTimeout(() => process.exit(0), 800); // 応答を返してから終了する(Docker が再起動する)
          return Response.json({ ok: true });
        } catch (e) {
          if (e instanceof HttpError) return Response.json({ message: e.message }, { status: e.status });
          throw e;
        }
      },
    },
  },
});
