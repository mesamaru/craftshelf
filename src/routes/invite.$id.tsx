import { useEffect, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";
import { roleLabel } from "~/lib/permissions";

export const Route = createFileRoute("/invite/$id")({
  beforeLoad: ({ context, params }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: `/invite/${params.id}` } });
  },
  component: Invitation,
});

type Info = { organizationName: string; inviterEmail: string; role: string };

// 招待のリンクを開いたとき: 参加するか断るかを選ぶ
function Invitation() {
  const { id } = Route.useParams();
  const router = useRouter();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    authClient.organization.getInvitation({ query: { id } }).then(({ data, error }) => {
      if (error) setError(error.status === 400 || error.status === 404 ? "この招待は使えません(期限切れ・取り消し済み・別のメールアドレス宛て)" : errorText(error));
      else setInfo(data);
    });
  }, [id]);

  const accept = async () => {
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id });
    if (error) return setError(errorText(error));
    if (data) await authClient.organization.setActive({ organizationId: data.member.organizationId });
    await router.navigate({ to: "/team" });
  };
  const reject = async () => {
    await authClient.organization.rejectInvitation({ invitationId: id });
    await router.navigate({ to: "/" });
  };

  return (
    <main className="page narrow">
      <h1 className="title">チームへの招待</h1>
      <section className="group form">
        {info ? (
          <>
            <div className="row"><span>チーム</span><span className="trail" translate="no">{info.organizationName}</span></div>
            <div className="row"><span>招待した人</span><span className="trail" translate="no">{info.inviterEmail}</span></div>
            <div className="row"><span>役割</span><span className="trail">{roleLabel(info.role)}</span></div>
            <button className="capsule primary" type="button" onClick={accept}>参加する</button>
            <button className="capsule" type="button" onClick={reject}>断る</button>
          </>
        ) : !error && <p className="row muted">読み込み中…</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
