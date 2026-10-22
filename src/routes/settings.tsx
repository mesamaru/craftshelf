import { useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { renderSVG } from "uqr";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login" });
    return { user: context.user };
  },
  component: Settings,
});

// ユーザー設定(アカウント・セキュリティ・ログアウト)
function Settings() {
  const { user } = Route.useRouteContext();
  const router = useRouter();

  const logout = async () => {
    await authClient.signOut();
    await router.invalidate();
    await router.navigate({ to: "/login" });
  };

  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/" className="capsule">‹ 戻る</Link>
        <h1>アカウント</h1>
      </header>

      <div className="group-title">プロフィール</div>
      <section className="group">
        <div className="row"><span>表示名</span><span className="trail" translate="no">{user.name}</span></div>
        <div className="row"><span>メールアドレス</span><span className="trail" translate="no">{user.email}</span></div>
      </section>

      <div className="group-title">セキュリティ</div>
      <TwoFactor enabled={user.twoFactorEnabled} />
      <Passkeys />

      <section className="group spaced">
        <button className="row danger" type="button" onClick={logout}>ログアウト</button>
      </section>
    </main>
  );
}

function TwoFactor({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const start = async () => {
    setError("");
    if (enabled) {
      const { error } = await authClient.twoFactor.disable({ password });
      if (error) return setError(errorText(error));
      setPassword("");
      return router.invalidate();
    }
    const { data, error } = await authClient.twoFactor.enable({ password });
    if (error) return setError(errorText(error));
    setPassword("");
    if (data?.method === "totp") setSetup({ uri: data.totpURI, backupCodes: data.backupCodes });
  };
  const confirm = async () => {
    setError("");
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    if (error) return setError(errorText(error));
    setSetup(null);
    setCode("");
    await router.invalidate();
  };

  return (
    <section className="group form">
      <div className="row"><span>二段階認証</span><span className="trail">{enabled ? "オン" : "オフ"}</span></div>
      {setup ? (
        <>
          <p className="row muted">認証アプリで QR コードを読み取り、表示された 6 桁のコードを入力してください。</p>
          <div className="row qr" dangerouslySetInnerHTML={{ __html: renderSVG(setup.uri) }} />
          <p className="row muted">予備のコード(認証アプリが使えないときに 1 回ずつ使えます。安全な場所に保管してください)</p>
          <pre className="row codes" translate="no">{setup.backupCodes.join("\n")}</pre>
          <input className="row" inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
            value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="capsule primary" type="button" onClick={confirm}>有効にする</button>
        </>
      ) : (
        <>
          <input className="row" type="password" autoComplete="current-password" placeholder="いまのパスワード"
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="capsule" type="button" onClick={start} disabled={!password}>
            {enabled ? "二段階認証をオフにする" : "二段階認証を設定する"}
          </button>
        </>
      )}
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}

function Passkeys() {
  const { data: list, refetch } = authClient.useListPasskeys();
  const [error, setError] = useState("");

  const add = async () => {
    setError("");
    const res = await authClient.passkey.addPasskey({ name: "パスキー" });
    if (res?.error) return setError(errorText(res.error));
    refetch();
  };
  const remove = async (id: string) => {
    const { error } = await authClient.passkey.deletePasskey({ id });
    if (error) return setError(errorText(error));
    refetch();
  };

  return (
    <section className="group">
      <div className="row"><span>パスキー</span><span className="trail">{list?.length ?? 0} 個</span></div>
      {list?.map((p) => (
        <div className="row" key={p.id}>
          <span translate="no">{p.name || "パスキー"}</span>
          <button className="trail link danger" type="button" onClick={() => remove(p.id)}>削除</button>
        </div>
      ))}
      <button className="row link" type="button" onClick={add}>パスキーを追加</button>
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}
