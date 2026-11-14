// 圧縮ファイルの種類(画面とサーバーで同じものを使う)。展開できるのは zip・tar・tar.gz・tgz だけ
export type ArchiveFormat = "zip" | "tar" | "tar.gz";

const LOWER = (name: string) => name.toLowerCase();

/** 展開できる形式(拡張子で決める)。できないものは null */
export function formatOf(name: string): ArchiveFormat | null {
  const n = LOWER(name);
  if (n.endsWith(".zip")) return "zip";
  if (n.endsWith(".tar.gz") || n.endsWith(".tgz")) return "tar.gz";
  if (n.endsWith(".tar")) return "tar";
  return null;
}

/** 展開できない形式の理由(7z・rar・zst など)。知らない拡張子は null */
export function unsupportedReason(name: string): string | null {
  const m = LOWER(name).match(/\.(7z|rar|zst|xz|bz2|lz4|lzma|z|cab|arj|ace|iso|gz|tar\.(?:xz|bz2|zst|lz4|lzma|z))$/);
  return m ? `この形式(.${m[1]})は展開できません(対応しているのは .zip・.tar・.tar.gz・.tgz です)` : null;
}

/** 画面で「展開」を出すか(展開できない形式も出し、押すと理由を見せる) */
export const looksLikeArchive = (name: string) => !!formatOf(name) || !!unsupportedReason(name);

/** 展開先のフォルダの名前の元(Foo.tar.gz → Foo) */
export const archiveBase = (name: string) => name.replace(/\.(tar\.gz|tgz|tar|zip)$/i, "");
