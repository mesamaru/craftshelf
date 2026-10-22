# Craftshelf Next 開発メモ

- 利用者への説明・UI の文言は日本語。利用者が入力した名前・メモなどには `translate="no"` を付ける。
- 設計と方針は `docs/DESIGN.md`。構成を変えたらそちらも直す。
- **変更をコミットするたびに `VERSION` を上げ、`CHANGELOG.md` の先頭に見出しを追加する。** 形式は CraftShelf と同じ `00.00.00`(メジャー.マイナー.修正)、見出しは `## 00.01.00 - YYYY-MM-DD タイトル`。
- 構成: TanStack Start(`src/routes/` がページとサーバーのルート)・Drizzle + PostgreSQL(`src/server/db/`)・Better Auth(`src/server/auth.ts`)。サーバーだけで動く処理は `src/server/` に置き、画面側のファイルから直接 import しない(`createServerFn` の中で動的に import する)。
- **データベースの変更は「足すだけ」**(表・項目を消したり、名前や意味を変えたりしない)。スキーマを変えたら `npm run db:generate` で `drizzle/` に移行の SQL を足す。認証の表は `npm run auth:schema` で作る(`auth-schema.ts` を手で書き換えない)。
- **テスト**: コミットの前に `npm run typecheck`・`npm test`・`npm run build` を通す。テストは `tests/*.test.ts`(PGlite を使うので PostgreSQL は要らない)。
- 認証の確認は、画面の `beforeLoad` だけでなく、サーバー側の処理ごとに必ず行う(`src/server/guard.ts` の `requireUser`・`requireTeam`)。権限は `src/lib/permissions.ts` に足す。
- コミットの作成者は `mesamaru <74803890+mesamaru@users.noreply.github.com>`。コード・例・コミットメッセージに、実際の IP アドレス・共有名・ドメインなど個人の環境の情報を書かない。
- **開発が終わったら、版と変更内容を利用者に報告し、公開(push・タグ)してよいか確認してから公開する。**
- デザインは Apple の Liquid Glass を参考にする(半透明のガラス素材・グループリスト・カプセル型ボタン)。
