import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    tanstackStart(),
    // 静的ファイル(JS・CSS)はビルドのときに gzip・brotli にしておき、Accept-Encoding に合わせて配る。動的な応答は compress-plugin が gzip にする
    nitro({ traceDeps: ["@electric-sql/pglite*"], plugins: ["./src/server/compress-plugin.ts", "./src/server/startup.ts"], compressPublicAssets: { gzip: true, brotli: true } }),
    viteReact(),
  ],
});
