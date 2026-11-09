// アイテムの種類のアイコン(配布元のアイコンが無いときに出す。線だけの小さな図)
const PATHS: Record<string, string> = {
  plugin: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4", // 差し込みプラグ
  mod: "M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9", // 箱
  datapack: "M9 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h2M15 4h2a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-2", // { }
  resourcepack: "M4 5h16v14H4zM4 15l5-5 5 5 2-2 4 4M15 9h.01", // 絵
  shader: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4", // 光
  modpack: "M12 3 3 7.5l9 4.5 9-4.5zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5", // 重ねた束
};

/** 配布元のアイコン(url)か、無ければ種類の図 */
export function ItemIcon({ type, url }: { type: string; url?: string }) {
  if (url) return <img src={url} alt="" width={40} height={40} loading="lazy" />;
  return (
    <span className="icon-ph" aria-hidden="true">
      {PATHS[type] && (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={PATHS[type]} /></svg>
      )}
    </span>
  );
}
