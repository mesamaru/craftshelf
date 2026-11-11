// ダウンロードの Content-Disposition。日本語の名前をそのまま入れるとヘッダーが作れない(Response が例外になる)ので、
// ASCII だけの filename= と、UTF-8 の filename*= を併記する(RFC 6266・5987)
export function attachment(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]|["\%;]/g, "_").replace(/^\.+$/, "_") || "download";
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${plain}"; filename*=UTF-8''${star}`;
}
