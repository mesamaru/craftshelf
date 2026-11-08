// 英語表示: 辞書・数字と組み合わさる文・1 文字の語(曜日)
import { describe, expect, it } from "vitest";
import { translate } from "~/lib/i18n";

describe("英語表示", () => {
  it("辞書・数字の文・記号を置き換え、日本語の無いものはそのまま", () => {
    expect(translate("保存")).toBe("Save");
    expect(translate("3 件")).toBe("3 items");
    expect(translate("30 日")).toBe("30 days");
    expect(translate("日")).toBe("Sun");
    expect(translate("月水 04:00・そろえる")).toMatch(/^Mon Wed 04:00 · /);
    expect(translate("Paper 1.21.4")).toBe("Paper 1.21.4");
    expect(translate("ロビー をサーバーに入れる")).toBe("Add ロビー to a server");
    expect(translate(" 件")).toBe(" items"); // {n} 件 のように分かれた単位
    expect(translate(" 台(入れたもの ")).toBe(" servers(installed ");
    expect(translate("3 件を選んでいます")).toBe("3 selected");
    expect(translate("LuckPerms を選ぶ")).toBe("Select LuckPerms");
    expect(translate("更新を確かめています…")).toBe("Checking for updates…");
    expect(translate("自動更新")).toBe("Auto update");
    expect(translate("自動更新(6 時間ごとに、新しい版があれば入れる)")).toBe("Auto update (every 6 hours, install new versions if any)");
    expect(translate("プラグインを外す・入れ替えるときは、設定フォルダ(plugins/〈名前〉/)も plugins/.craftshelf-config に退避し、元に戻すと設定も戻します(ファイルが 100 個・20 MB を超えるフォルダは退避しません)。")).toMatch(/^When a plugin is removed/);
    expect(translate("選んだ 2 台へ反映")).toBe("Promote to 2 selected");
    expect(translate("外したファイルは消さずに名前を変えて残すので、元に戻せます(1 台につき新しい 30 件まで)。変更はサーバーの再起動で反映されます。")).toMatch(/^Removed files are kept/);
    expect(translate("入っているもの(plugins/)")).toBe("Installed (plugins/)");
    expect(translate("新しいパスワード(10 文字以上)")).toBe("New password (10+ characters)");
    expect(translate("匿名の利用状況を送る(1 日 1 回)")).toBe("Send anonymous usage (once a day)");
    expect(translate("この版は、このサーバーの種類・バージョンに合いません")).toBe("This version does not fit this server's type and version");
    expect(translate("2 個")).toBe("2 items"); // パスキーの数など
    expect(translate("1 個")).toBe("1 item");
    expect(translate("自動")).toBe("Auto");
    expect(translate("新しいバージョンがあります")).toBe("New versions available");
    expect(translate("水曜日")).toBe("Wed");
    expect(translate("保存先「NAS」のバックアップ(新しい 5 個)")).toBe("Backups in storage “NAS” (newest 5)");
    expect(translate("作れませんでした: 時間帯が正しくありません")).toBe("Failed: Invalid time zone");
  });
});
