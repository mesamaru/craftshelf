import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // PGlite の準備(beforeAll)は、テストのファイルを並べて動かすと 10 秒を超えることがある
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30000, hookTimeout: 60000 },
});
