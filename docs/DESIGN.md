# CraftShelf v03 設計メモ

CraftShelf の次の版。作りを新しくし(TypeScript)、2 つの形で使えるようにする。

- **自分で入れて使う版(`mesamaru/craftshelf` の `dev`)**: v02 と同じく、自分のサーバー機に入れて使う。
- **サービス版(`mesamaru/craftshelf-server`)**: 多くの人が使えるサービスとして公開する。チームごとに分かれる。中身の多くは `dev` と同じ。違い(登録を閉じる・チームを 1 つにする・手元の保存先を使うなど)はこれから決める。

v02(Python、`main`)は、v03 へ移れるようにしたところで更新を終える。v03 は `dev` で作る(2026-10-24 から)。

## 方針

- **ファイルは利用者側だけに置く**。クラウド(このアプリ)が持つのは、目録(どのサーバーに何が入っているか)と指示だけ。配布元の規約・保存の費用・漏えいの心配を小さくするため。
- **まず無料**。利用の上限(サーバーの数・チームの人数など)だけを設ける。
- **手元のサーバー機の Docker で動かす**。公開の入口は Cloudflare Tunnel だけにする。利用者が増えたら、同じ compose を VPS へ移す。
- **バックアップは選べる**: NAS(SMB・NFS)と Cloudflare R2。家の中と外の両方に置くのを初期値にする。

## 全体の形

```
[CraftShelf v03(このアプリ)]  TypeScript / TanStack Start / PostgreSQL + Drizzle / Better Auth
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
- 本番のビルドでは `instance.ts` が 2 つの束(サーバーの関数 / サーバーのルートと起動時の処理)に別々に入る。データベース(`createDb`)とエージェントの列(`hub`)は `globalThis` でプロセスに 1 つにする(03.56.00 から。PGlite を 2 回開くと、互いの書き込みが見えない)。
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

## Pterodactyl に直接つなぐ

- チームがパネルの URL と Client API キー(`ptlc_…`)を登録し、パネルのサーバーを選んでチームのサーバーとして追加する(表 `ptero_connection`・`server`)。
- **API キーは AES-256-GCM で暗号化して保存する**(`src/server/secrets.ts`)。鍵は `BETTER_AUTH_SECRET` から HKDF で作り、行ごとの ID を一緒に渡して、ほかの行へ写し替えても読めないようにする。画面には最後の 4 文字だけを出す。
  - `BETTER_AUTH_SECRET` を変えると、保存したキーは読めなくなる(登録し直しになる)。鍵を入れ替えられるよう、保存する文字列の先頭に版(`v1:`)を付けている。
- **利用者が入力した URL へつなぐときは、必ず `safeFetch`(`src/server/net.ts`)を使う**。このアプリは家の LAN の中で動くので、LAN の中の機器(ルーター・NAS など)やクラウドのメタデータにつながれると危ない(SSRF)。
  - https だけ。URL にユーザー名・パスワードは付けられない。転送(リダイレクト)は追わない。
  - IP アドレスで書いたものも、名前を引いた結果も、公開されたアドレスかを確かめる。名前はつなぐたびに引き直して確かめるので、あとから向き先を LAN の中へ変えられても防げる。
- 権限: パネルの登録とサーバーの追加は `server: ["create"]`、削除は `server: ["delete"]`、起動と停止は `server: ["control"]`、見るのはチームのメンバー全員。
- どの処理も、選んでいるチームの ID で絞って読み書きする。ほかのチームのものは、ID を知っていても「見つからない」(404)になる。
- 02 にあった「証明書を検証しない」は付けない(多くの人のキーを預かるため)。管理者キーで全サーバーを取る `type=admin-all` も、いまは使わない。
- 無料の上限: パネルは 1 チーム 5 つ、サーバーは 1 チーム 20 台(`SERVER_LIMITS`)。

## Mod・プラグイン

- サーバーごとに種類(`src/lib/platforms.ts`)と Minecraft のバージョンを決める(表 `server_profile`)。種類で置き場所(`plugins/` か `mods/`)と、Modrinth で絞り込む条件が決まる。
- **ファイルはこのアプリを通さない**。Pterodactyl の `files/pull` で、Wings に Modrinth の CDN から直接取り込ませる。取り込ませる URL は `https://cdn.modrinth.com/` のものだけ、ファイル名は安全な `.jar` だけにする。
  - パネルの設定で URL からの取り込みが止められていると入れられない。そのときにこのアプリを通して送る方法は、まだ無い。
- このアプリで入れたものは表 `installed_mod` に記録する(配布元・プロジェクト・版)。同じプロジェクトを入れ直すと、新しい版を取り込んでから古いファイルを消す(= 更新)。
- 外すのは、いまフォルダーにある `.jar` だけ。フォルダーをまたぐ名前(`/`・`\`・`..`)は断る。
- 権限: 種類の設定は `server: ["update"]`、入れる・外す・更新は `library: ["edit"]`、見る・探すのはメンバー全員。
- **入れる版**: サーバーの種類とバージョンに合う安定版のうち、いちばん新しいもの。いちばん新しい版から 3 日以内に作りの違う版(Paper 向けと Bukkit 向けなど)が出ていれば、種類の `loaders` の前のほう(Paper のサーバーなら paper)に合うものを選ぶ(`pickVersion`)。それより古い版には戻らない(作者が印を付けなくなっただけのことがあるため)。

## ライブラリ(チームの目録)

- チームで使う Mod・プラグインの一覧(表 `library_item`)。**ファイルは持たず**、配布元のプロジェクト(いまは Modrinth)だけを記録する。サーバーに入れたものは自動で載る。
- 画面(トップ)では、それぞれがどのサーバーにどの版で入っているか(`installed_mod` から)を出し、種類が合うサーバー(プラグインなら plugins/ を使うサーバー)を選んで入れられる。
- 足すのは `library: ["edit"]`(編集者以上)。種類(`project_type`、`ITEM_TYPES`)はプラグイン・Mod と、03.58.00 からデータパック・リソースパック・シェーダー・Modパック(v02 と同じ)。外してもサーバーのファイルは消さない。無料の上限は 1 チーム 500 件(`LIBRARY_LIMITS`)。
- データパック(03.58.00 から): ワールドのあるサーバー(プロキシ以外、`kindsOf`)の `<level-name>/datapacks/`(`server.properties` を `worldOf` で読む)に .zip を置く。サーバーにあるファイルの種類は拡張子で決める(.jar = サーバーの種類のフォルダ、.zip = datapacks。`fileProfile`)。入れる・更新・無効・外す・元に戻す・配布元を探す・そろえる・セット・更新の確認は、どれも `Profile.kind = "datapack"` で同じ処理を通る(Modrinth は作り `datapack` の版だけ、CurseForge は分類 6945)。どの種類として入れるかは、`kind` → サーバーに入っているファイル → ライブラリの種類の順に決める(`targetProfile`)。データパックの前提は配布元に問い合わせない。
- リソースパック・シェーダーはクライアントで使うので、サーバーには入れない(v02 と同じ)。ライブラリで持ち、版の一覧から配布元の CDN のファイルをダウンロードできる(アップロードしたものは保存先から・共有リンクも)。アップロードは .zip・.mrpack も受け付け、中身(pack.mcmeta と data/ か assets/・shaders/・modrinth.index.json・manifest.json)で種類を決める(`analyzePack`)。
- Modパック(03.58.00 から): アイテムとして持ち、`modpackService.fromItem` が受け取る版のとおりのいちばん新しい版(配布元の CDN から、転送は CDN の中だけ・100 MB まで)か、アップロードしたいちばん新しいファイルを読んで、`import` と同じくセットを作る。サーバーを選ぶと overrides を書き込み(`server: ["update"]`)、セットも入れる。使った版は `library_item.pack` に覚え、`refreshInfo` がいちばん新しい版を取り直して、使った版より新しければ一度だけ「新しい版」の種類で知らせる。
- タグ(表 `library_tag`、チームの中で共有。付け外しは `library: ["edit"]`、1 つ 30 文字・1 件に 20 個まで)とお気に入り(表 `library_favorite`、利用者ごと。閲覧者もできる。一覧の上に並べる)。
- 一覧の絞り込み(名前・種類・配布元・タグ)と並べ替え(名前・追加日)は画面の中だけで行う。「更新あり」は押したときだけ `outdated` が配布元に問い合わせる(サーバーの種類とバージョンごとに 1 回。更新を止めたもの・割り当てのないサーバーは見ない)。まとめて操作(タグ・セットに足す・外す)は、選んだものに 1 件ずつ同じ処理を呼ぶ(タグだけは 1 回で付ける)。
- 前提の確かめ(03.56.00 から。`modTools.missingOf` をセット・ライブラリ・サーバーで共有): 前提は、配布元の必須(Modrinth・CurseForge の、そのサーバーに入るいちばん新しい版の `deps`)と、手で決めた前提(表 `library_dep`、アイテム → 前提のアイテム。配布元が前提を知らない SpigotMC・アップロードしたものにも使える。`linkDep` は `library: ["edit"]`)。ライブラリの「前提が足りない」(`missingDeps`)は押したときだけ配布元に問い合わせ、アイテムの「詳しく」(`missingDeps(itemId)`)とサーバーの画面(`serverDeps`、開いたとき)は自動で確かめる。足りないものは `install` でそのサーバーに入れる。無効にしたものは入っていないものとみなす。
- 配布元の変更内容(`itemVersions`・`itemChangelog`): Modrinth は `/project/<ID>/version`(30 個)と `/version/<ID>` の `changelog`(Markdown の文のまま)、CurseForge は `/files` と `/files/<ID>/changelog`(HTML を `html-text.ts` で文字にする)、SpigotMC は版ごとの変更内容が無いので、更新のお知らせ(`/resources/<ID>/updates`、base64 の HTML を文字にする)を版の代わりにする。画面ではいつも文字として出す(HTML として描かない)。
- アイテムの情報を直す(`editItem`・`relinkItem`、`member: ["update"]`): 種類・動く作り(`library_item.loaders`)・対応 MC(`mc_versions`)・受け取る版(`channel`)。どれも "" = 直していない。動く作りを直すと、配布元に問い合わせるときの loaders にそれを使い、対応 MC がサーバーのバージョンを含むなら MC のバージョンでは絞らない(`pickOf`)。付け替えは URL で別のプロジェクトにし、チームのサーバーの `installed_mod`・`server_hold` の配布元と ID も付け替える(次の更新で新しいプロジェクトの版に入れ替わる)。アップロードしたものは付け替えない。
- 対応 MC(`library_item.upstream_mc`・`info_at`): 1 分ごとの `refreshInfo` が、取ってから 1 日たったものを 50 件ずつ取り直す(Modrinth は `/projects` の `game_versions`、CurseForge は `latestFilesIndexes`、SpigotMC は `testedVersions`、アップロードは jar から読んだもの。スナップショットは除く)。一覧は直したもの、無ければこれを出し、MC のバージョンで絞り込める(1.20 は 1.20.x を含む)。
- 受け取る版(`channel`): release = 正式版だけ(正式版が無いものだけベータ)/ all = ベータ・アルファも含めていちばん新しいもの。チームの既定は `team_option.channel`(管理者以上)、アイテムごとに変えられる。v02 の `stable_only`・`item_sources.channel` は `maybeImportV02Channels` で一度だけ引き継ぐ。
- URL から足す(`addFromUrl`): Modrinth(slug でも)・SpigotMC・CurseForge(slug を `/mods/search?slug=` で ID に)のページの URL を読む(`parseSourceUrl`)。Hangar はまだ配布元に無いので断る。
- v02 からの取り込み(`maybeImportV02Library`、結果は `/data/v03/import-v02-library.json`): v02 から移った自分用の版で一度だけ。配布元が Modrinth(ID が 8 文字)とわかるプラグイン・Mod と、SpigotMC(数字の ID)とわかるプラグインだけを載せ、v02 のセットも作る(版の固定は、03.59.00 から `maybeImportV02Pins` が一度だけ引き継ぐ。下の「セット」)。03.58.00 からはデータパック・リソースパック・シェーダー・Modパックも取り込む。それより前に取り込んだパネルでは `maybeImportV02Kinds` が一度だけ、その種類だけを取り込み(v02 の保存先は前に登録したものを使う)、取り込み済みの同じ名前のセットに足す(結果は `/data/v03/import-v02-kinds.json`。ライブラリと一緒に取り込んだときは印だけを置く)。

## セット

- ライブラリから選んだものの組み合わせ(表 `addon_set`・`addon_set_item`。中身はライブラリの項目を指すだけ。ライブラリから外すとセットからも外れる)。
- 「サーバーに入れる」(`apply`)は、サーバーの種類(プラグイン / Mod)に合うもので、このアプリで入れた記録(`installed_mod`)に無いものだけを入れる。種類の合わないものは入れない。1 件ずつ結果(入れた・入っている・入れない・入れられない)を返し、失敗しても残りは続ける。入れる処理はライブラリと同じ(`modTools` の `installInto`)。
- 権限: 作る・中身を変える・入れるのは `library: ["edit"]`、見るのはメンバー全員。無料の上限は 1 チーム 50 個・1 セット 200 件(`SET_LIMITS`)。
- サーバーに結び付けるセットは 1 台に 1 つ(表 `server_set`)。「そろえる」(`sync`)は `apply` と同じく種類の合うものだけを扱い、足りないものを入れ、入っているもの(`installed_mod`)に新しい版(`latestFile` の版が記録と違う)があれば入れ直す(= 更新。古いファイルは消す)。セットに無いものは外さない。
- 「更新を止める」(表 `server_hold`、サーバー × 配布元 × ID)。そろえる・予約・更新の確認では、止めたものを新しい版にしない(画面の「更新」は、その場の操作なので止めない)。
- 版の固定(03.59.00 から。v02 の `set_items.version_id`): `addon_set_item.version_id`(配布元の版の ID・アップロードしたものはファイルの ID)と `version_number`(表示用)。null はいつもサーバーに合う新しい版。`pin`(`library: ["edit"]`)は配布元に版があることを確かめて保存する(SpigotMC は前の版を取れないので固定できない)。`applyTo` は固定したものを、`versionsOf` にその版があれば `fileById` で入れ、無ければ「合わないので飛ばしました」(`pinned: true`。まとめ・通知にも載せる)。自動更新・まとめて最新・予約の update(`updateInstalled`)は、結び付けたセットの固定(`modTools.pinsOf`)を使い、更新の確認(`updatesOf`)は固定したものを見ない。「更新を止める」はサーバーごとに今の版のままにするもので、固定より先に効く(止めたもの・無効にしたもの・`add` で入っているものは、固定した版にしない)。ほかのサーバーにそろえる(`copy`)は、そろえる元の版を使うので固定を見ない。v02 の固定は `maybeImportV02Pins` が一度だけ、Modrinth はファイルの SHA-1(`/version_files` にまとめて 1 回)・CurseForge はファイルの名前(新しい 30 件の中)・アップロードしたものは SHA-256 で取り込んだファイルに対応させ、取れないものは「固定を引き継げなかったもの」として結果(`/data/v03/import-v02-pins.json`)に出す。v03 で固定を決め直したものは上書きしない。
- サーバーの比較(`/compare`): `catalog` の `installs` だけで表を作る(サーバーには問い合わせない)。版を選ぶときは `versions`(Modrinth・CurseForge はサーバーの種類・バージョンに合う版を新しい順に 30 個、アップロードしたものは保存した版。SpigotMC は前の版を取ってこられないので無し)。`install` に `versionId` を渡すと、その一覧にある版だけを受け付け、いちばん新しい版でなければ `server_hold` に入れる。
- 種類(プラグイン・Mod): Modrinth は、Fabric などにも対応したプラグインを `project_type: "mod"` と返すので、ライブラリに足すときは探したときの種類、入れたときは入れたサーバーの種類で決める。
- 「前の版に戻す」: `installInto` が更新で入れ替えた版を表 `install_history` に残す(1 つにつき 10 件)。`rollback` はいちばん新しい前の版を `fileById`(Modrinth は `/version/<ID>`、CurseForge は `/files/<ID>`、アップロードは版の行)で取り直して入れ、使った記録と戻す前の版の記録を消し、`server_hold` を付ける。SpigotMC は古い版を取ってこられないので戻せない。
- 前提: Modrinth の版の `dependencies` のうち `required` のもの(CurseForge は `relationType: 3`)を `FileChoice.deps` で返し、同じ配布元から、`installInto` がまだ入っていないものを入れる(2 段まで。入れられなくても本体はそのまま)。
- 「セットに無いものを外す」(`sync` の `removeExtra`)は、`installed_mod` の記録があるもの(このアプリで入れたもの)のうち、セットに無いものだけを外す。手で置いたファイルは記録が無いので触らない。予約では外さない(気づかないうちに消えないように)。
- そろえ方(03.55.00 から、「ほかのサーバーにそろえる」と同じ 3 通り): `sync` の `how` が `update`(`applyTo` の `update`。入っているものだけ新しい版に)/ `add`(既定。足りないものも入れる)/ `mirror`(さらにセットに無いものを外す = 前の `removeExtra: true`)。画面ではそろえる元に、結び付けたセットかほかのサーバー(`copy`)を選ぶ。
- セットの前提(`missingDeps`、03.55.00 から): セットの Modrinth・CurseForge のもののうち、選んだサーバーの種類に合うものの `latestFile` の `deps` を見て、セットに無いものを、使うものの名前と一緒に返す。`addDeps`(`library: ["edit"]`)はライブラリに載せて(種類は選んだサーバーの種類)セットに足す。
- まとめて最新にする(`updateServers`、03.55.00 から。サーバーの一覧): 選んだサーバー(空なら割り当てで使えるすべて)の入っているものを `applyTo`(`sync`)で新しい版にする(自動更新と同じ `updateInstalled`)。変えたもの・失敗したものだけを返し、記録する。

- **SpigotMC**(`src/server/spiget.ts`): Spiget(SpigotMC の公開 API)で探し、Pterodactyl に `https://api.spiget.org/v2/resources/<数字の ID>/download`(Spiget の CDN へ転送される)を取り込ませる。URL はこちらで組み立てるものだけ。SpigotMC の外のサイトで配っているもの(external)・有料のもの(premium)・プラグインではないカテゴリー(Standalone・Web・DataPack)は扱わない。
  - 動くサーバーはカテゴリーで決める(`spigetFits`): サーバー用 → Paper・Purpur・Spigot、プロキシ用 → BungeeCord、Universal → 両方。Folia・Velocity は見分けられないので入れない。Minecraft のバージョンでは絞らない(SpigotMC の対応バージョンは作者の自己申告で粗いため)。版はいちばん新しいものだけ(古い版は Spiget から取り込めない)。
  - ファイルの名前は、名前と版から安全な文字だけで作る(作れなければ `spigot-<ID>.jar`)。
- 配布元は `installed_mod`・`library_item` の `source`(`modrinth` / `spigot`)で分け、同じものかは「配布元 + ID」で判断する(`src/lib/sources.ts`)。
- **CurseForge**(`src/server/curseforge.ts`、自分用の版だけ): チームが設定した利用者の API キー(表 `team_curseforge`、`seal`)で使う。サービス版では使わない(CurseForge の規約で、サービスとして使うには別の取り決めが要るため)。分類はプラグイン = 5・Mod = 6、作りは `modLoaderType`(Forge 1・Fabric 4・Quilt 5・NeoForge 6)。取り込ませるのは `downloadUrl` が forgecdn.net のものだけで、作者が外部からのダウンロードを許していないもの(`allowModDistribution: false`・`downloadUrl` が無い)は扱わない。

## 操作の記録と通知

- 操作の記録(表 `audit_log`。`src/server/events.ts` の `record`)。各サービスの、変える操作の最後に記録する(だれが・何を・どのサーバーに・詳しい内容)。予約で動いたものは user_id が null。見られるのは `member: ["update"]`(管理者以上)。画面では操作・対象・詳しく・人の名前で探せる(`list` の `q`、ILIKE。`%`・`_` はそのままの文字)。
- Discord への通知(表 `team_notify`)。Webhook の URL は `seal` で暗号化して保存し、`https://discord.com/api/webhooks/…`(discordapp.com・ptb・canary を含む)だけを受け付ける。記録の種類(`EVENT_KINDS`: changes・sets・schedule・power・admin・updates・auto・errors・backup・panel)のうち、選んだものだけを送る。記録は 1 つの種類(`kind`)で残し、ほかにも当てはまる種類は `also` で渡す(自動更新・予約で入れた → auto、失敗 → errors、バックアップ → backup。前からの種類を選んだチームにも、前と同じように届く)。`allowed_mentions` を空にしてメンションさせない。送れなくても、もとの操作は失敗させない。

- 新しい版の見回り(`setService.runUpdateChecks`、1 分ごと): 前に確かめてから 1 日(`UPDATE_CHECK_EVERY`)たったサーバーを 1 回に 2 台まで、`update_checked_at` を条件付きで書き換えてから確かめる(配布元へは入っているもの 1 つにつき 1 回。自動更新を入れたサーバーは見ない)。見つけた行を `server.update_notice` に残し、前に知らせていない行だけを `updates` で記録する。
- パネルの新しい版(自分用の版、`startup.ts`): 6 時間ごとに GitHub のリリースを見て、いまより新しい版があれば `events.announcePanel` ですべてのチームに `panel` で記録する(同じ版は 1 度だけ)。
- お知らせ(ベル)の既読は、利用者 × チームごとに表 `notice_seen` に残す(どの端末でも同じ。先へ進めるだけ)。
- ファイル比較(`/compare/files`、`files.configs`): v02 と同じ場所(一番上・plugins は 3 段・config は 4 段・mods/config は 3 段)から、開ける設定ファイルを 1 台 400 個まで集める。一覧では中身を読まず大きさで見る。開いたら全部を読み、行の差分(`src/lib/diff.ts`、Myers の方法)で基準にそろえて並べる。写すのは `files.save`(履歴に残る)。行の操作と直接の書き換えは、画面の中だけの「元に戻す・やり直す」(Ctrl+Z・Ctrl+Y・Ctrl+Shift+Z とボタン。続けて打った文字は 1 回で戻す。100 回まで)で戻せる。

- サーバーの割り当て(表 `member_server_limit`・`member_server`): `member_server_limit` に行がある閲覧者・編集者は、`member_server` のサーバーだけを使える。確かめるのは `serverOf(deps, who, id)`(`who` は `requireTeam` の結果。チームの ID だけを渡すのは予約などの人でない操作だけ)と `needServerAccess`、一覧は `serverScope` で絞る。管理者・オーナーは制限しない。

- サーバー本体(`software.ts`、表 `server_software`): 今のビルドは「入れ替えた記録(jar の大きさが同じなら)→ version_history.json → jar の名前」の順に読む。入れ替えは、今の jar を `<jar>.craftshelf-old-<数字>` に名前を変えてから、同じ名前で配布元(`BUILD_HOSTS` の公式の取得先だけ)から取り込ませる。取り込めなければ名前を戻す。残した jar は `server_software.old_jars` に新しい順で 5 つまで(古いものはサーバーから消す。いちばん新しいものは `backup_jar` にも書くので、前の版でも 1 つは戻せる)。戻すときは、選んだ jar と今の jar の名前を入れ替え、今の jar を残した側に入れる。
  - サーバー本体の種類(`src/lib/software.ts` の `SOFTWARE`。03.54.00 から): サーバーの種類(Mod・プラグインの置き場所)とは別に、「どこから何の jar を取るか」を決める。`server_software.software` に選んだもの → jar の名前(サーバーの種類と合うもの)→ サーバーの種類の順に決める。Paper・Folia・Purpur・Leaf・Pufferfish・Velocity・Waterfall・BungeeCord・Fabric・Vanilla・Mohist・SpongeVanilla は入れ替えられ、Forge・NeoForge・Quilt・Arclight は新しい版の確認だけ(v02 の `mcnet.py` と同じ公式の取得先。BungeeCord は移った先の hub.spigotmc.org)。`BUILD_HOSTS` は Pterodactyl への取り込み・フォルダのサーバーの転送先・エージェントの `AGENT_PULL_HOSTS` で同じものを使う。
  - ビルドを選ぶ(`builds`・`install`): 配布元の一覧(新しい順に 25 個。Minecraft のバージョンも選べる。プロキシはプロキシの版)から選ぶ。取得先は、画面から来た URL ではなく、サーバーで一覧を引き直して決める。いちばん新しいものは安定版の中から選ぶ。Minecraft のバージョンを変えるとサーバーの種類のバージョンも変え、画面ではワールドのバックアップを勧める。
  - 新しいビルドのお知らせ: 新しい版の見回り(`runUpdateChecks`)で、Mod・プラグインの行と一緒に「・サーバー本体(…): 今 → 新しい」の行を作る(同じ行は 2 度知らせない。自動更新を入れたサーバーでも、サーバー本体は見る)。
  - 種類の判定(`detectServer`、v02 の detect_server): jar の名前・`SERVER_JARFILE`・決まったファイル(velocity.toml・purpur.yml・config/paper-global.yml・libraries/net/… など)・Pterodactyl の egg の名前から種類を、version_history.json・jar の名前・`MINECRAFT_VERSION` から Minecraft のバージョンを読む。Pterodactyl のサーバーを足したときに自動で埋め、画面の「サーバーのファイルから判定する」でも使う(決めるのは保存したとき)。
- サーバーの状態の人数(`servers.status` の `ping`、`mcping.ts`): Minecraft の Server List Ping でオンラインの人数・最大・名前の一部(12 人まで)・応答の速さを読む。Pterodactyl は既定の割り当て(別名 → IP。0.0.0.0 ならパネルの名前)、フォルダのサーバーは 127.0.0.1 の `server-port`、エージェントはエージェントの `ping`(自分のサーバーのポートだけ。行き先は渡さない)。サービス版は、名前を引いた先が公開されたアドレス(`isPublicAddress`)のときだけつなぐ。Query は使わない。

- 配布元を探す(`library.identify`): このアプリの記録が無い jar を 1 回に 100 個まで読み(Pterodactyl はダウンロード用の URL から)、Modrinth の `version_files`(SHA-1)・CurseForge の `fingerprints`(`fingerprint.ts`、v02 と同じ MurmurHash2)で探す。見つかったものは `installed_mod` に記録し、ライブラリにも載せる(種類はサーバーの種類)。見つからないものは `uploads.fromServer` でアップロードしたものとして取り込める。

- 変更の履歴(表 `server_change`): `installInto` が入れる・更新を、`remove` が外すを残す。外すときは消さずに `<名前>.craftshelf-removed` に名前を変える(元に戻すと名前を戻す)。更新を元に戻すのは `fileById` で前の版を取り直す(SpigotMC はできない)。1 台につき新しい 30 件までで、古いものの残したファイルも消す。セットの「セットに無いものを外す」も同じように残す(外すのは `modTools.removeFrom` にまとめてある)。
- 無効にする(`library.setEnabled`): 消さずに `<名前>.jar.disabled` に名前を変える(v02 と同じ)。`installed_mod` の記録の名前も変え、履歴(「無効にする」「有効にする」)から戻せる。無効にしたものは、更新の確認・セットでそろえる・自動更新・ほかのサーバーにそろえるで入れ替えない(比較の表・入っているものには「無効」と出す)。
- 設定フォルダの退避: プラグインを外す・更新で入れ替えるとき、jar の plugin.yml の名前と同じフォルダ(`plugins/<名前>/`)を `plugins/.craftshelf-config/<key>/<名前>/` に写し、`server_change.config_backup` に残す。元に戻すと上書きで戻す。Pterodactyl・フォルダ・エージェントのどれでも動くよう、`listFiles`・`readBytes`・`upload` だけで 1 ファイルずつ写す(隠しファイルは除く。100 個・20 MB・6 段を超えるフォルダは退避しない)。退避できなくても入れ替え・外すは続ける。履歴を消すときに退避先も消す(フォルダのサーバーの `deleteFiles` も、Pterodactyl と同じくフォルダーを中身ごと消す)。
- ほかのサーバーにそろえる(`sets.copy`、画面は「ほかのサーバーとそろえる」。検証用から本番へ反映するのも同じ): そろえる元の `installed_mod`(無効にしたものは除く)と同じ版を、そろえる先の種類・バージョンに合うときだけ入れる(`versionsOf` に無い版は入れない。SpigotMC はいちばん新しい版のときだけ)。`update` = 入っているものだけ / `add` = 足りないものも / `mirror` = さらに、そろえる元に無いもの(このアプリで入れたもの)を外す。先で止めているもの・無効にしたものは変えない。元で止めているものは、先でも止める。プラグインと Mod のサーバーどうしはそろえない。
- ライブラリに取り込む(`library.adopt`、比較の表から): 配布元がわかっていてライブラリに無いもの(`catalog.orphans`)はそのまま載せる。記録の無い jar は `identifyIn` で中身から探し、見つからなければ `uploads.fromServer`(自分用の版だけ)。

- バックアップ(`backup.ts`、自分用の版・PGlite だけ): PGlite の `dumpDataDir`・`secret`・`library` を `tar` でまとめ、`/data/v03/backups` に新しい 5 個を残す。戻すときは `restore-pending.tar.gz` を置いて終了し、次の起動で(データベースを開く前・鍵を読む前に)`applyPendingRestore` が入れ替える。今のデータは `before-restore-<日時>` に移し、失敗したら元に戻して `restore-failed-…` に名前を変える。
  - 定期バックアップ(表 `backup_schedule`、03.53.00 から): 毎日 `time`(`tz` は保存したブラウザの時間帯)に作る。置き場所は `target_id` の保存先(`_craftshelf_backup/`。v02 と同じ場所で、名前が違うので混ざらない)か、null ならパネルの中。新しい `keep` 個を残す(手で作るときも同じ)。保存先に置いたものは一覧(`Store.list`)から、ダウンロード・戻すもできる。
- ワールドのバックアップ(`worlds.ts`、表 `world_backup`、03.53.00 から): Pterodactyl はパネルのバックアップ(Client API の backups。サーバー全体)を作り、名前が `CraftShelf ` で始まるもの(このアプリが作ったもの)だけを、鍵つき・作っている途中を除いて `keep` 個まで残す。ダウンロードは Wings の署名付きの URL へ移す。フォルダのサーバー・エージェント(自分用の版だけ)は、`level-name` と `_nether`・`_the_end` を `listFiles`・`readBytes` で 1 ファイルずつ読み、`tar.ts` で tar.gz に少しずつ書く(メモリは 1 ファイルぶん。100 MB を超えるもの・読めないものは飛ばして記録に書く。`session.lock` は入れない)。RCON・コンソールが使えれば `save-off`・`save-all flush` のあとで読み、終わったら `save-on`。置き場所は保存先(`_craftshelf_worlds/<サーバーの ID>/`)かパネルの中(`/data/v03/worlds/<サーバーの ID>/`)。大きいファイルを送る・読むのは `Store.putFile`・`Store.read`(ストリーム)。手で作るときは始めたらすぐ返し、終わると一覧・操作の記録(種類 `backup`、失敗は `errors` も)に出る。予約は 1 分ごとの `tick` で、`last_run_at` を条件付きで書き換えてから始める(終わるのは待たない)。
  - 戻す(`restore`、管理者以上。画面では 2 回確かめる): Pterodactyl はパネルの復元(`truncate` を選べる)。フォルダのサーバー・エージェントは、状態が止まっている(か分からない)ときだけ戻し、動いていれば `stop` を選んだときだけ止めて待つ(2 分)。tar.gz を `untarGz` で 1 ファイルずつ読み、1 つのワールド(と `_nether`・`_the_end`)の中のものだけを受け付ける。最初に出てきたフォルダごとに、今のフォルダを `<名前>.craftshelf-before-restore-<日時>` に名前を変えて残してから `upload` で書く。途中で失敗したら、書いたフォルダを消して名前を戻す。

- 時刻: 表の時刻は `timestamp`(時間帯なし)で、Drizzle は UTC として読み書きする。データベースのつなぎの時間帯を UTC にしている(`db/index.ts`。PGlite はパソコン・コンテナの時間帯を使うため。移行は切り替える前に流し、`0025_time_utc` がそれまでの時間帯で `now()` が入れた時刻を UTC に直した)。画面では利用者の時刻で出す。

- Modpack(`modpack.ts`): ファイルを持たないので、.mrpack は `modrinth.index.json` の mods/ の SHA-1 で Modrinth の版を探し(env.server が unsupported のものは飛ばす)、CurseForge は `manifest.json` の projectID を使う。名前はまとめて取り(Modrinth `/projects`・CurseForge `POST /mods`)、ライブラリに Mod として載せ、同じ名前のセットを作る。overrides は、サーバーを選んだときだけ、テキストの設定ファイル(`files.editable`)を 300 個まで書き込む(上書きする前の中身は `server_file_history` に残す)。

- v02 から移る: v02 のパネル(`v03switch.py`)は GitHub のリリース `v03.xx.xx`(安定版)と `dev-v03.xx.xx`(開発版)の一式を取ってきて乗り換える(同じ版なら安定版)。安定版は `release-v03.yml` が作る(「最新」にはしない。v02 のインストーラー版が最新の正式リリースを見るため)。取り込み直すときは `reimport-pending` を置いて終了し、次の起動で `applyPendingReimport` が v03 のデータを `before-reimport-<日時>` に移す(データベースが空になるので、いつもどおり v02 から取り込む)。

- メール(`mail.ts`、Resend): `RESEND_API_KEY`・`MAIL_FROM` があるときだけ送る。サービス版はメールアドレスの確認を必須にする(`requireEmailVerification`。確かめていない人がログインしようとしたら、確認のメールを送り直す)。パスワードの再設定・招待(URL を決めているとき)も送る。送れなくても、処理は止めない(記録に残す)。

- エージェント(`agent-hub.ts`・`agents.ts`・`src/agent/main.ts`、表 `agent`・`agent_server`): 家の中から外向きにロングポーリングで取りに来る。頼めるのは `AGENT_METHODS` だけで、エージェントも同じ一覧で確かめる。フォルダの操作は `local.ts` をそのまま使い、取り込む URL は最初から配布元の公式の取得先だけに絞る。サーバーは `kind = "agent"` で、`serverOf` が `agentClient`(Pterodactyl と同じ形)を返す。詳しくは docs/AGENT.md。

## 予約

- チームごとに 1 つ(表 `team_schedule`)。曜日・時刻(`tz`、いまは日本時間)・すること(`check` = 確かめるだけ / `sync` = そろえる)。決めるのは `server: ["update"]`。
- `src/server/startup.ts` が 1 分ごとに `tick` を呼ぶ(処理ごとに、前の回が終わっていなければ飛ばす)。時刻になったチームは、動かす前に `last_run_at` を条件付きで書き換え、書き換えられたときだけ動かす(同じ分に 2 回・複数のプロセスで重ねて動かさない)。
- 中身は `setService.runForSchedule`(画面からは呼ばない)。セットを結び付けたサーバーを 1 台ずつ `applyTo` し、1 台が失敗しても残りは続ける。結果は `schedule` の種類で記録する(user_id は null)。
- サーバーごとの予約(表 `server_schedule`、03.55.00 から。v02 の予約同期): `mode` = off / daily / weekly(`dow`)、`time`(`tz`)、すること `action` = update(入っているものを最新に)/ sync(結び付けたセットでそろえる)、`restart` = 何か変えたら再起動する。決めるのは `server: ["update"]`。`serverTick` が 1 分ごとに、チームの予約と同じく `last_run_at` を条件付きで書き換えてから動かし、結果をいつも `schedule` の種類で記録する(Discord には、何か変えたとき・失敗したときだけ送る。`record` の `quiet`、03.56.00 から)。チームの予約(`team_schedule`)とは別に動く。v02 の `sched_*` は `maybeImportV02Schedules` で一度だけ update として引き継ぐ(結果は `/data/v03/import-v02-schedule.json`)。
- サーバーごとの自動更新(`server.auto_update`、入れる・やめるのは `library: ["edit"]`): 同じ 1 分ごとの見回りで `setService.runAutoUpdates` を呼ぶ。前に確かめてから 6 時間(`AUTO_UPDATE_EVERY`)たったサーバーを、`auto_updated_at` を条件付きで書き換えてから動かし、入っているものを `applyTo`(`sync`)で新しい版にする(止めたもの・無効にしたものは除く)。何か変えたとき・失敗したときだけ記録する。v02 で自動更新をオンにしていたサーバーは `maybeImportV02AutoUpdate` で一度だけ引き継ぐ(結果は `/data/v03/import-v02-auto-update.json`)。

## ファイルとコマンド

- コマンド(`src/server/files.ts` の `command`)は Pterodactyl の `/command` に送る。1 行・500 文字まで、権限は `server: ["control"]`。出力はウェブソケットが要るので、いまは受け取らない(パネルのコンソールで見る)。
- 設定ファイルは、サーバーのフォルダーの中の相対パスだけ(`cleanPath`。`..`・`.`・空の区切り・改行を断る)。開けるのはテキストの拡張子(`TEXT_FILE`)で 512 KB までのものだけ。見る・直すのは `server: ["update"]`(パスワードなどが入っていることがあるため)。チームが「編集者にも許す」(表 `team_option.editor_files`、決めるのは `member: ["update"]`、既定はオフ)を選んだときは `library: ["edit"]` でもよい(`files.ts` の `needFiles`。割り当てたサーバーだけ)。
- 保存する前に、画面で書き方を確かめる(`src/lib/syntax.ts`: JSON は `JSON.parse` と場所を探す小さな読み手・YAML は `yaml`・TOML は `smol-toml`・properties は `\u` の形だけ)。誤りがあれば行番号つきで知らせ、それでも保存するかを聞く(サーバー側では断らない)。
- 保存するときは、開いたときの中身(base)とサーバーのいまの中身を比べ、違えば保存しない(409)。保存する前の中身を表 `server_file_history` に残す(1 ファイル 30 件)。

## フォルダでつなぐサーバー(自分用の版だけ)

- 表 `local_server`(サーバー 1 台に 1 行。`server.kind = "local"`)。`src/server/local.ts` の `localClient` は Pterodactyl のクライアントと同じ形(`PteroClient`)で、`serverOf` が種類で切り替える。ほかの処理(ライブラリ・セット・予約・ファイル・ポート)は変えない。
- 使えるのは `deps.local` があるとき(`CRAFTSHELF_MODE=self`)だけ。サービス版はクラウドで動くので、利用者のフォルダは見えない。
- フォルダは絶対パスで、あるフォルダだけ(`checkRoot`)。パネルのデータ(`DATA_DIR`)とそれを含むフォルダは断る。中のパスは `inside` でフォルダの外(`..`・外を指すシンボリックリンク)を断る。
- アドオンは、パネルが配布元の CDN(cdn.modrinth.com・api.spiget.org → cdn.spiget.org)から取ってきて置く(転送は、この 3 つへのものだけを 3 回まで追う。300 MB まで。いったん .part に書いてから名前を変える)。
- 起動・停止: `command`(`spawn` でサーバーのフォルダで実行。起動は待たない、停止は 120 秒まで待つ)/ `docker`(`/var/run/docker.sock` の HTTP API)。RCON(`rcon`)はコマンド・停止(停止のコマンドが無いとき)・状態に使う。パスワードは `seal`(`rcon:<サーバーの ID>`)。設定できるのは `server: ["update"]`。
- v02 からの取り込み(`importFolders`): `kind=local` のうち、このマシンから見えるフォルダのものを、起動・停止・RCON の設定と一緒に取り込む(RCON のパスワードは v02 の鍵で開いて、v03 の鍵で包み直す)。

## アップロードしたアドオン(自分用の版だけ)

- 「ファイルは利用者側だけに置く」の方針に合わせ、自分用の版(利用者のサーバー機)でだけ受け付ける。サービス版では使えない(`deps.local` が無い)。
- ライブラリの項目は `source = "upload"`(`project_id` はこのアプリが作る ID)。版は表 `library_file`(保存先・中の場所・大きさ・SHA-256・版・動くサーバーの種類)。同じ種類で名前が同じなら同じ項目の新しい版、同じ SHA-256 は 2 度入れない。
- jar は `src/server/jar.ts` で、zip の目次から説明ファイルだけを取り出して読む(展開しない。1 ファイル 1 MB まで)。
- 保存先のあいだで移す(`moveFiles`、管理者以上): 1 つずつ、移した先に書いて読み直し、SHA-256 が合えば `target_id` を書き換えてから元を消す。合わない・失敗したものは元に残す。
- 保存先(表 `storage_target`。設定は `seal` で暗号化): パネルの中(既定、`/data/v03/library`)・フォルダ・WebDAV・SMB。SMB は `node-smb2`(SMB 2.0・2.1、NTLMv2 に固定)で、1 回の操作ごとにつないで切る。通信への署名・SMB 3 には対応していないので、それを必須にしている相手はマウントしてフォルダとして使う。中の場所は `<種類>/<名前>/<ID の頭>-<ファイル名>`。保存先を切り替えても、いままでのファイルは元の保存先のまま(`target_id`)。ファイルが残っている保存先は消せない。
- サーバーへは `installInto` が、サーバーの種類に合う作り(`loaders`)のいちばん新しい版を、保存先から読んで送る。Pterodactyl は `files/upload` の署名付きの先へ multipart で送る(undici の fetch には undici の FormData を使う)。フォルダのサーバーは書き込む。
- v02 からの取り込み(`importUploads`、ライブラリ・セットより先に行う): 配布元がわからないプラグイン・Mod を `upload` の項目にし、版は v02 の保存先のファイルをそのまま指す(コピーしない)。v02 のパネルの中(`/data`、中の場所は `library/<relpath>`)・WebDAV・SMB を v03 の保存先として登録する(使う保存先にはしない)。NFS など v03 に無い方式は飛ばす。動くサーバーの種類は v02 の `meta.loader` の表示から決める。
- アップロード・ダウンロードはファイルをそのまま送るので、サーバーの関数ではなく `/api/library/upload`・`/api/library/files/<ID>` の口を使う(権限の確認は `uploadService`)。
- 1 つ 1 GB まで(v02 と同じ。`UPLOAD_LIMITS.fileBytes`)。`receive` は権限を確かめてから、本文を `/data/v03/tmp` に少しずつ書き(上限を超えたらやめる)、jar はファイルの目次と説明ファイルだけを読み(`jar.ts` の `fileSource`)、保存先へは `putFile` で送る。ダウンロード・共有リンク(1 つのとき)は `Store.read` で少しずつ返す。サーバーへ送るとき(`installInto`)と、サーバーの jar を取り込むとき(100 MB まで)はメモリに読む。画面は、いくつでも・フォルダごと(中の .jar だけ)・ドラッグ&ドロップで選べ、1 つずつ順に送る。

## 共有リンクと利用状況

- 共有リンク(表 `share_link`、自分用の版だけ): アップロードしたもののいちばん新しい版を、ログインしていない人に渡す。トークンは 24 バイトの乱数で、SHA-256 のハッシュだけを保存する(URL は作ったときにだけ返す)。期限は 1 時間〜30 日か無期限(`expires_at` を 9999 年にする。前の版でも期限内として読める)。回数の上限(`max_downloads`、1〜1000 回、null は上限なし)は、数えるのと同じ 1 つの UPDATE で確かめる。「止める」は期限を今にする(一覧に残る)。画面は URL と wget・curl のコマンドを出す。いくつかなら圧縮しない zip(`src/server/zip.ts`)。URL は `/s/<トークン>/<ファイル名>`(wget などでも元の名前で保存されるように)。作るのは `library: ["edit"]`、一覧・削除は作った人(管理者はすべて)。
- 利用状況(`usage`、管理者以上): ライブラリの件数(配布元ごと)・アップロードした版の数と大きさ(保存先ごと)・サーバー・入れたもの・セット・メンバー・共有リンクの数。ユーザーごと(`perUser`、03.55.00 から): 登録したもの(種類ごと)・アップロードした版と大きさ・作ったセット・共有リンク・操作の記録の数(すべてと 30 日)・最後の操作。どれもこのチームの中だけを数える。

## API と API トークン

- トークンは Better Auth の apiKey(`cs_` で始まる。ハッシュだけを保存)。`metadata` にチーム(`teamId`)と範囲(`scopes`。03.57.00 から)を持たせ、作った人のそのチームでの役割で、範囲の中だけ動く。範囲は `read`(いつも付く)・`library`・`control`・`admin`(`src/lib/permissions.ts` の `TOKEN_SCOPES`)で、作った人の役割を超えるものは作れない(編集者は library・control まで、閲覧者は read だけ)。前の版に戻しても狭まるよう `readOnly`(read だけのとき true)も書く。03.56 までのトークン(`scopes` なし)は、`readOnly` なら read、そうでなければすべての範囲。1 分に 120 回まで。作る・消すのはログインしてから(トークンでは作れない)。
- 確かめるのは `src/server/guard.ts` の `requireUser`・`requireTeam`。`x-api-key` か `Authorization: Bearer cs_…` があればトークンとして確かめ(`verifyApiKey`)、役割の権限は `roles[role].authorize` で見る。トークンの範囲は、処理が求める権限から決める(`scopesFor`: library の権限 → library、server の control → control、それ以外 → admin)。範囲が足りなければ断る(read だけのトークンは、権限を求める操作をすべて断る)。チームを抜けた人のトークンは使えない。Better Auth の「トークンでログインしたことにする」設定は使わない。
- 外から呼べる API(`src/server/rest.ts`、`/api/v1/…`)は、画面と同じサービスの処理を呼ぶだけ(権限の確認もそちら)。ブラウザのログインの Cookie では使わせず、トークンだけを受け付ける(ほかのサイトから呼ばれないように)。GET はクエリー、POST は JSON を受け取る。ルートの定義(`ROUTES`)には、ひとことの説明(`summary`)・要る範囲(`scope`)・POST の中身の例(`example`)を書き、`GET /api/v1` と画面の「API の説明」(`/api-docs`、curl の例つき)はここから作る(手で二重に書かない)。`tests/rest-docs.test.ts` が説明・範囲の無いもの・英訳の無いものを、`tests/api.test.ts` が範囲の無いトークンで説明どおりに断られるかを確かめる。

## 処理の一覧・個人の設定・ホーム画面に追加(03.57.00 から)

- 処理の一覧(`src/server/jobs.ts`、表 `job`、画面 `/jobs`): 時間のかかる処理を、待ち(`queued`)・実行中・成功・失敗で残す。各サービスが `jobService(deps).track(情報, 処理, 結果のまとめ)` で包む(まとめての処理は `queue` で先に待ちとして並べる)。書いているのは、サーバーへの導入・セットを入れる・セットでそろえる・ほかのサーバーにそろえる・まとめて最新にする・自動更新・予約・サーバー本体の入れ替えと戻す・ワールドのバックアップと戻す・パネルのバックアップ。状態を書けなくても処理は止めない。終わってから 30 日で消す。起動したとき(`instance.ts` の `build()`、リクエストを受ける前)に、待ち・実行中のまま残ったものを失敗にする(プロセスは 1 つの前提)。見られるのはチームのメンバー全員(サーバーを割り当てられた人は、そのサーバーのものと自分の操作だけ)。
- 1 分ごとの処理(`startup.ts` の `minuteTasks`): 処理ごとに独立して動かし、前の回が終わっていない処理だけを飛ばす(どれかが返ってこなくても、ほかは毎回動く)。
- 個人の設定(`src/server/prefs.ts`、表 `user_pref`): 見た目(明るさ・アクセント・テーマ・背景の暗さとぼかし)をアカウントに保存し、`getAppState` で渡す。画面はアカウントの値を当て、まだ無ければブラウザの値を使ってアカウントにも保存する。背景画像は大きいのでブラウザごと(サーバーに送らない)。テーマは v02 の 8 つ(`src/lib/theme.ts` の `PRESETS`。明るさとアクセントの色も決める)と標準。背景は `body::before`(ぼかし `--bg-blur`)・`body::after`(暗さ `--bg-dim`)に置く。v02 の個人設定は `maybeImportV02Prefs` で一度だけ引き継ぐ(`/data/v03/import-v02-prefs.json`)。
- ホーム画面に追加(PWA): `public/manifest.webmanifest`・アイコン(v02 と同じ)・`public/sw.js`。サービスワーカーは画面を保存せず、つながらないときだけ `public/offline.html`(「つながっていません」)を出す。本番のビルドで、https か localhost のときだけ登録する。

## これから決めること・作るもの

1. CurseForge から探す、サーバーに入っている Mod の配布元を見つける(ファイルの中身や SHA-1 から)
2. エージェント: 登録用のトークン・通信の約束事・02 の Python からの切り出し
3. 公開の準備: 利用規約・プライバシーポリシー・監視・利用の上限・メールの送信(Resend などの送信サービス)・セキュリティスキャン

## ポート管理

- 画面は `/ports`(サーバーの画面の「ポート」から)。行 = サーバー(グループごと)、列 = ポートの種類。重複・範囲外と、見つかったポートは右上のベルに出す。
- 表: `port_kind`(種類・範囲・読み書きするファイルと項目・並び順)・`port_group`(グループの番号と名前・並び順)・`server_port_info`(サーバーのグループ・メモ・マシン)・`server_port`(ポート)。
- 読み取り(`src/server/ports.ts` の `scan`): Pterodactyl の割り当て(`network/allocations`)と、種類ごとの設定ファイルの項目(`files/contents`)を読む。`plugins/*/config.yml` からポートらしい項目(名前に port を含む番号)も探し、「見つかった」として聞く。
- 重複は**同じマシン(Pterodactyl のノード)の中だけ**で確かめる(`src/lib/ports.ts` の `findProblems`。画面とサーバーで同じものを使う)。
- 番号を変えると、設定ファイルのその行の番号だけを書き換える(`src/server/port-config.ts`。properties と、字下げで入れ子にする YAML・HOCON・TOML)。割り当てのポートはパネルの「ネットワーク」で変える。
- 見る: チームのメンバー全員。読み取り直す(再読込。Pterodactyl への問い合わせが多い)・種類・グループ・ポートを変える(ファイルの書き換えを含む): `server: ["update"]`。
