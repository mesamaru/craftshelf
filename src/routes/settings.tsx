import { type ReactNode, useEffect, useRef, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { SettingsFrame } from "~/lib/settings-frame";
import { Info } from "~/lib/ui";
import { renderSVG } from "uqr";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";
import { getImportReport } from "~/lib/session";
import { getVersions, installVersion, rollbackUpdate, setAutoUpdate, useImageVersion } from "~/lib/versions-api";
import { useCan } from "~/lib/use-can";
import { SCOPE_LABELS, SCOPE_SHORT, TOKEN_SCOPES, type TokenScope, permsAllowScope } from "~/lib/permissions";
import { useServerFn } from "@tanstack/react-start";
import { createToken, listTokens, removeToken } from "~/lib/tokens-api";
import { getLang, setLang } from "~/lib/i18n";
import { ACCENTS, ACCENT_LABELS, type Accent, DEFAULT_THEME, LIMITS, type Mode, PRESETS, type Preset, type Theme, backgroundFrom, getTheme, saveTheme } from "~/lib/theme";
import { saveMyBackground, saveMyTheme } from "~/lib/prefs-api";
import { sendFeedback, setTelemetry, telemetryInfo } from "~/lib/telemetry-api";
import { deleteAccount } from "~/lib/teams-api";
import { settingsTitle } from "~/lib/titles";
import { confirmDialog, promptDialog } from "~/lib/dialog-queue";

export const Route = createFileRoute("/settings")({
  validateSearch: (s: Record<string, unknown>): { s?: string } => (typeof s.s === "string" ? { s: s.s } : {}),
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login" });
    return { user: context.user };
  },
  head: ({ match }) => ({ meta: [{ title: settingsTitle(match.search.s ?? "profile") }] }),
  component: Settings,
});

// 設定のうち、アカウントとパネルのまとまり(?s= で選ぶ。何も選ばないとパソコンはプロフィール、スマホは一覧)
const SECTIONS = ["profile", "security", "passkeys", "look", "tokens", "versions", "telemetry", "import", "feedback"] as const;
type Section = (typeof SECTIONS)[number];
const INFO: Partial<Record<Section, ReactNode>> = {
  look: <><span>見た目と背景画像はアカウントに保存し、どの端末でも同じになります。背景画像は長い辺 1920 px までに縮めて保存し(2 MB まで)、テーマの背景の代わりに使います。</span><span>言語は、このブラウザでの表示だけが変わります。利用者が入力した名前などは訳しません。</span></>,
  tokens: <><span>スクリプトなどから CraftShelf を操作するときに使います(使える API は「API の説明」にあります)。トークンは x-api-key か Authorization: Bearer で渡します。</span><span>選んでいるチームのもので、選んだ範囲の中で、あなたの権限(役割と、メンバーごとに足し引きした権限)のとおりに動きます。</span></>,
  versions: <span>切り替える前に、パネルのバックアップを作ります(置き場所・残す数は定期バックアップの設定のもの)。データベースは「足すだけ」で変えていくので、前の版に戻してもデータは読めます。ただし、メンバーごとの権限などを知らない古い版には戻せません(一覧に「戻せません」と出ます)。選んだ版が起動できなかったときは、イメージの版に自動で戻ります。</span>,
  telemetry: <span>開発の参考にするため、版・OS・使っている機能・登録数(おおまかな範囲)だけを送ります。名前・ファイル名・アドレス・IP アドレスなどは送りません。送るのは、ここをオンにしたときだけです。</span>,
  import: <span>v02 のデータは書き換えていません。Docker のイメージを v02 に戻せば、v02 をそのまま使えます。</span>,
};

function Settings() {
  const { user } = Route.useRouteContext();
  const { s } = Route.useSearch();
  const at: Section = SECTIONS.includes(s as Section) ? (s as Section) : "profile";
  return (
    <SettingsFrame at={at} root={!s} info={INFO[at]}>
      {at === "profile" && <>
        <Profile name={user.name} username={user.username ?? ""} />
        <section className="group">
          <div className="row"><span>メールアドレス</span><span className="trail" translate="no">{user.email.endsWith("@v02.craftshelf.invalid") ? "未設定(v02 から取り込み)" : user.email}</span></div>
        </section>
        <DeleteAccount />
      </>}
      {at === "security" && <>
        {user.legacyTotp && (
          <p className="notice" role="status">
            v02 の二段階認証(認証アプリのコード)でログインしています。予備のコードは引き継げなかったので、下の「二段階認証を設定する」で設定し直してください(設定し直すと、v02 のものは使わなくなります)。
          </p>
        )}
        <ChangePassword />
        <TwoFactor enabled={user.twoFactorEnabled} />
      </>}
      {at === "passkeys" && <Passkeys />}
      {at === "look" && <>
        <section className="group">
          <div className="row">
            <span>表示する言語</span>
            <select className="trail" defaultValue={typeof window === "undefined" ? "ja" : getLang()} onChange={(e) => setLang(e.target.value === "en" ? "en" : "ja")} aria-label="表示する言語">
              <option value="ja" translate="no">日本語</option>
              <option value="en" translate="no">English</option>
            </select>
          </div>
        </section>
        <Appearance />
      </>}
      {at === "tokens" && <ApiTokens userId={user.id} />}
      {at === "versions" && <Versions userId={user.id} />}
      {at === "telemetry" && <Telemetry userId={user.id} />}
      {at === "import" && <ImportReport userId={user.id} />}
      {at === "feedback" && <Feedback />}
    </SettingsFrame>
  );
}

// 表示名・ユーザー名(ログインに使う)を変える。ユーザー名の決まりと重複は Better Auth の username プラグインが確かめる
function Profile({ name, username }: { name: string; username: string }) {
  const router = useRouter();
  const [v, setV] = useState({ name, username });
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    setError("");
    setNote("");
    const u = v.username.trim();
    const { error } = await authClient.updateUser({
      ...(v.name.trim() !== name ? { name: v.name.trim() } : {}),
      ...(u !== username ? { username: u, displayUsername: u } : {}),
    });
    if (error) return setError(errorText(error));
    setNote("保存しました");
    await router.invalidate();
  };
  return (
    <form className="group form" onSubmit={(e) => (e.preventDefault(), save())}>
      <label className="row"><span>表示名</span><input className="trail field" maxLength={60} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} aria-label="表示名" /></label>
      <label className="row"><span>ユーザー名</span><input className="trail field" maxLength={40} autoComplete="username" placeholder="未設定" value={v.username} onChange={(e) => setV({ ...v, username: e.target.value })} aria-label="ユーザー名" /></label>
      <button className="row link" type="submit" disabled={!v.name.trim() || !v.username.trim() && !!username || (v.name.trim() === name && v.username.trim() === username)}>保存</button>
      {note && <p className="row muted" role="status">{note}</p>}
      {error && <p className="row error" role="alert">{error}</p>}
    </form>
  );
}

// ログインしたままパスワードを変える(いまのパスワードで確かめる)
function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [revoke, setRevoke] = useState(true);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    setNote("");
    const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: revoke });
    if (error) return setError(errorText(error));
    setCurrent("");
    setNext("");
    setNote("パスワードを変えました");
  };
  return (
    <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
      <div className="row"><span>パスワード</span></div>
      <input className="row" type="password" autoComplete="current-password" placeholder="いまのパスワード" value={current} onChange={(e) => setCurrent(e.target.value)} />
      <input className="row" type="password" autoComplete="new-password" placeholder="新しいパスワード(10 文字以上)" value={next} onChange={(e) => setNext(e.target.value)} />
      <label className="row"><span>ほかの端末のログインを切る</span><input className="trail switch" type="checkbox" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} /></label>
      <button className="btn sec" type="submit" disabled={!current || next.length < 10}>パスワードを変える</button>
      {note && <p className="row muted" role="status">{note}</p>}
      {error && <p className="row error" role="alert">{error}</p>}
    </form>
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
          <button className="btn pri" type="button" onClick={confirm}>有効にする</button>
        </>
      ) : (
        <>
          <input className="row" type="password" autoComplete="current-password" placeholder="いまのパスワード"
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn sec" type="button" onClick={start} disabled={!password}>
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
  const rename = async (id: string, now: string) => {
    const name = await promptDialog({ title: "名前を変える", placeholder: "パスキーの名前(どの端末のものか分かるように)", value: now, max: 60 });
    if (!name || name === now) return;
    setError("");
    const { error } = await authClient.passkey.updatePasskey({ id, name });
    if (error) return setError(errorText(error));
    refetch();
  };

  return (
    <section className="group">
      <div className="row"><span>パスキー</span><span className="trail">{`${list?.length ?? 0} 個`}</span></div>
      {list?.map((p) => (
        <div className="row" key={p.id}>
          <span translate="no">{p.name || "パスキー"}</span>
          <button className="trail link" type="button" onClick={() => rename(p.id, p.name || "パスキー")}>名前を変える</button>
          <button className="link danger" type="button" onClick={() => remove(p.id)}>削除</button>
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
  const [report, setReport] = useState<Report | null | undefined>(undefined);
  useEffect(() => {
    if (admin) getImportReport().then(setReport, () => setReport(null));
  }, [admin]);
  if (report === undefined) return null;
  if (!report) return <section className="group"><div className="row muted">v02 からは取り込んでいません</div></section>;
  return (
    <>
      <section className="group">
        <div className="row"><span>取り込んだ日時</span><span className="trail">{new Date(report.at).toLocaleString("ja-JP")}</span></div>
        <div className="row"><span>利用者</span><span className="trail">{report.users.length} 人</span></div>
        <div className="row"><span>Pterodactyl</span><span className="trail" translate="no">{report.ptero ? `${report.ptero.url}(サーバー ${report.ptero.servers} 台)` : "なし"}</span></div>
        {report.library && (
          <div className="row"><span>ライブラリ・セット</span><span className="trail">{report.library.items} 件・セット {report.library.sets} 個{report.library.folders ? `・フォルダのサーバー ${report.library.folders} 台` : ""}{report.library.uploads ? `・アップロードしたもの ${report.library.uploads} 件` : ""}</span></div>
        )}
        {report.kinds && (
          <div className="row"><span>データパック・リソースパック・シェーダー・Modパック(あとから)</span><span className="trail">{`${report.kinds.items + (report.kinds.uploads ?? 0)} 件`}</span></div>
        )}
        {report.pins && report.pins.pinned.length + report.pins.skipped.length > 0 && (
          <div className="row"><span>セットの版の固定</span><span className="trail">{`${report.pins.pinned.length} 件`}</span></div>
        )}
        {report.perms && report.perms.users.length > 0 && (
          <div className="row"><span>ユーザーごとの権限</span><span className="trail" translate="no">{report.perms.users.map((u) => u.name).join("、")}</span></div>
        )}
        {report.deps && report.deps.linked.length > 0 && (
          <div className="row"><span>前提の紐付け</span><span className="trail">{`${report.deps.linked.length} 件`}</span></div>
        )}
        {report.shares && report.shares.links.length > 0 && (
          <div className="row"><span>共有リンク</span><span className="trail">{`${report.shares.links.length} 個`}</span></div>
        )}
        {[...report.skipped, ...(report.library?.skipped ?? []), ...(report.kinds?.skipped ?? []), ...(report.pins?.skipped ?? []), ...(report.perms?.skipped ?? []),
          ...(report.deps?.skipped ?? []), ...(report.shares?.skipped ?? [])].map((x, i) => (
          <div className="row" key={i}><span className="main"><span>{x.what}</span><span className="muted" translate="no">{x.detail}</span></span><span className="trail">取り込まず</span></div>
        ))}
        {report.notes.map((n, i) => <p className="row muted" key={`n${i}`}>{n}</p>)}
      </section>
    </>
  );
}

type VersionInfo = Awaited<ReturnType<typeof getVersions>>;

// パネルのバージョン(自分用の版。チームのオーナーと管理者だけ): GitHub にある版を選んで切り替える
function Versions({ userId }: { userId: string }) {
  const { app } = Route.useRouteContext();
  const { can } = useCan(userId);
  const admin = app.mode === "self" && can({ panel: ["manage"] });
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
  const canRestore = can({ member: ["update"] });
  const saveAuto = async (auto: boolean, channel: "stable" | "dev") => {
    setError("");
    // 先に画面を変える(続けて変えたとき、前の値で上書きしないように)
    setInfo((v) => (v ? { ...v, updates: { ...v.updates, auto, channel } } : v));
    try {
      await setAutoUpdate({ data: { auto, channel } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      getVersions().then(setInfo, () => {});
    }
  };
  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (!(await confirmDialog({ message: label, ok: label.includes("戻しますか") ? "戻す" : "切り替える", danger: label.includes("戻しますか") }))) return;
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
      <section className="group">
        <div className="row"><span>いまの版</span><span className="trail">v{info?.current ?? "…"}</span></div>
        {info?.selected && info.image < info.updates.floor && (
          <div className="row"><span className="main"><span>{`イメージの版(v${info.image})`}</span><span className="muted">いまのデータを読めない古い版なので、戻せません</span></span></div>
        )}
        {info?.selected && info.image >= info.updates.floor && (
          <button className="row link" type="button" disabled={!!busy}
            onClick={() => run(`イメージの版(v${info.image})に戻しますか? パネルが再起動します`, () => useImageVersion())}>
            イメージの版(v{info.image})に戻す
          </button>
        )}
        {info?.releases.map((r) => (
          <div className="row" key={r.version}>
            <span className="main">
              <span>v{r.version}{r.stable ? "" : "(開発版)"}{r.version === info.current ? "(いまの版)" : ""}</span>
              <span className="muted">{r.publishedAt ? new Date(r.publishedAt).toLocaleString("ja-JP") : ""}</span>
            </span>
            {r.version !== info.current && r.version < info.updates.floor && <span className="trail muted">戻せません</span>}
            {r.version !== info.current && r.version >= info.updates.floor && (
              <button className="trail link" type="button" disabled={!!busy}
                onClick={() => run(`v${r.version} に切り替えますか? パネルが再起動します(データはそのままです)`, () => installVersion({ data: { version: r.version } }))}>
                {r.version > info.current ? "更新する" : "この版に戻す"}
              </button>
            )}
          </div>
        ))}
        {info?.listError && <p className="row error" role="alert">{info.listError}</p>}
        {info && !info.listError && info.releases.length === 0 && <p className="row muted">GitHub に切り替えられる版がまだありません。</p>}
        {busy && <p className="row muted" role="status">{busy}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      {info && (
        <>
          <div className="gtitle">自動アップデート<Info>入れる前にパネルのバックアップを作ります。大きな版上げ(v04 など)は自動では入れません。「この更新の前に戻す」で戻した版は、自動では入れ直しません。</Info></div>
          <section className="group form">
            <label className="row">
              <span>新しい版を自動で入れる(6 時間ごとに確かめる)</span>
              <input className="trail switch" type="checkbox" checked={info.updates.auto} disabled={!!busy}
                onChange={(e) => saveAuto(e.target.checked, info.updates.channel)} />
            </label>
            <div className="row">
              <span>入れる版</span>
              <select className="trail" value={info.updates.channel} disabled={!!busy} aria-label="自動で入れる版" onChange={(e) => saveAuto(info.updates.auto, e.target.value === "dev" ? "dev" : "stable")}>
                <option value="stable">安定版だけ</option>
                <option value="dev">開発版も</option>
              </select>
            </div>
            {info.updates.lastCheck && <div className="row muted">{`前に確かめたとき: ${new Date(info.updates.lastCheck).toLocaleString("ja-JP")}`}</div>}
          </section>
          {info.updates.history.length > 0 && (
            <>
              <div className="gtitle">更新の記録<Info>更新の前のバックアップは、定期バックアップの「残す数」を超えると古いものから消えます。</Info></div>
              <section className="group">
                {info.updates.history.map((h) => (
                  <div className="row" key={h.at}>
                    <span className="main">
                      <span>{`v${h.from} → v${h.to}${h.auto ? "(自動)" : ""}`}</span>
                      <span className="muted">{`${new Date(h.at).toLocaleString("ja-JP")}${h.rolledBackAt ? " · 戻しました" : h.backup ? "" : " · バックアップなし"}`}</span>
                    </span>
                    {h.canRollback && canRestore && (
                      <button className="trail link" type="button" disabled={!!busy}
                        onClick={() => run(`v${h.from} と、この更新の前のデータに戻しますか? パネルが再起動します(今のデータは before-restore-… に残します)`, () => rollbackUpdate({ data: { at: h.at } }))}>
                        この更新の前に戻す
                      </button>
                    )}
                  </div>
                ))}
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}

const tokenMessage = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

// API トークン(外から /api/v1 を呼ぶとき)。選んでいるチームのもので、自分の権限のとおりに動く
function ApiTokens({ userId }: { userId: string }) {
  const { can, perms } = useCan(userId);
  // 自分の権限で選べる範囲だけを出す(サーバーでも確かめる。読み込むまでは役割で決める)
  const allowed: Record<TokenScope, boolean> = perms ? { read: true, library: permsAllowScope(perms, "library"), control: permsAllowScope(perms, "control"), admin: permsAllowScope(perms, "admin") }
    : { read: true, library: can({ library: ["edit"] }), control: can({ server: ["control"] }), admin: can({ member: ["update"] }) };
  const load = useServerFn(listTokens);
  const create = useServerFn(createToken);
  const remove = useServerFn(removeToken);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listTokens>> | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<TokenScope[]>(["read"]);
  const [days, setDays] = useState(90);
  const [made, setMade] = useState("");
  const [error, setError] = useState("");
  const reload = () => load().then(setRows, (e) => setError(tokenMessage(e)));
  useEffect(() => { reload(); }, []);

  const submit = async () => {
    setError("");
    try {
      const r = await create({ data: { name, scopes, days } });
      setMade(r.key);
      setName("");
      await reload();
    } catch (e) {
      setError(tokenMessage(e));
    }
  };
  return (
    <>
      <section className="group">
        {rows?.length === 0 && <div className="row muted">まだありません。</div>}
        {rows?.map((k) => (
          <div className="row" key={k.id}>
            <span className="main">
              <span translate="no">{k.name}</span>
              <span className="muted"><span className="codes">{k.start}…</span> · {k.scopes.map((x) => SCOPE_SHORT[x]).join("・")} · {k.expiresAt ? `${new Date(k.expiresAt).toLocaleDateString("ja-JP")} まで` : "期限なし"}{k.lastUsed ? ` · 最後に使った日 ${new Date(k.lastUsed).toLocaleDateString("ja-JP")}` : ""}</span>
            </span>
            <button className="trail link danger" type="button"
              onClick={async () => (await confirmDialog({ message: `トークン「${k.name}」を消しますか?(使っているスクリプトは動かなくなります)`, ok: "消す", danger: true })) && remove({ data: { id: k.id } }).then(reload, (e) => setError(tokenMessage(e)))}>消す</button>
          </div>
        ))}
      </section>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <input className="row" placeholder="名前(使い道。例 毎朝の更新の確認)" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <div className="row muted">範囲(読むことは、どのトークンでもできます)</div>
        {TOKEN_SCOPES.filter((x) => x !== "read" && allowed[x]).map((x) => (
          <label className="row" key={x}><span>{SCOPE_LABELS[x]}</span>
            <input className="trail switch" type="checkbox" checked={scopes.includes(x)} onChange={(e) => setScopes((v) => (e.target.checked ? [...v, x] : v.filter((y) => y !== x)))} /></label>
        ))}
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
    </>
  );
}

// 開発者への匿名の利用状況(自分用の版・管理者以上)。送る内容をそのまま見せる
function Telemetry({ userId }: { userId: string }) {
  const { app } = Route.useRouteContext();
  const { can } = useCan(userId);
  const admin = app.mode === "self" && can({ panel: ["manage"] });
  const set = useServerFn(setTelemetry);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof telemetryInfo>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (admin) telemetryInfo().then(setInfo, (e) => setError(e instanceof Error ? e.message : String(e))); }, [admin]);
  if (!admin || !info) return error ? <p className="error" role="alert">{error}</p> : null;
  if (!info.available) return <section className="group"><div className="row muted">この環境では使えません</div></section>;
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
      <section className="group">
        <label className="row"><span>匿名の利用状況を送る(1 日 1 回)</span><input className="trail switch" type="checkbox" checked={info.enabled} onChange={(e) => change(e.target.checked)} /></label>
        {info.lastSent && <div className="row"><span>最後に送った日時</span><span className="trail">{new Date(info.lastSent).toLocaleString("ja-JP")}</span></div>}
        <details className="row column">
          <summary>送る内容を見る</summary>
          <pre className="log" translate="no">{JSON.stringify(info.preview, null, 2)}</pre>
        </details>
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
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
        <label className="row"><span>版と OS も送る</span><input className="trail switch" type="checkbox" checked={includeEnv} onChange={(e) => setIncludeEnv(e.target.checked)} /></label>
        <button className="row link" type="submit" disabled={busy || message.trim().length < 2}>{busy ? "送っています…" : "開発者に送る"}</button>
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </form>
    </>
  );
}

// 「標準」の見本: src/styles.css の --bg(明るい)の上に、右下だけ暗いときの色(端末に合わせて変わるため)
const STANDARD_SWATCH = "linear-gradient(135deg, transparent 62%, #0b1220 62%), radial-gradient(120% 90% at 0% 0%, #dbeafe, transparent 60%), radial-gradient(100% 80% at 100% 100%, #f6efe6, transparent 60%), #eef2f7";

// 見た目: 明るさ・アクセントの色・テーマ(v02 のテーマ)・背景の暗さとぼかし・背景画像(どれもアカウントに保存)
function Appearance() {
  const save = useServerFn(saveMyTheme);
  const saveBg = useServerFn(saveMyBackground);
  const [busy, setBusy] = useState(false);
  const [t, setT] = useState<Theme>({ ...DEFAULT_THEME, background: "" });
  useEffect(() => { setT(getTheme()); }, []); // 保存した見た目は、読み込んだあとで読む(サーバーで作った画面と合わせるため)
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // 画面にはすぐ当て、アカウントへの保存は少し待ってから(つまみを動かしている間に何度も送らない)
  const change = (next: Theme) => {
    setError("");
    try {
      saveTheme(next);
    } catch {
      return setError("背景画像が大きすぎて保存できませんでした。小さい画像を選んでください");
    }
    setT(next);
    clearTimeout(timer.current);
    const { background: _, ...saved } = next;
    timer.current = setTimeout(() => { save({ data: saved }).catch((e) => setError(e instanceof Error ? e.message : "保存できませんでした")); }, 400);
  };
  // 背景画像は縮めてからアカウントに保存し、保存できたら当てる(null で外す)
  const setBackground = async (image: string | null) => {
    setError("");
    setBusy(true);
    try {
      change({ ...t, background: await saveBg({ data: { image } }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存できませんでした");
    } finally {
      setBusy(false);
    }
  };
  const preset = PRESETS[t.preset];
  return (
    <>
      <section className="group">
        <div className="row column">
          <span>テーマ</span>
          <div className="themes" role="group" aria-label="テーマ">
            {(Object.keys(PRESETS) as Preset[]).map((id) => (
              <button key={id} type="button" className="theme-tile" aria-pressed={t.preset === id} onClick={() => change({ ...t, preset: id })}>
                <span className="sw" style={{ background: PRESETS[id].bg ?? STANDARD_SWATCH }} />
                {PRESETS[id].name}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span>明るさ</span>
          {preset.tone ? (
            <span className="trail">{preset.tone === "dark" ? "ダーク(テーマに合わせる)" : "ライト(テーマに合わせる)"}</span>
          ) : (
            <select className="trail" value={t.mode} onChange={(e) => change({ ...t, mode: e.target.value as Mode })} aria-label="明るさ">
              <option value="auto">端末に合わせる</option>
              <option value="light">ライト</option>
              <option value="dark">ダーク</option>
            </select>
          )}
        </div>
        <div className="row wrap">
          <span>アクセントの色</span>
          <span className="trail seg" role="group" aria-label="アクセントの色">
            {(Object.keys(ACCENT_LABELS) as Accent[]).map((a) => {
              const c = a === "auto" ? preset.accent ?? ACCENTS.blue : ACCENTS[a];
              return (
                <button key={a} type="button" className={t.accent === a ? "on" : ""} aria-pressed={t.accent === a} onClick={() => change({ ...t, accent: a })}
                  style={{ borderColor: c, ...(t.accent === a ? { background: c } : { color: c }) }}>{ACCENT_LABELS[a]}</button>
              );
            })}
          </span>
        </div>
        <label className="row">
          <span>背景の暗さ</span>
          <input className="trail" type="range" min={0} max={LIMITS.dim} value={t.dim} onChange={(e) => change({ ...t, dim: Number(e.target.value) })} aria-label="背景の暗さ" />
          <span className="muted">{`${t.dim}%`}</span>
        </label>
        <label className="row">
          <span>背景のぼかし</span>
          <input className="trail" type="range" min={0} max={LIMITS.blur} value={t.blur} onChange={(e) => change({ ...t, blur: Number(e.target.value) })} aria-label="背景のぼかし" />
          <span className="muted">{`${t.blur}px`}</span>
        </label>
        <label className="row link" aria-disabled={busy}>
          {busy ? "背景画像を保存しています…" : t.background ? "背景画像を変える" : "背景画像を選ぶ"}
          <input type="file" accept="image/*" hidden disabled={busy} onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            let image: string;
            try {
              image = await backgroundFrom(f);
            } catch (err) {
              return setError(err instanceof Error && err.message === "too-big" ? "背景画像が大きすぎて保存できませんでした。小さい画像を選んでください" : "画像を読めませんでした");
            }
            await setBackground(image);
          }} />
        </label>
        {t.background && <button className="row link danger" type="button" disabled={busy} onClick={() => setBackground(null)}>背景画像を外す</button>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}

// アカウントを消す(サービス版)。パスワードで確かめる
function DeleteAccount() {
  const { app } = Route.useRouteContext();
  const remove = useServerFn(deleteAccount);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (app.mode !== "service") return null;
  return (
    <section className="group">
      {!open ? (
        <button className="row link danger" type="button" onClick={() => setOpen(true)}>アカウントを消す</button>
      ) : (
        <>
          <p className="row muted">アカウントを消すと、元に戻せません。自分だけのチームは一緒に消えます。ほかのメンバーがいるチームのオーナーは、先にオーナーを譲るか、チームを消してください。</p>
          <input className="row" type="password" autoComplete="current-password" placeholder="確かめのためのパスワード" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="row danger" type="button" disabled={busy || !password} onClick={async () => {
            if (!(await confirmDialog({ message: "アカウントを消しますか?元に戻せません", ok: "消す", danger: true }))) return;
            setBusy(true);
            setError("");
            try {
              await remove({ data: { password } });
              location.href = "/login";
            } catch (e) {
              setError(e instanceof Error ? e.message : "うまくいきませんでした");
              setBusy(false);
            }
          }}>{busy ? "消しています…" : "アカウントを消す"}</button>
        </>
      )}
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}
