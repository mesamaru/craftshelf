import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [tanstackStart(), nitro({ traceDeps: ["@electric-sql/pglite*"], plugins: ["./src/server/startup.ts"] }), viteReact()],
});
