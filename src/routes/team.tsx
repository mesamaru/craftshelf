import { type ReactNode, useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { errorText } from "~/lib/errors";
import { filesAccess, setEditorFiles } from "~/lib/files-api";
import { curseforgeKey, libraryCatalog, setCurseforgeKey, setLibraryChannel } from "~/lib/library-api";
import { listSets } from "~/lib/sets-api";
import { OPEN_ADD } from "~/lib/shell";
import { CHANNELS, type Channel } from "~/lib/sources";
import { Btn, Info } from "~/lib/ui";
import { SettingsFrame } from "~/lib/settings-frame";
import { useCan } from "~/lib/use-can";
import { useServerFn } from "@tanstack/react-start";
import { ASSIGNABLE_ROLES, GRANTS, GRANT_LABELS, type Grant, type RoleName, roleLabel } from "~/lib/permissions";
import { serverAssignments, setServerAssignment } from "~/lib/servers-api";
import { settingsTitle } from "~/lib/titles";
import { deleteTeam, memberGrants, resetSignIn, setMemberGrants, transferOwner } from "~/lib/teams-api";

export const Route = createFileRoute("/team")({
  validateSearch: (s: Record<string, unknown>): { s?: string } => (typeof s.s === "string" ? { s: s.s } : {}),
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login" });
    return { user: context.user };
  },
  head: ({ match }) => ({ meta: [{ title: settingsTitle(match.search.s ?? "members") }] }),
  component: Team,
});

// 設定のうち、チームのまとまり(?s= で選ぶ。何も選ばないとメンバー)
const SECTIONS = ["members", "perms", "curseforge", "setup", "channel"] as const;
type Section = (typeof SECTIONS)[number];
const INFO: Partial<Record<Section, ReactNode>> = {
  perms: <><span>役割(閲覧者・編集者・管理者)の権限に、メンバーごとに足したり引いたりできます。たとえば「編集者だけど設定ファイルも直せる」「閲覧者だけどサーバーの電源は操作できる」「編集者だけどライブラリは変えられない」のようにできます。</span><span>メンバーの招待・役割の変更・チームの設定・利用状況・パネルのバックアップは、役割(管理者以上)だけで決まります。オーナーの権限は減らせません。API トークンも、作った人の今の権限の分だけ使えます。</span></>,
  curseforge: <span>設定すると、サーバーの画面とライブラリで CurseForge からも探して入れられます。作者が外部からのダウンロードを許していないものは入れられません。キーは暗号化して保存し、画面には最後の 4 文字だけを出します。</span>,
  channel: <span>更新・サーバーに入れるときに、どの版を選ぶかです。「正式版だけ」でも、正式版が 1 つも無いものはベータ版を使います。アイテムごとに「詳しく」→「情報を直す」で変えられます。</span>,
};

// チーム(メンバー・招待・役割・チームの切り替え・権限・連携)
function Team() {
  const { user, app } = Route.useRouteContext();
  const { s } = Route.useSearch();
  const { team, me, can, refetch } = useCan(user.id);
  const at: Section = SECTIONS.includes(s as Section) ? (s as Section) : "members";
  const admin = can({ member: ["update"] });

  return (
    <SettingsFrame at={at} info={INFO[at]}>
      {at === "members" && app.mode === "service" && <Switcher activeId={team?.id} />}
      {team && at === "members" && (
        <>
          <TeamName key={team.id} id={team.id} name={team.name} editable={can({ organization: ["update"] })} onDone={refetch} />
          <div className="gtitle">{`メンバー(${team.members.length} 人)`}</div>
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
              <div className="gtitle">返事を待っている招待</div>
              <section className="group">
                {team.invitations.filter((i) => i.status === "pending").map((i) => (
                  <InviteRow key={i.id} id={i.id} email={i.email} role={i.role}
                    cancelable={can({ invitation: ["cancel"] })} onDone={refetch} />
                ))}
              </section>
            </>
          )}
          {app.mode === "self" && admin && (
            <SignInHelp members={team.members.filter((m) => m.role !== "owner" && m.userId !== user.id).map((m) => ({ userId: m.userId, name: m.user.name }))} />
          )}
          {me && me.role !== "owner" && <Leave teamId={team.id} />}
          {me?.role === "owner" && (
            <OwnerTools teamName={team.name} service={app.mode === "service"}
              members={team.members.filter((m) => m.userId !== user.id).map((m) => ({ userId: m.userId, name: m.user.name }))} />
          )}
        </>
      )}
      {team && at === "perms" && admin && <>
        <EditorFiles />
        <Grants key={team.members.map((m) => m.role).join()} me={user.id} members={team.members.map((m) => ({ userId: m.userId, name: m.user.name, role: m.role }))} />
        <Assignments key={`a${team.members.map((m) => m.role).join()}`} />
      </>}
      {at === "curseforge" && app.mode === "self" && can({ integrations: ["manage"] }) && <CurseForgeKey />}
      {team && (at === "setup" || at === "channel") && admin && <LibrarySetup key={team.id} members={team.members.length} part={at} />}
    </SettingsFrame>
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
      <div className="gtitle">使うチーム</div>
      <section className="group form">
        {teams?.map((t) => (
          <button key={t.id} className="row" type="button" onClick={() => pick(t.id)}>
            <span translate="no">{t.name}</span>
            {t.id === activeId && <span className="trail">✓</span>}
          </button>
        ))}
        <input className="row" placeholder="新しいチームの名前" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn sec" type="button" onClick={create} disabled={!name.trim()}>チームを作る</button>
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
    <form className="group" onSubmit={(e) => (e.preventDefault(), save())}>
      <label className="row">
        <span>チームの名前</span>
        <input className="trail field" maxLength={60} value={value} onChange={(e) => setValue(e.target.value)} aria-label="チームの名前" />
        {value !== name && <Btn kind="pri" sm type="submit" disabled={!value.trim()}>保存</Btn>}
      </label>
      {error && <p className="row error" role="alert">{error}</p>}
    </form>
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
      <span className="av" aria-hidden="true" translate="no">{member.user.name.slice(0, 1).toUpperCase()}</span>
      <span className="main">
        <span><span translate="no">{member.user.name}</span>{isMe ? "(自分)" : ""}</span>
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
      <div className="gtitle">招待</div>
      <section className="group form">
        <input className="row" type="email" placeholder="招待する人のメールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="row">
          <span>役割</span>
          <select className="trail" value={role} onChange={(e) => setRole(e.target.value as RoleName)}>
            {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        </div>
        <button className="btn pri" type="button" onClick={send} disabled={!email}>招待のリンクを作る</button>
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

// CurseForge の API キー(console.curseforge.com で作るもの)。設定すると、CurseForge から探して入れられる
const cfMessage = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

function CurseForgeKey() {
  const load = useServerFn(curseforgeKey);
  const save = useServerFn(setCurseforgeKey);
  const [hint, setHint] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const reload = () => load().then((r) => setHint(r.hint), (e) => setError(cfMessage(e)));
  useEffect(() => { reload(); }, []);
  const run = async (value: string | null, done: string) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await save({ data: { key: value } });
      setKey("");
      setNote(done);
      await reload();
    } catch (e) {
      setError(cfMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (hint === null) return null;
  return (
    <>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), run(key, "保存しました"))}>
        <input className="row" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)}
          placeholder={hint ? `API キー(設定済み ${hint}。変えるときだけ入力)` : "API キー(console.curseforge.com で作ったもの)"} aria-label="CurseForge の API キー" />
        <div className="row actions">
          <button className="link" type="submit" disabled={busy || !key.trim()}>{busy ? "確かめています…" : "確かめて保存"}</button>
          {hint && <button className="trail link danger" type="button" disabled={busy} onClick={() => run(null, "消しました")}>キーを消す</button>}
        </div>
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </form>
    </>
  );
}

// 設定ファイルを編集者にも許すか(管理者以上が決める。既定は管理者以上だけ)
function EditorFiles() {
  const load = useServerFn(filesAccess);
  const save = useServerFn(setEditorFiles);
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { load().then((a) => setOn(a.editors), (e) => setError(cfMessage(e))); }, []);
  const change = async (v: boolean) => {
    setError("");
    setOn(v);
    try {
      await save({ data: { on: v } });
    } catch (e) {
      setOn(!v);
      setError(cfMessage(e));
    }
  };
  if (on === null && !error) return null;
  return (
    <>
      <div className="gtitle">設定ファイル<Info>設定ファイル(server.properties・plugins の設定など)には、データベースのパスワードや API キーが入っていることがあります。既定では管理者とオーナーだけが見る・直せます。許すと、編集者も「ファイルとコマンド」とファイル比較で見る・直せるようになります(割り当てたサーバーだけ)。人ごとに許す・止めるときは「メンバーごとの権限」で決めます。</Info></div>
      <section className="group">
        <label className="row">
          <span>編集者にも、サーバーの設定ファイルを見る・直すのを許す</span>
          <input className="trail switch" type="checkbox" checked={!!on} disabled={on === null} onChange={(e) => change(e.target.checked)} />
        </label>
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}

// メンバーごとの権限(管理者以上・03.60.00 から): 役割の権限に足す・引く。オーナーと自分は変えられない
function Grants({ members, me }: { members: { userId: string; name: string; role: string }[]; me: string }) {
  const load = useServerFn(memberGrants);
  const save = useServerFn(setMemberGrants);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof memberGrants>> | null>(null);
  const [open, setOpen] = useState("");
  const [error, setError] = useState("");
  const reload = () => load().then(setRows, (e) => setError(cfMessage(e)));
  useEffect(() => { reload(); }, []);
  const list = members.filter((m) => m.userId !== me && rows?.some((r) => r.userId === m.userId && !r.owner));
  if (!rows || !list.length) return error ? <p className="error" role="alert">{error}</p> : null;
  const change = async (userId: string, perms: Grant[]) => {
    setError("");
    setRows((d) => d && d.map((x) => (x.userId === userId ? { ...x, perms } : x))); // 先に画面を変える
    try {
      await save({ data: { userId, perms } });
    } catch (e) {
      setError(cfMessage(e));
    }
    await reload();
  };
  return (
    <>
      <div className="gtitle">メンバーごとの権限</div>
      {list.map((m) => {
        const r = rows.find((x) => x.userId === m.userId)!;
        const more = r.perms.filter((g) => !r.base.includes(g)).length;
        const less = r.base.filter((g) => !r.perms.includes(g)).length;
        return (
          <section className="group" key={m.userId}>
            <div className="row">
              <span className="main">
                <span translate="no">{m.name}</span>
                <span className="muted small">{roleLabel(m.role)} · {more || less ? `足した権限 ${more}・引いた権限 ${less}` : "役割のとおり"}</span>
              </span>
              <button className="trail link" type="button" aria-expanded={open === m.userId} onClick={() => setOpen(open === m.userId ? "" : m.userId)}>{open === m.userId ? "閉じる" : "変える"}</button>
            </div>
            {open === m.userId && GRANTS.map((g) => (
              <label className="row" key={g}>
                <span className="main">
                  <span>{GRANT_LABELS[g]}</span>
                  {r.perms.includes(g) !== r.base.includes(g) && <span className="muted small">{r.perms.includes(g) ? "役割より多い(足した権限)" : "役割より少ない(引いた権限)"}</span>}
                </span>
                <input className="trail switch" type="checkbox" checked={r.perms.includes(g)} aria-label={GRANT_LABELS[g]}
                  onChange={(e) => change(m.userId, e.target.checked ? [...r.perms, g] : r.perms.filter((x) => x !== g))} />
              </label>
            ))}
            {open === m.userId && (more > 0 || less > 0) && <button className="row link" type="button" onClick={() => change(m.userId, r.base as Grant[])}>役割のとおりに戻す</button>}
          </section>
        );
      })}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// サーバーの割り当て(管理者以上): 閲覧者・編集者ごとに、使えるサーバーを決める。管理者・オーナーはいつでもすべて
function Assignments() {
  const load = useServerFn(serverAssignments);
  const save = useServerFn(setServerAssignment);
  const [data, setData] = useState<Awaited<ReturnType<typeof serverAssignments>> | null>(null);
  const [error, setError] = useState("");
  const reload = () => load().then(setData, (e) => setError(e instanceof Error ? e.message : "読み込めませんでした"));
  useEffect(() => { reload(); }, []);
  if (!data || (!data.members.length && !error)) return null;
  const change = async (userId: string, limited: boolean, serverIds: string[]) => {
    setError("");
    setData((d) => d && { ...d, members: d.members.map((x) => (x.userId === userId ? { ...x, limited, serverIds } : x)) }); // 先に画面を変える
    try {
      await save({ data: { userId, limited, serverIds } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "うまくいきませんでした");
      await reload();
    }
  };
  return (
    <>
      <div className="gtitle">サーバーの割り当て<Info>オフにすると、その人は下で選んだサーバーだけを見る・操作できます(一覧・比較・セット・ポートにも、選んだサーバーだけが出ます)。管理者とオーナーは、いつでもすべてのサーバーを使えます。</Info></div>
      {data.members.map((m) => (
        <section className="group" key={m.userId}>
          <label className="row">
            <span className="main"><span translate="no">{m.name}</span><span className="muted small">{roleLabel(m.role)}</span></span>
            <span className="trail small">すべてのサーバーを使える</span>
            <input className="trail switch" type="checkbox" checked={!m.limited} onChange={(e) => change(m.userId, !e.target.checked, m.serverIds)} />
          </label>
          {m.limited && data.servers.map((s) => (
            <label className="row" key={s.id}>
              <span className="main" translate="no">{s.name}</span>
              <input className="trail switch" type="checkbox" checked={m.serverIds.includes(s.id)}
                onChange={(e) => change(m.userId, true, e.target.checked ? [...m.serverIds, s.id] : m.serverIds.filter((x) => x !== s.id))} />
            </label>
          ))}
          {m.limited && !data.servers.length && <div className="row muted">サーバーがありません</div>}
        </section>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// オーナーだけ: オーナーを譲る(両方の版)・チームを消す(サービス版)
function OwnerTools({ teamName, service, members }: { teamName: string; service: boolean; members: { userId: string; name: string }[] }) {
  const transfer = useServerFn(transferOwner);
  const remove = useServerFn(deleteTeam);
  const [to, setTo] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      location.href = "/team";
    } catch (e) {
      setError(e instanceof Error ? e.message : "うまくいきませんでした");
      setBusy(false);
    }
  };
  if (!members.length && !service) return null;
  return (
    <>
      <div className="gtitle">オーナー</div>
      {members.length > 0 && (
        <section className="group">
          <div className="row">
            <span>オーナーを譲る</span>
            <select className="trail" value={to} onChange={(e) => setTo(e.target.value)} aria-label="オーナーを譲る相手">
              <option value="">選んでください…</option>
              {members.map((m) => <option key={m.userId} value={m.userId} translate="no">{m.name}</option>)}
            </select>
          </div>
          <button className="row link" type="button" disabled={busy || !to} onClick={() => {
            const name = members.find((m) => m.userId === to)?.name ?? "";
            if (confirm(`${name} さんにオーナーを譲りますか?(あなたは管理者になります)`)) run(() => transfer({ data: { userId: to } }));
          }}>譲る</button>
        </section>
      )}
      {service && (
        <section className="group">
          <input className="row" placeholder={`消すときは、チームの名前(${teamName})を入力`} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} aria-label="消すチームの名前" />
          <button className="row danger" type="button" disabled={busy || confirmName.trim() !== teamName} onClick={() => {
            if (confirm("チームを消しますか?サーバー・ライブラリ・セットなど、このチームのものはすべて消え、元に戻せません(サーバーのファイルは消えません)")) run(() => remove({ data: { name: confirmName } }));
          }}>このチームを消す</button>
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// ログインできなくなったメンバー(自分用の版・管理者以上): 二段階認証を外す・パスキーをすべて消す。
// サービス版では出さない(理由は src/server/teams.ts の resetSignIn)
function SignInHelp({ members }: { members: { userId: string; name: string }[] }) {
  const reset = useServerFn(resetSignIn);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  if (!members.length) return null;
  const run = async (what: "twoFactor" | "passkeys", ask: string) => {
    const name = members.find((m) => m.userId === to)?.name ?? "";
    if (!confirm(`${name} さんの${ask}`)) return;
    setError("");
    setNote("");
    try {
      const r = await reset({ data: { userId: to, what } });
      setNote(r.removed ? "外しました。その人はログインし直しになります" : "設定されていませんでした");
    } catch (e) {
      setError(e instanceof Error ? e.message : "うまくいきませんでした");
    }
  };
  return (
    <>
      <div className="gtitle">ログインできなくなったメンバー<Info>本人が端末をなくしたときに使います。外すと、その人のいまのログインもすべて切れます。操作は記録に残ります。オーナーの設定は変えられません。</Info></div>
      <section className="group">
        <div className="row">
          <span>メンバー</span>
          <select className="trail" value={to} onChange={(e) => setTo(e.target.value)} aria-label="ログインできなくなったメンバー">
            <option value="">選んでください…</option>
            {members.map((m) => <option key={m.userId} value={m.userId} translate="no">{m.name}</option>)}
          </select>
        </div>
        <button className="row link danger" type="button" disabled={!to} onClick={() => run("twoFactor", "二段階認証を外しますか?(パスワードだけでログインできるようになります)")}>二段階認証を外す</button>
        <button className="row link danger" type="button" disabled={!to} onClick={() => run("passkeys", "パスキーをすべて消しますか?")}>パスキーをすべて消す</button>
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}

// はじめての設定と受け取る版(管理者以上。03.65.00 まではライブラリの画面にあった)
function LibrarySetup({ members, part }: { members: number; part: "setup" | "channel" }) {
  const load = useServerFn(libraryCatalog);
  const [cat, setCat] = useState<Awaited<ReturnType<typeof libraryCatalog>> | null>(null);
  const reload = () => { load().then(setCat, () => setCat(null)); };
  useEffect(reload, []);
  if (!cat) return null;
  return part === "setup" ? <Guide cat={cat} members={members} /> : <TeamChannel value={cat.channel} onDone={reload} />;
}

// はじめての設定(済んだものに ✓)
function Guide({ cat, members }: { cat: Awaited<ReturnType<typeof libraryCatalog>>; members: number }) {
  const sets = useServerFn(listSets);
  const [setCount, setSetCount] = useState<number | null>(null);
  useEffect(() => { sets().then((s) => setSetCount(s.length), () => setSetCount(0)); }, []);
  const steps = [
    { done: cat.servers.length > 0, label: "サーバーをつなぐ(Pterodactyl パネル・フォルダ)", to: "/servers" as const },
    { done: cat.servers.length > 0 && cat.servers.every((s) => s.type), label: "サーバーの種類(Paper・Fabric など)を選ぶ", to: "/servers" as const },
    { done: cat.items.length > 0, label: "ライブラリに Mod・プラグインを足す", to: null, add: true },
    { done: (setCount ?? 0) > 0, label: "セットを作って、まとめて入れる", to: "/sets" as const },
    { done: members > 1, label: "チームの人を招待する", to: "/team" as const },
  ];
  if (setCount === null) return null;
  return (
    <section className="group">
      {steps.map((s) => (
        <div className="row" key={s.label}>
          <span className={s.done ? "badge ok" : "badge upd"}>{s.done ? "済み" : "まだ"}</span>
          <span className="mid"><span className={s.done ? "sub" : "ttl"}>{s.label}</span></span>
          {!s.done && s.to && <Link to={s.to} className="btn tint sm">開く</Link>}
          {!s.done && "add" in s && <Btn kind="tint" sm onClick={() => window.dispatchEvent(new Event(OPEN_ADD))}>開く</Btn>}
        </div>
      ))}
    </section>
  );
}

// 受け取る版のチームの既定
function TeamChannel({ value, onDone }: { value: Channel; onDone: () => void }) {
  const save = useServerFn(setLibraryChannel);
  const [error, setError] = useState("");
  const change = (channel: string) => save({ data: { channel } }).then(() => { setError(""); onDone(); }, (e) => setError(e instanceof Error ? e.message : "うまくいきませんでした"));
  return (
    <section className="group">
      <label className="row">
        <span>チームの既定</span>
        <select className="trail" value={value} aria-label="受け取る版のチームの既定" onChange={(e) => change(e.target.value)}>
          {(Object.keys(CHANNELS) as Channel[]).map((c) => <option key={c} value={c}>{CHANNELS[c]}</option>)}
        </select>
      </label>
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}
