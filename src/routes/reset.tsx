import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";

export const Route = createFileRoute("/reset")({
  validateSearch: (s: Record<string, unknown>): { token?: string; error?: string } => ({
    ...(typeof s.token === "string" ? { token: s.token } : {}), ...(typeof s.error === "string" ? { error: s.error } : {}),
  }),
  component: Reset,
});

// メールのリンクから開く: 新しいパスワードを決める
function Reset() {
  const { token, error: linkError } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    const { error } = await authClient.resetPassword({ newPassword: password, token: token! });
    setBusy(false);
    if (error) return setError(errorText(error));
    setDone(true);
  };
  return (
    <main className="auth glass">
      <img className="brand-mark" src="/icon.svg" alt="" />
      <h1 className="title">新しいパスワード</h1>
      {!token || linkError ? (
        <section className="group"><p className="row error" role="alert">リンクが使えません(期限切れか、もう使ったもの)。もう一度やり直してください</p></section>
      ) : done ? (
        <section className="group"><p className="row" role="status">パスワードを変えました。新しいパスワードでログインしてください。</p></section>
      ) : (
        <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
          <input className="row" type="password" autoComplete="new-password" placeholder="新しいパスワード(10 文字以上)" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <p className="row error" role="alert">{error}</p>}
          <button className="btn pri" disabled={busy}>{busy ? "変えています…" : "パスワードを変える"}</button>
        </form>
      )}
      <p className="foot"><Link to="/login">ログインへ</Link>{!token || linkError ? <> · <Link to="/forgot">もう一度送る</Link></> : null}</p>
    </main>
  );
}
