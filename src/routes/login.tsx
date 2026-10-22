import { useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";

export const Route = createFileRoute("/login")({
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: "/" });
  },
  component: Login,
});

function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const done = async () => {
    await router.invalidate();
    await router.navigate({ to: "/" });
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const signIn = () =>
    run(async () => {
      const { data, error } = await authClient.signIn.email({ email, password });
      if (error) return setError(errorText(error));
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return setNeedCode(true);
      await done();
    });
  const verify = () =>
    run(async () => {
      const { error } = await authClient.twoFactor.verifyTotp({ code, trustDevice: false });
      if (error) return setError(errorText(error));
      await done();
    });
  const withPasskey = () =>
    run(async () => {
      const res = await authClient.signIn.passkey();
      if (res?.error) return setError(errorText(res.error));
      await done();
    });

  return (
    <main className="page narrow">
      <h1 className="title">Craftshelf Next</h1>
      {needCode ? (
        <form className="group form" onSubmit={(e) => (e.preventDefault(), verify())}>
          <p className="row muted">認証アプリに表示されている 6 桁のコードを入力してください。</p>
          <input className="row" inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
            value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          {error && <p className="row error" role="alert">{error}</p>}
          <button className="capsule primary" disabled={busy}>確認</button>
        </form>
      ) : (
        <>
          <form className="group form" onSubmit={(e) => (e.preventDefault(), signIn())}>
            <input className="row" type="email" autoComplete="username webauthn" placeholder="メールアドレス"
              value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="row" type="password" autoComplete="current-password" placeholder="パスワード"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <p className="row error" role="alert">{error}</p>}
            <button className="capsule primary" disabled={busy}>ログイン</button>
          </form>
          <button className="capsule" type="button" onClick={withPasskey} disabled={busy}>パスキーでログイン</button>
          <p className="foot">アカウントが無い場合は <Link to="/signup">新しく作る</Link></p>
        </>
      )}
    </main>
  );
}
