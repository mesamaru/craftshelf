// 確認・入力のダイアログ(ブラウザ標準の confirm / prompt / alert の代わり)。
// 使い方は `if (!(await confirm({ message, danger: true }))) return;` と `const t = await prompt({ title, value })`(動きは dialog-queue.ts)。
// <DialogHost /> を 1 つ、__root.tsx に置いてある。中央のガラスのダイアログ(スマホは下から)。Enter で実行・Esc でやめる・Tab は中を回る
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { type Req, dialogs, wordOk } from "./dialog-queue";
import { translate } from "./i18n";
import { Btn } from "./ui";

export { confirmDialog, dialogs, promptDialog, useConfirm, usePrompt } from "./dialog-queue";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

export function DialogHost() {
  const req = useSyncExternalStore(dialogs.subscribe, dialogs.current, () => undefined);
  if (!req || typeof document === "undefined") return null;
  return createPortal(<DialogBox key={reqKey(req)} req={req} />, document.body);
}

// 続けて同じ文のものが来ても、別のダイアログとして作り直す(入力・段を引き継がない)
const ids = new WeakMap<Req, number>();
let seq = 0;
const reqKey = (r: Req) => ids.get(r) ?? (ids.set(r, ++seq), seq);

function DialogBox({ req }: { req: Req }) {
  const uid = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(1);
  const [text, setText] = useState(req.kind === "prompt" ? req.value ?? "" : "");
  const [error, setError] = useState("");
  const isPrompt = req.kind === "prompt";
  const confirm = req.kind === "confirm" ? req : null;
  const word = confirm && step === 2 ? confirm.word : undefined; // 2 段目で入力させる言葉
  const message = confirm && step === 2 ? confirm.second : req.message;
  const shown = word ? translate(word) : undefined; // 英語表示では、画面に出ている訳を入力してもよい
  const ask = word ? `確認のため「${word}」と入力` : req.kind === "prompt" ? req.placeholder ?? req.title : undefined;
  const okLabel = req.ok ?? (isPrompt ? "決定" : "実行");

  // 開いたら中にフォーカスを入れ(入力欄があればそこ・なければ実行ボタン)、閉じたら元の場所へ戻す
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    return () => { if (back?.isConnected) back.focus?.(); };
  }, []);
  useEffect(() => {
    (input.current ?? box.current?.querySelector<HTMLElement>(".dlg-foot .btn:last-child"))?.focus();
    input.current?.select();
  }, [step]);
  // Esc でやめる(下のシートの Esc より先に受ける)・Tab を中に閉じ込める
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dialogs.cancel(); }
      else if (e.key === "Tab" && box.current) {
        const f = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!f.length) return;
        const at = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey ? at <= 0 : at === f.length - 1 || at < 0) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, []);

  const run = () => {
    if (req.kind === "prompt") return setError(dialogs.submit(text) ?? "");
    if (confirm?.second && step === 1) return setStep(2);
    if (!wordOk(text, word, shown)) return;
    dialogs.close(true);
  };
  // 実行ボタンの上で Enter を押したときは、ボタンの Enter(クリック)に任せる。入力欄の Enter は決定
  const enter = (e: React.KeyboardEvent) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); run(); } };
  const label = req.title;

  return (
    <>
      <div className="scrim dlg-scrim" onMouseDown={() => dialogs.cancel()} />
      <div ref={box} className="dlg" role="alertdialog" aria-modal="true" aria-label={label} aria-labelledby={label ? undefined : `${uid}m`} aria-describedby={label && message ? `${uid}m` : undefined} onKeyDown={enter}>
        {label && <h3>{label}</h3>}
        {message && <p id={`${uid}m`} className="dlg-msg">{message}</p>}
        {(isPrompt || word) && (
          <>
            <input ref={input} className="dlg-input" value={text} maxLength={req.kind === "prompt" ? req.max : undefined} aria-invalid={!!error} aria-label={ask} placeholder={ask}
              onChange={(e) => { setText(e.target.value); setError(""); }} />
            {error && <p className="dlg-err" role="alert">{error}</p>}
          </>
        )}
        <div className="dlg-foot">
          <Btn onClick={() => dialogs.cancel()}>{req.cancel ?? "キャンセル"}</Btn>
          <Btn kind={confirm?.danger ? "red" : "pri"} disabled={!wordOk(text, word, shown)} onClick={run}>{okLabel}</Btn>
        </div>
      </div>
    </>
  );
}
