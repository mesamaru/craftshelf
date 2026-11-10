// 手元のバックアップのファイルから戻す(POST /api/backup/restore、中身はそのまま送る)。管理者以上・自分用の版だけ。戻すのは次の起動で
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/backup/restore")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { auth, backups } = await import("~/server/instance");
        const { isHttpError, readBody, requireTeam } = await import("~/server/guard");
        const { BACKUP_MAX_BYTES } = await import("~/server/backup");
        try {
          await requireTeam(auth, request.headers, { member: ["update"] }); // 読む前に確かめる(管理者以上)
          await backups.restoreUpload(request.headers, await readBody(request, BACKUP_MAX_BYTES));
          setTimeout(() => process.exit(0), 800); // 応答を返してから終了する(Docker が再起動する)
          return Response.json({ ok: true });
        } catch (e) {
          if (isHttpError(e)) return Response.json({ message: e.message }, { status: e.status });
          throw e;
        }
      },
    },
  },
});
