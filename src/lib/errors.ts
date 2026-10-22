// Better Auth のエラーを画面向けの日本語にする
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "メールアドレスかパスワードが違います",
  USER_ALREADY_EXISTS: "このメールアドレスはすでに登録されています",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "このメールアドレスはすでに登録されています",
  PASSWORD_TOO_SHORT: "パスワードは 10 文字以上にしてください",
  INVALID_CODE: "コードが違います",
  INVALID_PASSWORD: "パスワードが違います",
  TOO_MANY_REQUESTS: "試行が多すぎます。しばらく待ってからやり直してください",
};

export function errorText(e: { code?: string; message?: string; status?: number } | null | undefined): string {
  if (!e) return "";
  if (e.status === 429) return MESSAGES.TOO_MANY_REQUESTS;
  return (e.code && MESSAGES[e.code]) || e.message || "うまくいきませんでした";
}
