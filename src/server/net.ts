// 利用者が入力した URL へ、サーバーからつなぐときの安全策。
// このアプリは家の LAN の中で動くので、入力した URL で LAN の中の機器(ルーター・NAS など)や
// クラウドのメタデータへつながれると危ない(SSRF)。公開されたアドレスの HTTPS だけを許す。
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(addr, prefix, "ipv6");

// IPv6 の中に IPv4 を埋め込んだ形(::ffff:a.b.c.d、64:ff9b::a.b.c.d)は、中の IPv4 で判断する
function embeddedV4(addr: string): string | null {
  const m = addr.toLowerCase().match(/^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16), lo = parseInt(m[3], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

export function isPublicAddress(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 4) return !blocked.check(addr, "ipv4");
  if (family === 6) {
    const v4 = embeddedV4(addr);
    if (v4) return !blocked.check(v4, "ipv4");
    return !blocked.check(addr, "ipv6");
  }
  return false;
}

export class UnsafeUrlError extends Error {}

// 入力した URL を確かめて、正規化した形(末尾の / なし)を返す
// allowPrivate: 自分用の版では、家の中の Pterodactyl などにもつなげるようにする(http も許す)
export function checkPublicUrl(input: string, allowPrivate = false): string {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new UnsafeUrlError("URL の形が正しくありません");
  }
  if (allowPrivate) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("http:// か https:// の URL を入力してください");
    if (url.username || url.password) throw new UnsafeUrlError("URL にユーザー名やパスワードを含めないでください");
    if (!url.hostname) throw new UnsafeUrlError("URL の形が正しくありません");
    return url.origin + url.pathname.replace(/\/+$/, "");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("https:// の URL を入力してください");
  if (url.username || url.password) throw new UnsafeUrlError("URL にユーザー名やパスワードを含めないでください");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) throw new UnsafeUrlError("家の中・社内などのアドレスにはつなげません");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    throw new UnsafeUrlError("インターネットに公開されたアドレスを入力してください");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

// 名前を引いた結果がすべて公開されたアドレスのときだけつなぐ(引くたびに確かめるので、
// あとから名前の向き先を LAN の中に変えられても防げる)
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, "", 0);
    const list = addrs as dns.LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || list.length === 0) {
      return callback(Object.assign(new Error("公開されていないアドレスにはつなげません"), { code: "EUNSAFEADDR" }), "", 0);
    }
    if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

const agent = new Agent({ connect: { lookup: safeLookup, timeout: 10_000 }, headersTimeout: 20_000, bodyTimeout: 60_000 });

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// 外へつなぐときに使う fetch。転送(リダイレクト)は追わない
// 自分用の版で使う fetch。家の中のアドレスにもつなぐ(使う人がそのサーバー機の持ち主なので)。転送は追わない
const lanAgent = new Agent({ connect: { timeout: 10_000 }, headersTimeout: 20_000, bodyTimeout: 60_000 });
export const lanFetch: FetchLike = async (url, init) => {
  checkPublicUrl(url, true);
  const res = await undiciFetch(url, { ...(init as object), redirect: "manual", dispatcher: lanAgent } as never);
  return res as unknown as Response;
};

export const safeFetch: FetchLike = async (url, init) => {
  checkPublicUrl(url);
  const res = await undiciFetch(url, { ...(init as object), redirect: "manual", dispatcher: agent } as never);
  return res as unknown as Response;
};
