// 確認(confirm)と 1 行の入力(prompt)の順番待ち。画面の部品は dialogs.tsx。
// ブラウザ標準の窓の代わり。同時に開くのは 1 つだけで、あとから頼まれたものは前のが閉じてから出る。
// 呼び出す側は `if (!(await confirmDialog({...}))) return;` の形で使う
export type ConfirmOpts = {
  title?: string;
  /** 本文(複数行可) */
  message: string;
  /** 実行するボタン(初めは「実行」) */
  ok?: string;
  cancel?: string;
  /** 危ない操作(外す・消す・戻す)。実行のボタンが赤くなる */
  danger?: boolean;
  /** 2 段目の本文。あると、実行を押したあとに同じダイアログの中でもう一度確かめる */
  second?: string;
  /** 2 段目でこの言葉を入力するまで実行できない(「戻す」など) */
  word?: string;
};
export type PromptOpts = {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  ok?: string;
  cancel?: string;
  /** 長さの上限(入力欄にも付ける) */
  max?: number;
  /** 決定のときの検査。文字(前後の空白を除いたもの)を渡し、返した文を入力欄の下にエラーとして出す(null・空なら通る) */
  validate?: (value: string) => string | null | undefined;
};
export type Req = (({ kind: "confirm" } & ConfirmOpts) | ({ kind: "prompt" } & PromptOpts)) & { done: (v: boolean | string | null) => void };

const queue: Req[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const dialogs = {
  /** いま出しているもの(なければ undefined) */
  current: (): Req | undefined => queue[0],
  subscribe(f: () => void) {
    subs.add(f);
    return () => void subs.delete(f);
  },
  confirm: (o: ConfirmOpts) => new Promise<boolean>((done) => { queue.push({ kind: "confirm", ...o, done: done as Req["done"] }); emit(); }),
  /** 入力した文字(前後の空白を除く)。やめたときは null */
  prompt: (o: PromptOpts) => new Promise<string | null>((done) => { queue.push({ kind: "prompt", ...o, done: done as Req["done"] }); emit(); }),
  /** いまのものを閉じて、結果を返す(確認: true / false、入力: 文字 / null) */
  close(v: boolean | string | null) {
    queue.shift()?.done(v);
    emit();
  },
  /** やめる(確認は false、入力は null) */
  cancel() {
    const r = queue[0];
    if (r) dialogs.close(r.kind === "confirm" ? false : null);
  },
  /** 入力の決定。空・長すぎ・validate に通らなければ、閉じずにエラーの文を返す */
  submit(text: string): string | null {
    const r = queue[0];
    if (r?.kind !== "prompt") return null;
    const v = text.trim();
    const err = !v ? "入力してください" : r.max && v.length > r.max ? `${r.max} 文字までです` : r.validate?.(v);
    if (err) return err;
    dialogs.close(v);
    return null;
  },
};

export const confirmDialog = dialogs.confirm;
export const promptDialog = dialogs.prompt;
/** 確認(`await confirm({ message, danger })` の形)。どの画面からも使える */
export const useConfirm = () => confirmDialog;
/** 1 行の入力(`await prompt({ title, value })`。やめたときは null) */
export const usePrompt = () => promptDialog;

/** 2 段目の「言葉を入力」が合っているか(前後の空白は無視)。英語表示では画面に出る訳(Restore など)も受ける */
export const wordOk = (typed: string, word?: string, shown?: string) => !word || typed.trim() === word || typed.trim() === shown;
