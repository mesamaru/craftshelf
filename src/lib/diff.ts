// 行の差分(ファイル比較で使う。v02 の cfgdiff.js と同じやり方)

export type Op = { t: "eq"; a: number; b: number } | { t: "del"; a: number } | { t: "ins"; b: number };

/** 行の差分(Myers の方法) */
export function diffLines(A: string[], B: string[]): Op[] {
  const n = A.length, m = B.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const px = vv[off + prevK], py = px - prevK;
    while (x > px && y > py) { x--; y--; ops.push({ t: "eq", a: x, b: y }); }
    if (d > 0) {
      if (x === px) { y--; ops.push({ t: "ins", b: y }); } else { x--; ops.push({ t: "del", a: x }); }
    }
  }
  return ops.reverse();
}

// same: 基準と同じ / chg: 違う / miss: 基準にあってこちらに無い / extra: こちらだけにある / gap: ほかのサーバーだけにある行のすき間
export type Cell = { i: number | null; kind: "same" | "chg" | "miss" | "extra" | "gap" };
export type Row = { base: number | null; cells: Cell[]; diff: boolean };

/** 基準のファイルにそろえて、ほかのファイルの行を横に並べる */
export function alignAll(base: string[], others: string[][]): Row[] {
  const nb = base.length;
  const map: (Cell | null)[][] = others.map(() => new Array(nb).fill(null));
  const before: number[][][] = others.map(() => Array.from({ length: nb + 1 }, () => []));
  others.forEach((lines, k) => {
    const ops = diffLines(base, lines);
    let i = 0;
    while (i < ops.length) {
      const op = ops[i];
      if (op.t === "eq") { map[k][op.a] = { i: op.b, kind: "same" }; i++; continue; }
      const dels: number[] = [], ins: number[] = [];
      while (i < ops.length && ops[i].t !== "eq") {
        const o = ops[i] as Exclude<Op, { t: "eq" }>;
        if (o.t === "del") dels.push(o.a); else ins.push(o.b);
        i++;
      }
      const pairs = Math.min(dels.length, ins.length);
      for (let p = 0; p < pairs; p++) map[k][dels[p]] = { i: ins[p], kind: "chg" };
      for (let p = pairs; p < dels.length; p++) map[k][dels[p]] = { i: null, kind: "miss" };
      const next = ops[i];
      const at = dels.length ? dels[dels.length - 1] + 1 : next && next.t === "eq" ? next.a : nb;
      for (let p = pairs; p < ins.length; p++) before[k][at].push(ins[p]);
    }
  });
  const rows: Row[] = [];
  for (let g = 0; g <= nb; g++) {
    const extra = Math.max(0, ...before.map((b) => b[g].length));
    for (let r = 0; r < extra; r++) rows.push({ base: null, cells: before.map((b) => (r < b[g].length ? { i: b[g][r], kind: "extra" } : { i: null, kind: "gap" })), diff: true });
    if (g < nb) {
      const cells = map.map((m) => m[g] ?? { i: null, kind: "miss" as const });
      rows.push({ base: g, cells, diff: cells.some((c) => c.kind !== "same") });
    }
  }
  return rows;
}

/** 行に分ける(改行コードの違いは見ない) */
export const splitLines = (text: string) => {
  const t = text.replace(/\r\n/g, "\n");
  if (t === "") return [];
  return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
};

/**
 * ほかのファイル(k 番目)の、その行(rows[idx])を基準の行にした結果の行。
 * 違う → 書き換える / 基準にあってこちらに無い → 次にある行の前に入れる / こちらだけにある → 消す
 */
export function takeBase(base: string[], other: string[], rows: Row[], idx: number, k: number): string[] {
  const r = rows[idx];
  const c = r.cells[k];
  const out = other.slice();
  if (r.base === null) {
    if (c.i !== null) out.splice(c.i, 1);
  } else if (c.i !== null) {
    out[c.i] = base[r.base];
  } else {
    let at = out.length;
    for (let j = idx + 1; j < rows.length; j++) {
      const next = rows[j].cells[k].i;
      if (next !== null) { at = next; break; }
    }
    out.splice(at, 0, base[r.base]);
  }
  return out;
}
