# Craftshelf Next 設計メモ

多くの人が使えるサービスとして公開する、CraftShelf の次の形。自分で入れて使う CraftShelf(02)は、別のリポジトリでこれまでどおり続ける。

## 方針

- **ファイルは利用者側だけに置く**。クラウド(このアプリ)が持つのは、目録(どのサーバーに何が入っているか)と指示だけ。配布元の規約・保存の費用・漏えいの心配を小さくするため。
- **まず無料**。利用の上限(サーバーの数・チームの人数など)だけを設ける。
- **手元のサーバー機の Docker で動かす**。公開の入口は Cloudflare Tunnel だけにする。利用者が増えたら、同じ compose を VPS へ移す。
- **バックアップは選べる**: NAS(SMB・NFS)と Cloudflare R2。家の中と外の両方に置くのを初期値にする。

## 全体の形

```
[Craftshelf Next(このアプリ)]  TypeScript / TanStack Start / PostgreSQL + Drizzle / Better Auth
   ├─ 画面・アカウント・チーム・権限・ライブラリの目録・配布元の検索
   │
   ├─(接続 1)エージェント経由 …… 自宅や VPS で動かしている Minecraft サーバー
   │    エージェント = CraftShelf 02 の Python を流用(解析・保存先・ファイル操作)
   │    エージェントから外向きに WebSocket でつなぐ(利用者はポートを開けなくてよい)
   │
   └─(接続 2)Pterodactyl に直接 …… レンタルサーバーの利用者
        Client API を使う。API キーは暗号化して保存する
```

## 技術の選び方

| 部分 | 使うもの | 理由 |
|---|---|---|
| 画面とサーバー | TanStack Start(React・Vite・Nitro) | 型のそろった画面とサーバーの処理を 1 つのコードで書ける。Node のコンテナで動く |
| データベース | PostgreSQL + Drizzle ORM | 多人数の同時の読み書きに強い。移行は `drizzle/` の SQL として残す |
| 認証 | Better Auth | 二段階認証(`twoFactor`)・パスキー(`passkey`)・チームと権限(`organization`)・API キー(`apiKey`)をまかなう |
| 試すとき・テスト | PGlite | PostgreSQL を WebAssembly で動かす。`DATABASE_URL=pglite:<フォルダー>` |

## 決まりごと

- **データベースの変更は「足すだけ」**: 表・項目を消したり、名前や意味を変えたりしない。`npm run db:generate` で `drizzle/` に移行の SQL を足し、起動したときに流す。
- 認証の表(`src/server/db/auth-schema.ts`)は `npm run auth:schema` で作る。Better Auth の設定(プラグイン)を変えたら作り直し、続けて `npm run db:generate`。
- サーバーだけで動く処理は `src/server/` に置き、画面からは `createServerFn` かサーバーのルート(`src/routes/api/`)を通して使う。認証の確認は、画面の `beforeLoad` だけでなく、サーバー側の処理ごとに必ず行う。
- 利用者の IP は、Cloudflare Tunnel が付ける `cf-connecting-ip` を使う(`CLIENT_IP_HEADER`)。app のポートを外に出さない構成のときだけ信頼できる。

## チームと権限

- サーバー・ライブラリはチーム(Better Auth の organization)に属する。登録するとその人だけのチームが 1 つでき、オーナーになる。
- 役割(`src/lib/permissions.ts`):

| 役割 | できること |
|---|---|
| オーナー | すべて(チームの削除を含む)。作った人だけ |
| 管理者 | メンバーの招待・役割の変更・外す、サーバーの登録・設定・削除、起動と停止、Mod の操作 |
| 編集者 | サーバーの起動と停止、Mod・プラグインを入れる・外す・更新する |
| 閲覧者 | 見るだけ |

- サーバー側の処理では `requireTeam(auth, headers, { server: ["control"] })` のように、選んでいるチームでの権限を必ず確かめる(`src/server/guard.ts`)。
- 招待はリンクで渡す(メールの送信は、送信サービスを決めてから足す)。招待されたメールアドレスでログインした人だけが参加できる。
  - メールアドレスの確認はまだ無いので、招待のリンクを知っている人が、そのアドレスで先に登録すると参加できてしまう。メールの送信を足すときに、確認を必須にする。
- 無料の上限: 1 人が作れるチームは 5 つ、1 チームの人数は 20 人(`src/server/auth.ts` の `LIMITS`)。

## これから決めること・作るもの

1. Pterodactyl への直接の接続(API キーの暗号化・保存)
2. ライブラリと配布元の検索(Modrinth・CurseForge。CurseForge はサービス用の API キーと規約の確認)
3. エージェント: 登録用のトークン・通信の約束事・02 の Python からの切り出し
4. 公開の準備: 利用規約・プライバシーポリシー・監視・利用の上限・メールの送信(Resend などの送信サービス)・セキュリティスキャン
