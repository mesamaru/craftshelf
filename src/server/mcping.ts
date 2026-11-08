// Minecraft の Server List Ping(サーバー一覧に出る情報: オンラインの人数・最大・名前の一部・バージョン・応答の速さ)。v02 の mcnet.ping。
// エージェントからも使うので、node の標準だけで書く
import dns from "node:dns/promises";
import net from "node:net";

export type Ping = { latency: number; online: number; max: number; sample: string[]; version: string; motd: string };

const varint = (n: number) => {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
};

// 先頭の varint と、その長さ(足りなければ null)
function readVarint(buf: Buffer, at: number): [number, number] | null {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= buf.length) return null;
    const b = buf[at + i];
    n |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [n >>> 0, i + 1];
  }
  throw new Error("サーバーからの応答が正しくありません");
}

const motdText = (d: unknown): string => typeof d === "string" ? d.replace(/§./g, "")
  : Array.isArray(d) ? d.map(motdText).join("")
  : d && typeof d === "object" ? motdText((d as { text?: unknown }).text ?? "") + motdText((d as { extra?: unknown }).extra ?? []) : "";

/** 応答の JSON を、画面に出す形にする(名前は 12 人まで) */
export function parseStatus(json: string, latency: number): Ping {
  const st = JSON.parse(json);
  const p = st?.players ?? {};
  return {
    latency, online: Number(p.online) || 0, max: Number(p.max) || 0,
    sample: (Array.isArray(p.sample) ? p.sample : []).map((x: { name?: unknown }) => String(x?.name ?? "")).filter((n: string) => /^[A-Za-z0-9_]{1,16}$/.test(n)).slice(0, 12),
    version: String(st?.version?.name ?? "").slice(0, 80), motd: motdText(st?.description).slice(0, 200).trim(),
  };
}

/**
 * host:port に Server List Ping を送る。publicOnly なら、名前を引いた先が公開されたアドレスのときだけつなぐ
 * (サービス版で、利用者の入力したアドレスから家の中・クラウドの内側へつながせないように)
 */
export async function ping(host: string, port: number, opts: { timeoutMs?: number; publicOnly?: (addr: string) => boolean } = {}): Promise<Ping> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ポートが正しくありません");
  let addr = host;
  if (opts.publicOnly) {
    const list = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!list.length) throw new Error(`${host} が見つかりません`);
    if (list.some((a) => !opts.publicOnly!(a.address))) throw new Error("公開されていないアドレスにはつなげません");
    addr = list[0].address;
  }
  const timeoutMs = opts.timeoutMs ?? 3000;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host: addr, port });
    let buf = Buffer.alloc(0);
    const done = (e: Error | null, v?: Ping) => { clearTimeout(timer); sock.destroy(); if (e) reject(e); else resolve(v!); };
    const timer = setTimeout(() => done(new Error(`応答がありません(${host}:${port})`)), timeoutMs);
    sock.on("error", () => done(new Error(`つながりません(${host}:${port})`)));
    sock.on("connect", () => {
      const h = Buffer.from(host, "utf8");
      const hs = Buffer.concat([varint(0), varint(767), varint(h.length), h, Buffer.from([port >> 8, port & 255]), varint(1)]);
      sock.write(Buffer.concat([varint(hs.length), hs, varint(1), Buffer.from([0])]));
    });
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 256 * 1024) return done(new Error("サーバーからの応答が大きすぎます"));
      try {
        const total = readVarint(buf, 0);
        if (!total || buf.length < total[1] + total[0]) return;
        const id = readVarint(buf, total[1])!;
        if (id[0] !== 0) throw new Error("サーバーからの応答が正しくありません");
        const len = readVarint(buf, total[1] + id[1])!;
        const at = total[1] + id[1] + len[1];
        done(null, parseStatus(buf.subarray(at, at + len[0]).toString("utf8"), Date.now() - started));
      } catch (e) {
        done(e instanceof SyntaxError ? new Error("サーバーからの応答が正しくありません") : (e as Error));
      }
    });
  });
}

/** server.properties の文字から、ゲームのポート(無ければ 25565) */
export const gamePort = (props: string | null) => Number(props?.match(/^\s*server-port\s*=\s*(\d+)\s*$/m)?.[1]) || 25565;
