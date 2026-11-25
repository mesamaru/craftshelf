// パネルの版の読み方と比べ方(画面とサーバーの両方で使う)。
// 版の形は 2 つある:
// - 旧 `03.xx.xx`(メジャー.マイナー.修正。03.99.xx まで)
// - 新 `0.xx.xx`(大型.メジャー.マイナー。0.04.00 から)
// 旧の `03.AA.BB` は「大型 0・メジャー 03・マイナー AA・修正 BB」と読み、新の `G.MM.mm` は「大型 G・メジャー MM・マイナー mm」と読む。
// こう読むと、0.04.00 は 03.99.xx の次になる。文字のまま比べないこと("0.04.00" < "03.99.02" になる)
const OLD = /^(\d{2})\.(\d{2})\.(\d{2})$/;
const NEW = /^(\d)\.(\d{2})\.(\d{2})$/;

/** 版の形か(旧・新のどちらか)。v02 の版(02.xx.xx)も形としては受け付ける */
export const isVersion = (v: string) => OLD.test(v) || NEW.test(v);

/** 比べるための数の組 [大型, メジャー, マイナー, 修正]。形が違えば null */
export function versionKey(v: string): [number, number, number, number] | null {
  const o = v.match(OLD);
  if (o) return [0, Number(o[1]), Number(o[2]), Number(o[3])];
  const n = v.match(NEW);
  if (n) return [Number(n[1]), Number(n[2]), Number(n[3]), 0];
  return null;
}

/** a が新しければ正、古ければ負、同じなら 0。形が違うものは、どの版よりも古いとみなす */
export function compareVersion(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** 新しい方(形が違うものは選ばない。どちらも違えば b) */
export const newerVersion = (a: string, b = "") => (compareVersion(a, b) > 0 ? a : b);

/** 大型(製品の世代)。旧の形は 0。大型が変わる版へは、自動アップデートで入れない */
export const generationOf = (v: string) => versionKey(v)?.[0] ?? -1;

/** v03 か、それより新しい版か(v02 の版・形の違うものは false) */
export const isV03OrLater = (v: string) => compareVersion(v, "03.00.00") >= 0;
