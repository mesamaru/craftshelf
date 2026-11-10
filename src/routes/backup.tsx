import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Info } from "~/lib/ui";
import { SettingsFrame } from "~/lib/settings-frame";
import { cancelRestore, createBackup, listBackups, reimportV02, restoreBackup, setBackupSchedule } from "~/lib/backup-api";

export const Route = createFileRoute("/backup")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/backup" } });
    return { user: context.user };
  },
  component: Backup,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

// パネルのバックアップと復元(自分用の版・管理者以上)
function Backup() {
  const load = useServerFn(listBackups);
  const create = useServerFn(createBackup);
  const restore = useServerFn(restoreBackup);
  const cancel = useServerFn(cancelRestore);
  const reimport = useServerFn(reimportV02);
  const saveSchedule = useServerFn(setBackupSchedule);
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof listBackups>>["schedule"] | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof listBackups>> | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const reload = () => load().then((d) => { setData(d); setDraft((old) => old ?? d.schedule); }, (e) => setError(message(e)));
  useEffect(() => { reload(); }, []);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  // 再起動を待って開き直す
  const waitRestart = async () => {
    setBusy("再起動しています…");
    await new Promise((r) => setTimeout(r, 3000));
    for (let i = 0; i < 60; i++) {
      if (await fetch("/api/auth/ok").then((r) => r.ok, () => false)) return location.assign("/");
      await new Promise((r) => setTimeout(r, 2000));
    }
    setBusy("");
    setError("再起動を待ちきれませんでした。少し待ってから開き直してください");
  };
  const upload = async (file: File) => {
    if (!confirm(`${file.name} から戻しますか?パネルが再起動し、今のデータと入れ替えます(今のデータは消さずに残します)`)) return;
    setBusy("送っています…");
    setError("");
    const res = await fetch("/api/backup/restore", { method: "POST", body: file });
    if (!res.ok) {
      setBusy("");
      setError((await res.json().catch(() => ({}))).message ?? "戻せませんでした");
      return;
    }
    await waitRestart();
  };

  const row = (name: string, at: string, bytes: number | null) => (
    <div className="row" key={name}>
      <span className="main"><span translate="no">{at ? new Date(at).toLocaleString("ja-JP") : ""}</span><span className="muted small" translate="no">{name}{bytes !== null ? ` · ${size(bytes)}` : ""}</span></span>
      <a className="trail link" href={`/api/backup/${name}`} download>ダウンロード</a>
      <button className="link" type="button" disabled={!!busy} onClick={async () => {
        if (!confirm("このバックアップから戻しますか?パネルが再起動し、今のデータと入れ替えます(今のデータは消さずに残します)")) return;
        setBusy("切り替えています…");
        setError("");
        try {
          await restore({ data: { name } });
          await waitRestart();
        } catch (e) {
          setBusy("");
          setError(message(e));
        }
      }}>戻す</button>
    </div>
  );

  return (
    <SettingsFrame at="backup" info={<span>バックアップには、データベース(チーム・サーバー・ライブラリ・設定)、保存したパスワードなどを解く鍵、パネルの中に置いたアドオンが入ります(NAS などほかの保存先のファイルと、サーバーのファイルは入りません)。鍵が入るので、ダウンロードしたものは大切に保管してください。戻すときは、今のデータを before-restore-… のフォルダに移して残します。</span>}>
      {(data?.pending || data?.reimport) && (
        <p className="notice" role="status">
          {data.reimport ? "次の起動で v02 から取り込み直します。" : "次の起動でバックアップと入れ替えます。"}<button type="button" className="link" disabled={!!busy} onClick={() => run("やめています…", () => cancel())}>やめる</button>
        </p>
      )}
      <section className="group">
        <button className="row link" type="button" disabled={!!busy || !data} onClick={() => run("作っています…", () => create())}>{busy === "作っています…" ? busy : "今のデータのバックアップを作る"}</button>
      </section>
      {data && draft && (
        <>
          <div className="gtitle">定期バックアップ<Info>手で作るときも、ここで選んだ置き場所・残す数を使います。保存先(NAS など)は「保存先」で足せます。時刻は、保存したときのブラウザの時間帯です。作れなかったときは、お知らせと Discord(「エラー」「バックアップ」を選んでいれば)で知らせます。</Info></div>
          <section className="group form">
            <label className="row">
              <span>毎日バックアップを作る</span>
              <input className="trail switch" type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            </label>
            {draft.enabled && (
              <div className="row">
                <span>時刻</span>
                <input className="trail" type="time" value={draft.time} aria-label="バックアップする時刻" onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
              </div>
            )}
            <div className="row">
              <span>置き場所</span>
              <select className="trail" value={draft.targetId ?? ""} aria-label="バックアップの置き場所" onChange={(e) => setDraft({ ...draft, targetId: e.target.value || null })}>
                <option value="">パネルの中</option>
                {data.targets.map((t) => <option key={t.id} value={t.id} translate="no">{t.name}</option>)}
              </select>
            </div>
            <div className="row">
              <span>残す数</span>
              <select className="trail" value={draft.keep} aria-label="残すバックアップの数" onChange={(e) => setDraft({ ...draft, keep: Number(e.target.value) })}>
                {[1, 2, 3, 5, 7, 10, 14, 20, 30, 60].map((n) => <option key={n} value={n}>{`${n} 個`}</option>)}
              </select>
            </div>
            {data.schedule.lastRunAt && <div className="row muted">{`前に予約で動いたとき: ${new Date(data.schedule.lastRunAt).toLocaleString("ja-JP")}`}</div>}
            <button className="row link" type="button" disabled={!!busy} onClick={() => run("保存しています…", async () => {
              await saveSchedule({ data: { ...draft, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
              setDraft(null);
            })}>保存</button>
          </section>
        </>
      )}
      {data?.schedule.targetId && (
        <>
          <div className="gtitle">{`保存先「${data.targets.find((t) => t.id === data.schedule.targetId)?.name ?? ""}」のバックアップ(新しい ${data.schedule.keep} 個)`}</div>
          <section className="group">
            {data.storageError && <div className="row error" role="alert">{data.storageError}</div>}
            {!data.storageError && data.stored.length === 0 && <div className="row muted">まだありません。</div>}
            {data.stored.map((b) => row(b.name, b.at, null))}
          </section>
        </>
      )}
      <div className="gtitle">{data?.schedule.targetId ? "パネルの中のバックアップ" : `パネルの中のバックアップ(新しい ${data?.schedule.keep ?? 5} 個)`}</div>
      <section className="group">
        {!data && !error && <div className="row muted">読み込み中…</div>}
        {data?.backups.length === 0 && <div className="row muted">まだありません。</div>}
        {data?.backups.map((b) => row(b.name, b.at, b.size))}
      </section>

      <div className="gtitle">手元のファイルから戻す</div>
      <section className="group">
        <label className="row link">
          バックアップのファイル(.tar.gz)を選ぶ
          <input type="file" accept=".gz,application/gzip" hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
        </label>
      </section>
      {data?.v02 && (
        <>
          <div className="gtitle">v02 から取り込み直す<Info>v03 を試したあと v02 に戻って使い続け、もう一度 v03 に移るときに使います。取り込み直したあとは、ログインし直してください(v02 のユーザー名とパスワード)。</Info></div>
          <section className="group">
            <button className="row link danger" type="button" disabled={!!busy} onClick={async () => {
              if (!confirm("v02 のデータを取り込み直しますか?パネルが再起動し、v03 の今のデータ(v03 で変えたこと)を before-reimport-… のフォルダに移して、v02 のデータを取り込み直します。")) return;
              setBusy("切り替えています…");
              setError("");
              try {
                await reimport();
                await waitRestart();
              } catch (e) {
                setBusy("");
                setError(message(e));
              }
            }}>v02 のデータを取り込み直す</button>
          </section>
        </>
      )}
      {busy && busy !== "作っています…" && <p className="notice" role="status">{busy}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </SettingsFrame>
  );
}
