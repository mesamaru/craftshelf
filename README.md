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
- **配布元(Modrinth / SpigotMC / CurseForge)と連携して、最新版の確認・ダウンロード**(下記)
- **アカウントでログイン**(閲覧のみ / 編集者 / 管理者)
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

## ログイン(アカウント)

初めて画面を開くと「初期設定」画面になるので、**管理者アカウント**を作成してください。以降はログインが必要です。

右上の「ユーザー管理」(管理者のみ)から、ほかのユーザーを追加できます。

| 権限 | できること |
| --- | --- |
| 閲覧のみ | 一覧の閲覧・ダウンロード |
| 編集者 | ＋ 登録・編集・削除・inbox取り込み・配布元の紐付け・更新の確認と保存 |
| 管理者 | ＋ ストレージ設定・保存先の移行・ユーザー管理・設定 |

- パスワードはハッシュ化して保存されます。ログインの失敗が続くと10分ほどロックされます
- パスワードを忘れた場合は、ほかの管理者が「ユーザー管理」から再設定できます
- 環境変数 `AUTH_USER` / `AUTH_PASS` を指定しておくと、ユーザーが1人もいないときにその名前で管理者が自動作成されます(以前のBasic認証の設定は、そのまま管理者アカウントとして引き継がれます)

## 配布元との連携・更新の取得(Modrinth / SpigotMC / CurseForge)

登録したプラグイン・Modを配布サイトと紐付けると、最新版の確認と、更新ファイルのダウンロード・保管ができます。

- **自動で探す**: 保存済みファイルのハッシュで Modrinth(CurseForge はAPIキー登録時)を照合し、一致すれば自動で紐付けます。プラグインは SpigotMC で名前が完全に一致するものがあれば紐付けます(名前での推定なので、違っていたら「紐付け直す」)。見つからない場合は候補が表示されます
- **URLで紐付け**: 配布ページのURL(例 `https://modrinth.com/plugin/luckperms`、`https://www.spigotmc.org/resources/luckperms.28140/`、`https://www.curseforge.com/minecraft/mc-mods/jei`)を貼り付け
- **URLから追加**: まだ持っていないものを、配布ページのURLから最新版をダウンロードして登録します
- **更新を確認**: 紐付け済みのものをまとめて確認し、新しい版があれば一覧に「更新あり」と表示します。「その他… → 確認して更新をすべて保存」で一括ダウンロードもできます
- **絞り込み**: Mod は「ローダー(fabric / neoforge / forge など)」と「Minecraftのバージョン」で絞り込まないと、別のMCバージョン向けの版が最新と判定されることがあります。アイテムの「絞り込みを変更」で設定してください(ハッシュで見つかった場合は自動で設定されます)
- **定期確認**: 右上「⚙ 設定」で、6時間〜1週間ごとの自動確認と、見つかった更新の自動ダウンロードを設定できます

注意:
- **NeoForge / Forge / Fabric** は Mod の「ローダー」の種類で、Mod 自体は Modrinth / CurseForge で配布されています。ローダーの絞り込みで対応します
- **CurseForge** は公式APIキーが必要です(https://console.curseforge.com で無料発行 → 「⚙ 設定」に登録)。また作者が外部ツールからのダウンロードを許可していないファイルは、自動ダウンロードできません(配布ページへのリンクが表示されます)
- **SpigotMC** は非公式API(Spiget)を使います。有料リソースや外部サイトで配布されているものは自動ダウンロードできません
- コンテナからインターネット(api.modrinth.com / api.spiget.org / api.curseforge.com)に接続できる必要があります

## 保存先の中身の確認と移行

「🗄 ストレージ設定」の各保存先で:

- **中身を確認**: 登録済みの件数・サイズ・見つからないファイル・未登録のファイル・inbox の中身を、切り替えずに確認できます
- **移行…**: 登録済みのファイルと情報(バージョン・メモ・配布元の紐付け)を、別の保存先へ **コピー** または **移動** します。移行先に同じファイルがあればスキップするので、何度実行しても重複しません。処理は裏で進み、画面上部に進み具合が表示されます

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
| `AUTH_USER` / `AUTH_PASS` | なし | ユーザーが1人もいないときに、この名前・パスワードで管理者を自動作成する |
| `GITHUB_REPO` | なし | `ユーザー名/リポジトリ名`。設定すると起動のたびに最新コードを取得(Dockerのみ) |
| `GITHUB_BRANCH` | `main` | 取得するブランチ |
| `AUTO_UPDATE` | `true` | `false` にすると自動更新を止める |

## 注意

- ログインは必須ですが、家庭内LAN向けの道具です。インターネットには直接公開しないでください(外から使う場合は VPN や Tailscale などを経由してください)。
- `index.db` は SQLite です。Unraid の共有フォルダ上でロックのエラーが出る場合は、`DB_DIR` をキャッシュ上の appdata に分けてください。
- 「削除」は保存先のファイルも実際に消します(ゴミ箱はありません)。
