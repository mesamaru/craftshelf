// エージェント(src/agent/main.ts)を 1 つのファイルにまとめる。パネルの /agent/craftshelf-agent.mjs から取ってこられるように、
// パネルの公開フォルダ(public/agent。git には入れない)に置く。esbuild は vite と一緒に入っているものを使う
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = readFileSync(root + "VERSION", "utf8").trim();
await build({
  entryPoints: [root + "src/agent/main.ts"],
  outfile: root + "public/agent/craftshelf-agent.mjs", // パネルのビルドの前に作り、公開するファイルに入れる
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  alias: { "~": root + "src" },
  banner: { js: `#!/usr/bin/env node\n// CraftShelf エージェント(パネル v${version} と一緒に作ったもの)。使い方は https://github.com/mesamaru/craftshelf/blob/dev/docs/AGENT.md\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  legalComments: "none",
  logLevel: "warning",
});
console.log("agent: public/agent/craftshelf-agent.mjs");
