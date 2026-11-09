// 個人の設定(アカウントごと。どの端末でも同じ): いまは見た目だけ(背景画像はブラウザごとなので、ここには置かない)
import { eq } from "drizzle-orm";
import { type SavedTheme, cleanTheme } from "~/lib/theme";
import { userPref } from "./db/schema";
import { HttpError, requireUser } from "./guard";
import type { Deps } from "./servers";

export function prefService(deps: Pick<Deps, "db" | "auth">) {
  const { db, auth } = deps;
  return {
    /** 保存した見た目(まだ無ければ null) */
    async theme(userId: string): Promise<SavedTheme | null> {
      const [r] = await db.select({ theme: userPref.theme }).from(userPref).where(eq(userPref.userId, userId));
      if (!r?.theme) return null;
      try {
        return cleanTheme(JSON.parse(r.theme));
      } catch {
        return null;
      }
    },

    /** 見た目を保存する(ログインしている本人だけ。API トークンでは変えない) */
    async setTheme(headers: Headers, theme: unknown) {
      const s = await requireUser(auth, headers);
      if (s.apiKey) throw new HttpError(403, "見た目は、ログインしてから変えてください");
      const t = cleanTheme(theme);
      const values = { userId: s.user.id, theme: JSON.stringify(t), updatedAt: new Date() };
      await db.insert(userPref).values(values).onConflictDoUpdate({ target: userPref.userId, set: values });
      return t;
    },
  };
}
