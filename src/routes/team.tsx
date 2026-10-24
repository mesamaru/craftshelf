import { useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";
import { useCan } from "~/lib/use-can";
import { ASSIGNABLE_ROLES, type RoleName, roleLabel } from "~/lib/permissions";

export const Route = createFileRoute("/team")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login" });
    return { user: context.user };
  },
  component: Team,
});

// チーム(メンバー・招待・役割・チームの切り替え)
function Team() {
  const { user, app } = Route.useRouteContext();
  const { team, me, can, refetch } = useCan(user.id);

  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/" className="capsule">‹ 戻る</Link>
        <h1>チーム</h1>
      </header>
      {app.mode === "service" && <Switcher activeId={team?.id} />}
      {team && (
        <>
          <TeamName key={team.id} id={team.id} name={team.name} editable={can({ organization: ["update"] })} onDone={refetch} />
          <div className="group-title">メンバー({team.members.length} 人)</div>
          <section className="group">
            {team.members.map((m) => (
              <MemberRow key={m.id} member={m} isMe={m.userId === user.id}
                editable={m.role !== "owner" && m.userId !== user.id && can({ member: ["update"] })}
                removable={m.role !== "owner" && m.userId !== user.id && can({ member: ["delete"] })} onDone={refetch} />
            ))}
          </section>
          {can({ invitation: ["create"] }) && <Invite onDone={refetch} />}
          {team.invitations.some((i) => i.status === "pending") && (
            <>
              <div className="group-title">返事を待っている招待</div>
              <section className="group">
                {team.invitations.filter((i) => i.status === "pending").map((i) => (
                  <InviteRow key={i.id} id={i.id} email={i.email} role={i.role}
                    cancelable={can({ invitation: ["cancel"] })} onDone={refetch} />
                ))}
              </section>
            </>
          )}
          {me && me.role !== "owner" && <Leave teamId={team.id} />}
        </>
      )}
    </main>
  );
}

function Switcher({ activeId }: { activeId?: string }) {
  const { data: teams, refetch } = authClient.useListOrganizations();
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const pick = async (organizationId: string) => {
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) setError(errorText(error));
  };
  const create = async () => {
    setError("");
    const slug = `t-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const { data, error } = await authClient.organization.create({ name, slug });
    if (error) return setError(errorText(error));
    setName("");
    refetch();
    if (data) await pick(data.id);
  };

  return (
    <>
      <div className="group-title">使うチーム</div>
      <section className="group form">
        {teams?.map((t) => (
          <button key={t.id} className="row" type="button" onClick={() => pick(t.id)}>
            <span translate="no">{t.name}</span>
            {t.id === activeId && <span className="trail">✓</span>}
          </button>
        ))}
        <input className="row" placeholder="新しいチームの名前" translate="no" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="capsule" type="button" onClick={create} disabled={!name.trim()}>チームを作る</button>
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}

function TeamName({ id, name, editable, onDone }: { id: string; name: string; editable: boolean; onDone: () => void }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState("");
  if (!editable) return null;
  const save = async () => {
    const { error } = await authClient.organization.update({ organizationId: id, data: { name: value } });
    if (error) return setError(errorText(error));
    onDone();
  };
  return (
    <section className="group form">
      <div className="row"><span>チームの名前</span></div>
      <input className="row" translate="no" value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="capsule" type="button" onClick={save} disabled={!value.trim() || value === name}>名前を変える</button>
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}

type Member = { id: string; userId: string; role: string; user: { name: string; email: string } };

function MemberRow({ member, isMe, editable, removable, onDone }:
  { member: Member; isMe: boolean; editable: boolean; removable: boolean; onDone: () => void }) {
  const [error, setError] = useState("");
  const setRole = async (role: RoleName) => {
    const { error } = await authClient.organization.updateMemberRole({ memberId: member.id, role });
    if (error) return setError(errorText(error));
    onDone();
  };
  const remove = async () => {
    if (!confirm(`${member.user.name} さんをチームから外しますか?`)) return;
    const { error } = await authClient.organization.removeMember({ memberIdOrEmail: member.id });
    if (error) return setError(errorText(error));
    onDone();
  };
  return (
    <div className="row member">
      <span className="main">
        <span translate="no">{member.user.name}{isMe ? "(自分)" : ""}</span>
        <span className="muted" translate="no">{member.user.email}</span>
        {error && <span className="error" role="alert">{error}</span>}
      </span>
      {editable ? (
        <select className="trail" value={member.role} onChange={(e) => setRole(e.target.value as RoleName)} aria-label="役割">
          {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
        </select>
      ) : (
        <span className="trail">{roleLabel(member.role)}</span>
      )}
      {removable && <button className="link danger" type="button" onClick={remove}>外す</button>}
    </div>
  );
}

function Invite({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleName>("viewer");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  const send = async () => {
    setError("");
    setLink("");
    const { data, error } = await authClient.organization.inviteMember({ email, role });
    if (error) return setError(errorText(error));
    if (data) setLink(`${location.origin}/invite/${data.id}`);
    setEmail("");
    onDone();
  };

  return (
    <>
      <div className="group-title">招待</div>
      <section className="group form">
        <input className="row" type="email" placeholder="招待する人のメールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="row">
          <span>役割</span>
          <select className="trail" value={role} onChange={(e) => setRole(e.target.value as RoleName)}>
            {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        </div>
        <button className="capsule" type="button" onClick={send} disabled={!email}>招待のリンクを作る</button>
        {link && (
          <>
            <p className="row muted">このリンクを招待する人に送ってください(48 時間有効。そのメールアドレスでログインした人だけが参加できます)。</p>
            <input className="row" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          </>
        )}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}

function InviteRow({ id, email, role, cancelable, onDone }:
  { id: string; email: string; role: string; cancelable: boolean; onDone: () => void }) {
  const cancel = async () => {
    await authClient.organization.cancelInvitation({ invitationId: id });
    onDone();
  };
  return (
    <div className="row">
      <span translate="no">{email}</span>
      <span className="trail">{roleLabel(role)}</span>
      {cancelable && <button className="link danger" type="button" onClick={cancel}>取り消す</button>}
    </div>
  );
}

function Leave({ teamId }: { teamId: string }) {
  const [error, setError] = useState("");
  const leave = async () => {
    if (!confirm("このチームから抜けますか?")) return;
    const { error } = await authClient.organization.leave({ organizationId: teamId });
    if (error) return setError(errorText(error));
    location.href = "/team";
  };
  return (
    <section className="group spaced">
      <button className="row danger" type="button" onClick={leave}>このチームから抜ける</button>
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}
