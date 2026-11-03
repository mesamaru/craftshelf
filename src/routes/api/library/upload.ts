// アップロードを受け取る(POST /api/library/upload?filename=…、本文はファイルそのもの)
import { createFileRoute } from "@tanstack/react-router";

const handle = async ({ request }: { request: Request }) => {
  const { uploads } = await import("~/server/instance");
  const { HttpError } = await import("~/server/guard");
  const { UPLOAD_LIMITS } = await import("~/server/uploads");
  try {
    const filename = new URL(request.url).searchParams.get("filename") ?? "";
    if (!filename || filename.length > 200 || /[\\/]/.test(filename)) throw new HttpError(400, "ファイルの名前が正しくありません");
    if (Number(request.headers.get("content-length") ?? 0) > UPLOAD_LIMITS.fileBytes) throw new HttpError(400, "ファイルが大きすぎます");
    const data = new Uint8Array(await request.arrayBuffer());
    return Response.json(await uploads.ingest(request.headers, filename, data));
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ message: e.message }, { status: e.status });
    throw e;
  }
};

export const Route = createFileRoute("/api/library/upload")({
  server: { handlers: { POST: handle } },
});
