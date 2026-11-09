// 保存した版を zip でダウンロードする(ライブラリで選んだもの・セット)。先に入るもの・入らないものを確かめ、
// 保存していないものがあれば知らせてから、フォームの POST で /api/library/zip を開く(数が多いと URL に入らないため)
import { zipPlan } from "~/lib/saved-api";

type Input = { itemIds?: string[]; setId?: string };

export async function downloadZip(plan: (a: { data: Input }) => ReturnType<typeof zipPlan>, input: Input) {
  const p = await plan({ data: input });
  if (!p.count) throw new Error("保存した版のあるものがありません(「保存する」にするか、版の一覧から保存してください)");
  if (p.tooBig) throw new Error("まとめると大きすぎます(3.5 GB まで)。分けてダウンロードしてください");
  if (p.missing.length && !confirm(`保存していないもの(${p.missing.length} 件)は入りません: ${p.missing.slice(0, 10).join("、")}${p.missing.length > 10 ? " ほか" : ""}\nほかの ${p.count} 件をダウンロードしますか?`)) return false;
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/library/zip";
  for (const [k, v] of [["ids", (input.itemIds ?? []).join(",")], ["set", input.setId ?? ""]]) {
    const f = document.createElement("input");
    f.type = "hidden";
    f.name = k;
    f.value = v;
    form.append(f);
  }
  document.body.append(form);
  form.submit();
  form.remove();
  return true;
}
