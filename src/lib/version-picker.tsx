// サーバーにアドオンを入れるときの「版の一覧」(どの画面もこの部品を使う): 版を新しい順に並べ、このサーバーの Minecraft への対応の印・出どころを付ける。
// 初めは「合う最新版」を選んでおき、なぜその版かを 1 行で出す。非対応の版を選んで入れるときは確認を出す
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Btn } from "~/lib/ui";
import { modVersions } from "~/lib/library-api";
import { mcCompare, mcRange } from "~/lib/platforms";
import { SOURCE_LABEL, type ItemSource } from "~/lib/sources";

export type VRow = Awaited<ReturnType<typeof modVersions>>[number];
export type VArgs = { id: string; projectId: string; source: ItemSource; kind?: "datapack" };

const SUPPORT: Record<VRow["support"], [string, string]> = { ok: ["対応", "ok"], unknown: ["対応不明", "muted-badge"], no: ["非対応", "bad"] };
const TYPE: Record<string, string> = { beta: "ベータ", alpha: "アルファ" };

/** 対応の印(対応 / 対応不明 / 非対応) */
export function SupportBadge({ s }: { s: VRow["support"] }) {
  return <span className={`badge ${SUPPORT[s][1]}`}>{SUPPORT[s][0]}</span>;
}

/** 選んだ版が、いまのサーバーに対応しなければ確認する(入れると動かないおそれ)。続けてよければ true */
export const confirmUnsupported = (v: VRow, mc: string) =>
  v.support !== "no" || confirm(`${v.versionNumber} は、このサーバー(Minecraft ${mc || "不明"})に対応していません。入れると動かないおそれがあります。それでも入れますか?`);

/** なぜその版を選んでいるか(1 行)。mc = サーバーの Minecraft バージョン */
export function whyVersion(rows: VRow[], v: VRow | undefined, mc: string) {
  if (!v) return "";
  const best = rows.find((r) => r.suggested);
  const newest = rows[0];
  const at = mc ? `サーバー ${mc} に` : "このサーバーに";
  if (v.suggested) return newest && newest.versionNumber !== v.versionNumber ? `${at}合う ${v.versionNumber} を入れます(最新は ${newest.versionNumber})` : `${at}合う最新版 ${v.versionNumber} を入れます`;
  if (v.support === "no") return `${v.versionNumber} は${at}対応していません${best ? `(合う最新版は ${best.versionNumber})` : ""}`;
  return `${v.versionNumber} を入れます${best ? `(合う最新版は ${best.versionNumber})` : ""}`;
}

// 出どころ(配布元の版・ライブラリに保存した版)
const originOf = (v: VRow, source: ItemSource) =>
  v.upstream && v.saved && source !== "upload" ? `${SOURCE_LABEL[source]}・保存済み` : v.saved ? (source === "upload" ? "アップロード" : "ライブラリに保存") : SOURCE_LABEL[source];

/** 版の一覧(選ぶ)。current = いま入っている版の ID */
export function VersionPicker({ rows, source, value, onChange, current, mc }: { rows: VRow[]; source: ItemSource; value: string; onChange: (v: VRow) => void; current?: string; mc?: string }) {
  return (
    <section className="group vlist" role="radiogroup" aria-label="版">
      {rows.length === 0 && <div className="row muted">選べる版がありません</div>}
      {rows.map((v) => {
        // 範囲の中に抜けがあって非対応のとき(1.8.9〜1.21.4 に 1.20.4 が無い)は、範囲だけだと分からないので書き添える
        const span = mcRange(v.mcVersions);
        const gap = mc && v.support === "no" && v.mcVersions.length > 1 && mcCompare(mc, v.mcVersions[0]) > 0 && mcCompare(mc, v.mcVersions[v.mcVersions.length - 1]) < 0;
        return (
          <button key={v.versionId} type="button" className={`row link vrow${value === v.versionId ? " sel" : ""}`} role="radio" aria-checked={value === v.versionId} onClick={() => onChange(v)}>
            <span className="vdot" aria-hidden="true" />
            <span className="mid">
              <span className="ttl"><span translate="no">{v.versionNumber}</span>
                {v.suggested && <span className="tag">合う最新版</span>}
                {TYPE[v.type] && <span className="tag">{TYPE[v.type]}</span>}
                {v.versionId === current && <span className="tag">今</span>}
              </span>
              <span className="sub">{[span && `MC ${span}${gap ? `(${mc} は未対応)` : ""}`, v.date.slice(0, 10), originOf(v, source)].filter(Boolean).join(" · ")}</span>
            </span>
            <SupportBadge s={v.support} />
          </button>
        );
      })}
    </section>
  );
}

/** 版の一覧を読み込んで選ばせる。初めは合う最新版を選ぶ。決めたら onChoose(選んだ版。合う最新版のままなら auto = true) */
export function VersionChooser({ args, mc, current, label, busy, note, onChoose }:
  { args: VArgs; mc: string; current?: string; label: string; busy?: boolean; note?: string; onChoose: (v: VRow, auto: boolean) => void }) {
  const load = useServerFn(modVersions);
  const [rows, setRows] = useState<VRow[] | null>(null);
  const [sel, setSel] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setRows(null);
    setError("");
    load({ data: { id: args.id, projectId: args.projectId, source: args.source, kind: args.kind } }).then((r) => {
      setRows(r);
      setSel((r.find((x) => x.suggested) ?? r.find((x) => x.support !== "no") ?? r[0])?.versionId ?? "");
    }, (e) => setError(e instanceof Error ? e.message : "うまくいきませんでした"));
  }, [args.id, args.projectId, args.source, args.kind]);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!rows) return <p className="muted">版を読み込んでいます…</p>;
  const v = rows.find((r) => r.versionId === sel);
  const offline = rows.length > 0 && rows.every((r) => !r.upstream) && args.source !== "upload";
  return (
    <>
      {offline && <p className="sub">配布元から版を読めないので、ライブラリに保存した版だけを出しています</p>}
      <VersionPicker rows={rows} source={args.source} value={sel} onChange={(r) => setSel(r.versionId)} current={current} mc={mc} />
      <p className="sub vwhy" role="status">{whyVersion(rows, v, mc)}</p>
      {note && <p className="sub">{note}</p>}
      <div className="sheet-foot"><span className="grow" />
        <Btn kind="pri" disabled={!v || busy || v.versionId === current} onClick={() => v && confirmUnsupported(v, mc) && onChoose(v, !!v.suggested)}>{label}</Btn>
      </div>
    </>
  );
}
