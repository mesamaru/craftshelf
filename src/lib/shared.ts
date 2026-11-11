// 画面で同じ問い合わせを短いあいだ 1 つにまとめる(同時の呼び出しも、ttl のあいだの呼び出しも同じ結果を返す)。
// ブラウザの中だけで覚える(サーバーでの描画では覚えない = 利用者・チームをまたいで結果が混ざらない)。
// GET 以外の通信(登録・変更・ログイン・ログアウト・チームの切り替えなど)があったら、覚えたものをすべて捨てる(古い結果を見せない)。
// 「読み直す」(router.invalidate)でも捨てる(src/router.tsx)
type Hit = { at: number; p: Promise<unknown> };
const hits = new Map<string, Hit>();
let watching = false;

/** 覚えたものを捨てる(prefix を渡すと、そのキーで始まるものだけ) */
export function forgetShared(prefix = "") {
  for (const k of [...hits.keys()]) if (k.startsWith(prefix)) hits.delete(k);
}

const inBrowser = () => typeof window !== "undefined";

// fetch を 1 度だけ包み、書き込みの前と後(終わったあと)に捨てる
function watch() {
  if (watching) return;
  watching = true;
  const orig = globalThis.fetch;
  globalThis.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "GET" || method === "HEAD") return orig.call(globalThis, input, init);
    forgetShared();
    return orig.call(globalThis, input, init).finally(() => forgetShared());
  } as typeof fetch;
}

export function shared<T>(key: string, fn: () => Promise<T>, ttl = 3000): Promise<T> {
  if (!inBrowser()) return fn();
  watch();
  const hit = hits.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p as Promise<T>;
  const p = fn();
  hits.set(key, { at: Date.now(), p });
  p.catch(() => { if (hits.get(key)?.p === p) hits.delete(key); }); // 失敗は覚えない
  return p;
}
