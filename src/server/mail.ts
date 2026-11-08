// メールの送信(招待・パスワードの再設定・メールアドレスの確認)。Resend(https://resend.com)を使う。
// RESEND_API_KEY と MAIL_FROM(送り元。例 CraftShelf <no-reply@example.com>)があるときだけ送り、無ければ送らずに動く
import type { FetchLike } from "./net";

export type Mail = { to: string; subject: string; text: string };
export type Mailer = { send: (m: Mail) => Promise<void> };

export function resendMailer(fetch: FetchLike, apiKey: string, from: string): Mailer {
  return {
    async send(m) {
      let res: Response;
      try {
        res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error("メールの送信サービスに接続できません");
      }
      if (!res.ok) throw new Error(`メールを送れませんでした(HTTP ${res.status})`);
    },
  };
}

/** 送るメールの文面 */
export const MAILS = {
  verify: (url: string): Omit<Mail, "to"> => ({
    subject: "CraftShelf: メールアドレスの確認",
    text: `CraftShelf への登録ありがとうございます。\n\n次のリンクを開くと、登録が終わります(24 時間有効)。\n${url}\n\n心当たりが無いときは、このメールを消してください。`,
  }),
  reset: (url: string): Omit<Mail, "to"> => ({
    subject: "CraftShelf: パスワードの再設定",
    text: `パスワードを再設定するには、次のリンクを開いてください(1 時間有効)。\n${url}\n\n心当たりが無いときは、このメールを消してください。パスワードは変わりません。`,
  }),
  invite: (inviter: string, team: string, url: string): Omit<Mail, "to"> => ({
    subject: `CraftShelf: 「${team}」への招待`,
    text: `${inviter} さんが、CraftShelf のチーム「${team}」にあなたを招待しました。\n\n次のリンクを開いて、このメールアドレスでログイン(または登録)すると参加できます(48 時間有効)。\n${url}\n\n心当たりが無いときは、このメールを消してください。`,
  }),
};
