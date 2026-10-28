import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { renderSVG } from "uqr";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";
import { getImportReport } from "~/lib/session";
import { getVersions, installVersion, useImageVersion } from "~/lib/versions-api";
import { useCan } from "~/lib/use-can";

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
        <div className="row"><span>メールアドレス</span><span className="trail" translate="no">{user.email.endsWith("@v02.craftshelf.invalid") ? "未設定(v02 から取り込み)" : user.email}</span></div>
      </section>

      <div className="group-title">セキュリティ</div>
      {user.legacyTotp && (
        <p className="notice" role="status">
          v02 の二段階認証(認証アプリのコード)でログインしています。予備のコードは引き継げなかったので、下の「二段階認証を設定する」で設定し直してください(設定し直すと、v02 のものは使わなくなります)。
        </p>
      )}
      <TwoFactor enabled={user.twoFactorEnabled} />
      <Passkeys />

      <ImportReport userId={user.id} />
      <Versions userId={user.id} />

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

type Report = NonNullable<Awaited<ReturnType<typeof getImportReport>>>;

// v02 から取り込んだもの(チームの管理者だけに見せる)
function ImportReport({ userId }: { userId: string }) {
  const { can } = useCan(userId);
  const admin = can({ member: ["update"] });
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => {
    if (admin) getImportReport().then(setReport, () => setReport(null));
  }, [admin]);
  if (!report) return null;
  return (
    <>
      <div className="group-title">v02 から取り込んだもの({new Date(report.at).toLocaleString("ja-JP")})</div>
      <section className="group">
        <div className="row"><span>利用者</span><span className="trail">{report.users.length} 人</span></div>
        <div className="row"><span>Pterodactyl</span><span className="trail" translate="no">{report.ptero ? `${report.ptero.url}(サーバー ${report.ptero.servers} 台)` : "なし"}</span></div>
        {report.skipped.map((x, i) => (
          <div className="row" key={i}><span className="main"><span>{x.what}</span><span className="muted">{x.detail}</span></span><span className="trail">取り込まず</span></div>
        ))}
        {report.notes.map((n, i) => <p className="row muted" key={`n${i}`}>{n}</p>)}
      </section>
      <p className="foot">v02 のデータは書き換えていません。Docker のイメージを v02 に戻せば、v02 をそのまま使えます。</p>
    </>
  );
}

type VersionInfo = Awaited<ReturnType<typeof getVersions>>;

// パネルのバージョン(自分用の版。チームのオーナーと管理者だけ): GitHub にある版を選んで切り替える
function Versions({ userId }: { userId: string }) {
  const { app } = Route.useRouteContext();
  const { can } = useCan(userId);
  const admin = app.mode === "self" && can({ organization: ["update"] });
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (admin) getVersions().then(setInfo, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [admin]);
  if (!admin) return null;

  // 再起動を待って開き直す
  const waitRestart = async () => {
    await new Promise((r) => setTimeout(r, 3000));
    for (let i = 0; i < 60; i++) {
      if (await fetch("/api/auth/ok").then((r) => r.ok, () => false)) return location.reload();
      await new Promise((r) => setTimeout(r, 2000));
    }
    setError("再起動を待ちきれませんでした。少し待ってから開き直してください");
  };
  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (!confirm(label)) return;
    setBusy("切り替えています…");
    setError("");
    try {
      await fn();
      setBusy("再起動しています…");
      await waitRestart();
    } catch (e) {
      setBusy("");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="group-title">パネルのバージョン</div>
      <section className="group">
        <div className="row"><span>いまの版</span><span className="trail">v{info?.current ?? "…"}</span></div>
        {info?.selected && (
          <button className="row link" type="button" disabled={!!busy}
            onClick={() => run(`イメージの版(v${info.image})に戻しますか? パネルが再起動します`, () => useImageVersion())}>
            イメージの版(v{info.image})に戻す
          </button>
        )}
        {info?.releases.map((r) => (
          <div className="row" key={r.version}>
            <span className="main">
              <span>v{r.version}{r.version === info.current ? "(いまの版)" : ""}</span>
              <span className="muted">{r.publishedAt ? new Date(r.publishedAt).toLocaleString("ja-JP") : ""}</span>
            </span>
            {r.version !== info.current && (
              <button className="trail link" type="button" disabled={!!busy}
                onClick={() => run(`v${r.version} に切り替えますか? パネルが再起動します(データはそのままです)`, () => installVersion({ data: { version: r.version } }))}>
                {r.version > info.current ? "更新する" : "この版に戻す"}
              </button>
            )}
          </div>
        ))}
        {info && info.releases.length === 0 && <p className="row muted">GitHub に切り替えられる版がまだありません。</p>}
        {busy && <p className="row muted" role="status">{busy}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">データベースは「足すだけ」で変えていくので、前の版に戻してもデータは読めます。選んだ版が起動できなかったときは、イメージの版に自動で戻ります。</p>
    </>
  );
}
