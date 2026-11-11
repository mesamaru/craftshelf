// ホームのウィジェットの並び(03.69.00 から。v02 の「ウィジェットを編集」と同じ: 並べ替え・表示 / 非表示・全幅・メモ / ToDo / 時計 / 今日の日付)。
// アカウントに保存する(user_pref.dash の JSON)ので、画面と保存の両方でここの cleanDash を通す
export const DASH_WIDGETS = [
  ["tiles", "概要"], ["updates", "更新があるもの"], ["recent", "最近追加したもの"], ["cats", "種類ごとの件数"],
  ["attention", "確認が必要なもの"], ["servers", "サーバー"], ["links", "配布元の連携"], ["storage", "保存先とバックアップ"],
] as const;
export const CUSTOM_TYPES = { memo: "メモ", todo: "ToDo リスト", clock: "時計", date: "今日の日付" } as const;
export type CustomType = keyof typeof CUSTOM_TYPES;
export type Custom = { id: string; type: CustomType; title: string; text: string; md: boolean; items: { t: string; d: boolean }[]; style: "digital" | "analog" };
export type DashLayout = { order: string[]; hidden: string[]; full: string[]; custom: Custom[] };

export const DASH_LIMITS = { custom: 12, title: 40, text: 10000, items: 100, item: 200 };
export const DASH_DEFAULT: DashLayout = { order: DASH_WIDGETS.map(([k]) => k), hidden: [], full: ["tiles"], custom: [] };

const KNOWN = new Set<string>(DASH_WIDGETS.map(([k]) => k));
const ID = /^x[0-9a-f]{8}$/;
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** 保存したもの・送られてきたものを、知っているウィジェットだけの正しい形にそろえる(足りないものは後ろに足す) */
export function cleanDash(v: unknown): DashLayout {
  const d = obj(v);
  const custom: Custom[] = [];
  for (const raw of Array.isArray(d.custom) ? d.custom : []) {
    const c = obj(raw);
    const type = String(c.type) as CustomType;
    if (!ID.test(String(c.id)) || !(type in CUSTOM_TYPES) || custom.some((x) => x.id === c.id) || custom.length >= DASH_LIMITS.custom) continue;
    custom.push({
      id: String(c.id), type, title: String(c.title ?? "").slice(0, DASH_LIMITS.title), text: String(c.text ?? "").slice(0, DASH_LIMITS.text), md: c.md === true,
      items: (Array.isArray(c.items) ? c.items : []).slice(0, DASH_LIMITS.items).map((x) => ({ t: String(obj(x).t ?? "").slice(0, DASH_LIMITS.item), d: obj(x).d === true })).filter((x) => x.t.trim()),
      style: c.style === "analog" ? "analog" : "digital",
    });
  }
  const known = new Set([...KNOWN, ...custom.map((c) => c.id)]);
  const keep = (l: unknown) => [...new Set(strs(l).filter((k) => known.has(k)))];
  const order = keep(d.order);
  for (const k of known) if (!order.includes(k)) order.push(k);
  return { order, hidden: keep(d.hidden), full: d.full === undefined ? DASH_DEFAULT.full : keep(d.full), custom };
}

/** 新しいウィジェットの ID(x と 16 進 8 桁) */
export const newCustomId = () => `x${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
