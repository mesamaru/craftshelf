# CraftShelf 開発メモ

- 利用者への説明・UIの文言は日本語。
- **変更をコミットするたびに `VERSION` を上げ、`CHANGELOG.md` の先頭に見出しを追加する。**
  - 形式は `00.00.00`(2桁ずつ、メジャー.マイナー.修正)。
  - メジャー: 互換性のない変更 / マイナー: 機能追加 / 修正: 不具合修正・小さな改善。上の桁を上げたら下の桁は 00 に戻す。
  - CHANGELOG の見出しは `## 01.02.03 - YYYY-MM-DD タイトル`(画面の「パネルの更新」がこの形式を読む)。
- 稼働中のパネルは GitHub (`mesamaru/craftshelf` の `main`) の `VERSION` を見て更新を検知し、`git clone` → `rsync` で /app を入れ替えて再起動する(`selfupdate.py`)。`main` に push した時点で配布されるので、動作確認してから push すること。
- 構成: `app.py`(Flask本体)/ `storage.py`(ローカル・SMB・WebDAV)/ `sources.py`(Modrinth・Spiget・CurseForge)/ `selfupdate.py` / `ptero.py`(Pterodactyl Client API)/ `notify.py`(Discord Webhook)/ `static/index.html`・`app.css`・`app.js`(画面。CSP のためインラインの script は使わない)。
- デザインは Apple の Liquid Glass(iOS 26 以降)を参考にしている(半透明のガラス素材・グループリスト・シート・カプセル型ボタン)。
