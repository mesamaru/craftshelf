// 複数のファイルを 1 つの zip にまとめる(まとめてダウンロード・セット・共有リンク)
import { Readable, Transform, pipeline } from "node:stream";
import { constants, crc32, createDeflateRaw } from "node:zlib";

// 大きくなる zip(まとめてダウンロード・セット・共有リンク)は、1 つずつ読みながら書く(メモリに全部を載せない)。
// 先に CRC・大きさがわからないので、中身のあとに書く(データ記述子)。ZIP64 は使わないので、全体は 4 GB 未満にする(呼ぶ側で ZIP_MAX_BYTES を確かめる)
export const ZIP_MAX_BYTES = 3.5 * 1024 * 1024 * 1024;
export type ZipEntry = { name: string; open: () => Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array>> };

export function zipStream(entries: ZipEntry[]): Readable {
  async function* gen() {
    const central: Buffer[] = [];
    const used = new Set<string>();
    let offset = 0;
    for (const e of entries) {
      let name = e.name;
      for (let i = 2; used.has(name); i++) name = e.name.replace(/(\.[^./]+)?$/, `-${i}$1`);
      used.add(name);
      const n = Buffer.from(name, "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0808, 6); // 名前は UTF-8・大きさは後ろに書く
      local.writeUInt16LE(8, 8); // deflate
      local.writeUInt16LE(n.length, 26);
      yield Buffer.concat([local, n]);
      let crc = 0;
      let usize = 0;
      let csize = 0;
      const count = new Transform({ transform(c: Buffer, _e, done) { crc = crc32(c, crc); usize += c.length; done(null, c); } });
      const out = pipeline(Readable.from(await e.open()), count, createDeflateRaw({ level: constants.Z_BEST_SPEED }), () => {});
      for await (const c of out as AsyncIterable<Buffer>) {
        csize += c.length;
        yield c;
      }
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      desc.writeUInt32LE(csize, 8);
      desc.writeUInt32LE(usize, 12);
      yield desc;
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(8, 10);
      c.writeUInt32LE(crc >>> 0, 16);
      c.writeUInt32LE(csize, 20);
      c.writeUInt32LE(usize, 24);
      c.writeUInt16LE(n.length, 28);
      c.writeUInt32LE(offset, 42);
      central.push(c, n);
      offset += 30 + n.length + csize + 16;
      if (offset > 0xffffffff) throw new Error("zip が大きすぎます");
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    yield Buffer.concat([cd, end]);
  }
  return Readable.from(gen());
}
