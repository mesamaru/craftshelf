// 全体の枠(ログインした画面だけ)。v02 と同じ形(03.68.00 から):
// パソコン = 左のメニュー(ライブラリ・ホーム・セット・サーバーと各サーバー、下に お知らせ・設定・自分。‹ で畳むとアイコンだけ)と、上の検索・「＋ 追加」・読み直し。
// 幅 1000 px まで = 上のバー(名前・読み直し・お知らせ・設定)と下のタブ(ライブラリ・セット・＋・ホーム・サーバー)。検索は見出しの下(MobileSearch)
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { markNoticesSeen, recentEvents } from "./events-api";
import { libraryCatalog, librarySummary } from "./library-api";
import { AddSheet, LIBRARY_CHANGED, libraryChanged } from "./library-add";
import { OPEN_PALETTE } from "./palette";
import { roleLabel } from "./permissions";
import { listServers, serverStatus, sharedLocalEnabled } from "./servers-api";
import { unreadCount } from "./notices";
import { Icon, type IconName, Sheet } from "./ui";
import { shared, forgetShared } from "./shared";
import { useCan, useTeamKey } from "./use-can";

/** 「＋ 追加」のシートを開く(ライブラリの画面の、空のときの案内などから) */
export const OPEN_ADD = "craftshelf:add";

// ログインしていなくても開く画面には枠を出さない
const PUBLIC = /^\/(login|signup|forgot|reset|invite|terms|privacy)(\/|$)/;
export const showShell = (path: string) => !PUBLIC.test(path);

type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;
type Server = Awaited<ReturnType<typeof listServers>>[number];

type Summary = Awaited<ReturnType<typeof librarySummary>>;
// 枠が読んだ保存先(見出しの右の印に使う)
const ShellCtx = createContext<{ storage: Summary["storage"]; admin: boolean }>({ storage: null, admin: false });

// どの画面がどのメニューに入るか
const SECTION: [RegExp, string][] = [
  [/^\/$|^\/cleanup/, "library"],
  [/^\/home/, "home"],
  [/^\/sets/, "sets"],
  [/^\/servers\/[^/]+/, "server"],
  [/^\/(servers|ports|software|compare)/, "servers"],
  [/^\/(settings|team|activity|storage|backup|usage|shares|api-docs)/, "settings"], // チームとアカウントは、設定の 2 段の画面にまとめた(03.67.00)
  [/^\/jobs/, "jobs"],
];
const sectionOf = (path: string) => SECTION.find(([r]) => r.test(path))?.[1] ?? "";
const SIDE_MAX_SERVERS = 8;
const MINI = "craftshelf.side-mini";

export function Shell({ user, children }: { user: { id: string; name: string }; children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const router = useRouter();
  const { team, me, can } = useCan(user.id);
  const loadSummary = useServerFn(librarySummary);
  const loadCat = useServerFn(libraryCatalog);
  const loadServers = useServerFn(listServers);
  const teamKey = useTeamKey(); // 選んでいるチームが分かる(null = まだ)まで、チームごとの読み込みはしない
  const [sum, setSum] = useState<Summary | null>(null);
  const [cat, setCat] = useState<Catalog | null>(null); // 「＋ 追加」のシートだけが使う(開いたときに読む)
  const [servers, setServers] = useState<Server[]>([]);
  const [local, setLocal] = useState(false);
  const [sheet, setSheet] = useState<"" | "add" | "notices">("");
  const [mini, setMini] = useState(false);
  const notices = useNotices();
  const reloadSum = () => { shared("library-summary", () => loadSummary(), 3000).then(setSum, () => setSum(null)); };
  // 画面を移るたびに数を読み直す(サーバーを足した・消したあと)。ページが同じ時に読んだものは、共有して使う(src/lib/shared.ts)
  useEffect(() => {
    if (teamKey === null) return;
    shared("servers", () => loadServers(), 3000).then(setServers, () => setServers([]));
    reloadSum();
  }, [path, teamKey]);
  useEffect(() => { if (sheet === "add") loadCat().then(setCat, () => setCat(null)); }, [sheet]);
  useEffect(() => {
    sharedLocalEnabled().then(setLocal, () => setLocal(false));
    try { setMini(!!localStorage.getItem(MINI)); } catch {}
    const add = () => setSheet("add");
    // Ctrl B でメニューを畳む・広げる(v02 と同じ。入力欄の中では使わない)
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b" && innerWidth >= 1000
        && !(e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]"))) {
        e.preventDefault();
        setMini((m) => !m);
      }
    };
    window.addEventListener(LIBRARY_CHANGED, reloadSum);
    window.addEventListener(OPEN_ADD, add);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener(LIBRARY_CHANGED, reloadSum); window.removeEventListener(OPEN_ADD, add); window.removeEventListener("keydown", key); };
  }, []);
  // 畳んだかは <html> の印(操作のバーなど、枠の外に出すものも幅を合わせる)と、この端末に残す
  useEffect(() => {
    document.documentElement.classList.toggle("side-mini", mini);
    try { if (mini) localStorage.setItem(MINI, "1"); else localStorage.removeItem(MINI); } catch {}
  }, [mini]);
  const at = sectionOf(path);
  const edit = can({ library: ["edit"] });
  const search = () => window.dispatchEvent(new Event(OPEN_PALETTE));
  const reload = () => { forgetShared(); libraryChanged(); router.invalidate(); };
  const nav = (to: string, icon: IconName, label: string, key: string, n?: ReactNode) => (
    <Link to={to as "/"} className="nav" title={label} aria-current={at === key ? "page" : undefined}>
      <Icon name={icon} /><span className="t">{label}</span>{n}
    </Link>
  );
  const openNotices = () => { notices.read(); setSheet("notices"); };
  const unread = notices.unread > 0 && <span className="nb" aria-hidden="true">{notices.unread > 99 ? "99+" : notices.unread}</span>;
  return (
    <ShellCtx.Provider value={{ storage: sum?.storage ?? null, admin: can({ storage: ["manage"] }) }}>
      <div className="shell">
        <aside className="side glass" aria-label="メニュー">
          <div className="side-head">
            <Link to="/" className="brand" title="CraftShelf v03"><img src="/icon.svg" alt="" /><span className="t">CraftShelf</span><span className="vtag">v03</span></Link>
            <button type="button" className="fold" onClick={() => setMini(!mini)} aria-expanded={!mini}
              aria-label={mini ? "メニューを広げる" : "メニューを畳む"} title={`${mini ? "メニューを広げる" : "メニューを畳む"}(Ctrl B)`}>
              <Icon name={mini ? "fwd" : "back"} />
            </button>
          </div>
          {nav("/", "library", "ライブラリ", "library", sum && <span className="n">{sum.count}</span>)}
          {nav("/home", "home", "ホーム", "home")}
          {nav("/sets", "sets", "セット", "sets")}
          {nav("/servers", "servers", "サーバー", "servers")}
          {servers.length > 0 && (
            <div className="sub-nav">
              {servers.slice(0, SIDE_MAX_SERVERS).map((s) => <ServerLink key={s.id} server={s} on={path === `/servers/${s.id}` || path.startsWith(`/servers/${s.id}/`)} />)}
              {servers.length > SIDE_MAX_SERVERS && <Link to="/servers" className="nav"><span className="t">{`ほか ${servers.length - SIDE_MAX_SERVERS} 台`}</span></Link>}
            </div>
          )}
          <div className="side-foot">
            <button type="button" className="nav" title="お知らせ" onClick={openNotices}><Icon name="bell" /><span className="t">お知らせ</span>{unread}</button>
            {nav("/settings", "settings", "設定", "settings")}
            <Link to="/settings" className="nav me" title={user.name} aria-label="アカウントの設定">
              <span className="av" aria-hidden="true" translate="no">{user.name.slice(0, 1).toUpperCase()}</span>
              <span className="t"><b translate="no">{user.name}</b><small>{me ? roleLabel(me.role) : ""}</small></span>
            </Link>
          </div>
        </aside>
        <div className="shell-main">
          <div className="top glass">
            <Link to="/" className="brand"><img src="/icon.svg" alt="" /><span className="t">CraftShelf</span><span className="vtag">v03</span></Link>
            <button type="button" className="gsearch" onClick={search} aria-label="検索(Ctrl K)">
              <Icon name="search" /><span className="lbl">検索</span><kbd>Ctrl K</kbd>
            </button>
            <span className="grow" />
            {edit && <button type="button" className="btn pri addbtn" onClick={() => setSheet("add")}>＋ 追加</button>}
            <button type="button" className="rbtn" onClick={reload} aria-label="読み直す" title="読み直す"><Icon name="reload" /></button>
            <button type="button" className="rbtn m" onClick={openNotices} aria-label={`お知らせ ${notices.unread} 件`} title="お知らせ"><Icon name="bell" />{unread}</button>
            <Link to="/settings" className="rbtn m" aria-label="設定" title="設定"><Icon name="settings" /></Link>
          </div>
          {children}
        </div>
        <nav className="tabbar glass" aria-label="メニュー">
          <Link to="/" className={at === "library" ? "on" : ""}><Icon name="library" />ライブラリ</Link>
          <Link to="/sets" className={at === "sets" ? "on" : ""}><Icon name="sets" />セット</Link>
          {edit && <button type="button" className="plus" aria-label="追加" onClick={() => setSheet("add")}><span><Icon name="plus" /></span></button>}
          <Link to="/home" className={at === "home" ? "on" : ""}><Icon name="home" />ホーム</Link>
          <Link to="/servers" className={at === "servers" || at === "server" ? "on" : ""}><Icon name="servers" />サーバー</Link>
        </nav>
        {sheet === "add" && <AddSheet cat={cat} local={local} onClose={() => setSheet("")} />}
        {sheet === "notices" && (
          <Sheet title="お知らせ" onClose={() => setSheet("")}>
            <section className="group notice-list">
              {!notices.list?.length && <div className="row muted">お知らせはありません</div>}
              {notices.list?.map((e) => (
                <div className="row" key={e.id}>
                  <span className="main">
                    <span>{e.action}{e.target ? <>: <span translate="no">{e.target}</span></> : null}</span>
                    <span className="muted small" translate="no">{new Date(e.at).toLocaleString("ja-JP")}{e.userName ? ` · ${e.userName}` : ""}{e.detail ? ` · ${e.detail.split("\n")[0].slice(0, 80)}` : ""}</span>
                  </span>
                </div>
              ))}
            </section>
          </Sheet>
        )}
      </div>
    </ShellCtx.Provider>
  );
}

/** 見出しの右の保存先の印(自分用の版だけ。管理者は押すと保存先の設定へ) */
export function StoragePill() {
  const { storage, admin } = useContext(ShellCtx);
  if (!storage) return null;
  const inner = <><span className="sd" aria-hidden="true" /><Icon name="library" /><span className="t" translate={storage.name ? "no" : undefined}>{storage.name || "ローカル"}</span></>;
  return admin ? <Link to="/storage" className="pill" title="保存先">{inner}</Link> : <span className="pill" title="保存先">{inner}</span>;
}

/** 幅 1000 px までの、見出しの下の検索(パソコンは上のバーの検索) */
export const MobileSearch = () => (
  <button type="button" className="msearch" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE))}><Icon name="search" /><span>検索</span></button>
);

// メニューのサーバー(稼働の点。1 分ごとに読み直す)
function ServerLink({ server, on }: { server: Server; on: boolean }) {
  const status = useServerFn(serverStatus);
  const [state, setState] = useState("");
  useEffect(() => {
    // サーバーの一覧(servers.tsx)が 50 秒以内に読んだ状態があれば、それを使う。見えていないあいだ(タブが裏・最小化)は読まない
    const read = () => shared(`status:${server.id}`, () => status({ data: { id: server.id } }), 50_000).then((s) => setState(s.state), () => setState(""));
    const tick = () => { if (!document.hidden) read(); };
    read();
    const t = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [server.id]);
  return (
    <Link to="/servers/$id" params={{ id: server.id }} className="nav" aria-current={on ? "page" : undefined}
      title={`${server.name}${state === "running" ? "(稼働中)" : state ? "(停止中)" : ""}`}>
      <span className={`dot ${state}`} /><span className="t" translate="no">{server.name}</span>
    </Link>
  );
}

// お知らせ: 最近の出来事。前に開いたあとのものを数える(どこまで読んだかはサーバーに残し、どの端末でも同じ)
const SEEN = "craftshelf.notices-seen"; // 03.50.00 まではブラウザごとに残していた(サーバーにまだ無いときだけ使う)
function useNotices() {
  const load = useServerFn(recentEvents);
  const mark = useServerFn(markNoticesSeen);
  const [list, setList] = useState<Awaited<ReturnType<typeof recentEvents>>["items"] | null>(null);
  const [seen, setSeen] = useState("");
  useEffect(() => {
    load().then((r) => { setList(r.items); setSeen(r.seenAt ?? localStorage.getItem(SEEN) ?? ""); }, () => setList([]));
  }, []);
  const unread = unreadCount(list ?? [], seen);
  const read = () => {
    if (list?.length && list[0].at > seen) {
      setSeen(list[0].at);
      mark({ data: { at: list[0].at } }).catch(() => {});
    }
  };
  return { list, unread, read };
}
