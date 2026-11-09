import { type ReactNode, useEffect } from "react";
import { getLang, startEnglish } from "~/lib/i18n";
import { Palette } from "~/lib/palette";
import { type SavedTheme, applyTheme, localTheme, saveTheme } from "~/lib/theme";
import { saveMyTheme } from "~/lib/prefs-api";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { getAppState } from "~/lib/session";
import appCss from "~/styles.css?url";

export const Route = createRootRoute({
  beforeLoad: async () => getAppState(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#eef1f7", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#111214", media: "(prefers-color-scheme: dark)" },
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

// 見た目: アカウントに保存したものを使う(背景画像はこのブラウザのもの)。アカウントにまだ無ければ、このブラウザの値を使い、アカウントにも保存する
function useTheme(user: { theme?: SavedTheme | null } | null | undefined) {
  const saved = user?.theme ? JSON.stringify(user.theme) : "";
  useEffect(() => {
    const local = localTheme();
    if (saved) {
      const t = { ...(JSON.parse(saved) as SavedTheme), background: local?.background ?? "" };
      try {
        saveTheme(t);
      } catch {
        applyTheme(t);
      }
    } else {
      applyTheme();
      if (user && local) saveMyTheme({ data: local }).catch(() => {});
    }
  }, [saved, !!user]);
}

function RootDocument({ children }: { children: ReactNode }) {
  const ctx = Route.useRouteContext() as { user?: { theme?: SavedTheme | null } | null };
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
        {children}
        {ctx.user ? <Palette /> : null}
        <Scripts />
      </body>
    </html>
  );
}
