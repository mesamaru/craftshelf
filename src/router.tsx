import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { forgetShared } from "./lib/shared";

export function getRouter() {
  const router = createRouter({ routeTree, scrollRestoration: true, defaultPreload: "intent" });
  // 「読み直す」・変更のあとの invalidate は、画面で覚えている結果(src/lib/shared.ts)も捨てて、取り直す
  const invalidate = router.invalidate.bind(router);
  router.invalidate = (opts) => { forgetShared(); return invalidate(opts); };
  return router;
}
