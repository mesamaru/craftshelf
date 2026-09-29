# MC Pack Library

プラグイン・Mod・データパック・リソースパックを、ブラウザにドラッグ&ドロップするだけで整理・保管するツールです。
保存先は Unraid の共有フォルダに置けます。

## できること

- **ドロップで登録**: ファイル・フォルダ(まとめて数百個でも可)をブラウザに投げ込む。フォルダは中の .jar / .zip だけを拾います
- **自動で名前とバージョンを読み取り**
  - プラグイン: `plugin.yml` / `paper-plugin.yml` / `bungee.yml` / `velocity-plugin.json`
  - Mod: `fabric.mod.json` / `quilt.mod.json` / `mods.toml` / `neoforge.mods.toml` / `mcmod.info`
  - データパック・リソースパック: `pack.mcmeta`(名前・バージョンは無いのでファイル名から推測、`pack_format` も表示)
  - 読めなかったら「その他」に入れます(あとから編集できます)
- **名前をクリック → 保存済みの全バージョンを一覧**(新しい順/古い順、1.10 が 1.9 より新しい、beta より正式版が新しい、といった自然な順序で並びます)
- 同じファイルを二重に登録しない(中身のSHA-256で判定)
- 名前・バージョン・メモの編集、ダウンロード、削除
- 名前・保存数・サイズ・最終追加日での並び替え、種類での絞り込み、検索
- **inbox取り込み**: NASの `inbox/` フォルダに直接コピーしたファイルを一括登録(既存コレクションの初回取り込みに便利)

## ファイルの保存形式

NAS上には人が見てもわかる形で保存されます。このツールが壊れても、ファイルはそのまま使えます。

```
<保存先>/
  library/
    plugins/WorldEdit/WorldEdit-bukkit-7.3.0.jar
    plugins/WorldEdit/WorldEdit-bukkit-7.2.15.jar
    mods/Fabric API/fabric-api-0.92.0+1.20.1.jar
    datapacks/Terralith/Terralith_v2.5.5.zip
    resourcepacks/...
  inbox/        ← ここに入れて「inboxを取り込む」
  index.db      ← 名前・バージョンなどの記録(SQLite)
```

`index.db` を失っても、`library/` に置かれたファイルは「inboxを取り込む」で再登録できます(メモは消えます)。

## Unraid への導入

1. このフォルダごと Unraid に置く(例: `appdata` 共有の中に `mc-pack-library` フォルダ)
2. `docker-compose.yml` の `volumes` の左側を、保存したい共有フォルダに変更する(例: `/mnt/user/minecraft/library`)
3. Unraid のターミナル(または SSH)で実行

   ```
   cd /mnt/user/appdata/mc-pack-library
   docker compose up -d --build
   ```

   `docker compose` が使えない古い Unraid の場合は、次の2行でも同じです。

   ```
   docker build -t mc-pack-library .
   docker run -d --name mc-pack-library --restart unless-stopped \
     -p 8765:8080 -v /mnt/user/minecraft/library:/data -e TZ=Asia/Tokyo mc-pack-library
   ```

4. ブラウザで `http://<UnraidのIPアドレス>:8765` を開く

手動で更新する場合は、`app.py` などを差し替えて `docker compose up -d --build` をもう一度実行します。データは共有フォルダ側にあるので消えません。GitHub連携での自動更新は次の節を参照してください。

## 自動更新(GitHubから)

コンテナ起動のたびに、GitHubリポジトリの `main` ブランチ最新コードを取得して反映できます。`/data`(保存したファイルや `index.db`)には触れないので、アップデートしてもコレクションは消えません。

1. このフォルダの中身をGitHubの**公開(public)**リポジトリに push する

   ```
   cd mc-pack-library
   git init -b main            # すでに初期化済みならスキップ
   git add -A
   git commit -m "initial"
   git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
   git push -u origin main
   ```

2. `docker-compose.yml` の `GITHUB_REPO=` に `ユーザー名/リポジトリ名` を書く

   ```
   environment:
     - GITHUB_REPO=あなたのユーザー名/mc-pack-library
     - GITHUB_BRANCH=main
   ```

3. Dockgeでスタックを再起動(Restart)する。ログに `[update] 最新化しました: <コミットハッシュ>` と出れば成功です。以降、コンテナを再起動するたびに最新コードを取り込みます。画面右上の保存先の横にも反映済みのコミットが小さく表示されます。

自動更新を止めたいときは `AUTO_UPDATE=false` を追加してください。取得に失敗した場合(ネットワーク不通など)は、既存のコードのまま起動を続けるので、更新の失敗でサービスが止まることはありません。

非公開(private)リポジトリを使いたい場合は、`GITHUB_REPO` の代わりに個人アクセストークンを埋め込んだURL形式が必要になるので、その際は教えてください。

## 保存先をWeb画面から追加登録する(SMB / WebDAV・Nextcloud)

`docker-compose.yml` の `volumes` で指定した場所(初期状態では「ローカル」という保存先として扱われます)以外に、画面右上の「⚙ ストレージ設定」から、SMB(Windows共有)や WebDAV(Nextcloud など)の接続情報を登録して、いつでも切り替えて使えます。Unraidを使い続けつつ、将来TrueNASやNextcloudを追加で登録する、といった使い方ができます。

### 使い方

1. 画面右上の「⚙ ストレージ設定」を開き、「＋ 接続を追加」
2. 名前・種類を選んで入力
   - **SMB**(Unraid・TrueNAS など): サーバー(IPアドレス)・共有名。Unraidの「パブリック」共有ならユーザー名は空欄(ゲスト接続)でOK
   - **WebDAV**(Nextcloud など): URL・ユーザー名・パスワード。Nextcloud ならサーバーのURL(例 `https://cloud.example.com`)だけで、`/remote.php/dav/files/<ユーザー名>` は自動で補います。二段階認証を使っている場合は Nextcloud の「設定 → セキュリティ」で作った**アプリパスワード**を使ってください。自己署名証明書なら「証明書を検証しない」をオン
   - サブフォルダ(任意)を指定すると、共有の中のそのフォルダを保存先にします(無ければ作ります)
3. 「接続をテスト」で読み書きできるか確認してから「保存」
4. 一覧に追加された接続の「使用する」を押すと切り替わります

**切り替えると表示される一覧もその保存先のものに変わります**(それぞれの保存先は完全に独立したコレクションとして管理され、混ざりません)。ファイルの自動移行(コピー)は行わないので、既存のコレクションを別の保存先でも使いたい場合は、ファイルをその保存先の `inbox/`(または `library/`)にコピーしてから「inboxを取り込む」を使ってください。

### 特別な権限は不要

SMB / WebDAV はアプリ(Python)が直接通信する方式なので、OSの `mount` は使いません。`cap_add` / `security_opt` / `privileged` などの設定は不要で、Proxmox の非特権LXC の中の Docker でもそのまま動きます。

(以前のバージョンは OS の `mount` を使っていたため、非特権LXCなどでは「マウントの権限がありません」で失敗していました。以前に登録した SMB 接続はそのまま引き継がれます。NFS は非対応になったため、「編集」で SMB に変更してください。)

### そのほかの注意点

- 登録したパスワードはコンテナ内(`/config/secret.key` または `DATA_DIR` 配下)の鍵で暗号化して保存されます。バックアップの際はこの鍵ファイルも一緒に扱われるようにしてください(鍵を失うと保存済みパスワードは復号できなくなります)。
- `index.db`(登録情報)は常にコンテナ側(`CONFIG_DIR`)に置かれ、SMB / WebDAV 側にはファイル本体だけが保存されます。
- コンテナ起動時に、そのとき「使用中」になっている保存先へ自動で接続を試みます。NASの電源が入っていないなど接続に失敗した場合は、画面上部に警告バナーが表示され、アップロードはできませんが、アプリ自体は起動します。30秒ごとに自動で繋ぎ直しを試みるほか、設定パネルの「再接続」でもすぐ試せます。
- 「ローカル」保存先(初期状態、`docker-compose.yml` の `volumes` で指定した場所)は削除できません。

## PC上で試す(Dockerなし)

```
pip install -r requirements.txt
python app.py
```

`http://127.0.0.1:8765` が開けます。保存先を NAS にしたい場合は、NAS の共有フォルダをドライブにつないだうえで環境変数で指定します。

```
# Windows
set DATA_DIR=Z:\mc-library
python app.py
# 他のPCからもアクセスしたい場合は  set HOST=0.0.0.0  も追加
```

## 設定(環境変数)

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `DATA_DIR` | `./data`(Dockerでは `/data`) | 「ローカル」保存先の場所 |
| `CONFIG_DIR` (`DB_DIR`でも可) | `DATA_DIR` と同じ | `index.db` や暗号化鍵、ストレージ設定だけ別の場所(appdataなど)に置く場合 |
| `PORT` / `HOST` | `8765` / `127.0.0.1` | `python app.py` で起動するときのみ |
| `AUTH_USER` / `AUTH_PASS` | なし | 両方指定するとBasic認証がかかる |
| `GITHUB_REPO` | なし | `ユーザー名/リポジトリ名`。設定すると起動のたびに最新コードを取得(Dockerのみ) |
| `GITHUB_BRANCH` | `main` | 取得するブランチ |
| `AUTO_UPDATE` | `true` | `false` にすると自動更新を止める |

## 注意

- 認証はオプションです。家庭内LAN向けの道具なので、インターネットには公開しないでください。
- `index.db` は SQLite です。Unraid の共有フォルダ上でロックのエラーが出る場合は、`DB_DIR` をキャッシュ上の appdata に分けてください。
- 「削除」は保存先のファイルも実際に消します(ゴミ箱はありません)。
