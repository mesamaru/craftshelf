import { useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";

export const Route = createFileRoute("/signup")({
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: "/" });
  },
  component: Signup,
});

function Signup() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    const { error } = await authClient.signUp.email({ name, email, password });
    setBusy(false);
    if (error) return setError(errorText(error));
    await router.invalidate();
    await router.navigate({ to: "/" });
  };

  return (
    <main className="page narrow">
      <h1 className="title">アカウントを作る</h1>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <input className="row" autoComplete="nickname" placeholder="表示名" translate="no"
          value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="row" type="email" autoComplete="email" placeholder="メールアドレス"
          value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="row" type="password" autoComplete="new-password" placeholder="パスワード(10 文字以上)"
          minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="row error" role="alert">{error}</p>}
        <button className="capsule primary" disabled={busy}>作成</button>
      </form>
      <p className="foot">アカウントがある場合は <Link to="/login">ログイン</Link></p>
    </main>
  );
}
