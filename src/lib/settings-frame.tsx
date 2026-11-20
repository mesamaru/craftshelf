// 設定の 2 段の形: 左にまとまり(自分・チーム・ライブラリ・パネル・サポート)、右に中身。スマホは一覧から押して入り、中身の上に「‹ 設定」。使い方は docs/UI.md
import { type ReactNode, useEffect } from "react";
import { Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { authClient } from "./auth-client";
import { roleLabel } from "./permissions";
import { SETTING_LABEL, type SettingsKey } from "./titles";
import { Icon, type IconName, Info } from "./ui";
import { useCan } from "./use-can";

export type { SettingsKey };

type Entry = { key: SettingsKey; label: string; to: string; s?: string; show: boolean; icon: IconName; color: string };
type Ctx = { user?: { id: string; name?: string } | null; app: { mode: "self" | "service" } };

// 色つきの四角は v02 の設定(歯車)に合わせた(03.69.00)。分け方は 03.88.00 から、だれに効くか(自分・チーム・ライブラリ・パネル)で。権限で使えないものは出さない(本当の確認はそれぞれの画面のサーバー側の処理で行う)
function useGroups(ctx: Ctx): [string, Entry[]][] {
  const { can } = useCan(ctx.user?.id ?? "");
  const self = ctx.app.mode === "self";
  const admin = can({ member: ["update"] });
  const panel = self && can({ panel: ["manage"] });
  const e = (key: SettingsKey, label: string, icon: IconName, color: string, to: string, show: boolean, s?: string): Entry => ({ key, label, icon, color, to, s, show });
  // だれに効くかで分ける: 自分(アカウント)・チーム・ライブラリ・パネル全体(自分で動かす CraftShelf)・サポート
  const groups: [string, Entry[]][] = [
    ["自分", [
      e("security", SETTING_LABEL.security, "key", "c-other", "/settings", true, "security"),
      e("passkeys", SETTING_LABEL.passkeys, "shield", "c-mod", "/settings", true, "passkeys"),
      e("look", SETTING_LABEL.look, "sparkle", "c-resourcepack", "/settings", true, "look"),
      e("tokens", SETTING_LABEL.tokens, "link", "c-plugin", "/settings", true, "tokens"),
    ]],
    ["チーム", [
      e("members", SETTING_LABEL.members, "team", "c-resourcepack", "/team", true),
      e("perms", SETTING_LABEL.perms, "shield", "c-other", "/team", admin, "perms"),
      e("activity", SETTING_LABEL.activity, "bell", "c-plugin", "/activity", can({ audit: ["read"] }) || can({ integrations: ["manage"] })),
      e("usage", SETTING_LABEL.usage, "chart", "c-teal", "/usage", admin),
      e("setup", SETTING_LABEL.setup, "check", "c-teal", "/team", admin, "setup"),
    ]],
    ["ライブラリ", [
      e("storage", SETTING_LABEL.storage, "servers", "c-plugin", "/storage", self && can({ storage: ["manage"] })),
      e("channel", SETTING_LABEL.channel, "clock", "c-datapack", "/team", admin, "channel"),
      e("curseforge", SETTING_LABEL.curseforge, "key", "c-other", "/team", self && can({ integrations: ["manage"] }), "curseforge"),
      e("shares", SETTING_LABEL.shares, "share", "c-teal", "/shares", self && can({ library: ["edit"] })),
      e("cleanup", SETTING_LABEL.cleanup, "wand", "c-mod", "/cleanup", can({ library: ["edit"] })),
    ]],
    ["パネル", [
      e("backup", SETTING_LABEL.backup, "download", "c-mod", "/backup", self && admin),
      e("versions", SETTING_LABEL.versions, "reload", "c-mod", "/settings", panel, "versions"),
      e("telemetry", SETTING_LABEL.telemetry, "chart", "c-other", "/settings", panel, "telemetry"),
    ]],
    ["サポート", [
      e("feedback", SETTING_LABEL.feedback, "chat", "c-teal", "/settings", true, "feedback"),
      e("api", SETTING_LABEL.api, "file", "c-other", "/api-docs", true),
    ]],
  ];
  return groups.map(([g, list]) => [g, list.filter((x) => x.show)]);
}

/** 設定の画面の枠。at = 開いているまとまり、root = スマホで一覧を出す(/settings を何も選ばずに開いたとき)、info = 見出しの ⓘ */
export function SettingsFrame({ at, root, info, children }: { at: SettingsKey; root?: boolean; info?: ReactNode; children: ReactNode }) {
  // 開いたまとまりの行を、左の一覧の見えるところへ(一覧が長いと、下のほうの行が隠れたままになるため)
  useEffect(() => { document.querySelector(".set-nav [aria-current='page']")?.scrollIntoView({ block: "nearest" }); }, [at]);
  const ctx = useRouteContext({ strict: false }) as Ctx;
  const router = useRouter();
  const groups = useGroups(ctx);
  const { me } = useCan(ctx.user?.id ?? "");
  // ログインしていない(API の説明だけは開ける)ときは枠なし
  if (!ctx.user) return <main className="page narrow">{children}</main>;
  const label = SETTING_LABEL[at];
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
          <section className="group">
            <Link to="/settings" search={{ s: "profile" } as never} activeOptions={{ exact: true, includeSearch: true }} className="row click account-row" aria-current={at === "profile" ? "page" : undefined}>
              <span className="av" aria-hidden="true" translate="no">{(ctx.user.name ?? "?").slice(0, 1).toUpperCase()}</span>
              <span className="mid"><span className="ttl" translate="no">{ctx.user.name}</span><span className="sub">{me ? `${roleLabel(me.role)} · アカウント` : "アカウント"}</span></span>
              <span className="chev" aria-hidden="true">›</span>
            </Link>
          </section>
          {groups.map(([g, list]) => list.length > 0 && (
            <div key={g}>
              <div className="gtitle">{g}</div>
              <section className="group">
                {list.map((e) => (
                  <Link key={e.key} to={e.to as "/settings"} search={(e.s ? { s: e.s } : {}) as never} activeOptions={{ exact: true, includeSearch: true }} className="row click" aria-current={e.key === at ? "page" : undefined}>
                    <span className={`cicon ${e.color}`} aria-hidden="true"><Icon name={e.icon} /></span>
                    <span className="mid"><span className="ttl">{e.label}</span></span><span className="chev" aria-hidden="true">›</span>
                  </Link>
                ))}
              </section>
            </div>
          ))}
          <section className="group spaced">
            <button type="button" className="row click" onClick={logout}><span className="cicon c-red" aria-hidden="true"><Icon name="logout" /></span><span className="mid"><span className="ttl danger">ログアウト</span></span></button>
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
