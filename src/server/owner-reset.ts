// オーナーのログインを戻す(自分用の版。端末も予備のコードもなくして、パネルの中では戻せないとき)。
// サーバーの上で `node launcher.mjs reset-owner <メールアドレスか名前>` を動かすと、/data/v03/reset-owner.json に頼みごとを置く。
// 動いているパネルが数秒ごとにそれを見つけて、その人の二段階認証とパスキーを外し、パスワードを置き換え、ほかのログインを切る。
// データの置き場所に書ける人(= サーバーに入れる人)だけが使える。結果は reset-owner-result.json に書き、操作の記録にも残す
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { and, eq, or } from "drizzle-orm";
import type { Db } from "./db";
import { account, legacyTotp, member, passkey, session, twoFactor, user } from "./db/schema";
import type { EventInput } from "./events";

export const RESET_FILE = "reset-owner.json";
export const RESET_RESULT = "reset-owner-result.json";
const STALE_MS = 10 * 60_000; // 古い頼みごとは使わない(置いたまま忘れたもの)

export type ResetResult = { ok: boolean; at: string; user?: string; error?: string };

/** その人の二段階認証・パスキーを外し、パスワードを置き換えて、ログインを全部切る。見つからない・同じ名前が複数なら投げる */
export async function resetLogin(db: Db, login: string, password: string) {
  const key = login.trim();
  if (!key) throw new Error("メールアドレスか名前を指定してください");
  if (password.length < 10 || password.length > 128) throw new Error("パスワードは 10〜128 文字にしてください");
  const found = await db.select({ id: user.id, name: user.name }).from(user)
    .where(or(eq(user.email, key.toLowerCase()), eq(user.username, key.toLowerCase()), eq(user.name, key)));
  if (!found.length) throw new Error(`「${key}」という利用者が見つかりません`);
  if (found.length > 1) throw new Error(`「${key}」に当たる利用者が ${found.length} 人います。メールアドレスで指定してください`);
  const [u] = found;
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const done = await tx.update(account).set({ password: hash, updatedAt: new Date() })
      .where(and(eq(account.userId, u.id), eq(account.providerId, "credential"))).returning({ id: account.id });
    if (!done.length) await tx.insert(account).values({ id: randomUUID(), accountId: u.id, providerId: "credential", userId: u.id, password: hash, createdAt: new Date(), updatedAt: new Date() });
    await tx.delete(twoFactor).where(eq(twoFactor.userId, u.id));
    await tx.delete(legacyTotp).where(eq(legacyTotp.userId, u.id));
    await tx.delete(passkey).where(eq(passkey.userId, u.id));
    await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, u.id));
    await tx.delete(session).where(eq(session.userId, u.id));
  });
  return u;
}

/** 置いてある頼みごとを片付ける(無ければ何もしない)。頼みごとのファイルはすぐ消す(パスワードを残さない) */
export async function applyOwnerReset(db: Db, v03Dir: string, record: (e: EventInput) => Promise<unknown>, now = new Date()): Promise<ResetResult | null> {
  const file = join(v03Dir, RESET_FILE);
  if (!existsSync(file)) return null;
  let req: { login?: unknown; password?: unknown; at?: unknown } = {};
  try {
    req = JSON.parse(readFileSync(file, "utf8"));
  } catch { /* 下で断る */ }
  rmSync(file, { force: true });
  let result: ResetResult;
  try {
    const at = Date.parse(String(req.at ?? ""));
    if (!Number.isFinite(at) || now.getTime() - at > STALE_MS) throw new Error("頼みごとが古すぎるか、読めません。もう一度コマンドを動かしてください");
    const u = await resetLogin(db, String(req.login ?? ""), String(req.password ?? ""));
    for (const { teamId } of await db.select({ teamId: member.organizationId }).from(member).where(eq(member.userId, u.id))) {
      await record({ teamId, userId: null, kind: "admin", action: "サーバーの上でログインを戻す", target: u.name, detail: "二段階認証とパスキーを外し、パスワードを置き換えました(サーバーのコマンドから)" });
    }
    result = { ok: true, at: now.toISOString(), user: u.name };
  } catch (e) {
    result = { ok: false, at: now.toISOString(), error: e instanceof Error ? e.message : String(e) };
  }
  writeFileSync(join(v03Dir, RESET_RESULT), JSON.stringify(result) + "\n", { mode: 0o600 });
  return result;
}
