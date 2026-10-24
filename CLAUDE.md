# CraftShelf v03 開発メモ

- **ここは `mesamaru/craftshelf` の `dev` ブランチ(v03 の開発・自分で入れて使う版)**。`main` = v02(安定版。将来 v03 へ移れるようにして、v02 の更新を終える)。v02(Python)とは履歴もコードも別。`next` はいまは無い(v04 を作るときに、その時点の `dev` から切るかもしれない)。多くの人が使うサービス版は別のリポジトリ `mesamaru/craftshelf-server`(`main`)。
- **v03 は `dev` で作る**: 利用者が `dev` を見て意見を出す → `dev` に作る → 同じ機能をサービス版にも入れる。**`main` に出す前に、v02 → v03 のデータの移し方と、Docker の入れ替え方を用意する**(v02 のパネルは、それまで v03 に自動更新しない)。
- **`DATA_FORMAT`(read=0)は消さない**: v02 の Docker のパネルは、起動のたびに受け取り先のブランチを取り込む。この目印があると、v02 のパネルは v03 を「読めない版」とみなして取り込まない(無いと、開発ビルドを選んだ v02 のパネルが v03 で上書きされて起動しなくなる)。
- **サービス版へ入れる手順**: 手元の作業フォルダーには `origin`(craftshelf)と `server`(craftshelf-server)の 2 つのリモートをつないでおく。`git switch server` → `git cherry-pick <dev のコミット>` で取り込み、`VERSION`・`CHANGELOG.md` はサービス版の番号で書き直してからコミットする。サービス版にだけ要るもの(チームの上限・公開の入口など)は、サービス版だけで作る。
- **動き方は 2 つ**(`CRAFTSHELF_MODE`、`src/server/env.ts`): `self` = 自分用(既定。設定なしで動き、データは `/data/v03`。最初の 1 人が管理者、あとは招待された人だけ、チームは 1 つ)/ `service` = サービス版(`APP_URL`・`BETTER_AUTH_SECRET`・`DATABASE_URL` が必須)。どちらでも動くように作る。Docker は自分用が `docker-compose.yml`(イメージ `ghcr.io/mesamaru/craftshelf:dev`。`dev` に push すると `.github/workflows/image.yml` が作る)、サービス版が `docker-compose.service.yml`。
- 版は `03.xx.xx`。タグは `dev-v03.01.02`(リリースの仕組みはまだ無い)。

- 利用者への説明・UI の文言は日本語。利用者が入力した名前・メモなどには `translate="no"` を付ける。
- 設計と方針は `docs/DESIGN.md`。構成を変えたらそちらも直す。
- **変更をコミットするたびに `VERSION` を上げ、`CHANGELOG.md` の先頭に見出しを追加する。** 形式は `00.00.00`(メジャー.マイナー.修正)、見出しは `## 03.01.00 - YYYY-MM-DD タイトル`。
- 構成: TanStack Start(`src/routes/` がページとサーバーのルート)・Drizzle + PostgreSQL(`src/server/db/`)・Better Auth(`src/server/auth.ts`)。サーバーだけで動く処理は `src/server/` に置き、画面側のファイルから直接 import しない(`createServerFn` の中で動的に import する)。
- **データベースの変更は「足すだけ」**(表・項目を消したり、名前や意味を変えたりしない)。スキーマを変えたら `npm run db:generate` で `drizzle/` に移行の SQL を足す。認証の表は `npm run auth:schema` で作る(`auth-schema.ts` を手で書き換えない)。
- **テスト**: コミットの前に `npm run typecheck`・`npm test`・`npm run build` を通す。テストは `tests/*.test.ts`(PGlite を使うので PostgreSQL は要らない)。
- 認証の確認は、画面の `beforeLoad` だけでなく、サーバー側の処理ごとに必ず行う(`src/server/guard.ts` の `requireUser`・`requireTeam`)。権限は `src/lib/permissions.ts` に足す。データベースの読み書きは、選んでいるチームの ID で必ず絞る。
- **利用者が入力した URL へサーバーからつなぐときは、必ず `src/server/net.ts` の `safeFetch` を使う**(LAN の中へつながせない)。利用者から預かるキーは `src/server/secrets.ts` の `seal` で暗号化して保存する。
- 画面を変えたら、ビルドしたサーバーを `PORT=3123` で動かして `npm run e2e` も通す(Edge で操作する。画面の写しは `.e2e/`)。
- コミットの作成者は `mesamaru <74803890+mesamaru@users.noreply.github.com>`。コード・例・コミットメッセージに、実際の IP アドレス・共有名・ドメインなど個人の環境の情報を書かない。
- **開発が終わったら、版と変更内容を利用者に報告し、公開(push・タグ)してよいか確認してから公開する。**
- デザインは Apple の Liquid Glass を参考にする(半透明のガラス素材・グループリスト・カプセル型ボタン)。
