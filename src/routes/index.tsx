import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login" });
  },
  component: Home,
});

function Home() {
  const { user } = Route.useRouteContext();
  const { data: team } = authClient.useActiveOrganization();
  return (
    <main className="page">
      <header className="bar">
        <h1>ライブラリ</h1>
        <Link to="/team" className="capsule" aria-label="チーム">
          <span translate="no">{team?.name ?? "チーム"}</span>
        </Link>
        <Link to="/settings" className="capsule" aria-label="アカウントの設定">
          <span translate="no">{user?.name}</span>
        </Link>
      </header>
      <section className="group">
        <div className="row muted">サーバーをつなぐと、ここに Mod・プラグインが並びます(準備中)。</div>
      </section>
    </main>
  );
}
