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
    expect(translate(" · 3 / 20 人 · 12 ms")).toBe(" · 3 / 20 players · 12 ms");
    expect(translate("232(試験版)(今)")).toBe("232 (experimental, current)");
    expect(translate("選んだ 2 台をまとめて最新にする(最新のものは飛ばす)")).toBe("Update 2 selected servers to the newest builds (skip up-to-date ones)");
    expect(translate("送っています… 2 / 5")).toBe("Uploading… 2 / 5");
    expect(translate("2026/1/4 4:00:00 まで使えます(5 回まで)。この URL は今だけ表示します。")).toBe("Valid until 2026/1/4 4:00:00 (up to 5 downloads). This URL is shown only now.");
    expect(translate("期限はありません。この URL は今だけ表示します。")).toBe("No expiry. This URL is shown only now.");
    expect(translate("共有リンク「Lobby」の 2 件")).toBe("2 items in share link “Lobby”"); // v02 から取り込んだ結果
    expect(translate("前提の紐付け: 自作 → LuckPerms(LP-Core)")).toBe("Dependency link: 自作 → LuckPerms(LP-Core)");
    expect(translate("操作 12 回(30 日で 3 回)")).toBe("12 actions (3 in the last 30 days)");
    expect(translate("「ロビー」を「検証」にそろえますか?(入っているものだけ合わせる)")).toBe("Sync “ロビー” with “検証”? (Only match what is installed)");
    expect(translate("5 回")).toBe("5 times");
    expect(translate("チームの既定(正式版だけ)")).toBe("Team default (releases only)");
    expect(translate("LuckPerms を足しました")).toBe("Added LuckPerms");
    expect(translate(" — 前提が入っていません")).toBe(" — dependency not installed");
    expect(translate("前提が入っていません: ")).toBe("Dependency not installed: ");
    expect(translate("前提")).toBe("Dependencies");
    expect(translate("57 個の API")).toBe("57 APIs");
    expect(translate("1 分 5 秒")).toBe("1 min 5 s");
    expect(translate("要る範囲: サーバーの操作(編集者以上)")).toBe("Needs: Server control (Editor or higher)");
    expect(translate("この API トークンの範囲では、この操作はできません(要る範囲: 管理)")).toBe("This API token's scopes do not allow this (needs: Admin)");
    expect(translate("戻しました(12 ファイル)。前のワールドは world.craftshelf-before-restore-1 に残しています")).toBe("Restored (12 files). The previous world is kept as world.craftshelf-before-restore-1");
    // 03.69.00: サーバー(一覧と詳細の 1 画面)・セット・設定・ホームのウィジェット
    expect(translate("対応が必要")).toBe("Needs attention");
    expect(translate("2 台・5 件")).toBe("2 servers · 5 updates");
    expect(translate("アドオン 6")).toBe("Add-ons 6");
    expect(translate("ほか 3 件")).toBe("3 more");
    expect(translate("常に最新")).toBe("Always latest");
    expect(translate("＋ セットを作成")).toBe("＋ Create set");
    expect(translate("「メモ」を消しますか?")).toBe("Delete “Note”?");
    expect(translate("足せるウィジェットは 12 個までです")).toBe("You can add up to 12 widgets");
    expect(translate("今年の 315 日目")).toBe("Day 315 of the year");
    expect(translate("11月11日")).toBe("Nov 11");
    expect(translate("(火)")).toBe("(Tue)");
    expect(translate("11/11(火)")).toBe("11/11 (Tue)");
    expect(translate("残り 3 件")).toBe("3 left");
    expect(translate("ユーザーと権限")).toBe("Users and permissions");
    // 03.68.00: v02 に合わせた枠・ホーム・ライブラリ
    expect(translate("5.4.145 · 2 バージョン · 2.4 KB · 2026/11/11")).toBe("5.4.145 · 2 versions · 2.4 KB · 2026/11/11");
    expect(translate("1.0 · 1 バージョン")).toBe("1.0 · 1 version");
    expect(translate("2 / 5 済み")).toBe("2 / 5 done");
    expect(translate("残り 3 件 ›")).toBe("3 more ›");
    expect(translate("未同期 2")).toBe("2 behind");
    expect(translate("ホーム")).toBe("Home");
    // 03.67.00: 設定の 2 段・セット
    expect(translate("メンバー(3 人)")).toBe("Members (3)");
    expect(translate("中身(2 件)")).toBe("Contents (2)");
    expect(translate("2 台を入れ替える")).toBe("Replace 2 servers");
    expect(translate("パスワードと二段階認証")).toBe("Password and two-factor");
    expect(translate("「ロビー」を「基本」にそろえますか?(足りないものも入れる)")).toBe("Sync “ロビー” with “基本”? (Also install missing items)");
    // 03.66.00: サーバーの一覧・詳細
    expect(translate("更新 2")).toBe("2 updates");
    expect(translate("新しい版 1 件")).toBe("1 new version");
    expect(translate("3 台を更新")).toBe("Update 3 servers");
    expect(translate("7 個を残す")).toBe("Keep 7");
    expect(translate("ロビー を停止しますか?")).toBe("Stop ロビー?");
    expect(translate("LuckPerms を 5.4.1 にしますか?")).toBe("Change LuckPerms to 5.4.1?");
    expect(translate("毎週 月曜日 05:00 · 入っているものを最新にする · 再起動")).toBe("Weekly Mon 05:00 · Update installed items · Restart");
    expect(translate("メモリ")).toBe("Memory");
    // 03.65.00: 新しい画面
    expect(translate("12 件を表示")).toBe("Show 12");
    expect(translate("3 件を入れました")).toBe("Installed 3");
    expect(translate("3 件を入れました。1 件は入れられませんでした")).toBe("Installed 3; 1 could not be installed");
    expect(translate("前提不足")).toBe("Missing deps");
    // 03.58.00: データパックなど
    expect(translate("入っているもの(plugins/・lobby/datapacks/)")).toBe("Installed (plugins/ · lobby/datapacks/)");
    expect(translate("新しい版 2.0")).toBe("New version 2.0");
    expect(translate("新しい版 3")).toBe("New versions 3");
    expect(translate("リソースパックなので、Paper のサーバーには入れません")).toBe("Resource packs cannot be installed on Paper servers");
    expect(translate("セット「My Pack 1.0」を作りました(4 件)。サーバーに入れました(失敗 0 件)")).toBe("Created set “My Pack 1.0” (4 items). Installed on the server (0 failed)");
    expect(translate("データパック")).toBe("Data pack");
    // 03.62.00: パネルの自動アップデート
    expect(translate("新しい版を自動で入れる(6 時間ごとに確かめる)")).toBe("Install new versions automatically (checks every 6 hours)");
    expect(translate("v03.61.00 → v03.62.00(自動)")).toBe("v03.61.00 → v03.62.00 (automatic)");
    expect(translate("2026/11/10 4:00:00 · 戻しました")).toBe("2026/11/10 4:00:00 · undone");
    // 03.59.00: セットの版の固定
    expect(translate("固定した版 4.0.0 は、このサーバーの種類・バージョンに合わないので飛ばしました")).toBe("Skipped: the pinned version 4.0.0 does not fit this server's type and version");
    expect(translate("5.4.0 → 5.3.0(固定した版)")).toBe("5.4.0 → 5.3.0 (pinned version)");
    expect(translate("版を固定しています(5.3.0)")).toBe("Pinned (5.3.0)");
    // 03.61.00: 配布元のファイルの保存など
    expect(translate("保存した版(2)")).toBe("Saved versions (2)");
    expect(translate("保存した版")).toBe("Saved versions");
    expect(translate(" 応答 12 ms")).toBe(" Response 12 ms");
    expect(translate(" · 容量 1.0 GB(空き 200 MB)")).toBe(" · Capacity 1.0 GB (200 MB free)");
    expect(translate(" · 登録しているファイル 3 個(4 MB、うち保存した版 2 個)")).toBe(" · Registered files 3 (4 MB, of which 2 saved versions)");
    expect(translate("3 個を調べ、2 個を取り込みました。取り込めなかったもの: inbox/a.jar(読めません)")).toBe("Checked 3, imported 2. Not imported: inbox/a.jar(読めません)");
    expect(translate("古い版: チームの既定(3 個残す)")).toBe("Old versions: team default (keep 3)");
    expect(translate("チームの既定(保存しない)")).toBe("Team default (don't save)");
    expect(translate("新しい方から 5 個残す")).toBe("Keep the newest 5");
    expect(translate("2 件が見つかりました(選んだもの 3.0 MB)")).toBe("Found 2 (selected 3.0 MB)");
    expect(translate("保存していないもの(2 件)は入りません: Alpha、Beta\nほかの 3 件をダウンロードしますか?")).toBe("2 items without saved versions are left out: Alpha, Beta\nDownload the other 3?");
    expect(translate("どのサーバーにも入っていません(セット「ロビー」に入っています)")).toBe("Not installed on any server (in set “ロビー”)");
    expect(translate("配布元の最後の更新は 2020-01-01")).toBe("Last updated at the source 2020-01-01");
    expect(translate("版 1 個・アドオン 2 件を消しました")).toBe("Deleted 1 versions and 2 add-ons");
  });
});
