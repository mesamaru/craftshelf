// メンバーごとの権限・チームのオーナーを譲る・チームを消す・アカウントを消す・メンバーの二段階認証を外す。チームとアカウントを消すのはサービス版だけ
// (自分用の版はチームが 1 つで、そこに全員がいるため)
import { verifyPassword } from "better-auth/crypto";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { GRANTS, GRANT_LABELS, isGrant, permsOf } from "~/lib/permissions";
import { account, legacyTotp, member, memberPerm, organization, passkey, session, teamOption, twoFactor, user as userTable } from "./db/schema";
import { eventService } from "./events";
import { HttpError, jsonList, memberPerms, requireTeam, requireUser } from "./guard";
import type { Deps } from "./servers";

const isOwner = (role: string | null | undefined) => !!role && role.split(",").includes("owner");

export function teamService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  const roleOf = async (teamId: string, userId: string) =>
    (await db.select({ role: member.role }).from(member).where(and(eq(member.organizationId, teamId), eq(member.userId, userId))))[0]?.role ?? null;
  const editorFilesOf = async (teamId: string) =>
    (await db.select({ on: teamOption.editorFiles }).from(teamOption).where(eq(teamOption.teamId, teamId)))[0]?.on ?? false;

  return {
    /** 自分の、選んでいるチームでの権限("種類:操作" の一覧。画面でボタンを出すか決める) */
    async myPerms(headers: Headers) {
      const { teamId, user } = await requireTeam(auth, headers);
      return { perms: [...((await memberPerms(auth, teamId, user.id)) ?? [])].sort() };
    },

    /** メンバーごとの権限(管理者以上): 役割だけのときの権限・足したもの・引いたもの・今の権限(足し引きできるものだけ) */
    async memberGrants(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers, { member: ["update"] });
      const rows = await db.select({ userId: member.userId, role: member.role, allow: memberPerm.allow, deny: memberPerm.deny }).from(member)
        .leftJoin(memberPerm, eq(memberPerm.memberId, member.id)).where(eq(member.organizationId, teamId));
      const editors = await editorFilesOf(teamId);
      return rows.map((r) => {
        const base = permsOf(r.role, { editorFiles: editors });
        const now = permsOf(r.role, { allow: jsonList(r.allow), deny: jsonList(r.deny), editorFiles: editors });
        return { userId: r.userId, owner: isOwner(r.role), base: GRANTS.filter((g) => base.has(g)), perms: GRANTS.filter((g) => now.has(g)) };
      });
    },

    /**
     * メンバーの権限を決める(管理者以上。ログインしてから)。perms は、足し引きできるもの(GRANTS)のうち持たせるもの。
     * 役割(とチームの設定)より多いものを足し、少ないものを引いて覚える。オーナーと自分は変えられない
     */
    async setMemberGrants(headers: Headers, userId: string, perms: string[]) {
      const { teamId, user, apiKey } = await requireTeam(auth, headers, { member: ["update"] });
      if (apiKey) throw new HttpError(403, "この操作は、ログインしてから行ってください");
      if (userId === user.id) throw new HttpError(400, "自分の権限は変えられません");
      if (!Array.isArray(perms) || !perms.every(isGrant)) throw new HttpError(400, "権限の指定が正しくありません");
      const [m] = await db.select({ id: member.id, role: member.role }).from(member).where(and(eq(member.organizationId, teamId), eq(member.userId, userId)));
      if (!m) throw new HttpError(404, "メンバーが見つかりません");
      if (isOwner(m.role)) throw new HttpError(403, "オーナーの権限は減らせません");
      const base = permsOf(m.role, { editorFiles: await editorFilesOf(teamId) });
      const want = new Set(perms);
      const allow = GRANTS.filter((g) => want.has(g) && !base.has(g));
      const deny = GRANTS.filter((g) => !want.has(g) && base.has(g));
      const values = { memberId: m.id, allow: JSON.stringify(allow), deny: JSON.stringify(deny), updatedAt: new Date() };
      await db.insert(memberPerm).values(values).onConflictDoUpdate({ target: memberPerm.memberId, set: values });
      const [to] = await db.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, userId));
      await record({ teamId, userId: user.id, kind: "admin", action: "メンバーの権限を変える", target: to?.name ?? "",
        detail: [...allow.map((g) => `+ ${GRANT_LABELS[g]}`), ...deny.map((g) => `− ${GRANT_LABELS[g]}`)].join("\n") || "役割のとおり" });
      return { allow, deny };
    },

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
     * メンバーの二段階認証を外す・パスキーをすべて消す(本人が端末をなくしたとき)。自分用の版の管理者以上だけ。
     * サービス版では出さない: アカウントはほかのチームと共有なので、1 つのチームのオーナーが、ほかのチームでも使う
     * ログインの守りを外せてしまう(本人の予備のコード・パスワードの再設定に任せる)。
     * オーナーは対象にしない(役割の変更と同じ決まり)。なくした端末に残ったログインも切る
     */
    async resetSignIn(headers: Headers, userId: string, what: "twoFactor" | "passkeys") {
      const { teamId, user, apiKey } = await requireTeam(auth, headers, { member: ["update"] });
      if (apiKey) throw new HttpError(403, "この操作は、ログインしてから行ってください");
      if (!deps.local) throw new HttpError(400, "サービス版では、本人が予備のコードかパスワードの再設定で設定し直してください");
      if (userId === user.id) throw new HttpError(400, "自分の設定は「アカウント」で変えてください");
      const role = await roleOf(teamId, userId);
      if (role === null) throw new HttpError(404, "メンバーが見つかりません");
      if (isOwner(role)) throw new HttpError(403, "オーナーの設定は変えられません");
      const [to] = await db.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, userId));
      const removed = await db.transaction(async (tx) => {
        let n = 0;
        if (what === "twoFactor") {
          n = (await tx.delete(twoFactor).where(eq(twoFactor.userId, userId)).returning({ id: twoFactor.id })).length;
          n += (await tx.delete(legacyTotp).where(eq(legacyTotp.userId, userId)).returning({ id: legacyTotp.userId })).length;
          await tx.update(userTable).set({ twoFactorEnabled: false }).where(eq(userTable.id, userId));
        } else {
          n = (await tx.delete(passkey).where(eq(passkey.userId, userId)).returning({ id: passkey.id })).length;
        }
        if (n) await tx.delete(session).where(eq(session.userId, userId));
        return n;
      });
      await record({
        teamId, userId: user.id, kind: "admin", action: what === "twoFactor" ? "二段階認証を外す" : "パスキーをすべて消す",
        target: to?.name ?? "", detail: what === "passkeys" ? `${removed} 個` : removed ? "" : "設定なし",
      });
      return { removed };
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
