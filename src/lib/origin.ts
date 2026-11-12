// ライブラリのファイル(版)の出どころ(library_file.origin)。画面の言葉は、ここの 1 か所だけ。
// upload = 画面・API からアップロードした / server = サーバーにあった jar をライブラリに取り込んだ /
// upstream = 配布元から保存した / v02 = v02 から取り込んだ / "" = 03.76.00 より前の行(今までの表示のまま)
export const ORIGIN_LABEL = { upload: "アップロード", server: "サーバーから取り込み", upstream: "配布元", v02: "v02 から" } as const;
export type Origin = keyof typeof ORIGIN_LABEL;
export const isOrigin = (v: unknown): v is Origin => typeof v === "string" && v in ORIGIN_LABEL;

/** 出どころの言葉。空・知らない値(古い行)は、今までどおり: 配布元の版を保存したもの(upstream = true)は「配布元」、それ以外は「アップロード」 */
export const originLabel = (origin: string | null | undefined, upstream = false) =>
  isOrigin(origin) ? ORIGIN_LABEL[origin] : upstream ? ORIGIN_LABEL.upstream : ORIGIN_LABEL.upload;
