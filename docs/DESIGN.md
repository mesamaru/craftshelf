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
- 足すのは `library: ["edit"]`(編集者以上)。プラグインと Mod だけ。外してもサーバーのファイルは消さない。無料の上限は 1 チーム 500 件(`LIBRARY_LIMITS`)。
- タグ(表 `library_tag`、チームの中で共有。付け外しは `library: ["edit"]`、1 つ 30 文字・1 件に 20 個まで)とお気に入り(表 `library_favorite`、利用者ごと。閲覧者もできる。一覧の上に並べる)。
- 一覧の絞り込み(名前・種類・配布元・タグ)と並べ替え(名前・追加日)は画面の中だけで行う。「更新あり」は押したときだけ `outdated` が配布元に問い合わせる(サーバーの種類とバージョンごとに 1 回。更新を止めたもの・割り当てのないサーバーは見ない)。まとめて操作(タグ・セットに足す・外す)は、選んだものに 1 件ずつ同じ処理を呼ぶ(タグだけは 1 回で付ける)。
- v02 からの取り込み(`maybeImportV02Library`、結果は `/data/v03/import-v02-library.json`): v02 から移った自分用の版で一度だけ。配布元が Modrinth(ID が 8 文字)とわかるプラグイン・Mod と、SpigotMC(数字の ID)とわかるプラグインだけを載せ、v02 のセットも作る(版の固定は引き継がない)。アップロードしただけのファイル・CurseForge・データパックは、名前を結果に残して飛ばす。

## セット

- ライブラリから選んだものの組み合わせ(表 `addon_set`・`addon_set_item`。中身はライブラリの項目を指すだけ。ライブラリから外すとセットからも外れる)。
- 「サーバーに入れる」(`apply`)は、サーバーの種類(プラグイン / Mod)に合うもので、このアプリで入れた記録(`installed_mod`)に無いものだけを入れる。種類の合わないものは入れない。1 件ずつ結果(入れた・入っている・入れない・入れられない)を返し、失敗しても残りは続ける。入れる処理はライブラリと同じ(`modTools` の `installInto`)。
- 権限: 作る・中身を変える・入れるのは `library: ["edit"]`、見るのはメンバー全員。無料の上限は 1 チーム 50 個・1 セット 200 件(`SET_LIMITS`)。
- サーバーに結び付けるセットは 1 台に 1 つ(表 `server_set`)。「そろえる」(`sync`)は `apply` と同じく種類の合うものだけを扱い、足りないものを入れ、入っているもの(`installed_mod`)に新しい版(`latestFile` の版が記録と違う)があれば入れ直す(= 更新。古いファイルは消す)。セットに無いものは外さない。
- 「更新を止める」(表 `server_hold`、サーバー × 配布元 × ID)。そろえる・予約・更新の確認では、止めたものを新しい版にしない(画面の「更新」は、その場の操作なので止めない)。
- サーバーの比較(`/compare`): `catalog` の `installs` だけで表を作る(サーバーには問い合わせない)。版を選ぶときは `versions`(Modrinth・CurseForge はサーバーの種類・バージョンに合う版を新しい順に 30 個、アップロードしたものは保存した版。SpigotMC は前の版を取ってこられないので無し)。`install` に `versionId` を渡すと、その一覧にある版だけを受け付け、いちばん新しい版でなければ `server_hold` に入れる。
- 種類(プラグイン・Mod): Modrinth は、Fabric などにも対応したプラグインを `project_type: "mod"` と返すので、ライブラリに足すときは探したときの種類、入れたときは入れたサーバーの種類で決める。
- 「前の版に戻す」: `installInto` が更新で入れ替えた版を表 `install_history` に残す(1 つにつき 10 件)。`rollback` はいちばん新しい前の版を `fileById`(Modrinth は `/version/<ID>`、CurseForge は `/files/<ID>`、アップロードは版の行)で取り直して入れ、使った記録と戻す前の版の記録を消し、`server_hold` を付ける。SpigotMC は古い版を取ってこられないので戻せない。
- 前提: Modrinth の版の `dependencies` のうち `required` のもの(CurseForge は `relationType: 3`)を `FileChoice.deps` で返し、同じ配布元から、`installInto` がまだ入っていないものを入れる(2 段まで。入れられなくても本体はそのまま)。
- 「セットに無いものを外す」(`sync` の `removeExtra`)は、`installed_mod` の記録があるもの(このアプリで入れたもの)のうち、セットに無いものだけを外す。手で置いたファイルは記録が無いので触らない。予約では外さない(気づかないうちに消えないように)。

- **SpigotMC**(`src/server/spiget.ts`): Spiget(SpigotMC の公開 API)で探し、Pterodactyl に `https://api.spiget.org/v2/resources/<数字の ID>/download`(Spiget の CDN へ転送される)を取り込ませる。URL はこちらで組み立てるものだけ。SpigotMC の外のサイトで配っているもの(external)・有料のもの(premium)・プラグインではないカテゴリー(Standalone・Web・DataPack)は扱わない。
  - 動くサーバーはカテゴリーで決める(`spigetFits`): サーバー用 → Paper・Purpur・Spigot、プロキシ用 → BungeeCord、Universal → 両方。Folia・Velocity は見分けられないので入れない。Minecraft のバージョンでは絞らない(SpigotMC の対応バージョンは作者の自己申告で粗いため)。版はいちばん新しいものだけ(古い版は Spiget から取り込めない)。
  - ファイルの名前は、名前と版から安全な文字だけで作る(作れなければ `spigot-<ID>.jar`)。
- 配布元は `installed_mod`・`library_item` の `source`(`modrinth` / `spigot`)で分け、同じものかは「配布元 + ID」で判断する(`src/lib/sources.ts`)。
- **CurseForge**(`src/server/curseforge.ts`、自分用の版だけ): チームが設定した利用者の API キー(表 `team_curseforge`、`seal`)で使う。サービス版では使わない(CurseForge の規約で、サービスとして使うには別の取り決めが要るため)。分類はプラグイン = 5・Mod = 6、作りは `modLoaderType`(Forge 1・Fabric 4・Quilt 5・NeoForge 6)。取り込ませるのは `downloadUrl` が forgecdn.net のものだけで、作者が外部からのダウンロードを許していないもの(`allowModDistribution: false`・`downloadUrl` が無い)は扱わない。

## 操作の記録と通知

- 操作の記録(表 `audit_log`。`src/server/events.ts` の `record`)。各サービスの、変える操作の最後に記録する(だれが・何を・どのサーバーに・詳しい内容)。予約で動いたものは user_id が null。見られるのは `member: ["update"]`(管理者以上)。
- Discord への通知(表 `team_notify`)。Webhook の URL は `seal` で暗号化して保存し、`https://discord.com/api/webhooks/…`(discordapp.com・ptb・canary を含む)だけを受け付ける。記録の種類(`EVENT_KINDS`: changes・sets・schedule・power・admin)のうち、選んだものだけを送る。`allowed_mentions` を空にしてメンションさせない。送れなくても、もとの操作は失敗させない。

- ファイル比較(`/compare/files`、`files.configs`): v02 と同じ場所(一番上・plugins は 3 段・config は 4 段・mods/config は 3 段)から、開ける設定ファイルを 1 台 400 個まで集める。一覧では中身を読まず大きさで見る。開いたら全部を読み、行の差分(`src/lib/diff.ts`、Myers の方法)で基準にそろえて並べる。写すのは `files.save`(履歴に残る)。

- サーバーの割り当て(表 `member_server_limit`・`member_server`): `member_server_limit` に行がある閲覧者・編集者は、`member_server` のサーバーだけを使える。確かめるのは `serverOf(deps, who, id)`(`who` は `requireTeam` の結果。チームの ID だけを渡すのは予約などの人でない操作だけ)と `needServerAccess`、一覧は `serverScope` で絞る。管理者・オーナーは制限しない。

- サーバー本体(`software.ts`、表 `server_software`): 今のビルドは「入れ替えた記録(jar の大きさが同じなら)→ version_history.json → jar の名前」の順に読む。入れ替えは、今の jar を `<jar>.craftshelf-old` に名前を変えてから、同じ名前で配布元(`BUILD_HOSTS` の公式の取得先だけ)から取り込ませる。取り込めなければ名前を戻す。戻すときは 2 つの名前を入れ替える(もう一度押すと元に戻る)。

- 配布元を探す(`library.identify`): このアプリの記録が無い jar を 1 回に 100 個まで読み(Pterodactyl はダウンロード用の URL から)、Modrinth の `version_files`(SHA-1)・CurseForge の `fingerprints`(`fingerprint.ts`、v02 と同じ MurmurHash2)で探す。見つかったものは `installed_mod` に記録し、ライブラリにも載せる(種類はサーバーの種類)。見つからないものは `uploads.fromServer` でアップロードしたものとして取り込める。

- 変更の履歴(表 `server_change`): `installInto` が入れる・更新を、`remove` が外すを残す。外すときは消さずに `<名前>.craftshelf-removed` に名前を変える(元に戻すと名前を戻す)。更新を元に戻すのは `fileById` で前の版を取り直す(SpigotMC はできない)。1 台につき新しい 30 件までで、古いものの残したファイルも消す。セットの「セットに無いものを外す」も同じように残す(外すのは `modTools.removeFrom` にまとめてある)。
- 無効にする(`library.setEnabled`): 消さずに `<名前>.jar.disabled` に名前を変える(v02 と同じ)。`installed_mod` の記録の名前も変え、履歴(「無効にする」「有効にする」)から戻せる。無効にしたものは、更新の確認・セットでそろえる・自動更新・ほかのサーバーにそろえるで入れ替えない(比較の表・入っているものには「無効」と出す)。
- 設定フォルダの退避: プラグインを外す・更新で入れ替えるとき、jar の plugin.yml の名前と同じフォルダ(`plugins/<名前>/`)を `plugins/.craftshelf-config/<key>/<名前>/` に写し、`server_change.config_backup` に残す。元に戻すと上書きで戻す。Pterodactyl・フォルダ・エージェントのどれでも動くよう、`listFiles`・`readBytes`・`upload` だけで 1 ファイルずつ写す(隠しファイルは除く。100 個・20 MB・6 段を超えるフォルダは退避しない)。退避できなくても入れ替え・外すは続ける。履歴を消すときに退避先も消す(フォルダのサーバーの `deleteFiles` も、Pterodactyl と同じくフォルダーを中身ごと消す)。
- ほかのサーバーにそろえる(`sets.copy`、画面は「ほかのサーバーとそろえる」。検証用から本番へ反映するのも同じ): そろえる元の `installed_mod`(無効にしたものは除く)と同じ版を、そろえる先の種類・バージョンに合うときだけ入れる(`versionsOf` に無い版は入れない。SpigotMC はいちばん新しい版のときだけ)。`update` = 入っているものだけ / `add` = 足りないものも / `mirror` = さらに、そろえる元に無いもの(このアプリで入れたもの)を外す。先で止めているもの・無効にしたものは変えない。元で止めているものは、先でも止める。プラグインと Mod のサーバーどうしはそろえない。
- ライブラリに取り込む(`library.adopt`、比較の表から): 配布元がわかっていてライブラリに無いもの(`catalog.orphans`)はそのまま載せる。記録の無い jar は `identifyIn` で中身から探し、見つからなければ `uploads.fromServer`(自分用の版だけ)。

- バックアップ(`backup.ts`、自分用の版・PGlite だけ): PGlite の `dumpDataDir`・`secret`・`library` を `tar` でまとめ、`/data/v03/backups` に新しい 5 個を残す。戻すときは `restore-pending.tar.gz` を置いて終了し、次の起動で(データベースを開く前・鍵を読む前に)`applyPendingRestore` が入れ替える。今のデータは `before-restore-<日時>` に移し、失敗したら元に戻して `restore-failed-…` に名前を変える。

- Modpack(`modpack.ts`): ファイルを持たないので、.mrpack は `modrinth.index.json` の mods/ の SHA-1 で Modrinth の版を探し(env.server が unsupported のものは飛ばす)、CurseForge は `manifest.json` の projectID を使う。名前はまとめて取り(Modrinth `/projects`・CurseForge `POST /mods`)、ライブラリに Mod として載せ、同じ名前のセットを作る。overrides は、サーバーを選んだときだけ、テキストの設定ファイル(`files.editable`)を 300 個まで書き込む(上書きする前の中身は `server_file_history` に残す)。

- v02 から移る: v02 のパネル(`v03switch.py`)は GitHub のリリース `v03.xx.xx`(安定版)と `dev-v03.xx.xx`(開発版)の一式を取ってきて乗り換える(同じ版なら安定版)。安定版は `release-v03.yml` が作る(「最新」にはしない。v02 のインストーラー版が最新の正式リリースを見るため)。取り込み直すときは `reimport-pending` を置いて終了し、次の起動で `applyPendingReimport` が v03 のデータを `before-reimport-<日時>` に移す(データベースが空になるので、いつもどおり v02 から取り込む)。

- メール(`mail.ts`、Resend): `RESEND_API_KEY`・`MAIL_FROM` があるときだけ送る。サービス版はメールアドレスの確認を必須にする(`requireEmailVerification`。確かめていない人がログインしようとしたら、確認のメールを送り直す)。パスワードの再設定・招待(URL を決めているとき)も送る。送れなくても、処理は止めない(記録に残す)。

- エージェント(`agent-hub.ts`・`agents.ts`・`src/agent/main.ts`、表 `agent`・`agent_server`): 家の中から外向きにロングポーリングで取りに来る。頼めるのは `AGENT_METHODS` だけで、エージェントも同じ一覧で確かめる。フォルダの操作は `local.ts` をそのまま使い、取り込む URL は最初から配布元の公式の取得先だけに絞る。サーバーは `kind = "agent"` で、`serverOf` が `agentClient`(Pterodactyl と同じ形)を返す。詳しくは docs/AGENT.md。

## 予約

- チームごとに 1 つ(表 `team_schedule`)。曜日・時刻(`tz`、いまは日本時間)・すること(`check` = 確かめるだけ / `sync` = そろえる)。決めるのは `server: ["update"]`。
- `src/server/startup.ts` が 1 分ごとに `tick` を呼ぶ(前の回が終わっていなければ飛ばす)。時刻になったチームは、動かす前に `last_run_at` を条件付きで書き換え、書き換えられたときだけ動かす(同じ分に 2 回・複数のプロセスで重ねて動かさない)。
- 中身は `setService.runForSchedule`(画面からは呼ばない)。セットを結び付けたサーバーを 1 台ずつ `applyTo` し、1 台が失敗しても残りは続ける。結果は `schedule` の種類で記録する(user_id は null)。
- サーバーごとの自動更新(`server.auto_update`、入れる・やめるのは `library: ["edit"]`): 同じ 1 分ごとの見回りで `setService.runAutoUpdates` を呼ぶ。前に確かめてから 6 時間(`AUTO_UPDATE_EVERY`)たったサーバーを、`auto_updated_at` を条件付きで書き換えてから動かし、入っているものを `applyTo`(`sync`)で新しい版にする(止めたもの・無効にしたものは除く)。何か変えたとき・失敗したときだけ記録する。v02 で自動更新をオンにしていたサーバーは `maybeImportV02AutoUpdate` で一度だけ引き継ぐ(結果は `/data/v03/import-v02-auto-update.json`)。

## ファイルとコマンド

- コマンド(`src/server/files.ts` の `command`)は Pterodactyl の `/command` に送る。1 行・500 文字まで、権限は `server: ["control"]`。出力はウェブソケットが要るので、いまは受け取らない(パネルのコンソールで見る)。
- 設定ファイルは、サーバーのフォルダーの中の相対パスだけ(`cleanPath`。`..`・`.`・空の区切り・改行を断る)。開けるのはテキストの拡張子(`TEXT_FILE`)で 512 KB までのものだけ。見る・直すのは `server: ["update"]`(パスワードなどが入っていることがあるため)。
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

## 共有リンクと利用状況

- 共有リンク(表 `share_link`、自分用の版だけ): アップロードしたもののいちばん新しい版を、ログインしていない人に渡す。トークンは 24 バイトの乱数で、SHA-256 のハッシュだけを保存する(URL は作ったときにだけ返す)。期限は 1 時間〜30 日。いくつかなら圧縮しない zip(`src/server/zip.ts`)。URL は `/s/<トークン>/<ファイル名>`(wget などでも元の名前で保存されるように)。作るのは `library: ["edit"]`、一覧・削除は作った人(管理者はすべて)。
- 利用状況(`usage`、管理者以上): ライブラリの件数(配布元ごと)・アップロードした版の数と大きさ(保存先ごと)・サーバー・入れたもの・セット・メンバー・共有リンクの数。

## API と API トークン

- トークンは Better Auth の apiKey(`cs_` で始まる。ハッシュだけを保存)。`metadata` にチーム(`teamId`)と「読み取りだけ」(`readOnly`)を持たせ、作った人のそのチームでの役割で動く。1 分に 120 回まで。作る・消すのはログインしてから(トークンでは作れない)。
- 確かめるのは `src/server/guard.ts` の `requireUser`・`requireTeam`。`x-api-key` か `Authorization: Bearer cs_…` があればトークンとして確かめ(`verifyApiKey`)、役割の権限は `roles[role].authorize` で見る。読み取りだけのトークンは、権限を求める操作をすべて断る。チームを抜けた人のトークンは使えない。Better Auth の「トークンでログインしたことにする」設定は使わない。
- 外から呼べる API(`src/server/rest.ts`、`/api/v1/…`)は、画面と同じサービスの処理を呼ぶだけ(権限の確認もそちら)。ブラウザのログインの Cookie では使わせず、トークンだけを受け付ける(ほかのサイトから呼ばれないように)。`GET /api/v1` で一覧を返す。

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
