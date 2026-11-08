# CraftShelf エージェント

エージェントは、**家の中のサーバー機で動かす小さなプログラム**です。CraftShelf(サービス版)へ外向きにつなぐので、家のルーターのポートを開けずに、家の Minecraft サーバーを CraftShelf から管理できます(Pterodactyl が無くても使えます)。

## できること・できないこと

- CraftShelf から頼めるのは、決まった操作だけです: ファイルの一覧・設定ファイルの読み書き・Mod・プラグインの取り込みと削除・起動と停止・コンソールのコマンド(RCON)・状態
- 扱うのは、**設定ファイルに書いたサーバーのフォルダの中だけ**です(フォルダの外・シンボリックリンクで外を指すものは扱いません)
- 起動・停止は、**設定ファイルに書いたコマンド・Docker のコンテナだけ**を使います。CraftShelf から任意のコマンドを実行させることはできません
- Mod・プラグイン・サーバー本体を取り込むのは、配布元の公式の取得先(Modrinth・SpigotMC・CurseForge・PaperMC・Purpur・Fabric)からだけです

## 使い方

1. CraftShelf の「サーバー」→「エージェント(家の中のサーバー)」で、名前を入れて「エージェントを登録」を押します。**トークン(ca_…)はこのときだけ表示されます**
2. 家のサーバー機(Node.js 22 以上)に、エージェントを取ってきます

   ```sh
   curl -O https://<CraftShelf の URL>/agent/craftshelf-agent.mjs
   ```

3. 同じフォルダに `craftshelf-agent.json` を作ります(画面に出る例をもとに、`servers` を自分のサーバーに合わせて書き換えます)

   ```json
   {
     "url": "https://craftshelf.example.com",
     "token": "ca_…",
     "servers": [
       { "key": "lobby", "name": "ロビー", "root": "/srv/minecraft/lobby",
         "control": "docker", "container": "mc-lobby", "rconPort": 25575, "rconPassword": "…" },
       { "key": "survival", "name": "サバイバル", "root": "/srv/minecraft/survival",
         "control": "command", "startCmd": "systemctl start mc-survival", "stopCmd": "systemctl stop mc-survival" }
     ]
   }
   ```

   - `key`: サーバーの見分け(英数字と `_ . -`、40 文字まで)。あとから変えると、CraftShelf では別のサーバーになります
   - `root`: サーバーのフォルダ(絶対パス)
   - `control`: 起動・停止の方法。`none`(しない)・`command`(`startCmd`・`stopCmd` を実行)・`docker`(`container` を起動・停止。`/var/run/docker.sock` が要ります)
   - `rconPort`・`rconPassword`: コンソールのコマンド・停止・状態に使います(`server.properties` の `enable-rcon=true` も要ります)
4. 動かします

   ```sh
   node craftshelf-agent.mjs craftshelf-agent.json
   ```

   ずっと動かすときは、systemd のサービスや Docker の `restart: unless-stopped` などで動かしてください
5. CraftShelf の画面にエージェントのサーバーが出たら、「追加」を押します。あとは、Pterodactyl のサーバーと同じように使えます

## 気をつけること

- トークンは、エージェントのパスワードです。漏れたときは、CraftShelf でエージェントを消して登録し直し、設定ファイルのトークンを替えてください
- 設定ファイルには RCON のパスワードなども入るので、ほかの人が読めない場所に置いてください(例 `chmod 600 craftshelf-agent.json`)
- エージェントは、CraftShelf のパネルと同じ版のものを使ってください(パネルの `/agent/craftshelf-agent.mjs` から取ってきたもの)

## 作り(開発者向け)

- やりとり: エージェントが `POST /api/agent/poll`(`Authorization: Bearer ca_…`)で取りに来て、頼みごとがあればすぐ、無ければ 25 秒待って返します。エージェントは結果を `POST /api/agent/result` で返します(`src/server/agent-hub.ts`)。頼みごとはサービスのプロセスの中の列に持ちます
- サービス側: エージェントのサーバーは `server.kind = "agent"`(表 `agent`・`agent_server`)。`serverOf` が Pterodactyl と同じ形のクライアント(`agentClient`)を返すので、ライブラリ・セット・ファイル・サーバー本体などの処理はそのまま動きます
- エージェント: `src/agent/main.ts`。フォルダの操作は自分用の版の「フォルダのサーバー」(`src/server/local.ts`)と同じものを使い、`npm run build` で `public/agent/craftshelf-agent.mjs` に 1 つのファイルとしてまとめ、パネルの `/agent/craftshelf-agent.mjs` から配ります
