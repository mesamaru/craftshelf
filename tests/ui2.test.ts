// 画面の使いにくさ・見た目・文言の直し(03.73.02): 大きさ・日付・タイトル・Ctrl K の行き先・そろえる結果・一覧の説明・YAML の行
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { applySummary } from "~/lib/apply-summary";
import { fmtSize, localDate } from "~/lib/format";
import { loadEnglish, translate } from "~/lib/i18n";
import { itemSub } from "~/lib/item-sub";
import { sourceLabel } from "~/lib/sources";
import { syntaxError, yamlLine } from "~/lib/syntax";
import { PAGE_HITS, SETTING_LABEL, pageTitle, settingsTitle } from "~/lib/titles";

beforeAll(() => loadEnglish());

describe("大きさ(切り上げない)", () => {
  it("1 KB 未満は B、そのあとは小数 1 けた", () => {
    expect(fmtSize(448)).toBe("448 B");
    expect(fmtSize(0)).toBe("0 B");
    expect(fmtSize(300 * 1024)).toBe("300.0 KB");
    expect(fmtSize(1536)).toBe("1.5 KB");
    expect(fmtSize(300 * 1024 + 1)).not.toBe("1 MB");
    expect(fmtSize(2.4 * 1024 ** 2)).toBe("2.4 MB");
    expect(fmtSize(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

describe("日付(この端末の時間)", () => {
  it("UTC の 11/11 20:00 は、日本の時間では 11/12", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      expect(localDate("2026-11-11T20:00:00.000Z")).toBe("2026-11-12");
      expect(localDate("2026-11-11T14:59:59Z")).toBe("2026-11-11");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
  it("読めない値は前の 10 文字", () => {
    expect(localDate("2026-02-01")).toBe("2026-02-01");
    expect(localDate("x")).toBe("x");
  });
});

describe("ページのタイトル", () => {
  it("「画面 - CraftShelf」・設定は「設定: まとまり - CraftShelf」", () => {
    expect(pageTitle("ライブラリ")).toBe("ライブラリ - CraftShelf");
    expect(pageTitle("サーバー: alpha")).toBe("サーバー: alpha - CraftShelf");
    expect(pageTitle()).toBe("CraftShelf");
    expect(settingsTitle("members")).toBe("設定: ユーザーと権限 - CraftShelf");
    expect(settingsTitle("storage")).toBe("設定: ストレージ - CraftShelf");
    expect(settingsTitle(undefined)).toBe("設定 - CraftShelf");
    expect(settingsTitle("nothing")).toBe("設定 - CraftShelf");
  });
  it("英語表示でも、日本語が残らない", () => {
    const all = [pageTitle("ライブラリ"), pageTitle("ホーム"), pageTitle("セット"), pageTitle("サーバー"), pageTitle("サーバー: alpha"), pageTitle("比較"), pageTitle("ファイル比較"),
      pageTitle("ポート"), pageTitle("処理"), pageTitle("サーバー本体"), pageTitle("ログイン"), pageTitle("アカウントの作成"), pageTitle("パスワードを忘れたとき"),
      pageTitle("パスワードの再設定"), pageTitle("利用規約"), pageTitle("プライバシー"), pageTitle("チームへの招待"), settingsTitle(),
      ...Object.keys(SETTING_LABEL).map((k) => settingsTitle(k))];
    for (const t of all) expect(translate(t), t).not.toMatch(/[぀-ヿ㐀-鿿]/);
    expect(translate(settingsTitle("members"))).toBe("Settings: Users and permissions - CraftShelf");
    expect(translate(pageTitle("サーバー: alpha"))).toBe("Server: alpha - CraftShelf");
    expect(translate(pageTitle("ライブラリ"))).toBe("Library - CraftShelf");
  });
});

describe("Ctrl K の行き先は、いまの画面の名前", () => {
  const labels = PAGE_HITS.map((h) => h.label);
  it("設定の左の一覧・メニューの名前で、足りない行き先(サーバー本体・パスキー・設定の各まとまり)がある", () => {
    for (const l of ["ユーザーと権限", "ストレージ", "ユーザーごとの利用状況", "設定", "操作の記録と通知", "比較", "処理", "サーバー本体", "パスキー", "パスワードと二段階認証",
      "見た目と言語", "API トークン", "CurseForge API キー", "受け取る版", "はじめの設定", "パネルのアップデート", "v02 からの取り込み", "お問い合わせ・要望", "利用状況の送信", "アドオンの整理", "ライブラリ", "ホーム", "セット", "サーバー", "ポート", "ファイル比較"]) {
      expect(labels, l).toContain(l);
    }
  });
  it("古い名前は無い", () => {
    for (const old of ["チーム", "保存先", "利用状況", "アカウントの設定", "操作の記録と Discord への通知", "サーバーの比較", "処理の一覧", "バックアップ "]) expect(labels, old).not.toContain(old);
  });
  it("行き先はどれも、実在する画面", () => {
    const tree = readFileSync("src/routeTree.gen.ts", "utf8");
    for (const h of PAGE_HITS) expect(tree, h.to).toContain(`'${h.to}'`);
  });
  it("設定の各まとまりは、同じ名前で出す(左の一覧・見出し・タイトル)", () => {
    expect(SETTING_LABEL.members).toBe("ユーザーと権限");
    expect(PAGE_HITS.find((h) => h.label === "パスキー")).toMatchObject({ to: "/settings", search: { s: "passkeys" }, sub: "設定" });
  });
});

describe("そろえる・入れる結果の一行のまとめ", () => {
  it("入れた・更新した・変えなかった(理由つき)・入れなかった・入れられなかった", () => {
    const list = [
      { title: "A", status: "installed", detail: "1.0" }, { title: "B", status: "updated", detail: "5.4.1 → 5.3.0(そろえる元と同じ版)" },
      { title: "C", status: "present", detail: "同じ版です(2.0)" }, { title: "D", status: "present", detail: "同じ版です(3.0)" }, { title: "E", status: "present", detail: "無効にしています(1.0)" },
      { title: "F", status: "skipped", detail: "配布元が分からないので入れません" }, { title: "G", status: "failed", detail: "対応していません" },
    ] as const;
    expect(applySummary([...list])).toEqual(["入れた 1", "更新した 1", "変えなかった 3(同じ版です 2・無効にしています)", "入れなかった 1(配布元が分からないので入れません)", "入れられなかった 1"]);
    expect(applySummary([])).toEqual([]);
  });
  it("英語表示", () => {
    expect(translate("入れた 2")).toBe("Added 2");
    expect(translate("更新した 1")).toBe("Updated 1");
    expect(translate("変えなかった 3(同じ版です 2・無効にしています)")).toMatch(/^Unchanged 3 \(.*Same version.*\)$/);
    expect(translate("入れなかった 1(配布元が分からないので入れません)")).toMatch(/^Skipped 1 \(.*\)$/);
    expect(translate("入れられなかった 1")).toBe("Failed 1");
    expect(translate("すでに入っていた 2")).toBe("Already installed 2");
    expect(translate("5.4.1 → 5.3.0(そろえる元と同じ版)")).toBe("5.4.1 → 5.3.0(same as the source)");
    for (const t of ["同じ版です(2.0)", "配布元が分からないので入れません", "入っていないので入れません", "無効にしています(1.0)"]) expect(translate(t), t).not.toMatch(/[぀-ヿ㐀-鿿]/);
  });
});

describe("ライブラリの一覧の説明は、どの出どころのものも同じ形", () => {
  const base = { createdAt: "2026-11-11T00:00:00Z" };
  it("版 · N バージョン · 大きさ · 日付(分からない値だけ省く)", () => {
    expect(itemSub({ ...base, version: "5.4.1", files: 0, size: 0 }, false)).toBe("5.4.1 · 1 バージョン");
    expect(itemSub({ ...base, version: "5.4.1", files: 2, size: 2457 }, false)).toBe("5.4.1 · 2 バージョン · 2.4 KB");
    expect(itemSub({ ...base, version: "", files: 0, size: 0 }, false)).toBe("");
    expect(itemSub({ ...base, version: "1.0", files: 1, size: 100 })).toMatch(/^1\.0 · 1 バージョン · 100 B · \d{4}\/\d+\/\d+$/);
  });
});

describe("出どころの名前", () => {
  it("upload は「アップロード」と出す", () => {
    expect(sourceLabel("upload")).toBe("アップロード");
    expect(sourceLabel("modrinth")).toBe("Modrinth");
    expect(sourceLabel("other")).toBe("other");
  });
});

describe("YAML の誤りの行は、ファイルにある行まで", () => {
  it("閉じていないまま終わっても、ファイルに無い次の行は指さない", async () => {
    expect(yamlLine("a: 1\nb: [1, 2\n", 3)).toBe(2);
    expect(yamlLine("a: 1\nb: 2\n\n\n", 9)).toBe(2);
    expect(yamlLine("a: 1\nb: 2", 2)).toBe(2);
    expect(yamlLine("a: 1", undefined)).toBeUndefined();
    expect(await syntaxError("a.yml", "a: 1\nb: [1, 2\n")).toMatch(/^2 行目: YAML/);
    expect(await syntaxError("a.yml", "a: 1\nb: 'x\n")).toMatch(/^2 行目: YAML/);
    expect(await syntaxError("a.yml", "a: 1\nb: 2\n  c: 3\n")).toMatch(/^2 行目: YAML/); // 途中の行はそのまま
  });
});

describe("画面の英訳(03.73.02 で足したもの・訳し残しの直し)", () => {
  it("訳されない入力欄・見出し", () => {
    for (const t of ["変更を元に戻す", "起動・停止の設定を開く", "退避", "ライブラリ管理 3 件", "押すと確かめます", "対応サーバー(カンマで区切る。空なら配布元のとおり)", "アドオンの種類とバージョン", "お知らせ", "処理",
      "そろえ方", "入っているものの版だけ、元と同じにする", "3 件を入れる", "入っている 2", "種類が合わない 1", "入れるものはありません", "入れるものはありませんでした", "アドオン: 最新(サーバー本体の新しいビルドは、サーバーの画面で確かめます)", "アドオン: 更新 3 件"]) {
      expect(translate(t), t).not.toMatch(/[぀-ヿ㐀-鿿]/);
    }
    expect(translate("変更を元に戻す")).toBe("Undo change");
    expect(translate("ライブラリ管理 3 件")).toBe("Library: 3 items");
    expect(translate("3 件を入れる")).toBe("Add 3");
    expect(translate("入っている 2")).toBe("Installed 2");
    expect(translate(" · ")).toBe(" · ");
    expect(translate("(管理者以上)")).toBe("(Admin or higher)");
    expect(translate("要る範囲: ")).toBe("Needs: ");
    expect(translate("2 秒")).toBe("2 s");
    expect(translate("重複・番号の誤りが 1 件あるため保存できません")).toBe("Cannot save: 1 duplicate or invalid port numbers");
    expect(translate("「beta」の ゲームが使っています")).toBe("“beta”'s Game is using it");
    expect(translate("beta(ゲーム) と同じ番号です")).toMatch(/^Same number as beta/);
    expect(translate("一覧の表示")).toBe("List view");
    expect(translate("CurseForge を使うには、設定の「CurseForge API キー」で API キーを設定してください")).not.toMatch(/[぀-ヿ㐀-鿿]/);
  });
});
