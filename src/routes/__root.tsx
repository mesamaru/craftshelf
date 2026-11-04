import { type ReactNode, useEffect } from "react";
import { getLang, startEnglish } from "~/lib/i18n";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { getAppState } from "~/lib/session";
import appCss from "~/styles.css?url";

export const Route = createRootRoute({
  beforeLoad: async () => getAppState(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "CraftShelf" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: () => (
    <RootDocument>
      <Outlet />
    </RootDocument>
  ),
});

function RootDocument({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (getLang() === "en") startEnglish();
  }, []);
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
