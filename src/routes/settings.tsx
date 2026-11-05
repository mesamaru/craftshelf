import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { renderSVG } from "uqr";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";
import { getImportReport } from "~/lib/session";
import { getVersions, installVersion, useImageVersion } from "~/lib/versions-api";
import { useCan } from "~/lib/use-can";
import { useServerFn } from "@tanstack/react-start";
import { createToken, listTokens, removeToken } from "~/lib/tokens-api";
import { getLang, setLang } from "~/lib/i18n";
import { sendFeedback, setTelemetry, telemetryInfo } from "~/lib/telemetry-api";

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

      <section className="group">
        <div className="row">
          <span>表示する言語</span>
          <select className="trail" defaultValue={typeof window === "undefined" ? "ja" : getLang()} onChange={(e) => setLang(e.target.value === "en" ? "en" : "ja")} aria-label="表示する言語">
            <option value="ja" translate="no">日本語</option>
            <option value="en" translate="no">English</option>
          </select>
        </div>
      </section>
      <p className="foot">このブラウザでの表示だけが変わります。利用者が入力した名前などは訳しません。</p>

      <div className="group-title">セキュリティ</div>
      {user.legacyTotp && (
        <p className="notice" role="status">
          v02 の二段階認証(認証アプリのコード)でログインしています。予備のコードは引き継げなかったので、下の「二段階認証を設定する」で設定し直してください(設定し直すと、v02 のものは使わなくなります)。
        </p>
      )}
      <TwoFactor enabled={user.twoFactorEnabled} />
      <Passkeys />

      <ApiTokens />
      <ImportReport userId={user.id} />
      <Versions userId={user.id} />
      <Telemetry userId={user.id} />
      <Feedback />

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
        {report.library && (
          <div className="row"><span>ライブラリ・セット</span><span className="trail">{report.library.items} 件・セット {report.library.sets} 個{report.library.folders ? `・フォルダのサーバー ${report.library.folders} 台` : ""}{report.library.uploads ? `・アップロードしたもの ${report.library.uploads} 件` : ""}</span></div>
        )}
        {[...report.skipped, ...(report.library?.skipped ?? [])].map((x, i) => (
          <div className="row" key={i}><span className="main"><span>{x.what}</span><span className="muted" translate="no">{x.detail}</span></span><span className="trail">取り込まず</span></div>
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

const tokenMessage = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

// API トークン(外から /api/v1 を呼ぶとき)。選んでいるチームのもので、自分の役割のとおりに動く
function ApiTokens() {
  const load = useServerFn(listTokens);
  const create = useServerFn(createToken);
  const remove = useServerFn(removeToken);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listTokens>> | null>(null);
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [days, setDays] = useState(90);
  const [made, setMade] = useState("");
  const [error, setError] = useState("");
  const reload = () => load().then(setRows, (e) => setError(tokenMessage(e)));
  useEffect(() => { reload(); }, []);

  const submit = async () => {
    setError("");
    try {
      const r = await create({ data: { name, readOnly, days } });
      setMade(r.key);
      setName("");
      await reload();
    } catch (e) {
      setError(tokenMessage(e));
    }
  };
  return (
    <>
      <div className="group-title">API トークン</div>
      <section className="group">
        {rows?.length === 0 && <div className="row muted">まだありません。</div>}
        {rows?.map((k) => (
          <div className="row" key={k.id}>
            <span className="main">
              <span translate="no">{k.name}</span>
              <span className="muted"><span className="codes">{k.start}…</span> · {k.readOnly ? "読み取りだけ" : "役割のとおり"} · {k.expiresAt ? `${new Date(k.expiresAt).toLocaleDateString("ja-JP")} まで` : "期限なし"}{k.lastUsed ? ` · 最後に使った日 ${new Date(k.lastUsed).toLocaleDateString("ja-JP")}` : ""}</span>
            </span>
            <button className="trail link danger" type="button"
              onClick={() => confirm(`トークン「${k.name}」を消しますか?(使っているスクリプトは動かなくなります)`) && remove({ data: { id: k.id } }).then(reload, (e) => setError(tokenMessage(e)))}>消す</button>
          </div>
        ))}
      </section>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <input className="row" placeholder="名前(使い道。例 毎朝の更新の確認)" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <label className="row"><span>読み取りだけ(入れる・起動などはできない)</span><input className="trail" type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /></label>
        <div className="row">
          <span>期限</span>
          <select className="trail" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="トークンの期限">
            <option value={30}>30 日</option><option value={90}>90 日</option><option value={365}>1 年</option><option value={0}>期限なし</option>
          </select>
        </div>
        <button className="row link" type="submit" disabled={!name.trim()}>トークンを作る</button>
        {made && (
          <p className="row" role="status">
            <span className="main">
              <span>トークンを作りました。いまだけ表示します。</span>
              <input className="codes share-url" readOnly value={made} onFocus={(e) => e.currentTarget.select()} aria-label="作ったトークン" />
            </span>
          </p>
        )}
        {error && <p className="row error" role="alert">{error}</p>}
      </form>
      <p className="foot">スクリプトなどから CraftShelf を操作するときに使います(<a href="/api/v1" target="_blank" rel="noreferrer">/api/v1</a> に使える API の一覧があります)。トークンは x-api-key か Authorization: Bearer で渡します。選んでいるチームのもので、あなたの役割のとおりに動きます。</p>
    </>
  );
}

// 開発者への匿名の利用状況(自分用の版・管理者以上)。送る内容をそのまま見せる
function Telemetry({ userId }: { userId: string }) {
  const { app } = Route.useRouteContext();
  const { can } = useCan(userId);
  const admin = app.mode === "self" && can({ member: ["update"] });
  const set = useServerFn(setTelemetry);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof telemetryInfo>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (admin) telemetryInfo().then(setInfo, (e) => setError(e instanceof Error ? e.message : String(e))); }, [admin]);
  if (!admin || !info?.available) return null;
  const change = async (enabled: boolean) => {
    setError("");
    try {
      await set({ data: { enabled } });
      setInfo(await telemetryInfo());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <div className="group-title">開発者への利用状況の送信</div>
      <section className="group">
        <label className="row"><span>匿名の利用状況を送る(1 日 1 回)</span><input className="trail" type="checkbox" checked={info.enabled} onChange={(e) => change(e.target.checked)} /></label>
        {info.lastSent && <div className="row"><span>最後に送った日時</span><span className="trail">{new Date(info.lastSent).toLocaleString("ja-JP")}</span></div>}
        <details className="row column">
          <summary>送る内容を見る</summary>
          <pre className="log" translate="no">{JSON.stringify(info.preview, null, 2)}</pre>
        </details>
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">開発の参考にするため、版・OS・使っている機能・登録数(おおまかな範囲)だけを送ります。名前・ファイル名・アドレス・IP アドレスなどは送りません。送るのは、ここをオンにしたときだけです。</p>
    </>
  );
}

// お問い合わせ・要望を開発者に送る
function Feedback() {
  const send = useServerFn(sendFeedback);
  const [kind, setKind] = useState<"request" | "bug" | "question" | "other">("request");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [includeEnv, setIncludeEnv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await send({ data: { kind, message, contact, includeEnv } });
      setNote("送りました。ありがとうございます");
      setMessage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="group-title">お問い合わせ・要望</div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <div className="row">
          <span>種類</span>
          <select className="trail" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="お問い合わせの種類">
            <option value="request">要望</option>
            <option value="bug">不具合</option>
            <option value="question">質問</option>
            <option value="other">その他</option>
          </select>
        </div>
        <textarea className="row" rows={4} placeholder="内容" value={message} maxLength={4000} onChange={(e) => setMessage(e.target.value)} aria-label="内容" />
        <input className="row" placeholder="返事の宛先(任意。Discord の名前・メールアドレスなど)" value={contact} maxLength={200} onChange={(e) => setContact(e.target.value)} />
        <label className="row"><span>版と OS も送る</span><input className="trail" type="checkbox" checked={includeEnv} onChange={(e) => setIncludeEnv(e.target.checked)} /></label>
        <button className="row link" type="submit" disabled={busy || message.trim().length < 2}>{busy ? "送っています…" : "開発者に送る"}</button>
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </form>
    </>
  );
}
