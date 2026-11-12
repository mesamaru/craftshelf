// ライブラリの一覧の小さな説明(v02 と同じ「版 · N バージョン · 大きさ · 日付」)。どの配布元のものも同じ形にし、分からない値だけ省く
import { fmtSize } from "./format";
import { originLabel } from "./origin";

// source・origin: アップロードしたもの(upload)は、ファイルの出どころ(アップロード・サーバーから取り込み・v02 から)も出す。出どころが空(古い行)なら出さない
type Sub = { version: string; files: number; size: number; createdAt: string; source?: string; origin?: string };

/** 保存した版の数が 0 でも、版が分かっていれば 1 バージョンとして数える(配布元のものも、アップロードしたものと同じ形になる) */
export function itemSub(i: Sub, date = true) {
  const n = i.files || (i.version ? 1 : 0);
  return [i.version, n ? `${n} バージョン` : "", i.size ? fmtSize(i.size) : "", date ? new Date(i.createdAt).toLocaleDateString("ja-JP") : "", i.source === "upload" && i.origin ? originLabel(i.origin) : ""].filter(Boolean).join(" · ");
}
