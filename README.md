# CraftShelf v03(開発中)

Minecraft サーバーの Mod・プラグインを管理する CraftShelf の次の版です。作りを新しくしました(TypeScript)。設計は [docs/DESIGN.md](docs/DESIGN.md)。

| ブランチ | 中身 |
|---|---|
| `main` | v02(安定版。いま配っているもの)。v03 へ移れるようにして、v02 の更新を終える予定 |
| `dev` | v03 の開発(ここで作り、試験する) |

多くの人が使うサービス版は [mesamaru/craftshelf-server](https://github.com/mesamaru/craftshelf-server) にあります(`dev` に合わせて更新します)。

いまできること: アカウントの作成・ログイン・二段階認証(認証アプリ)・パスキー・ログアウト、チーム(メンバーの招待・役割)、Pterodactyl パネルのサーバーの状態の確認と起動・停止、Modrinth から Mod・プラグインを探して入れる・更新する・外す。

## 手元で試す(Docker を使わない)

Node.js 24 以上が要ります。データベースは組み込みの PGlite(`.data/pg`)を使います。

```sh
npm ci
npm run dev        # http://localhost:3000
npm test           # テスト
npm run typecheck  # 型のチェック
npm run e2e        # ブラウザでの通しの確認(ビルドしたサーバーを PORT=3123 で動かしておく。Edge を使う)
```

## Docker を使わずに動かす(Linux の install.sh・Windows・macOS)

- Linux のサーバー機: `curl -fsSL https://raw.githubusercontent.com/mesamaru/craftshelf/dev/install.sh | sudo bash`(Node.js ごとまとめた一式を `/opt/craftshelf-v03` に置き、systemd のサービスにします。v02 の install.sh と同じデータ `/var/lib/craftshelf` を使います)
- Windows・macOS: リリースの `craftshelf-v03-<版>-win-x64.zip` / `-darwin-arm64.tar.gz` などを展開して、`CraftShelf.cmd` / `CraftShelf.command` をダブルクリック(データは v02 のインストーラー版と同じ場所)

入れ方・v02 からの移り方・自動起動・パネルの更新と自動アップデート・ログインを戻すコマンドは [docs/INSTALL.md](docs/INSTALL.md) にまとめています。

## サーバー機で動かす(Docker・自分用)

v02 と同じく、1 つのコンテナで動きます。設定は要りません(データベースも `./data/v03` の中に作ります)。

```sh
docker compose up -d     # docker-compose.yml(イメージ ghcr.io/mesamaru/craftshelf:dev)を使う
```

`http://サーバー機のアドレス:8765` を開き、最初の管理者を作ります。そのあとは、管理者が招待した人だけが登録できます。

- パスキーを使うときや、リバースプロキシの後ろに置くときは、開く URL を `APP_URL` に書きます
- **版の切り替え**: 管理者は「アカウント」→「パネルのバージョン」で、GitHub にある v03 の版を選んで更新したり、前の版に戻したりできます(ダウンロードした一式はチェックサムで確かめます。選んだ版が起動できなかったときは、イメージの版で起動します)。切り替える前にパネルのバックアップを作り、「この更新の前に戻す」で版とデータの両方を戻せます。6 時間ごとに確かめて自動で入れる設定(安定版だけ / 開発版も)もあります
- **ログインを戻す**: オーナーが二段階認証の端末も予備のコードもなくしたときは、`docker exec craftshelf node /app/launcher.mjs reset-owner <メールアドレスか名前>` で二段階認証とパスキーを外し、新しいパスワードを出せます([docs/INSTALL.md](docs/INSTALL.md))
- **v02 から切り替える**: v02 のパネルの「設定」→「アップデート」→「v03」から移れます。Docker なら、`docker-compose.yml` の `image:`(または `build: .`)を `ghcr.io/mesamaru/craftshelf:v03`(開発版は `:dev`)に変えて `docker compose up -d` してもかまいません。同じ `/data` を使いますが、v03 のデータは `/data/v03` に作るので、v02 のデータはそのまま残ります(元のイメージに戻せば v02 に戻れます)。移り方・引き継ぐもの・戻り方は、main の [MIGRATION.md](https://github.com/mesamaru/craftshelf/blob/main/MIGRATION.md) にまとめています
- **v02 から取り込み直す**: v03 を試したあと v02 に戻って使い続け、もう一度移るときは、「チーム」→「バックアップ」→「v02 のデータを取り込み直す」で、新しい v02 のデータを取り込み直せます(v03 のそのときのデータは `/data/v03/before-reimport-…` に移して残します)
- **安定版を出す**: `VERSION` と同じ番号の `v03.xx.xx` のタグを push すると、`release-v03.yml` がイメージ(`:v03`・`:03.xx.xx`)と、一式・Docker なしで動かす配布物(Windows・macOS・Linux)を付けたリリース `v03.xx.xx` を作ります(リリースは「最新」にしません)
- **v02 から取り込むもの**: 初めて起動したときに、v02 のデータ(`/data/index.db`)から次のものを取り込みます。v02 のデータには書き込みません。結果は「アカウント」の画面(管理者だけ)と `/data/v03/import-v02.json` で確かめられます
  - 利用者(v02 のユーザー名とパスワードのままログインできます)と役割(最初の管理者がオーナー)
  - 二段階認証: v02 と同じ認証アプリのコードでログインできます。予備のコードは引き継げないので、ログインしたら設定し直してください
  - Pterodactyl の設定(家の中のアドレスも)とサーバー、サーバーの種類・Minecraft のバージョン
  - ライブラリ・セットは、配布元が Modrinth・SpigotMC・CurseForge とわかるものと、アップロードしたもの(保存先がパネルの中・WebDAV・SMB のもの)を取り込みます。プラグイン・Mod に加えて、データパック・リソースパック・シェーダー・Modパックも取り込みます(03.58.00 から。それより前に取り込んだパネルでも、次の起動で一度だけ足りない分を取り込み、同じ名前のセットにも足します。結果は `/data/v03/import-v02-kinds.json`)
  - フォルダのサーバーは、このマシンから見えるフォルダのものだけを取り込みます
  - 前提の手での紐付け(03.64.00 から): v02 で「前提プラグインを紐付け」たものを、v03 の「前提を手で決める」(アイテム → 前提のアイテム)にします。v03 で手で決める前提は必須の前提だけなので、任意の前提(softdepend)の紐付けは引き継ぎません(結果は `/data/v03/import-v02-deps.json`)
  - 共有リンク(03.64.00 から): 期限の切れていないものを、配った URL のまま使えるように引き継ぎます(期限・ダウンロードの回数も v02 のまま)。v03 に取り込んでいない版は外し、1 つも残らないものは引き継ぎません(結果は `/data/v03/import-v02-shares.json`)
  - パスキー・API トークンは取り込めません(作りが違うため)。v03 で登録し直してください
  - v02 の `index.db` を `/data` 以外に置いていた(`DB_DIR`・`CONFIG_DIR`)ときは、そのフォルダもつないで `V02_CONFIG_DIR` に書きます

## 家の中のサーバーをつなぐ(エージェント)

Pterodactyl が無い・外から届かない家の中のサーバーは、**エージェント**でつなげます。家のサーバー機から CraftShelf へ外向きにつなぐので、家のポートは開けません。使い方は [docs/AGENT.md](docs/AGENT.md)。

## サーバー機で動かす(Docker・サービス版)

多くの人が使うサービスとして動かすときの構成です(PostgreSQL・Cloudflare Tunnel・バックアップ)。普段の作業は [mesamaru/craftshelf-server](https://github.com/mesamaru/craftshelf-server) で行います。

1. `.env.example` を `.env` にコピーして、値を入れます。
   - `APP_URL`: 公開する URL(例 `https://craftshelf.example.com`)
   - `BETTER_AUTH_SECRET`: `openssl rand -base64 32` で作った文字列
   - `POSTGRES_PASSWORD`: データベースのパスワード
   - `TUNNEL_TOKEN`: Cloudflare Zero Trust →「Networks」→「Tunnels」で作ったトンネルのトークン。トンネルの公開先は `http://app:3000` にします
   - `RESEND_API_KEY`・`MAIL_FROM`(任意): メールの送信(Resend)。設定すると、登録した人はメールアドレスを確かめるまでログインできず、パスワードの再設定・招待のメールも送ります。公開するときは設定してください(確かめないと、他人のメールアドレスで登録・招待の受け取りができてしまうため)
2. `docker compose -f docker-compose.service.yml up -d --build`

app のポートは外に出しません。入口は Cloudflare Tunnel だけです(家のポートを開けず、IP も知られません)。

- **見張り**: `GET /api/health` が、データベースまで答えられるかを返します(`{"ok":true}`。ログインは要りません)。外からの見張り(Uptime Kuma・Cloudflare の Health Checks など)に使えます
- **利用規約・プライバシーポリシー**: `/terms`・`/privacy`(`src/routes/terms.tsx`・`privacy.tsx`)は、ひな形です。公開する前に、運営者が中身を確かめて直してください

## バックアップ(サービス版)

backup のコンテナが毎日 `BACKUP_TIME` にデータベースを取り、`BACKUP_TARGETS` の保存先に送ります。古いものは `BACKUP_KEEP_DAYS` 日で消します。

| 保存先 | 設定 |
|---|---|
| NAS(SMB) | `BACKUP_NAS_SHARE`(例 `//nas.local/backup`)・`BACKUP_NAS_USER`・`BACKUP_NAS_PASSWORD` を入れ、`.env` に `COMPOSE_FILE=docker-compose.service.yml:docker-compose.nas-smb.yml` |
| NAS(NFS) | `BACKUP_NAS_HOST`・`BACKUP_NAS_EXPORT`(例 `/volume1/backup`)を入れ、`COMPOSE_FILE=docker-compose.service.yml:docker-compose.nas-nfs.yml` |
| Cloudflare R2 | `BACKUP_R2_ACCOUNT_ID`・`BACKUP_R2_ACCESS_KEY_ID`・`BACKUP_R2_SECRET_ACCESS_KEY`・`BACKUP_R2_BUCKET` |

- NAS はサーバー機と同じ家の中にあるので、火事・落雷・盗難・ランサムウェアでは一緒に失われることがあります。**NAS と R2 の両方(`nas,r2`)を勧めます。**
- `BACKUP_AGE_RECIPIENT` に [age](https://age-encryption.org/) の公開鍵(`age-keygen` で作る)を入れると、暗号化して保存します。秘密鍵はサーバー機の外に保管してください。
- NAS を選んだのにつながっていないときは、家の中のディスクに黙って保存せず、失敗として記録します。

```sh
docker compose run --rm backup now                                  # いますぐ取る
docker compose run --rm backup restore craftshelf-….dump.age r2     # 戻す(暗号化したものは BACKUP_AGE_IDENTITY に秘密鍵のファイルを指定)
```

戻せることを、ときどき実際に試してください。

## プライバシー(自分用の版)

- 「アカウント」の「開発者への利用状況の送信」をオンにしたパネルだけが、1 日 1 回、匿名の利用状況を開発者の受け口(v02 と同じ。`CRAFTSHELF_TELEMETRY_URL` で変えられ、空にすると送りません)に送ります。送るのは、ランダムな ID・版・OS・CPU・導入方法・使っている機能・登録数のおおまかな範囲(0 / 1-9 / 10-49 …)だけで、名前・ファイル名・アドレス・IP アドレスなどは送りません。送る内容は画面でそのまま見られます。
- 「お問い合わせ・要望」は、送ったときだけ、その内容(と、選んだときは版・OS)を送ります。

## ライセンス

[MIT License](LICENSE)
