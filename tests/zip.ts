// テスト用: 小さな zip(jar)を作る(deflate か、そのまま)
import { crc32, deflateRawSync } from "node:zlib";

// 中身は文字か、そのままのバイト(jar の中の jar を入れるとき)
export function makeZip(entries: Record<string, string | Uint8Array>, deflate = true): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = typeof text === "string" ? Buffer.from(text, "utf8") : Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

// 攻撃の確かめ用: 目次・ヘッダーの値を自由に決められる zip(嘘の大きさ・リンク・暗号化の印・CRC の間違いなど)
export type ZipEx = {
  name: string;
  data?: string | Uint8Array;
  /** 圧縮済みのデータをそのまま入れる(deflate のバイト列。data はここでは大きさの計算に使わない) */
  packed?: Uint8Array;
  method?: 0 | 8;
  /** Unix の mode(0o120777 = シンボリックリンク)。指定すると「作った OS = Unix」にする */
  mode?: number;
  flags?: number;
  /** 目次に書く大きさ・CRC(本当と違う嘘) */
  usize?: number;
  csize?: number;
  crc?: number;
  /** 局所ヘッダーの名前(目次と違う嘘) */
  localName?: string;
};

export function makeZipEx(entries: ZipEx[], opts: { prefix?: Uint8Array; comment?: string; noEnd?: boolean; disk?: number } = {}): Buffer {
  const prefix = Buffer.from(opts.prefix ?? []);
  const locals: Buffer[] = [prefix];
  const centrals: Buffer[] = [];
  let offset = prefix.length;
  for (const e of entries) {
    const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : Buffer.from(e.data ?? []);
    const method = e.method ?? 8;
    const data = e.packed ? Buffer.from(e.packed) : method === 8 ? deflateRawSync(raw) : raw;
    const n = Buffer.from(e.name, "utf8");
    const ln = Buffer.from(e.localName ?? e.name, "utf8");
    // 本物の CRC-32
    let crc = e.crc;
    if (crc === undefined) {
      crc = 0xffffffff;
      for (const b of raw) {
        crc ^= b;
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
      crc = (crc ^ 0xffffffff) >>> 0;
    }
    const usize = e.usize ?? raw.length;
    const csize = e.csize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.flags ?? 0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(ln.length, 26);
    locals.push(local, ln, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(e.mode === undefined ? 20 : 0x031e, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(e.flags ?? 0x800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(csize, 20);
    c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(n.length, 28);
    if (e.mode !== undefined) c.writeUInt32LE((e.mode << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, n);
    offset += 30 + ln.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment ?? "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.disk ?? 0, 4);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, ...(opts.noEnd ? [] : [end, comment])]);
}
