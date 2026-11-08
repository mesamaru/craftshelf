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
  });
});
