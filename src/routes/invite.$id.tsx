import { useEffect, useState } from "react";
import { createFileRoute, redirect, useRouteContext, useRouter } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";
import { roleLabel } from "~/lib/permissions";
import { pageTitle } from "~/lib/titles";

export const Route = createFileRoute("/invite/$id")({
  beforeLoad: ({ context, params }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: `/invite/${params.id}` } });
  },
  head: () => ({ meta: [{ title: pageTitle("チームへの招待") }] }),
  component: Invitation,
});

type Info = { organizationName: string; inviterEmail: string; role: string };
// メールを送れるパネルでは、確かめたメールアドレスでないと招待を見られない(Better Auth の requireEmailVerificationOnInvitation)
const NEEDS_VERIFY = /EMAIL_VERIFICATION_REQUIRED/;

// 招待のリンクを開いたとき: 参加するか断るかを選ぶ
function Invitation() {
  const { id } = Route.useParams();
  const router = useRouter();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [verify, setVerify] = useState(false);
  const [sent, setSent] = useState(false);
  const { user } = useRouteContext({ strict: false }) as { user?: { email: string } | null };

  useEffect(() => {
    authClient.organization.getInvitation({ query: { id } }).then(({ data, error }) => {
      if (error && NEEDS_VERIFY.test(String(error.code ?? ""))) setVerify(true);
      else if (error) setError(error.status === 400 || error.status === 404 ? "この招待は使えません(期限切れ・取り消し済み・別のメールアドレス宛て)" : errorText(error));
      else setInfo(data);
    });
  }, [id]);

  const accept = async () => {
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id });
    if (error && NEEDS_VERIFY.test(String(error.code ?? ""))) return setVerify(true);
    if (error) return setError(errorText(error));
    if (data) await authClient.organization.setActive({ organizationId: data.member.organizationId });
    await router.navigate({ to: "/team" });
  };
  const sendVerify = async () => {
    setError("");
    const { error } = await authClient.sendVerificationEmail({ email: user?.email ?? "", callbackURL: `/invite/${id}` });
    if (error) return setError(errorText(error));
    setSent(true);
  };
  const reject = async () => {
    await authClient.organization.rejectInvitation({ invitationId: id });
    await router.navigate({ to: "/" });
  };

  return (
    <main className="auth glass">
      <img className="brand-mark" src="/icon.svg" alt="" />
      <h1 className="title">チームへの招待</h1>
      <section className="group form">
        {verify ? (
          <>
            <p className="row">参加する前に、メールアドレスの確認が要ります。<span translate="no">{user?.email}</span> に確認のメールを送り、届いたリンクを開くと、この画面に戻ります。</p>
            {sent ? <p className="row muted" role="status">送りました。メールを確かめてください(24 時間有効)。</p>
              : <button className="btn pri" type="button" onClick={sendVerify}>確認のメールを送る</button>}
          </>
        ) : info ? (
          <>
            <div className="row"><span>チーム</span><span className="trail" translate="no">{info.organizationName}</span></div>
            <div className="row"><span>招待した人</span><span className="trail" translate="no">{info.inviterEmail}</span></div>
            <div className="row"><span>役割</span><span className="trail">{roleLabel(info.role)}</span></div>
            <button className="btn pri" type="button" onClick={accept}>参加する</button>
            <button className="btn sec" type="button" onClick={reject}>断る</button>
          </>
        ) : !error && <p className="row muted">読み込み中…</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
