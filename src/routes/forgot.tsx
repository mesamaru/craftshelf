import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";

export const Route = createFileRoute("/forgot")({ component: Forgot });

// パスワードを忘れたとき: 登録したメールアドレスに、再設定のリンクを送る(メールを送れるときだけ)
function Forgot() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset" });
    setBusy(false);
    if (error) return setError(errorText(error));
    setSent(true);
  };
  return (
    <main className="auth glass">
      <img className="brand-mark" src="/icon.svg" alt="" />
      <h1 className="title">パスワードの再設定</h1>
      {sent ? (
        <section className="group"><p className="row" role="status">登録されていれば、再設定のリンクをメールで送りました(1 時間有効)。メールが届かないときは、迷惑メールのフォルダも見てください。</p></section>
      ) : (
        <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
          <input className="row" type="email" autoComplete="email" placeholder="登録したメールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} required />
          {error && <p className="row error" role="alert">{error}</p>}
          <button className="btn pri" disabled={busy}>{busy ? "送っています…" : "再設定のリンクを送る"}</button>
        </form>
      )}
      <p className="foot"><Link to="/login">ログインに戻る</Link></p>
    </main>
  );
}
