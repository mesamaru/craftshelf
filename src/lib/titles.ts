// ページのタイトル(タブの名前)と、設定の各まとまりの名前。メニュー・設定の左の一覧・Ctrl K・タイトルで同じ名前を使う。
// 英語表示のときは、画面と同じ辞書で訳す(src/lib/i18n.ts)

/** 「ライブラリ - CraftShelf」のような題。parts は大きい順(「設定」「ユーザーと権限」など) */
export const pageTitle = (...parts: (string | null | undefined | false)[]) => [...parts.filter(Boolean), "CraftShelf"].join(" - ");

export type SettingsKey =
  | "profile" | "security" | "passkeys" | "look"
  | "members" | "perms" | "activity" | "storage" | "shares" | "tokens" | "curseforge" | "setup" | "channel"
  | "backup" | "versions" | "usage" | "telemetry" | "api" | "import" | "feedback" | "cleanup";

/** 設定の左の一覧の名前(v02 の設定と同じ言葉) */
export const SETTING_LABEL: Record<SettingsKey, string> = {
  profile: "プロフィール", security: "パスワードと二段階認証", passkeys: "パスキー", look: "見た目と言語",
  members: "ユーザーと権限", perms: "権限と割り当て", activity: "操作の記録と通知", storage: "ストレージ", shares: "共有リンク",
  tokens: "API トークン", curseforge: "CurseForge API キー", setup: "はじめの設定", channel: "受け取る版",
  backup: "バックアップ", versions: "パネルのアップデート", usage: "ユーザーごとの利用状況", telemetry: "利用状況の送信",
  api: "API の説明", import: "v02 からの取り込み", feedback: "お問い合わせ・要望", cleanup: "アドオンの整理",
};

/** 設定のまとまりの題(例 設定: ユーザーと権限 - CraftShelf)。key が無い・知らないときは「設定 - CraftShelf」 */
export const settingsTitle = (key?: string | null) => pageTitle(key && key in SETTING_LABEL ? `設定: ${SETTING_LABEL[key as SettingsKey]}` : "設定");

/** Ctrl K の「画面」の行き先(名前は、いまのメニュー・設定の一覧に合わせる) */
export type PageHit = { label: string; sub: "画面" | "設定"; to: string; search?: Record<string, string> };
const SETTING_AT: [SettingsKey, string, string?][] = [
  ["profile", "/settings", "profile"], ["security", "/settings", "security"], ["passkeys", "/settings", "passkeys"], ["look", "/settings", "look"],
  ["members", "/team"], ["perms", "/team", "perms"], ["usage", "/usage"], ["channel", "/team", "channel"],
  ["storage", "/storage"], ["curseforge", "/team", "curseforge"], ["tokens", "/settings", "tokens"], ["api", "/api-docs"],
  ["backup", "/backup"], ["activity", "/activity"], ["shares", "/shares"], ["cleanup", "/cleanup"],
  ["feedback", "/settings", "feedback"], ["telemetry", "/settings", "telemetry"], ["setup", "/team", "setup"],
  ["versions", "/settings", "versions"], ["import", "/settings", "import"],
];
export const PAGE_HITS: PageHit[] = [
  { label: "ライブラリ", sub: "画面", to: "/" },
  { label: "ホーム", sub: "画面", to: "/home" },
  { label: "セット", sub: "画面", to: "/sets" },
  { label: "サーバー", sub: "画面", to: "/servers" },
  { label: "比較", sub: "画面", to: "/compare" },
  { label: "サーバー本体", sub: "画面", to: "/software" },
  { label: "ファイル比較", sub: "画面", to: "/compare/files" },
  { label: "ポート", sub: "画面", to: "/ports" },
  { label: "処理", sub: "画面", to: "/jobs" },
  { label: "設定", sub: "画面", to: "/settings" },
  ...SETTING_AT.map(([key, to, s]): PageHit => ({ label: SETTING_LABEL[key], sub: "設定", to, ...(s ? { search: { s } } : {}) })),
];
