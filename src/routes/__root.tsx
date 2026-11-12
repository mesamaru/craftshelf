import { type ReactNode, useEffect } from "react";
import { getLang, startEnglish } from "~/lib/i18n";
import { DialogHost } from "~/lib/dialogs";
import { Palette } from "~/lib/palette";
import { DEFAULT_THEME, type SavedTheme, applyTheme, localTheme, saveTheme } from "~/lib/theme";
import { saveMyBackground, saveMyTheme } from "~/lib/prefs-api";
import { HeadContent, Outlet, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router";
import { Shell, showShell } from "~/lib/shell";
import { loadAppState } from "~/lib/session";
import appCss from "~/styles.css?url";

export const Route = createRootRoute({
  beforeLoad: async () => loadAppState(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#f2f2f7", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#000000", media: "(prefers-color-scheme: dark)" },
      { title: "CraftShelf" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // ホーム画面に追加(PWA)
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  component: () => (
    <RootDocument>
      <Outlet />
    </RootDocument>
  ),
});

// 見た目: アカウントに保存したもの(背景画像も)を使う。アカウントにまだ無ければ、このブラウザの値を使い、アカウントにも保存する
// (03.62 まではブラウザに置いていた背景画像も、アカウントで一度も決めていなければ移す)
function useTheme(user: { theme?: SavedTheme | null; background?: string | null } | null | undefined) {
  const saved = user?.theme ? JSON.stringify(user.theme) : "";
  const bg = user ? user.background ?? null : undefined;
  useEffect(() => {
    const local = localTheme();
    const localBg = local?.background ?? "";
    if (bg === null && localBg.startsWith("data:")) saveMyBackground({ data: { image: localBg } }).catch(() => {});
    const background = typeof bg === "string" ? bg : localBg;
    if (saved) {
      const t = { ...(JSON.parse(saved) as SavedTheme), background };
      try {
        saveTheme(t);
      } catch {
        applyTheme(t);
      }
    } else {
      applyTheme({ ...(local ?? DEFAULT_THEME), background });
      if (user && local) saveMyTheme({ data: local }).catch(() => {});
    }
  }, [saved, bg, !!user]);
}

function RootDocument({ children }: { children: ReactNode }) {
  const ctx = Route.useRouteContext() as { user?: { id: string; name: string; theme?: SavedTheme | null; background?: string | null } | null };
  const path = useRouterState({ select: (s) => s.location.pathname });
  useTheme(ctx.user);
  useEffect(() => {
    if (getLang() === "en") startEnglish();
    // オフラインで開いたときに「つながっていません」と出すため(https か localhost だけで動く)
    if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        {ctx.user && showShell(path) ? <Shell user={ctx.user}>{children}</Shell> : children}
        {ctx.user ? <Palette /> : null}
        <DialogHost />
        <Scripts />
      </body>
    </html>
  );
}
