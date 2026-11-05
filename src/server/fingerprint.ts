// CurseForge のフィンガープリント: 空白類(タブ・改行・空白)を除いた中身の MurmurHash2(seed = 1)。v02 の cf_fingerprint と同じ
export function cfFingerprint(input: Uint8Array): number {
  const data = input.filter((b) => b !== 9 && b !== 10 && b !== 13 && b !== 32);
  const m = 0x5bd1e995;
  let len = data.length;
  let h = (1 ^ len) >>> 0;
  let i = 0;
  while (len >= 4) {
    let k = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    k = (k ^ (k >>> 24)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    h = (Math.imul(h, m) ^ k) >>> 0;
    i += 4;
    len -= 4;
  }
  if (len === 3) h = (h ^ (data[i + 2] << 16)) >>> 0;
  if (len >= 2) h = (h ^ (data[i + 1] << 8)) >>> 0;
  if (len >= 1) h = Math.imul((h ^ data[i]) >>> 0, m) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, m) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}
