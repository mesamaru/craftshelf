// tar.gz を、ファイルを 1 つずつ足しながら書く(ワールドのバックアップ。全体をメモリに持たない)。
// 名前が 100 バイトを超えるときは PAX の拡張ヘッダーに書く(GNU tar・7-Zip・Windows の tar で読める)
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const octal = (n: number, width: number) => Math.floor(n).toString(8).padStart(width - 1, "0") + "\0";

function header(name: string, size: number, mtime: number, type: "0" | "x") {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(mtime, 12), 136);
  h.write("        ", 148); // チェックサムを計る間は空白
  h.write(type, 156);
  h.write("ustar\u000000", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148);
  return h;
}

// PAX の 1 行("<長さ> path=<名前>\n"。長さは自分の桁も含む)
function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`;
  const len = Buffer.byteLength(body);
  let digits = String(len).length;
  if (String(len + digits).length > digits) digits++;
  return `${len + digits}${body}`;
}

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

export function tarGz(path: string) {
  const gz = createGzip();
  const done = pipeline(gz, createWriteStream(path));
  let failed: unknown = null;
  done.catch((e) => { failed = e; });
  const write = async (b: Buffer) => {
    if (failed) throw failed;
    if (!gz.write(b)) await Promise.race([once(gz, "drain"), done]);
  };
  return {
    /** ファイルを 1 つ足す(name は / 区切りの相対パス) */
    async add(name: string, data: Uint8Array, mtime = Date.now() / 1000) {
      if (Buffer.byteLength(name) > 100) {
        const pax = Buffer.from(paxRecord("path", name), "utf8");
        await write(header(`PaxHeader/${name.split("/").pop()}`.slice(0, 99), pax.length, mtime, "x"));
        await write(Buffer.concat([pax, pad(pax.length)]));
      }
      await write(header(name, data.byteLength, mtime, "0"));
      await write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      await write(pad(data.byteLength));
    },
    /** 終わりのしるしを書いて閉じる */
    async end() {
      await write(Buffer.alloc(1024));
      gz.end();
      await done;
    },
    /** 途中でやめる(書きかけのファイルは呼ぶ側で消す) */
    abort() {
      gz.destroy();
      done.catch(() => {});
    },
  };
}
