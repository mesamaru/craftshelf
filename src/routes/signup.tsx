import { useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";
import { safeNext } from "~/lib/next";
import { pageTitle } from "~/lib/titles";

export const Route = createFileRoute("/signup")({
  validateSearch: (s: Record<string, unknown>): { next?: string } => (s.next ? { next: safeNext(s.next) } : {}),
  beforeLoad: ({ context, search }) => {
    if (context.user) throw redirect({ href: safeNext(search.next) });
  },
  head: () => ({ meta: [{ title: pageTitle("アカウントの作成") }] }),
  component: Signup,
});

function Signup() {
  const { app } = Route.useRouteContext();
  const router = useRouter();
  const { next } = Route.useSearch();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    const { error } = await authClient.signUp.email({ name, email, password });
    setBusy(false);
    if (error) return setError(errorText(error));
    if (app.verifyEmail) return setSent(true); // 確かめるまではログインできない
    await router.invalidate();
    await router.navigate({ href: safeNext(next) });
  };

  return (
    <main className="auth glass">
      <img className="brand-mark" src="/icon.svg" alt="" />
      <h1 className="title">{app.mode === "self" && app.signupOpen ? "最初の管理者を作る" : "アカウントを作る"}</h1>
      {app.mode === "self" && !app.signupOpen && <p className="foot">招待されたメールアドレスで登録してください。</p>}
      {sent ? (
        <section className="group"><p className="row" role="status">{`${email} に確認のメールを送りました。メールのリンクを開くと登録が終わり、ログインできます(24 時間有効)。`}</p></section>
      ) : (
      <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <input className="row" autoComplete="nickname" placeholder="表示名"
          value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="row" type="email" autoComplete="email" placeholder="メールアドレス"
          value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="row" type="password" autoComplete="new-password" placeholder="パスワード(10 文字以上)"
          minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="row error" role="alert">{error}</p>}
        <button className="btn pri" disabled={busy}>作成</button>
      </form>
      )}
      {app.mode === "service" && <p className="foot">登録すると、<Link to="/terms">利用規約</Link>と<Link to="/privacy">プライバシーポリシー</Link>に同意したものとします。</p>}
      <p className="foot">アカウントがある場合は <Link to="/login" search={{ next }}>ログイン</Link></p>
    </main>
  );
}
