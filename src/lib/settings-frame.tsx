// 設定の 2 段の形: 左にまとまり(アカウント・チーム・パネル)、右に中身。スマホは一覧から押して入り、中身の上に「‹ 設定」。使い方は docs/UI.md
import type { ReactNode } from "react";
import { Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { authClient } from "./auth-client";
import { Info } from "./ui";
import { useCan } from "./use-can";

export type SettingsKey =
  | "profile" | "security" | "passkeys" | "look"
  | "members" | "perms" | "activity" | "storage" | "shares" | "tokens" | "curseforge" | "setup" | "channel"
  | "backup" | "versions" | "usage" | "telemetry" | "api" | "import" | "feedback";

type Entry = { key: SettingsKey; label: string; to: string; s?: string; show: boolean };
type Ctx = { user?: { id: string } | null; app: { mode: "self" | "service" } };

// 権限で使えないものは出さない(本当の確認はそれぞれの画面のサーバー側の処理で行う)
function useGroups(ctx: Ctx): [string, Entry[]][] {
  const { can } = useCan(ctx.user?.id ?? "");
  const self = ctx.app.mode === "self";
  const admin = can({ member: ["update"] });
  const panel = self && can({ panel: ["manage"] });
  const groups: [string, Entry[]][] = [
    ["アカウント", [
      { key: "profile", label: "プロフィール", to: "/settings", s: "profile", show: true },
      { key: "security", label: "パスワードと二段階認証", to: "/settings", s: "security", show: true },
      { key: "passkeys", label: "パスキー", to: "/settings", s: "passkeys", show: true },
      { key: "look", label: "見た目と言語", to: "/settings", s: "look", show: true },
    ]],
    ["チーム", [
      { key: "members", label: "メンバー", to: "/team", show: true },
      { key: "perms", label: "権限と割り当て", to: "/team", s: "perms", show: admin },
      { key: "activity", label: "記録と通知(Discord)", to: "/activity", show: can({ audit: ["read"] }) || can({ integrations: ["manage"] }) },
      { key: "storage", label: "保存先", to: "/storage", show: self && can({ storage: ["manage"] }) },
      { key: "shares", label: "共有リンク", to: "/shares", show: self },
      { key: "tokens", label: "API トークン", to: "/settings", s: "tokens", show: true },
      { key: "curseforge", label: "連携(CurseForge)", to: "/team", s: "curseforge", show: self && can({ integrations: ["manage"] }) },
      { key: "setup", label: "はじめての設定", to: "/team", s: "setup", show: admin },
      { key: "channel", label: "受け取る版", to: "/team", s: "channel", show: admin },
    ]],
    ["パネル", [
      { key: "backup", label: "バックアップ", to: "/backup", show: self && admin },
      { key: "versions", label: "パネルのバージョン", to: "/settings", s: "versions", show: panel },
      { key: "usage", label: "利用状況", to: "/usage", show: admin },
      { key: "telemetry", label: "開発者への送信", to: "/settings", s: "telemetry", show: panel },
      { key: "api", label: "API の説明", to: "/api-docs", show: true },
      { key: "import", label: "v02 からの取り込み", to: "/settings", s: "import", show: self && admin },
      { key: "feedback", label: "お問い合わせ", to: "/settings", s: "feedback", show: true },
    ]],
  ];
  return groups.map(([g, list]) => [g, list.filter((e) => e.show)]);
}

/** 設定の画面の枠。at = 開いているまとまり、root = スマホで一覧を出す(/settings を何も選ばずに開いたとき)、info = 見出しの ⓘ */
export function SettingsFrame({ at, root, info, children }: { at: SettingsKey; root?: boolean; info?: ReactNode; children: ReactNode }) {
  const ctx = useRouteContext({ strict: false }) as Ctx;
  const router = useRouter();
  const groups = useGroups(ctx);
  // ログインしていない(API の説明だけは開ける)ときは枠なし
  if (!ctx.user) return <main className="page narrow">{children}</main>;
  const label = groups.flatMap(([, l]) => l).find((e) => e.key === at)?.label ?? "";
  const logout = async () => {
    await authClient.signOut();
    await router.invalidate();
    await router.navigate({ to: "/login" });
  };
  return (
    <main className={`page fill settings${root ? " at-root" : ""}`}>
      <header className="bar"><h1>設定</h1></header>
      <div className="split">
        <nav className="set-nav" aria-label="設定の一覧">
          {groups.map(([g, list]) => list.length > 0 && (
            <div key={g}>
              <div className="gtitle">{g}</div>
              <section className="group">
                {list.map((e) => (
                  <Link key={e.key} to={e.to as "/settings"} search={(e.s ? { s: e.s } : {}) as never} activeOptions={{ exact: true, includeSearch: true }} className="row click" aria-current={e.key === at ? "page" : undefined}>
                    <span className="mid"><span className="ttl">{e.label}</span></span><span className="chev" aria-hidden="true">›</span>
                  </Link>
                ))}
              </section>
            </div>
          ))}
          <section className="group spaced">
            <button type="button" className="row click" onClick={logout}><span className="mid"><span className="ttl danger">ログアウト</span></span></button>
          </section>
        </nav>
        <div className="set-body">
          <Link to="/settings" className="back">‹ 設定</Link>
          {label && <h2 className="set-title">{label}{info && <Info>{info}</Info>}</h2>}
          {children}
        </div>
      </div>
    </main>
  );
}

