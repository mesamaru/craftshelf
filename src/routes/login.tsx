import { useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";
import { safeNext } from "~/lib/next";

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { next?: string } => (s.next ? { next: safeNext(s.next) } : {}),
  beforeLoad: ({ context, search }) => {
    if (context.user) throw redirect({ href: safeNext(search.next) });
  },
  component: Login,
});

function Login() {
  const { app } = Route.useRouteContext();
  const router = useRouter();
  const { next } = Route.useSearch();
  const [id, setId] = useState(""); // メールアドレスかユーザー名(v02 から取り込んだ人はユーザー名)
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [needV02Code, setNeedV02Code] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const done = async () => {
    await router.invalidate();
    await router.navigate({ href: safeNext(next) });
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

  const signIn = (v02Code?: string) =>
    run(async () => {
      const opts = v02Code ? { headers: { "x-v02-totp": v02Code } } : undefined;
      const { data, error } = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)
        ? await authClient.signIn.email({ email: id, password }, opts)
        : await authClient.signIn.username({ username: id, password }, opts);
      if (error?.code === "V02_TOTP_REQUIRED") return setNeedV02Code(true);
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
      <h1 className="title">CraftShelf</h1>
      {needV02Code ? (
        <form className="group form" onSubmit={(e) => (e.preventDefault(), signIn(code))}>
          <p className="row muted">v02 で使っていた認証アプリに表示されている 6 桁のコードを入力してください。</p>
          <input className="row" inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
            value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          {error && <p className="row error" role="alert">{error}</p>}
          <button className="capsule primary" disabled={busy}>確認</button>
        </form>
      ) : needCode ? (
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
            <input className="row" autoComplete="username webauthn" placeholder={app.mode === "self" ? "ユーザー名かメールアドレス" : "メールアドレス"}
              value={id} onChange={(e) => setId(e.target.value)} required autoCapitalize="none" />
            <input className="row" type="password" autoComplete="current-password" placeholder="パスワード"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <p className="row error" role="alert">{error}</p>}
            <button className="capsule primary" disabled={busy}>ログイン</button>
          </form>
          <button className="capsule" type="button" onClick={withPasskey} disabled={busy}>パスキーでログイン</button>
          {app.mode === "self" && app.signupOpen ? (
            <p className="foot">はじめて使うときは <Link to="/signup" search={{ next }}>最初の管理者を作る</Link></p>
          ) : (
            <p className="foot">{app.mode === "self" ? "招待された人は " : "アカウントが無い場合は "}<Link to="/signup" search={{ next }}>新しく作る</Link></p>
          )}
        </>
      )}
    </main>
  );
}
