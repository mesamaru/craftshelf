import { useEffect } from "react";
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { useServerStatus } from "~/lib/server-status";

export const Route = createFileRoute("/servers/")({ component: NoServer });

// サーバーを選んでいないとき: パソコン(幅 900 px から)は左の一覧の先頭を開く。スマホは一覧だけ(右は出さない)
function NoServer() {
  const { servers } = getRouteApi("/servers").useLoaderData();
  const { first } = useServerStatus();
  const navigate = useNavigate();
  useEffect(() => {
    if (first && matchMedia("(min-width: 900px)").matches) navigate({ to: "/servers/$id", params: { id: first }, replace: true });
  }, [first]);
  if (servers.length > 0) return null;
  return <section className="group srv-empty"><div className="row muted">サーバーをつなぐと、ここに状態・アドオン・ファイルなどが出ます。「＋ サーバーを追加」から、Pterodactyl のサーバー・フォルダのサーバー・エージェントをつなげます。</div></section>;
}
