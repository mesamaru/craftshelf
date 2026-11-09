# CraftShelf v03 の入れ方・更新・ログインを戻す(自分用の版)

v03 は 3 つの形で動かせます。どれも中身は同じで、データは `<データの場所>/v03` に置きます(v02 のデータはそのまま残します)。

| 形 | 向いている人 | データの場所 | 開くアドレス |
|---|---|---|---|
| Docker | サーバー機・NAS | `./data`(コンテナの中は `/data`) | `http://<サーバー機>:8765` |
| install.sh(Linux・systemd) | Docker を使わない Linux のサーバー機 | `/var/lib/craftshelf` | `http://<サーバー機>:8765` |
| Windows・macOS の配布物(Node.js ごとまとめた zip・tar.gz) | 自分のパソコン | v02 のインストーラー版と同じ(下) | `http://127.0.0.1:8765` |

初めて開いたときは、最初の 1 人が管理者(オーナー)になります。v02 のデータがある場所で起動すると、初めての起動で v02 のデータを取り込みます(v02 のデータには書き込みません。取り込むものは [README](../README.md) の「v02 から取り込むもの」)。

## Docker

[README](../README.md) の「サーバー機で動かす(Docker・自分用)」のとおりです。v02 からは、`docker-compose.yml` の `image:` を `ghcr.io/mesamaru/craftshelf:v03`(開発版は `:dev`)に変えるか、v02 のパネルの「v03 に移る」で移れます。

## install.sh(Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/mesamaru/craftshelf/dev/install.sh | sudo bash
```

- GitHub のリリースから、Node.js ごとまとめた一式(`craftshelf-v03-<版>-linux-x64.tar.gz` / `-linux-arm64`)を取ってきて、チェックサムを確かめて `/opt/craftshelf-v03` に置き、systemd のサービス `craftshelf`(ユーザー `craftshelf`)にします。Node.js を別に入れる必要はありません。
- 設定(環境変数): `CRAFTSHELF_PORT`(既定 8765)・`CRAFTSHELF_HOST`(既定 0.0.0.0)・`CRAFTSHELF_CHANNEL`(`stable` = 安定版〔既定〕/ `dev` = 開発版も)・`CRAFTSHELF_VERSION`(`03.62.00` のように版を決める)。例: `curl … | sudo CRAFTSHELF_CHANNEL=dev bash`
- もう一度動かすと新しい版に入れ替えます(データはそのまま)。パネルの「パネルのバージョン」・自動アップデートでも更新できます。
- 状態: `systemctl status craftshelf` / ログ: `journalctl -u craftshelf -f` / 取り除く: `sudo bash install.sh --uninstall`(データは残します)
- **v02 の install.sh から移る**: そのまま v03 の install.sh を動かします。データは v02 と同じ `/var/lib/craftshelf` を使い、サービスの名前も同じ `craftshelf` なので、v03 のサービスに入れ替わり、初めての起動で v02 のデータを取り込みます。v02 の一式(`/opt/craftshelf`)は消しません。**v02 に戻す**ときは、v02 の install.sh(main の `install.sh`)をもう一度動かします(v02 のデータは書き換えていないので、そのまま使えます)。

## Windows・macOS

GitHub のリリースから、OS に合うものを取ってきて展開します。

- Windows: `craftshelf-v03-<版>-win-x64.zip` → 展開した `CraftShelf` フォルダの `CraftShelf.cmd` をダブルクリック
- macOS: `craftshelf-v03-<版>-darwin-arm64.tar.gz`(Apple シリコン)/ `-darwin-x64`(Intel)→ `CraftShelf.command` をダブルクリック(開けないときは、右クリック →「開く」)

パネルが起動し、ブラウザで `http://127.0.0.1:8765/` が開きます。もう一度ダブルクリックすると、動いていればブラウザだけを開きます。

- **タスクトレイ(Windows)・メニューバー(macOS)のアイコン**: v02 と同じく、アイコンのメニューに「CraftShelf を開く」「保存先フォルダを開く」(データの場所)「終了」があります。**止めるときは「終了」**を選びます(パネルも止まります)。
  - Windows: 起動を見届けたら、コマンドの窓は閉じます(記録はデータの場所の `craftshelf.log`)。アイコンは、タスクバーの右の「^」(隠れているアイコン)の中に入ることがあります。いつも見えるようにするには、アイコンをタスクバーへドラッグします。起動できなかったときは窓を残して理由を出します。
  - macOS: メニューバーにアイコンが出ます。ターミナルのウィンドウを閉じても止まります。**署名していない**ため、ダウンロードしたものをそのまま展開すると、macOS がメニューバーのアイコンの部品(`craftshelf-tray`)を止めることがあります(アイコンが出ないだけで、パネルは動きます)。そのときはターミナルで `xattr -dr com.apple.quarantine <展開した CraftShelf のフォルダ>` を動かしてから起動し直します。
  - アイコンを出さないときは `--no-tray` を付けて起動します(`CraftShelf.cmd --no-tray`)。そのときは、これまでどおりウィンドウが出たままになり、ウィンドウを閉じると止まります。

- **データの場所**: Windows は `%LOCALAPPDATA%\CraftShelf`、macOS は `~/Library/Application Support/CraftShelf`(v02 のインストーラー版と同じ)。ほかの場所にするときは `CraftShelf.cmd --data-dir D:\CraftShelf` のように起動します(ショートカットのリンク先に足せます)。
- **LAN のほかの端末から開く**: データの場所の `launcher.json` に `{"host": "0.0.0.0", "port": 8765}` と書きます(v02 と同じ)。
- **パソコンの起動時に動かす**: Windows は Win+R で `shell:startup` を開いて `CraftShelf.cmd` のショートカットを置きます。macOS は「システム設定」→「一般」→「ログイン項目」に `CraftShelf.command` を足します。
- 記録はデータの場所の `craftshelf.log` に出ます(ウィンドウが出ているときは、そこにも)。
- **v02 のインストーラー版から移る**: v02 をタスクトレイの「終了」で止め、v02 を自動で起動する設定にしていれば外してから、v03 を起動します。データの場所が同じなので、初めての起動で v02 のデータを取り込みます(ポートも同じ 8765 なので、v02 と同時には動かせません)。v02 に戻すときは、v03 をアイコンの「終了」で止めて v02 を起動します。
- 更新: パネルの「パネルのバージョン」・自動アップデートで新しい版を取ってきます(データの場所の `v03/versions` に置きます)。中に入っている Node.js は配布物のものなので、Node.js の新しい版が要るようになったら、新しい配布物を取ってきて入れ替えてください。

## パネルの更新・自動アップデート・この更新の前に戻す

「アカウント」→「パネルのバージョン」(「パネルの設定」の権限がある人)で:

- **版の切り替え**: GitHub にある v03 の版(安定版 `v03.xx.xx`・開発版 `dev-v03.xx.xx`)を選んで入れ替えます。切り替える前に、パネルのバックアップを作ります(置き場所・残す数は「チーム」→「バックアップ」の定期バックアップの設定のもの。データベースが PostgreSQL のときは作りません)。
- **自動アップデート**: オンにすると、6 時間ごとに GitHub を確かめ、新しい版があればバックアップを作ってから入れて再起動します。「安定版だけ」か「開発版も」を選べます。大きな版上げ(v04 など、メジャーが変わるもの)・時間のかかる処理が動いている間は入れません。v02 で自動アップデートを使っていたら、安定版だけで引き継ぎます。
- **この更新の前に戻す**: 「更新の記録」から選ぶと、その更新の前に作ったバックアップを次の起動で戻し、版も前のものにして再起動します(今のデータは `v03/before-restore-…` に残します)。データを戻すので、管理者以上だけが使えます。戻した版は、自動アップデートでは入れ直しません。更新の前のバックアップは、定期バックアップの「残す数」を超えると古いものから消えます。
- 設定と更新の記録は `v03/panel-update.json` に置きます(バックアップから戻しても消えないように、データベースの外に置いています)。

## ログインを戻す(オーナーが端末も予備のコードもなくしたとき)

二段階認証の端末も予備のコードもなく、ほかに戻せる管理者もいないときは、**サーバーの上で**次のコマンドを動かします。その人の二段階認証とパスキーを外し、パスワードを新しいものに置き換えて、ほかのログインを全部切ります。新しいパスワードは画面に出ます。

| 形 | コマンド |
|---|---|
| Docker | `docker exec craftshelf node /app/launcher.mjs reset-owner <メールアドレスか名前>` |
| install.sh | `sudo -u craftshelf /opt/craftshelf-v03/node/bin/node /opt/craftshelf-v03/launcher.mjs reset-owner <メールアドレスか名前> --data-dir /var/lib/craftshelf` |
| Windows | `CraftShelf.cmd reset-owner <メールアドレスか名前>`(コマンドプロンプトで、CraftShelf のフォルダで) |
| macOS | `./CraftShelf.command reset-owner <メールアドレスか名前>`(ターミナルで) |

- 名前は、v02 から取り込んだ人なら v02 のユーザー名です。同じ名前の人が複数いるときは、メールアドレスで指定します。
- コマンドはデータの場所に頼みごと(`v03/reset-owner.json`)を置き、動いているパネルが数秒で片付けて結果を返します。パネルが止まっているときは、10 分以内に起動すれば片付けます(それより古い頼みごとは使いません)。頼みごとのファイルは片付けたらすぐ消します。
- データの場所に書ける人(= サーバーに入れる人)だけが使えます。使ったことは「操作の記録」に「サーバーの上でログインを戻す」として残ります。
- ログインしたら、すぐに「アカウント」でパスワードを変え、二段階認証を設定し直してください。

## 配布物を作る(開発する人向け)

`npm run build` のあと `node scripts/package.mjs`(動かしている OS 向け)/ `node scripts/package.mjs all`(全部。Linux で)で `dist/` に作ります。公式の Node.js を取ってきて(チェックサムで確かめる)、`app/`(`.output`・`drizzle`・`VERSION`)・`launcher.mjs`・起動するファイル・タスクトレイの部品(Windows は `packaging/tray.ps1`、macOS は `packaging/craftshelf-tray`)とまとめます。macOS の `craftshelf-tray` は macOS で `swiftc` を使って `packaging/tray-macos.swift` から作ります(ワークフローの `tray-macos` のジョブ。手元で作らないときは、macOS 向けにはアイコンを入れずに作ります)。`v03.xx.xx` のタグ(`release-v03.yml`)と `dev` への push(`image.yml` の開発版のリリース)で、全部の OS 向けに作ってリリースに付けます。
