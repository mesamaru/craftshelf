import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { cancelRestore, createBackup, listBackups, restoreBackup } from "~/lib/backup-api";

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
  const [data, setData] = useState<Awaited<ReturnType<typeof listBackups>> | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const reload = () => load().then(setData, (e) => setError(message(e)));
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

  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/team" className="capsule">‹ チーム</Link>
        <h1>バックアップ</h1>
      </header>
      {data?.pending && (
        <p className="notice" role="status">
          次の起動でバックアップと入れ替えます。<button type="button" className="link" disabled={!!busy} onClick={() => run("やめています…", () => cancel())}>やめる</button>
        </p>
      )}
      <section className="group">
        <button className="row link" type="button" disabled={!!busy || !data} onClick={() => run("作っています…", () => create())}>{busy === "作っています…" ? busy : "今のデータのバックアップを作る"}</button>
      </section>
      <div className="group-title">パネルの中のバックアップ(新しい 5 個)</div>
      <section className="group">
        {!data && !error && <div className="row muted">読み込み中…</div>}
        {data?.backups.length === 0 && <div className="row muted">まだありません。</div>}
        {data?.backups.map((b) => (
          <div className="row" key={b.name}>
            <span className="main"><span translate="no">{new Date(b.at).toLocaleString("ja-JP")}</span><span className="muted small" translate="no">{b.name} · {size(b.size)}</span></span>
            <a className="trail link" href={`/api/backup/${b.name}`} download>ダウンロード</a>
            <button className="link" type="button" disabled={!!busy} onClick={async () => {
              if (!confirm("このバックアップから戻しますか?パネルが再起動し、今のデータと入れ替えます(今のデータは消さずに残します)")) return;
              setBusy("切り替えています…");
              setError("");
              try {
                await restore({ data: { name: b.name } });
                await waitRestart();
              } catch (e) {
                setBusy("");
                setError(message(e));
              }
            }}>戻す</button>
          </div>
        ))}
      </section>
      <div className="group-title">手元のファイルから戻す</div>
      <section className="group">
        <label className="row link">
          バックアップのファイル(.tar.gz)を選ぶ
          <input type="file" accept=".gz,application/gzip" hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
        </label>
      </section>
      {busy && busy !== "作っています…" && <p className="notice" role="status">{busy}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="foot">バックアップには、データベース(チーム・サーバー・ライブラリ・設定)、保存したパスワードなどを解く鍵、パネルの中に置いたアドオンが入ります(NAS などほかの保存先のファイルと、サーバーのファイルは入りません)。鍵が入るので、ダウンロードしたものは大切に保管してください。戻すときは、今のデータを before-restore-… のフォルダに移して残します。</p>
    </main>
  );
}
