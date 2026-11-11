// ホームに足せるウィジェット(メモ・ToDo・時計・今日の日付。v02 と同じ)。中身は DashLayout.custom に入れてアカウントに保存する(~/lib/dash)
import { useEffect, useState } from "react";
import { CUSTOM_TYPES, type Custom, DASH_LIMITS } from "./dash";
import { mdToHtml } from "./md";
import { Btn, Icon, Sheet } from "./ui";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const two = (n: number) => String(n).padStart(2, "0");
export const customName = (c: Custom) => c.title || CUSTOM_TYPES[c.type];

// 1 秒ごとに進む時刻(画面を作ったあとから。サーバーで作る画面と食い違わないように、最初は null)
function useNow() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Analog({ t }: { t: Date }) {
  const hand = (deg: number, len: number, w: number, cls: string) => {
    const r = ((deg - 90) * Math.PI) / 180;
    return <line className={cls} x1="50" y1="50" x2={50 + Math.cos(r) * len} y2={50 + Math.sin(r) * len} strokeWidth={w} strokeLinecap="round" />;
  };
  const h = t.getHours() % 12, m = t.getMinutes(), s = t.getSeconds();
  return (
    <svg viewBox="0 0 100 100" className="aclock" role="img" aria-label={t.toLocaleTimeString("ja-JP")}>
      <circle cx="50" cy="50" r="47" className="face" />
      {Array.from({ length: 12 }, (_, i) => {
        const r = (i * 30 * Math.PI) / 180, o = i % 3 ? 43 : 45;
        return <line key={i} className="tick" x1={50 + Math.sin(r) * 40} y1={50 - Math.cos(r) * 40} x2={50 + Math.sin(r) * o} y2={50 - Math.cos(r) * o} strokeWidth={i % 3 ? 1 : 2} />;
      })}
      {hand((h + m / 60) * 30, 24, 3.2, "hh")}{hand((m + s / 60) * 6, 34, 2.2, "mh")}{hand(s * 6, 38, 1, "sh")}
      <circle cx="50" cy="50" r="2.2" className="sh-dot" />
    </svg>
  );
}

/** 追加したウィジェット 1 つ。change で中身を直す(保存は呼び出し側。ToDo のチェックだけ少し待ってから保存する) */
export function CustomWidget({ c, change }: { c: Custom; change: (fn: (c: Custom) => Custom, delay?: number) => void }) {
  const now = useNow();
  const [sheet, setSheet] = useState(false);
  const [draft, setDraft] = useState("");
  const head = (extra?: React.ReactNode) => <div className="card-h"><h4 translate={c.title ? "no" : undefined}>{customName(c)}</h4>{extra}</div>;
  return (
    <section className={`card glass cw cw-${c.type}`}>
      {c.type === "memo" && <>
        {head(<button type="button" className="rbtn sm" aria-label="メモを直す" title="メモを直す" onClick={() => setSheet(true)}><Icon name="edit" /></button>)}
        <div className="card-b memo-body" translate="no">
          {c.text.trim()
            ? c.md ? <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(c.text) }} /> : <div className="plain">{c.text}</div>
            : <p className="dash-empty">右上のボタンからメモを書けます</p>}
        </div>
        {sheet && <MemoSheet c={c} onSave={(x) => { change((o) => ({ ...o, ...x })); setSheet(false); }} onClose={() => setSheet(false)} />}
      </>}
      {c.type === "todo" && <>
        {head(c.items.length > 0 && <span className="muted">{`残り ${c.items.filter((x) => !x.d).length} 件`}</span>)}
        <div className="card-b">
          <div className="todo" translate="no">
            {c.items.map((x, i) => (
              <div className={`todo-row${x.d ? " done" : ""}`} key={i}>
                <input type="checkbox" className="ck" checked={x.d} aria-label="完了" onChange={(e) => change((o) => ({ ...o, items: o.items.map((y, j) => (j === i ? { ...y, d: e.target.checked } : y)) }), 600)} />
                <span className="t">{x.t}</span>
                <button type="button" className="rbtn sm" aria-label="消す" title="消す" onClick={() => change((o) => ({ ...o, items: o.items.filter((_, j) => j !== i) }))}><Icon name="close" /></button>
              </div>
            ))}
          </div>
          <form className="todo-add" onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            if (!t || c.items.length >= DASH_LIMITS.items) return;
            change((o) => ({ ...o, items: [...o.items, { t, d: false }] }));
            setDraft("");
          }}>
            <input className="input" maxLength={DASH_LIMITS.item} placeholder="やることを追加" aria-label="やることを追加" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <Btn kind="tint" sm type="submit" disabled={!draft.trim()}><Icon name="plus" />追加</Btn>
          </form>
          {c.items.some((x) => x.d) && <div className="chips"><Btn sm onClick={() => change((o) => ({ ...o, items: o.items.filter((x) => !x.d) }))}>完了したものを消す</Btn></div>}
        </div>
      </>}
      {c.type === "clock" && <>
        {head(<Btn sm onClick={() => change((o) => ({ ...o, style: o.style === "analog" ? "digital" : "analog" }))}>{c.style === "analog" ? "デジタル" : "アナログ"}</Btn>)}
        <div className="card-b"><div className={`clockw ${c.style}`}>
          {!now ? null : c.style === "analog" ? <Analog t={now} />
            : <><div className="dig">{`${two(now.getHours())}:${two(now.getMinutes())}`}<span>{`:${two(now.getSeconds())}`}</span></div><div className="dig-sub">{`${now.getMonth() + 1}/${now.getDate()}(${WD[now.getDay()]})`}</div></>}
        </div></div>
      </>}
      {c.type === "date" && <>
        {head()}
        <div className="card-b">{now && (
          <div className="datew">
            <div className="d1">{`${now.getFullYear()}年`}</div>
            <div className="d2">{`${now.getMonth() + 1}月${now.getDate()}日`}<span>{`(${WD[now.getDay()]})`}</span></div>
            <div className="d3">{`今年の ${Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000) + 1} 日目`}</div>
          </div>
        )}</div>
      </>}
    </section>
  );
}

// メモを直す: 題・書き方(そのままの文字 / Markdown)・内容
function MemoSheet({ c, onSave, onClose }: { c: Custom; onSave: (x: Pick<Custom, "title" | "md" | "text">) => void; onClose: () => void }) {
  const [title, setTitle] = useState(c.title);
  const [md, setMd] = useState(c.md);
  const [text, setText] = useState(c.text);
  return (
    <Sheet title="メモ" onClose={onClose}>
      <section className="group form">
        <input className="row" placeholder="題(空なら「メモ」)" maxLength={DASH_LIMITS.title} value={title} onChange={(e) => setTitle(e.target.value)} translate="no" />
        <label className="row"><span className="mid">Markdown で書く</span><input type="checkbox" className="switch" checked={md} onChange={(e) => setMd(e.target.checked)} /></label>
        <textarea className="row memo-text" rows={10} maxLength={DASH_LIMITS.text} placeholder="内容" value={text} onChange={(e) => setText(e.target.value)} translate="no" />
      </section>
      {md && <p className="sub" translate="no"># 見出し　**太字**　- リスト　- [ ] やること　[リンク](https://…)</p>}
      <div className="sheet-foot"><span className="grow" /><Btn kind="pri" onClick={() => onSave({ title: title.trim(), md, text })}>保存</Btn></div>
    </Sheet>
  );
}
