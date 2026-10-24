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

## サーバー機で動かす(Docker)

1. `.env.example` を `.env` にコピーして、値を入れます。
   - `APP_URL`: 公開する URL(例 `https://craftshelf.example.com`)
   - `BETTER_AUTH_SECRET`: `openssl rand -base64 32` で作った文字列
   - `POSTGRES_PASSWORD`: データベースのパスワード
   - `TUNNEL_TOKEN`: Cloudflare Zero Trust →「Networks」→「Tunnels」で作ったトンネルのトークン。トンネルの公開先は `http://app:3000` にします
2. `docker compose up -d --build`

app のポートは外に出しません。入口は Cloudflare Tunnel だけです(家のポートを開けず、IP も知られません)。

## バックアップ

backup のコンテナが毎日 `BACKUP_TIME` にデータベースを取り、`BACKUP_TARGETS` の保存先に送ります。古いものは `BACKUP_KEEP_DAYS` 日で消します。

| 保存先 | 設定 |
|---|---|
| NAS(SMB) | `BACKUP_NAS_SHARE`(例 `//nas.local/backup`)・`BACKUP_NAS_USER`・`BACKUP_NAS_PASSWORD` を入れ、`.env` に `COMPOSE_FILE=docker-compose.yml:docker-compose.nas-smb.yml` |
| NAS(NFS) | `BACKUP_NAS_HOST`・`BACKUP_NAS_EXPORT`(例 `/volume1/backup`)を入れ、`COMPOSE_FILE=docker-compose.yml:docker-compose.nas-nfs.yml` |
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
