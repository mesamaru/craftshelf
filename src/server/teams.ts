// チームのオーナーを譲る・チームを消す・アカウントを消す。チームとアカウントを消すのはサービス版だけ
// (自分用の版はチームが 1 つで、そこに全員がいるため)
import { verifyPassword } from "better-auth/crypto";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { account, member, organization, session, user as userTable } from "./db/schema";
import { eventService } from "./events";
import { HttpError, requireTeam, requireUser } from "./guard";
import type { Deps } from "./servers";

const isOwner = (role: string | null | undefined) => !!role && role.split(",").includes("owner");

export function teamService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  const roleOf = async (teamId: string, userId: string) =>
    (await db.select({ role: member.role }).from(member).where(and(eq(member.organizationId, teamId), eq(member.userId, userId))))[0]?.role ?? null;

  return {
    /** オーナーを譲る(オーナーだけ)。譲った人は管理者になる */
    async transferOwner(headers: Headers, toUserId: string) {
      const { teamId, user, apiKey } = await requireTeam(auth, headers);
      if (apiKey) throw new HttpError(403, "この操作は、ログインしてから行ってください");
      if (!isOwner(await roleOf(teamId, user.id))) throw new HttpError(403, "オーナーを譲れるのは、オーナーだけです");
      if (toUserId === user.id) throw new HttpError(400, "ほかのメンバーを選んでください");
      if ((await roleOf(teamId, toUserId)) === null) throw new HttpError(404, "メンバーが見つかりません");
      const [to] = await db.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, toUserId));
      await db.transaction(async (tx) => {
        await tx.update(member).set({ role: "owner" }).where(and(eq(member.organizationId, teamId), eq(member.userId, toUserId)));
        await tx.update(member).set({ role: "admin" }).where(and(eq(member.organizationId, teamId), eq(member.userId, user.id)));
      });
      await record({ teamId, userId: user.id, kind: "admin", action: "オーナーを譲る", target: to?.name ?? "" });
    },

    /** チームを消す(サービス版・オーナーだけ)。確かめのため、チームの名前をそのまま入力してもらう。サーバー・ライブラリなども一緒に消える */
    async deleteTeam(headers: Headers, confirmName: string) {
      const { teamId, user, apiKey } = await requireTeam(auth, headers);
      if (apiKey) throw new HttpError(403, "この操作は、ログインしてから行ってください");
      if (deps.local) throw new HttpError(400, "自分用の版では、チームは消せません");
      if (!isOwner(await roleOf(teamId, user.id))) throw new HttpError(403, "チームを消せるのは、オーナーだけです");
      const [org] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, teamId));
      if (!org || confirmName.trim() !== org.name) throw new HttpError(400, "確かめのため、チームの名前をそのまま入力してください");
      await db.delete(organization).where(eq(organization.id, teamId)); // チームのものは、外部キーでまとめて消える
      await db.update(session).set({ activeOrganizationId: null }).where(eq(session.activeOrganizationId, teamId));
      // 自分のほかのチームがあれば、それを選んだ状態にする
      const [next] = await db.select({ id: member.organizationId }).from(member).where(eq(member.userId, user.id)).orderBy(asc(member.createdAt)).limit(1);
      if (next) await db.update(session).set({ activeOrganizationId: next.id }).where(and(eq(session.userId, user.id)));
      return { next: next?.id ?? null };
    },

    /**
     * アカウントを消す(サービス版・パスワードで確かめる)。ほかのメンバーがいるチームのオーナーのあいだは消せない。
     * 自分だけのチームは一緒に消す
     */
    async deleteAccount(headers: Headers, password: string) {
      const s = await requireUser(auth, headers);
      if (s.apiKey) throw new HttpError(403, "この操作は、ログインしてから行ってください");
      if (deps.local) throw new HttpError(400, "自分用の版では、アカウントは消せません(管理者にチームから外してもらってください)");
      const me = s.user.id;
      const [acc] = await db.select({ password: account.password }).from(account).where(and(eq(account.userId, me), eq(account.providerId, "credential")));
      if (!acc?.password || !(await verifyPassword({ hash: acc.password, password: String(password ?? "") }))) throw new HttpError(400, "パスワードが違います");
      const mine = await db.select({ teamId: member.organizationId, role: member.role, name: organization.name })
        .from(member).innerJoin(organization, eq(member.organizationId, organization.id)).where(eq(member.userId, me));
      const alone: string[] = [];
      for (const m of mine) {
        const [{ n }] = await db.select({ n: count() }).from(member).where(eq(member.organizationId, m.teamId));
        if (n <= 1) alone.push(m.teamId);
        else if (isOwner(m.role)) throw new HttpError(400, `チーム「${m.name}」には、ほかのメンバーがいます。先にオーナーを譲るか、チームを消してください`);
      }
      await db.transaction(async (tx) => {
        if (alone.length) await tx.delete(organization).where(inArray(organization.id, alone));
        await tx.delete(userTable).where(eq(userTable.id, me)); // セッション・メンバー・API トークンなども外部キーで消える
      });
    },
  };
}
