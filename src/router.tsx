import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { routeTree } from "./routeTree.gen";
import { forgetShared } from "./lib/shared";

// ページ(SSR)ごとの nonce。ルーターが入れるスクリプト(<script>)に付け、同じ値を CSP に書く(src/server/security.ts)。
// 開発中(vite dev)は Vite が自分のスクリプトを入れるので付けない
const pageNonce = createIsomorphicFn()
  .server(async () => {
    if (import.meta.env.DEV) return undefined;
    const [{ setResponseHeader }, { csp }] = await Promise.all([import("@tanstack/react-start/server"), import("./server/security")]);
    const nonce = crypto.randomUUID().replace(/-/g, "");
    setResponseHeader("Content-Security-Policy", csp(nonce));
    return nonce;
  })
  .client(async () => undefined);

export async function getRouter() {
  const nonce = await pageNonce();
  const router = createRouter({ routeTree, scrollRestoration: true, defaultPreload: "intent", ...(nonce ? { ssr: { nonce } } : {}) });
  // 「読み直す」・変更のあとの invalidate は、画面で覚えている結果(src/lib/shared.ts)も捨てて、取り直す
  const invalidate = router.invalidate.bind(router);
  router.invalidate = (opts) => { forgetShared(); return invalidate(opts); };
  return router;
}
