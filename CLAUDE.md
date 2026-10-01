# CraftShelf 開発メモ

- 利用者への説明・UIの文言は日本語。
- **変更をコミットするたびに `VERSION` を上げ、`CHANGELOG.md` の先頭に見出しを追加する。**
  - 形式は `00.00.00`(2桁ずつ、メジャー.マイナー.修正)。
  - メジャー: 互換性のない変更 / マイナー: 機能追加 / 修正: 不具合修正・小さな改善。上の桁を上げたら下の桁は 00 に戻す。
  - CHANGELOG の見出しは `## 01.02.03 - YYYY-MM-DD タイトル`(画面の「パネルの更新」がこの形式を読む)。
- 稼働中のパネルは GitHub (`mesamaru/craftshelf` の `main`) の `VERSION` を見て更新を検知し、`git clone` → `rsync` で /app を入れ替えて再起動する(`selfupdate.py`)。`main` に push した時点で配布されるので、動作確認してから push すること。
- 構成: `app.py`(Flask本体)/ `storage.py`(ローカル・SMB・WebDAV)/ `sources.py`(Modrinth・Spiget・CurseForge)/ `selfupdate.py` / `ptero.py`(Pterodactyl Client API)/ `notify.py`(Discord Webhook)/ `static/index.html`・`app.css`・`app.js`(画面。CSP のためインラインの script は使わない)。
- 配布形態は Docker / インストーラー版(`launcher.py` を PyInstaller で実行ファイルにしたもの。`packaging/build.py`、Windows は `packaging/windows/craftshelf.iss`)/ Ubuntu 用 `install.sh` の3つ。`v01.02.03` 形式のタグを push すると `.github/workflows/release.yml` が各 OS 向けにビルドしてリリースを作る。インストーラー版は自分を書き換えられないので、パネルの更新は GitHub のリリースを案内する(`selfupdate.MODE`)。動的な import(`__import__` など)は PyInstaller が拾えないので使わない。
- 公開リポジトリなので、コミットの作成者は `mesamaru <74803890+mesamaru@users.noreply.github.com>` にする(個人のメールアドレスを使わない)。コード・例・コミットメッセージに、実際の IP アドレス・共有名・ドメインなど個人の環境の情報を書かない。
- ブランチ: `main` = 安定版(一般向け)、`dev` = 開発ビルド。開発は `dev` で行い、確認できたら `main` にマージする。開発ビルドのリリースは `dev-v01.02.03` タグ(プレリリース)、安定版は `v01.02.03` タグ。パネルは設定の「受け取るアップデート」でどちらを取得するか切り替える(`selfupdate.CHANNEL`)。
- **開発が終わったら、版と変更内容を利用者に報告し、公開(push・タグ)してよいか確認してから公開する。**
- 英語表示は `static/i18n-en.js` の辞書(日本語→英語)で画面の文字を置き換えている。**画面に新しい日本語の文言を足したら、この辞書にも英訳を追加する。** 利用者が入力した名前・メモなどには `translate="no"` を付けて翻訳させない。
- デザインは Apple の Liquid Glass(iOS 26 以降)を参考にしている(半透明のガラス素材・グループリスト・シート・カプセル型ボタン)。
