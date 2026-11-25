// Nitro のプラグイン: すべての応答にセキュリティヘッダーを付け(security.ts)、動的な応答(server function の JSON・API)を gzip にして返す(中身は compress.ts)。
// 静的ファイルは事前に圧縮した版を Nitro が配る
import { gzipResponse } from "./compress";
import { securityHeaders } from "./security";

type App = { fetch: (req: Request) => Response | Promise<Response> };

export default function compress(nitroApp: App) {
  const fetch = nitroApp.fetch;
  nitroApp.fetch = async (req) => gzipResponse(req, securityHeaders(req, await fetch(req)));
}
