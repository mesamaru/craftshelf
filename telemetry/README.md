# CraftShelf 利用状況・お問い合わせの受け口(Cloudflare Workers)

CraftShelf の開発者が、各パネルから届く **匿名の利用状況**(利用者が同意したパネルだけ)と **お問い合わせ** を受け取るための小さなサーバーです。Cloudflare の無料枠で動きます。

| 場所 | 内容 |
| --- | --- |
| `POST /v1/ping` | パネルからの利用状況(1 日 1 回) |
| `POST /v1/feedback` | お問い合わせ・要望(Discord にも通知できます) |
| `/admin` | 開発者用の集計ページ(パスワード付き) |

受け取る項目は `src/index.js` に書かれたものだけで、それ以外は捨てます。IP アドレスは保存しません(送りすぎの制限には、その日だけ有効な値で一方向にハッシュしたものを使います)。

## 設置の手順

[Node.js](https://nodejs.org/) が入っている PC で、このフォルダ(`telemetry`)を開いて進めます。

1. Cloudflare の無料アカウントを作る(https://dash.cloudflare.com/sign-up)
   - Workers の画面で「workers.dev のサブドメイン」を決めるときは、**本名や個人のハンドル名を避けた名前**にしてください(URL がパネルのコードに載り、公開されます)
2. ログインする(ブラウザが開きます)

   ```bash
   npx wrangler login
   ```

3. データベースを作る。表示された `database_id` を `wrangler.toml` に書き込む

   ```bash
   npx wrangler d1 create craftshelf-telemetry
   ```

4. 表を作る

   ```bash
   npx wrangler d1 execute craftshelf-telemetry --remote --file schema.sql
   ```

5. 秘密の値を登録する(それぞれ入力を求められます)

   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```
   ```bash
   npx wrangler secret put HASH_SALT
   ```
   ```bash
   npx wrangler secret put DISCORD_WEBHOOK
   ```
   - `ADMIN_PASSWORD`: 集計ページのパスワード(長めのものにしてください)
   - `HASH_SALT`: 適当な長いランダムな文字列(覚えておく必要はありません)
   - `DISCORD_WEBHOOK`: お問い合わせを通知したい Discord チャンネルの Webhook URL(通知しないなら省略)

6. 公開する

   ```bash
   npx wrangler deploy
   ```

   表示された URL(`https://craftshelf-telemetry.<サブドメイン>.workers.dev`)が受け口です。

7. `https://…/admin` を開き、ユーザー名は何でもよく、パスワードに `ADMIN_PASSWORD` を入れると集計ページが見られます

8. パネル側の送り先を設定する: `app.py` の `DEFAULT_TELEMETRY_URL` にこの URL を書いてリリースすると、各パネルに同意の確認とお問い合わせの画面が出るようになります(個別のパネルでは環境変数 `CRAFTSHELF_TELEMETRY_URL` でも変えられます。空にすると無効)

## 手元で試す

```bash
npx wrangler d1 execute craftshelf-telemetry --local --file schema.sql
npx wrangler dev --local
```

`.dev.vars` に `ADMIN_PASSWORD=…` などを書いておくと、手元でも集計ページを開けます(このファイルは Git に入れません)。

## 費用の目安

Workers・D1 とも無料枠(1 日 10 万リクエスト・D1 5GB など)の範囲で、数千台規模まで収まる想定です。最新の無料枠は Cloudflare の料金ページで確認してください。
