// Better Auth のエラーを画面向けの日本語にする
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "メールアドレスかパスワードが違います",
  USER_ALREADY_EXISTS: "このメールアドレスはすでに登録されています",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "このメールアドレスはすでに登録されています",
  PASSWORD_TOO_SHORT: "パスワードは 10 文字以上にしてください",
  INVALID_CODE: "コードが違います",
  INVALID_PASSWORD: "パスワードが違います",
  V02_TOTP_INVALID: "コードが違います",
  INVALID_USERNAME_OR_PASSWORD: "ユーザー名かパスワードが違います",
  TOO_MANY_REQUESTS: "試行が多すぎます。しばらく待ってからやり直してください",
  YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS: "作れるチームの数の上限に達しました",
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: "このチームの人数の上限に達しました",
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "この人はすでにチームのメンバーです",
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: "この人はすでに招待されています",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: "オーナーはチームから抜けられません",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: "この招待は別のメールアドレス宛てです",
  INVITATION_NOT_FOUND: "この招待は使えません(期限切れか取り消し済み)",
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: "この役割で招待する権限がありません",
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER: "この人の役割を変える権限がありません",
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: "この人を外す権限がありません",
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: "招待する権限がありません",
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION: "チームを変更する権限がありません",
};

export function errorText(e: { code?: string; message?: string; status?: number } | null | undefined): string {
  if (!e) return "";
  if (e.status === 429) return MESSAGES.TOO_MANY_REQUESTS;
  return (e.code && MESSAGES[e.code]) || e.message || "うまくいきませんでした";
}
