// 全体の枠(ログインした画面だけ): 左のメニュー・上の検索と処理の一覧・お知らせ・「＋ 追加」。スマホは下のタブと、上の小さな検索・お知らせ
import { type ReactNode, useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Bell } from "./bell";
import { markNoticesSeen, recentEvents } from "./events-api";
import { libraryCatalog } from "./library-api";
import { AddSheet, LIBRARY_CHANGED } from "./library-add";
import { OPEN_PALETTE } from "./palette";
import { roleLabel } from "./permissions";
import { listServers, localEnabled, serverStatus } from "./servers-api";
import { listSets } from "./sets-api";
import { Icon, type IconName, Sheet } from "./ui";
import { useCan } from "./use-can";

/** 「＋ 追加」のシートを開く(ライブラリの画面の、空のときの案内などから) */
export const OPEN_ADD = "craftshelf:add";

// ログインしていなくても開く画面には枠を出さない
const PUBLIC = /^\/(login|signup|forgot|reset|invite|terms|privacy)(\/|$)/;
export const showShell = (path: string) => !PUBLIC.test(path);

type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;
type Server = Awaited<ReturnType<typeof listServers>>[number];

// どの画面がどのメニューに入るか
const SECTION: [RegExp, string][] = [
  [/^\/$|^\/cleanup/, "library"],
  [/^\/sets/, "sets"],
  [/^\/servers\/[^/]+/, "server"],
  [/^\/(servers|ports|software)/, "servers"],
  [/^\/compare/, "compare"],
  [/^\/(settings|team|activity|storage|backup|usage|shares|api-docs)/, "settings"], // チームとアカウントは、設定の 2 段の画面にまとめた(03.67.00)
  [/^\/jobs/, "jobs"],
];
const sectionOf = (path: string) => SECTION.find(([r]) => r.test(path))?.[1] ?? "";

export function Shell({ user, children }: { user: { id: string; name: string }; children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { team, me, can } = useCan(user.id);
  const loadCat = useServerFn(libraryCatalog);
  const loadServers = useServerFn(listServers);
  const loadSets = useServerFn(listSets);
  const isLocal = useServerFn(localEnabled);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [sets, setSets] = useState<number | null>(null);
  const [local, setLocal] = useState(false);
  const [sheet, setSheet] = useState<"" | "add" | "more">("");
  const reloadCat = () => { loadCat().then(setCat, () => setCat(null)); };
  // 画面を移るたびに数を読み直す(サーバー・セットを足した・消したあと)
  useEffect(() => {
    loadServers().then(setServers, () => setServers([]));
    loadSets().then((s) => setSets(s.length), () => setSets(null));
    reloadCat();
  }, [path, team?.id]);
  useEffect(() => {
    isLocal().then(setLocal, () => setLocal(false));
    const add = () => setSheet("add");
    window.addEventListener(LIBRARY_CHANGED, reloadCat);
    window.addEventListener(OPEN_ADD, add);
    return () => { window.removeEventListener(LIBRARY_CHANGED, reloadCat); window.removeEventListener(OPEN_ADD, add); };
  }, []);
  const at = sectionOf(path);
  const edit = can({ library: ["edit"] });
  const search = () => window.dispatchEvent(new Event(OPEN_PALETTE));
  const nav = (to: string, icon: IconName, label: string, key: string, n?: number | null) => (
    <Link to={to as "/"} className="nav" aria-current={at === key ? "page" : undefined} onClick={() => setSheet("")}>
      <Icon name={icon} /><span>{label}</span>{n != null && <span className="n">{n}</span>}
    </Link>
  );
  const meRow = (
    <Link to="/settings" className="me" aria-label="アカウントの設定" onClick={() => setSheet("")}>
      <span className="av" aria-hidden="true" translate="no">{user.name.slice(0, 1).toUpperCase()}</span>
      <span><b translate="no">{user.name}</b><small>{me ? roleLabel(me.role) : ""}</small></span>
    </Link>
  );
  return (
    <div className="shell">
      <aside className="side glass" aria-label="メニュー">
        <Link to="/" className="brand"><img src="/icon.svg" alt="" />CraftShelf<small>v03</small></Link>
        {nav("/", "library", "ライブラリ", "library", cat?.items.length)}
        {nav("/sets", "sets", "セット", "sets", sets)}
        {nav("/servers", "servers", "サーバー", "servers", servers.length)}
        {servers.length > 0 && (
          <div className="sub-nav">
            {servers.map((s) => <ServerLink key={s.id} server={s} on={path === `/servers/${s.id}` || path.startsWith(`/servers/${s.id}/`)} />)}
          </div>
        )}
        {nav("/compare", "compare", "比較", "compare")}
        <div className="sep" />
        {nav("/settings", "settings", "設定", "settings")}
        <span className="grow" />
        {meRow}
      </aside>
      <div className="shell-main">
        <div className="top">
          <button type="button" className="search glass" onClick={search} aria-label="検索(Ctrl K)">
            <Icon name="search" /><span className="lbl">検索</span><kbd>Ctrl K</kbd>
          </button>
          <span className="grow" />
          <Link to="/jobs" className="iconbtn glass hide-p" aria-label="処理の一覧" title="処理の一覧"><Icon name="jobs" /></Link>
          <Notices />
          {edit && <button type="button" className="btn pri hide-p" onClick={() => setSheet("add")}>＋ 追加</button>}
        </div>
        {children}
      </div>
      <nav className="tabbar glass" aria-label="メニュー">
        <Link to="/" className={at === "library" ? "on" : ""}><Icon name="library" />ライブラリ</Link>
        <Link to="/sets" className={at === "sets" ? "on" : ""}><Icon name="sets" />セット</Link>
        {edit && <button type="button" className="plus" aria-label="追加" onClick={() => setSheet("add")}><span>＋</span></button>}
        <Link to="/servers" className={at === "servers" || at === "server" ? "on" : ""}><Icon name="servers" />サーバー</Link>
        <button type="button" className={["compare", "settings", "jobs"].includes(at) ? "on" : ""} onClick={() => setSheet("more")}><Icon name="more" />その他</button>
      </nav>
      {sheet === "add" && <AddSheet cat={cat} local={local} onClose={() => setSheet("")} />}
      {sheet === "more" && (
        <Sheet title="その他" onClose={() => setSheet("")}>
          <section className="group more-list">
            {nav("/compare", "compare", "比較", "compare")}
            {nav("/settings", "settings", "設定", "settings")}
            {nav("/jobs", "jobs", "処理の一覧", "jobs")}
          </section>
          <section className="group">{meRow}</section>
        </Sheet>
      )}
    </div>
  );
}

// メニューのサーバー(稼働の点。1 分ごとに読み直す)
function ServerLink({ server, on }: { server: Server; on: boolean }) {
  const status = useServerFn(serverStatus);
  const [state, setState] = useState("");
  useEffect(() => {
    const read = () => status({ data: { id: server.id } }).then((s) => setState(s.state), () => setState(""));
    read();
    const t = setInterval(read, 60_000);
    return () => clearInterval(t);
  }, [server.id]);
  return (
    <Link to="/servers/$id" params={{ id: server.id }} className="nav" aria-current={on ? "page" : undefined}
      title={state === "running" ? "稼働中" : state ? "停止中" : undefined}>
      <span className={`dot ${state}`} /><span translate="no">{server.name}</span>
    </Link>
  );
}

// お知らせ: 最近の出来事。前に開いたあとのものを数える(どこまで読んだかはサーバーに残し、どの端末でも同じ)
const SEEN = "craftshelf.notices-seen"; // 03.50.00 まではブラウザごとに残していた(サーバーにまだ無いときだけ使う)
function Notices() {
  const load = useServerFn(recentEvents);
  const mark = useServerFn(markNoticesSeen);
  const [list, setList] = useState<Awaited<ReturnType<typeof recentEvents>>["items"] | null>(null);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState("");
  useEffect(() => {
    load().then((r) => { setList(r.items); setSeen(r.seenAt ?? localStorage.getItem(SEEN) ?? ""); }, () => setList([]));
  }, []);
  const unread = (list ?? []).filter((e) => e.at > seen).length;
  const toggle = (v: boolean) => {
    setOpen(v);
    if (v && list?.length && list[0].at > seen) {
      setSeen(list[0].at);
      mark({ data: { at: list[0].at } }).catch(() => {});
    }
  };
  return (
    <Bell open={open} setOpen={toggle} count={unread} label={`お知らせ ${unread} 件`}>
      {!list?.length && <div className="row muted">お知らせはありません</div>}
      {list?.map((e) => (
        <div className="row" key={e.id}>
          <span className="main">
            <span>{e.action}{e.target ? <>: <span translate="no">{e.target}</span></> : null}</span>
            <span className="muted small" translate="no">{new Date(e.at).toLocaleString("ja-JP")}{e.userName ? ` · ${e.userName}` : ""}{e.detail ? ` · ${e.detail.split("\n")[0].slice(0, 80)}` : ""}</span>
          </span>
        </div>
      ))}
    </Bell>
  );
}
