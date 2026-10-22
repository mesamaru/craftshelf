// ログインのあとに戻る先。同じサイトの中のパスだけを受け付ける(別のサイトへ飛ばされないように)
export const safeNext = (v: unknown) =>
  typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/";
