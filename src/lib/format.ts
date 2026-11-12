// 画面に出す大きさ・日付の整え方(画面とサーバーの記録で同じものを使う)

/** ファイルの大きさ(v02 と同じ「2.0 KB」の形。1 KB 未満は B のまま。切り上げない) */
export const fmtSize = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${Math.round(n)} B`);

/** 日付(2026-02-01 の形)。ISO の時刻(UTC)を、この端末の時間で読んだ日付にする。読めなければ前の 10 文字 */
export const localDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("sv-SE");
};
