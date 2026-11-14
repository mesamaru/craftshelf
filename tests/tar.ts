// テスト用: tar(と tar.gz)を作る。名前・種類・大きさを自由に決められる(攻撃の確かめ用)
import { gzipSync } from "node:zlib";

export type TarEntry = {
  name: string;
  data?: string | Uint8Array;
  /** 型フラグ。0 = ファイル(既定)・5 = フォルダ・1 = ハードリンク・2 = シンボリックリンク・3・4 = デバイス・6 = FIFO */
  type?: string;
  linkname?: string;
  /** ヘッダーに書く大きさ(データの長さと違う嘘も書ける) */
  size?: number;
  /** 名前を PAX の拡張ヘッダーで渡す(100 バイトを超える名前は自動でそうする) */
  pax?: boolean;
  /** チェックサムをわざと間違える */
  badSum?: boolean;
};

const octal = (n: number, width: number) => Math.floor(n).toString(8).padStart(width - 1, "0") + "\0";

function header(name: string, size: number, type: string, linkname = "", badSum = false) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(octal(type === "5" ? 0o755 : 0o644, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(0, 12), 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157, 100, "utf8");
  h.write("ustar\u000000", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(badSum ? sum + 1 : sum, 7) + " ", 148);
  return h;
}

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`;
  const len = Buffer.byteLength(body);
  let digits = String(len).length;
  if (String(len + digits).length > digits) digits++;
  return `${len + digits}${body}`;
}

export function makeTar(entries: TarEntry[], opts: { gz?: boolean; end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "0";
    const data = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : Buffer.from(e.data ?? []);
    if (e.pax || Buffer.byteLength(e.name) > 100) {
      const px = Buffer.from(paxRecord("path", e.name), "utf8");
      parts.push(header("PaxHeader/x", px.length, "x"), px, pad(px.length));
    }
    parts.push(header(e.pax || Buffer.byteLength(e.name) > 100 ? "placeholder" : e.name, e.size ?? data.length, type, e.linkname, e.badSum), data, pad(data.length));
  }
  if (opts.end !== false) parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts);
  return opts.gz ? gzipSync(tar) : tar;
}

// ---- 手組みの tar(攻撃の確かめ用。ヘッダーの値を自由に書ける) ----
const oct = (n: number, w: number) => n.toString(8).padStart(w - 1, "0") + "\0";
export function hdr(o: { name?: string; size?: number | string; type?: string; prefix?: string; magic?: string }) {
  const h = Buffer.alloc(512);
  h.write(o.name ?? "", 0, 100, "utf8");
  h.write(oct(0o644, 8), 100);
  h.write(oct(0, 8), 108);
  h.write(oct(0, 8), 116);
  h.write(typeof o.size === "string" ? o.size : oct(o.size ?? 0, 12), 124);
  h.write(oct(0, 12), 136);
  h.write("        ", 148);
  h.write(o.type ?? "0", 156);
  h.write(o.magic ?? "ustar\u000000", 257);
  if (o.prefix) h.write(o.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(oct(sum, 7) + " ", 148);
  return h;
}
export const entry = (h: Buffer, data: Buffer | string = "") => { const d = Buffer.from(data); return Buffer.concat([h, d, pad(d.length)]); };
/** PAX の拡張ヘッダー(kv の値はそのまま書く。size=abc のような嘘も書ける) */
export const paxEntry = (kv: Record<string, string>, type: "x" | "g" = "x") => {
  let body = "";
  for (const [k, v] of Object.entries(kv)) body += paxRecord(k, v);
  return entry(hdr({ name: "PaxHeader", type, size: Buffer.byteLength(body) }), body);
};
export const tarOf = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.alloc(1024)]);
