import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ActionBar, Btn, Chip, ChipBar, Info } from "~/lib/ui";
import { sharedServers } from "~/lib/servers-api";
import { softwareInfo, updateSoftware } from "~/lib/software-api";
import { useCan } from "~/lib/use-can";
import { pageTitle } from "~/lib/titles";
import { confirmDialog } from "~/lib/dialog-queue";

export const Route = createFileRoute("/software")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/software" } });
    return { user: context.user };
  },
  loader: () => sharedServers(),
  head: () => ({ meta: [{ title: pageTitle("サーバー本体") }] }),
  component: Software,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
type Info = Awaited<ReturnType<typeof softwareInfo>>;

// すべてのサーバーのサーバー本体(今のビルド・いちばん新しいビルド)。選んだものをまとめて最新にするのは管理者以上(v02 のサーバー本体の一覧)
function Software() {
  const { user } = Route.useRouteContext();
  const servers = Route.useLoaderData();
  const { can } = useCan(user.id);
  const admin = can({ server: ["update"] });
  const load = useServerFn(softwareInfo);
  const update = useServerFn(updateSoftware);
  const [infos, setInfos] = useState<Record<string, Info | string>>({});
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [restart, setRestart] = useState(false);
  const read = (id: string) => load({ data: { id } }).then((d) => setInfos((x) => ({ ...x, [id]: d })), (e) => setInfos((x) => ({ ...x, [id]: message(e) })));
  useEffect(() => { for (const s of servers) read(s.id); }, []);
  const updatable = servers.filter((s) => { const i = infos[s.id]; return typeof i === "object" && i.update && i.latest?.auto && i.jar; });
  // 最新のもの・入れ替えられないものは飛ばす
  const run = async (chosen: string[]) => {
    const ids = chosen.filter((id) => updatable.some((s) => s.id === id));
    const skipped = chosen.length - ids.length;
    if (!ids.length) return setNote("選んだサーバーは、どれも最新か、自動で入れ替えられません");
    if (!(await confirmDialog({ message: `${ids.length} 台のサーバー本体を、いちばん新しいビルドに入れ替えますか?(今の jar は残し、あとで戻せます${restart ? "。入れ替えたら再起動します" : "。サーバーを再起動すると新しい jar で動きます"})`, ok: "入れ替える" }))) return;
    setNote("");
    for (const id of ids) {
      setBusy(id);
      try {
        await update({ data: { id, restart } });
      } catch (e) {
        setInfos((x) => ({ ...x, [id]: message(e) }));
      }
      await read(id);
    }
    setBusy("");
    setPicked(new Set());
    setNote(`${ids.length} 台を入れ替えました${skipped ? `(最新・入れ替えられない ${skipped} 台は飛ばしました)` : ""}`);
  };
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <main className="page fill">
      <Link to="/servers" className="back">‹ サーバー</Link>
      <header className="bar">
        <h1>サーバー本体<small>{`${servers.length} 台`}</small><Info>Paper・Folia・Purpur・Leaf・Pufferfish・Velocity・Waterfall・BungeeCord・Fabric・Vanilla・Mohist・SpongeVanilla は入れ替えられます。ビルド・Minecraft のバージョンを選ぶのと、残した jar に戻すのは、それぞれのサーバーの画面からできます。</Info></h1>
      </header>
      {admin && updatable.length > 1 && (
        <ChipBar label="まとめて" tools={<Btn kind="tint" sm disabled={!!busy} onClick={() => run(updatable.map((s) => s.id))}>{`${updatable.length} 台を入れ替える`}</Btn>}>
          <Chip on={restart} onClick={() => setRestart(!restart)}>入れ替えたら再起動</Chip>
        </ChipBar>
      )}
      <section className="group">
        {servers.length === 0 && <div className="row muted">まだサーバーがありません。</div>}
        {servers.map((s) => {
          const i = infos[s.id];
          return (
            <div className="row" key={s.id}>
              {admin && <input type="checkbox" className="ck" checked={picked.has(s.id)} disabled={!!busy} onChange={() => toggle(s.id)} aria-label={`${s.name} を選ぶ`} />}
              <Link to="/servers/$id" params={{ id: s.id }} className="mid">
                <span className="ttl" translate="no">{s.name}</span>
                <span className="sub" translate="no">
                  {i === undefined ? "確かめています…" : typeof i === "string" ? i
                    : `${i.label} ${i.mc ? `${i.mc} · ` : ""}${i.build || "?"}${i.latest ? ` → ${i.latest.build}` : ""}${i.mcNewer.length ? ` · Minecraft ${i.mcNewer[0]} あり` : ""}`}
                </span>
              </Link>
              {typeof i === "object" && (i.update ? <span className="badge upd">新しいビルド</span> : i.latest ? <span className="badge ok">最新</span> : null)}
              {admin && typeof i === "object" && i.update && i.latest?.auto && i.jar && (
                <Btn kind="tint" sm disabled={!!busy} onClick={() => run([s.id])}>{busy === s.id ? "入れ替えています…" : "入れ替える"}</Btn>
              )}
            </div>
          );
        })}
      </section>
      {note && <p className="notice" role="status">{note}</p>}
      {admin && picked.size > 0 && (
        <ActionBar label="選んだサーバー">
          <strong>{`${picked.size} 台`}</strong>
          {picked.size < servers.length && <Btn sm disabled={!!busy} onClick={() => setPicked(new Set(servers.map((s) => s.id)))}>すべて選ぶ</Btn>}
          <Btn sm aria-pressed={restart} kind={restart ? "tint" : "sec"} onClick={() => setRestart(!restart)}>{restart ? "再起動する" : "再起動しない"}</Btn>
          <Btn kind="pri" sm disabled={!!busy} onClick={() => run([...picked])}>最新にする</Btn>
          <Btn sm aria-label="選ぶのをやめる" title="選ぶのをやめる" onClick={() => setPicked(new Set())}>✕</Btn>
        </ActionBar>
      )}
    </main>
  );
}
