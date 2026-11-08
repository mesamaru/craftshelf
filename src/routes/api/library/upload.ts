// アップロードを受け取る(POST /api/library/upload?filename=…、本文はファイルそのもの)。本文はディスクに少しずつ書く(1 GB まで)
import { createFileRoute } from "@tanstack/react-router";
import type { ReadableStream as WebStream } from "node:stream/web";

const handle = async ({ request }: { request: Request }) => {
  const { uploads } = await import("~/server/instance");
  const { HttpError } = await import("~/server/guard");
  const { UPLOAD_LIMITS } = await import("~/server/uploads");
  try {
    const filename = new URL(request.url).searchParams.get("filename") ?? "";
    if (!filename || filename.length > 200 || /[\\/]/.test(filename)) throw new HttpError(400, "ファイルの名前が正しくありません");
    if (Number(request.headers.get("content-length") ?? 0) > UPLOAD_LIMITS.fileBytes) throw new HttpError(400, "ファイルが大きすぎます");
    return Response.json(await uploads.receive(request.headers, filename, request.body as WebStream<Uint8Array> | null));
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ message: e.message }, { status: e.status });
    throw e;
  }
};

export const Route = createFileRoute("/api/library/upload")({
  server: { handlers: { POST: handle } },
});
