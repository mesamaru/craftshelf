# CraftShelf 開発メモ

- 利用者への説明・UIの文言は日本語。
- **変更をコミットするたびに `VERSION` を上げ、`CHANGELOG.md` の先頭に見出しを追加する。**
  - 形式は `00.00.00`(2桁ずつ、メジャー.マイナー.修正)。
  - メジャー: 互換性のない変更 / マイナー: 機能追加 / 修正: 不具合修正・小さな改善。上の桁を上げたら下の桁は 00 に戻す。
  - CHANGELOG の見出しは `## 01.02.03 - YYYY-MM-DD タイトル`(画面の「パネルの更新」がこの形式を読む)。
- 稼働中のパネルは GitHub (`mesamaru/craftshelf` の `main`) の `VERSION` を見て更新を検知し、`git clone` → `rsync` で /app を入れ替えて再起動する(`selfupdate.py`)。`main` に push した時点で配布されるので、動作確認してから push すること。
- 構成(02 から): 本体は `craftshelf/` パッケージ。層ごとのモジュールに分かれていて、**下の層は上の層を import しない**(どうしても要るときは関数の中で import する):
  `core`(設定・DB・移行・設定値)→ `analysis`(ファイルの解析)→ `auth`(暗号・ログイン・権限・配信)→ `events`(監査ログ・通知)→ `jobs`(ジョブと順番待ち)→ `library`(保存先・ライブラリ・セット・共有)→ `accounts`(ユーザー・個人設定・トークン・二段階認証)→ `upstream`(配布元・検索・Modパック)→ `servers`(サーバー)→ `system`(全体設定・自己更新・バックアップ・利用状況・予約)。
  `app.py` は入口だけ(gunicorn の `app:app`・launcher から読む。各モジュールの名前もまとめて見せる)。
- **データベースの変更は「足すだけ」**: 02 からは `craftshelf/core.py` の `MIGRATIONS` に、一度だけ実行するステップとして足す(表・項目を消したり、名前や意味を変えたりしない)。古い版が知らない表・項目を無視できるので、02 から 01.24 以降へ安全に戻せる。互換のない変更がどうしても要るときは、`DATA_FORMAT` の `write` を上げ、その番号を読める 01 の版(橋渡し)を先に出す。
- **テスト**: `python -m pytest`(依存は `tests/requirements.txt`)。コミットの前に通すこと。通しテストは `tests/flows/` に足し、最後に `FAILS: 0` を出して `sys.exit(1 if fails else 0)` で終える(結果を出さないものは失敗扱い)。外部のサービスを使うものは `tests/test_flows.py` の `NETWORK` に入れる。Windows ではパスが長いと読めないので、ファイル名は短くする。`.github/workflows/test.yml` が push ごとに動き、`release.yml` のビルドはこれが通ってから行う。
- **API を足したら説明も書く**: 関数の docstring(1 段落目)か `craftshelf/system.py` の `API_SUMMARY` に、ひとことの説明を書く(`tests/test_structure.py` が、説明の無い API を見つけると失敗する)。画面の「API の説明」(`/api/docs`)はルートの一覧から作られる。
- 受け取り先: 安定版 = `main`(タグ `v…`)/ 開発ビルド = `dev`(`dev-v…`)/ プレビュー(02)= `next`(`next-v…`)。
- 補助のモジュール: `storage.py`(ローカル・SMB・WebDAV)/ `sources.py`(Modrinth・Spiget・CurseForge)/ `selfupdate.py` / `ptero.py`(Pterodactyl Client API)/ `notify.py`(Discord Webhook)/ `static/index.html`・`app.css`・`static/js/*.js`(画面。CSP のためインラインの script は使わない)。画面の処理は役割ごとのファイル(base → auth → library → dashboard → servers → detail → jobs → settings → upload → init)に分かれていて、`index.html` がこの順に読む。ビルドの工程は無く、ファイル同士は名前を共有する(読み込んだ時点で動く処理は、前のファイルの名前だけを使う)。
- 配布形態は Docker / インストーラー版(`launcher.py` を PyInstaller で実行ファイルにしたもの。`packaging/build.py`、Windows は `packaging/windows/craftshelf.iss`)/ Ubuntu 用 `install.sh` の3つ。`v01.02.03` 形式のタグを push すると `.github/workflows/release.yml` が各 OS 向けにビルドしてリリースを作る。インストーラー版は自分を書き換えられないので、パネルの更新は GitHub のリリースを案内する(`selfupdate.MODE`)。動的な import(`__import__` など)は PyInstaller が拾えないので使わない。
- 公開リポジトリなので、コミットの作成者は `mesamaru <74803890+mesamaru@users.noreply.github.com>` にする(個人のメールアドレスを使わない)。コード・例・コミットメッセージに、実際の IP アドレス・共有名・ドメインなど個人の環境の情報を書かない。
- ブランチ: `main` = 安定版(一般向け)、`dev` = 開発ビルド。開発は `dev` で行い、確認できたら `main` にマージする。開発ビルドのリリースは `dev-v01.02.03` タグ(プレリリース)、安定版は `v01.02.03` タグ。パネルは設定の「受け取るアップデート」でどちらを取得するか切り替える(`selfupdate.CHANNEL`)。
- **開発が終わったら、版と変更内容を利用者に報告し、公開(push・タグ)してよいか確認してから公開する。**
- `telemetry/` は開発者用の受け口(Cloudflare Workers + D1)。パネルから送る項目を増やすときは、`telemetry_payload()`(app.py)・Worker の受け付ける項目(`telemetry/src/index.js`)・README の「プライバシー」・画面の説明(`teleWhat`)をそろえて更新する。
- 英語表示は `static/i18n-en.js` の辞書(日本語→英語)で画面の文字を置き換えている。**画面に新しい日本語の文言を足したら、この辞書にも英訳を追加する。** 利用者が入力した名前・メモなどには `translate="no"` を付けて翻訳させない。
- デザインは Apple の Liquid Glass(iOS 26 以降)を参考にしている(半透明のガラス素材・グループリスト・シート・カプセル型ボタン)。
