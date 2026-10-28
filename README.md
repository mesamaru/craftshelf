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

## サーバー機で動かす(Docker・自分用)

v02 と同じく、1 つのコンテナで動きます。設定は要りません(データベースも `./data/v03` の中に作ります)。

```sh
docker compose up -d     # docker-compose.yml(イメージ ghcr.io/mesamaru/craftshelf:dev)を使う
```

`http://サーバー機のアドレス:8765` を開き、最初の管理者を作ります。そのあとは、管理者が招待した人だけが登録できます。

- パスキーを使うときや、リバースプロキシの後ろに置くときは、開く URL を `APP_URL` に書きます
- **版の切り替え**: 管理者は「アカウント」→「パネルのバージョン」で、GitHub にある v03 の版を選んで更新したり、前の版に戻したりできます(ダウンロードした一式はチェックサムで確かめます。選んだ版が起動できなかったときは、イメージの版で起動します)
- **v02 から切り替える**: v02 の `docker-compose.yml` の `build: .` を `image: ghcr.io/mesamaru/craftshelf:dev` に変え、`docker compose up -d` します。同じ `/data` を使いますが、v03 のデータは `/data/v03` に作るので、v02 のデータはそのまま残ります(`build: .` に戻せば v02 に戻れます)
- **v02 から取り込むもの**: 初めて起動したときに、v02 のデータ(`/data/index.db`)から次のものを取り込みます。v02 のデータには書き込みません。結果は「アカウント」の画面(管理者だけ)と `/data/v03/import-v02.json` で確かめられます
  - 利用者(v02 のユーザー名とパスワードのままログインできます)と役割(最初の管理者がオーナー)
  - 二段階認証: v02 と同じ認証アプリのコードでログインできます。予備のコードは引き継げないので、ログインしたら設定し直してください
  - Pterodactyl の設定(家の中のアドレスも)とサーバー、サーバーの種類・Minecraft のバージョン
  - まだ取り込めないもの: ライブラリ・セット・フォルダのサーバー・パスキー・API トークン(v03 に機能ができたら取り込みます)
  - v02 の `index.db` を `/data` 以外に置いていた(`DB_DIR`・`CONFIG_DIR`)ときは、そのフォルダもつないで `V02_CONFIG_DIR` に書きます

## サーバー機で動かす(Docker・サービス版)

多くの人が使うサービスとして動かすときの構成です(PostgreSQL・Cloudflare Tunnel・バックアップ)。普段の作業は [mesamaru/craftshelf-server](https://github.com/mesamaru/craftshelf-server) で行います。

1. `.env.example` を `.env` にコピーして、値を入れます。
   - `APP_URL`: 公開する URL(例 `https://craftshelf.example.com`)
   - `BETTER_AUTH_SECRET`: `openssl rand -base64 32` で作った文字列
   - `POSTGRES_PASSWORD`: データベースのパスワード
   - `TUNNEL_TOKEN`: Cloudflare Zero Trust →「Networks」→「Tunnels」で作ったトンネルのトークン。トンネルの公開先は `http://app:3000` にします
2. `docker compose -f docker-compose.service.yml up -d --build`

app のポートは外に出しません。入口は Cloudflare Tunnel だけです(家のポートを開けず、IP も知られません)。

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

## ライセンス

[MIT License](LICENSE)
