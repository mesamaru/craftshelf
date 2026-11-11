// 個人の設定(アカウントごと。どの端末でも同じ): 見た目と背景画像(03.63.00 から。前はブラウザごとに置いていた)と、ホームのウィジェットの並び(03.69.00 から)
import { eq, sql } from "drizzle-orm";
import { type DashLayout, cleanDash } from "~/lib/dash";
import { BACKGROUND_MAX_BYTES, BACKGROUND_URL, type SavedTheme, cleanTheme } from "~/lib/theme";
import { userPref } from "./db/schema";
import { HttpError, requireUser } from "./guard";
import type { Deps } from "./servers";

// 背景画像の上限(画面で長い辺 1920 px までの JPEG に縮めてから送る。縮めても超えるものは断る)
export const PREF_LIMITS = { backgroundBytes: BACKGROUND_MAX_BYTES };
const DATA_URL = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

/** 中身の先頭で画像の種類を見る(書いてある種類は信用しない。SVG は受け付けない) */
export function imageType(b: Uint8Array): "jpeg" | "png" | "webp" | "gif" | null {
  const head = Buffer.from(b.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (head.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "jpeg";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (["GIF87a", "GIF89a"].includes(head.subarray(0, 6).toString("latin1"))) return "gif";
  return null;
}

/** 画像のバイト列を、保存する形(data URL)にする。画像でない・大きすぎるものは HttpError */
export function backgroundOf(data: Uint8Array) {
  const type = imageType(data);
  if (!type) throw new HttpError(400, "PNG・JPEG・WebP・GIF の画像を選んでください");
  if (data.byteLength > PREF_LIMITS.backgroundBytes) throw new HttpError(400, `背景画像が大きすぎます(縮めても ${PREF_LIMITS.backgroundBytes / 1024 / 1024} MB を超えます)。小さい画像を選んでください`);
  return `data:image/${type};base64,${Buffer.from(data).toString("base64")}`;
}

export function prefService(deps: Pick<Deps, "db" | "auth">) {
  const { db, auth } = deps;
  // 見た目・背景・ウィジェットの並びを 1 回で読む(背景画像の中身(最大 2 MB)は読まず、あるかだけ)
  const rowOf = async (userId: string) => (await db.select({ theme: userPref.theme, at: userPref.backgroundAt, has: sql<boolean>`coalesce(${userPref.background} <> '', false)`, dash: userPref.dash })
    .from(userPref).where(eq(userPref.userId, userId)))[0];
  type Row = Awaited<ReturnType<typeof rowOf>>;
  const themeOf = (r: Row): SavedTheme | null => {
    if (!r?.theme) return null;
    try {
      return cleanTheme(JSON.parse(r.theme));
    } catch {
      return null;
    }
  };
  const bgOf = (r: Row) => (!r?.at ? null : r.has ? `${BACKGROUND_URL}?v=${r.at.getTime()}` : "");
  const dashOf = (r: Row): DashLayout | null => {
    if (!r?.dash) return null;
    try {
      return cleanDash(JSON.parse(r.dash));
    } catch {
      return null;
    }
  };
  const session = async (headers: Headers) => {
    const s = await requireUser(auth, headers);
    if (s.apiKey) throw new HttpError(403, "見た目は、ログインしてから変えてください");
    return s;
  };

  return {
    /** 保存した見た目(まだ無ければ null) */
    async theme(userId: string): Promise<SavedTheme | null> {
      return themeOf(await rowOf(userId));
    },

    /** 見た目・背景画像の場所・ホームのウィジェットの並びを、まとめて 1 回で(getAppState 用。個別に読むのと同じ値) */
    async appState(userId: string) {
      const r = await rowOf(userId);
      return { theme: themeOf(r), dash: dashOf(r), background: bgOf(r) };
    },

    /**
     * 背景画像の場所(変えた時刻を付けるので、変えるまで画面はキャッシュを使える)。"" = 外した、null = まだ一度も決めていない
     * (画面は null のときだけ、前にブラウザに置いた背景画像をアカウントに移す)
     */
    async backgroundUrl(userId: string): Promise<string | null> {
      return bgOf(await rowOf(userId));
    },

    /** 背景画像(ログインしている本人のもの。無ければ null) */
    async background(headers: Headers) {
      const s = await requireUser(auth, headers);
      const [r] = await db.select({ bg: userPref.background }).from(userPref).where(eq(userPref.userId, s.user.id));
      const m = r?.bg?.match(DATA_URL);
      return m ? { type: `image/${m[1]}`, data: Buffer.from(m[2], "base64") } : null;
    },

    /** ホームのウィジェットの並び(まだ決めていなければ null。画面は既定の並びを使う) */
    async dash(userId: string): Promise<DashLayout | null> {
      return dashOf(await rowOf(userId));
    },

    /** ホームのウィジェットの並びを保存する(ログインしている本人だけ。知らないもの・長すぎるものは落として、そろえた形を返す) */
    async setDash(headers: Headers, layout: unknown): Promise<DashLayout> {
      const s = await session(headers);
      const dash = cleanDash(layout);
      const values = { userId: s.user.id, dash: JSON.stringify(dash), updatedAt: new Date() };
      await db.insert(userPref).values(values).onConflictDoUpdate({ target: userPref.userId, set: values });
      return dash;
    },

    /** 見た目を保存する(ログインしている本人だけ。API トークンでは変えない) */
    async setTheme(headers: Headers, theme: unknown) {
      const s = await session(headers);
      const t = cleanTheme(theme);
      const values = { userId: s.user.id, theme: JSON.stringify(t), updatedAt: new Date() };
      await db.insert(userPref).values(values).onConflictDoUpdate({ target: userPref.userId, set: values });
      return t;
    },

    /** 背景画像を決める(data URL。null なら外す)。画像の中身・大きさを確かめる。返すのは新しい場所 */
    async setBackground(headers: Headers, dataUrl: string | null) {
      const s = await session(headers);
      let background: string | null = null;
      if (dataUrl !== null) {
        const m = String(dataUrl).match(DATA_URL);
        if (!m) throw new HttpError(400, "PNG・JPEG・WebP・GIF の画像を選んでください");
        background = backgroundOf(Buffer.from(m[2], "base64"));
      }
      const now = new Date();
      await db.insert(userPref).values({ userId: s.user.id, background, backgroundAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: userPref.userId, set: { background, backgroundAt: now, updatedAt: now } });
      return background ? `${BACKGROUND_URL}?v=${now.getTime()}` : "";
    },
  };
}
