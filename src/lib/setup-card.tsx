import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { listBackups } from "./backup-api";
import { notifySettings } from "./events-api";
import type { libraryCatalog } from "./library-api";
import { OPEN_ADD } from "./shell";
import { Btn, Icon, Info } from "./ui";

type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;

// はじめの設定(v02 と同じ。管理者だけ。ライブラリの上と、設定の「はじめの設定」の 1 つだけ): 保存先・アドオン・サーバー・バックアップ・通知。「あとで」「使わない」とどこまで閉じたかは、この端末に残す
const SETUP = "craftshelf.setup";
type SetupState = { closed?: boolean; skip?: string[] };
type Step = { k: string; t: string; done: boolean; later?: string; to?: string; go?: string; info?: string };
// pinned: 設定から開いたとき。ライブラリで閉じていても出し、閉じるボタンは出さない(全部済んでいれば「すべて済みました」)
export function SetupCard({ cat, local, pinned }: { cat: Catalog; local: boolean; pinned?: boolean }) {
  const backups = useServerFn(listBackups);
  const notify = useServerFn(notifySettings);
  const [st, setSt] = useState<SetupState | null>(null);
  const [backup, setBackup] = useState(false);
  const [notified, setNotified] = useState(false);
  useEffect(() => {
    try { setSt(JSON.parse(localStorage.getItem(SETUP) ?? "{}")); } catch { setSt({}); }
    if (local) backups().then((b) => setBackup(b.schedule.enabled), () => {});
    notify().then((n) => setNotified(n.configured), () => {});
  }, [local]);
  if (!st || (st.closed && !pinned)) return null;
  const save = (s: SetupState) => { setSt(s); try { localStorage.setItem(SETUP, JSON.stringify(s)); } catch {} };
  const skip = (k: string) => save({ ...st, skip: [...(st.skip ?? []), k] });
  const skipped = (k: string) => !!st.skip?.includes(k);
  const steps = ([
    local && { k: "storage", t: "保存先を決める", done: !!cat.storage?.name || skipped("storage"), later: "ローカルのままにする", to: "/storage", go: "保存先を開く",
      info: "初めはこのパネルの中(ローカル)に保存します。NAS などに置くなら、保存先を足します。" },
    { k: "addon", t: "アドオンを追加する", done: cat.items.length > 0 },
    { k: "server", t: "サーバーをつなぐ", done: cat.servers.length > 0, to: "/servers", go: "サーバーを開く" },
    local && { k: "backup", t: "バックアップを設定する", done: backup || skipped("backup"), later: "あとで", to: "/backup", go: "バックアップを開く" },
    { k: "notify", t: "通知を受け取る", done: notified || skipped("notify"), later: "使わない", to: "/activity", go: "Discord 通知を開く" },
  ] as (Step | false)[]).filter((s): s is Step => !!s);
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return pinned ? <section className="group"><div className="row muted">すべて済みました。</div></section> : null;
  const next = steps.find((s) => !s.done)?.k;
  return (
    <section className="setup glass">
      <div className="sg-head">
        <div>{!pinned && <h3>はじめの設定</h3>}<small>{`${done} / ${steps.length} 済み`}</small></div>
        {pinned ? st.closed && <button type="button" className="link small" onClick={() => save({ ...st, closed: false })}>ライブラリにもう一度出す</button>
          : <button type="button" className="rbtn sm" aria-label="閉じる" title="閉じる" onClick={() => save({ ...st, closed: true })}><Icon name="close" /></button>}
      </div>
      <div className="meter"><i style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ul className="sg-steps">
        {steps.map((s) => (
          <li key={s.k} className={s.done ? "done" : s.k === next ? "next" : ""}>
            <span className="sg-dot" aria-hidden="true">{s.done ? "✓" : ""}</span>
            <span className="sg-t">{s.t}{s.info && <Info>{s.info}</Info>}</span>
            {!s.done && (
              <span className="sg-acts">
                {s.later && <button type="button" className="link small" onClick={() => skip(s.k)}>{s.later}</button>}
                {s.k === "addon" ? <Btn kind="pri" sm onClick={() => window.dispatchEvent(new Event(OPEN_ADD))}>＋ 追加</Btn>
                  : s.to && <Link to={s.to as "/"} className={`btn sm ${s.k === next ? "pri" : "tint"}`}>{s.go}</Link>}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
