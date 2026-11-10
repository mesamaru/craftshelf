import { createFileRoute, redirect } from "@tanstack/react-router";

// 03.66.00 から、ファイルとコンソールはサーバーの詳細のタブ(前の URL から来たらファイルのタブを開く)
export const Route = createFileRoute("/servers_/$id_/files")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/servers/$id", params: { id: params.id }, search: { tab: "files" } });
  },
});
