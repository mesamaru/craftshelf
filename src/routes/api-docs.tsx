import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ROLE_LABELS, type RoleName } from "~/lib/permissions";

export const Route = createFileRoute("/api-docs")({ component: ApiDocs });

type Doc = { method: string; path: string; summary: string; scopeLabel: string; role: RoleName; example: Record<string, unknown> | null };

// API の説明(v02 の 02.07): 一覧は src/server/rest.ts のルートの定義から作ったもの(GET /api/v1)を読む。ログインしていなくても見られる
function ApiDocs() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(location.origin);
    fetch("/api/v1").then((r) => r.json()).then((j) => setDocs(j.routes), () => setError("読み込めませんでした"));
  }, []);
  const shown = (docs ?? []).filter((d) => !q.trim() || `${d.method} ${d.path} ${d.summary}`.toLowerCase().includes(q.trim().toLowerCase()));
  // パスの :id などは <id> にして、URL は引用符でくくる(シェルが < を読み替えないように)
  const curl = (d: Doc) => {
    const url = `"${origin}${d.path.replace(/:(\w+)/g, "<$1>")}"`;
    return d.method === "GET"
      ? `curl -H "Authorization: Bearer cs_…" ${url}`
      : `curl -X POST -H "Authorization: Bearer cs_…" -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(d.example ?? {})}' ${url}`;
  };
  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/settings" className="capsule">‹ アカウント</Link>
        <h1>API の説明</h1>
      </header>
      <section className="group">
        <p className="row muted">スクリプトなどから CraftShelf を操作する API です。「アカウント」の「API トークン」で作ったトークン(cs_…)を、x-api-key か Authorization: Bearer で渡します。トークンで使えるのは、作るときに選んだ範囲の中で、作った人の役割でできることだけです。</p>
        <div className="row column">
          <span className="muted">例(サーバーの一覧)</span>
          <pre className="curl" translate="no">{`curl -H "Authorization: Bearer cs_…" "${origin}/api/v1/servers"`}</pre>
        </div>
        <p className="row muted">GET はクエリー(?query=… など)、POST は JSON で渡します。うまくいかないときは、HTTP の状態と {"{ \"message\": \"…\" }"} を返します(401 = トークンが正しくない、403 = 範囲・役割が足りない、404 = 見つからない)。</p>
      </section>

      <input className="capsule" placeholder="API を絞り込む(パス・説明)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="API を絞り込む" />
      <div className="group-title">{`${shown.length} 個の API`}</div>
      <section className="group">
        {!docs && !error && <div className="row muted">読み込んでいます…</div>}
        {error && <p className="row error" role="alert">{error}</p>}
        {shown.map((d) => (
          <details className="row column api-row" key={`${d.method} ${d.path}`}>
            <summary>
              <span className="method" translate="no">{d.method}</span> <span className="path" translate="no">{d.path}</span>
              <span className="api-summary">{d.summary}</span>
            </summary>
            <span className="muted small">{`要る範囲: ${d.scopeLabel}(${ROLE_LABELS[d.role]}以上)`}</span>
            <pre className="curl" translate="no">{curl(d)}</pre>
          </details>
        ))}
      </section>
      <p className="foot">この一覧は、パネルの中の API の定義から作っています(<a href="/api/v1" target="_blank" rel="noreferrer">GET /api/v1</a> でも同じものを JSON で見られます)。</p>
    </main>
  );
}
