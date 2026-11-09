// 起動したときに、データベースの準備(移行・v02 の取り込み)と「起動できた」しるしを済ませる。
// 最初のリクエストを待つと、だれも開かないうちの再起動で「起動できなかった」と見なされてしまうため。
// あわせて、予約などを 1 分ごとに確かめる(処理ごとに独立して動かし、前の回が終わっていない処理は、その回は飛ばす)

/** 1 分ごとに呼ぶ関数を作る。どれかが返ってこなくても、ほかの処理は毎回動く */
export function minuteTasks(tasks: [string, (now: Date) => Promise<unknown>][]) {
  const busy = new Set<string>();
  return (now = new Date()) => {
    for (const [name, fn] of tasks) {
      if (busy.has(name)) continue;
      busy.add(name);
      Promise.resolve().then(() => fn(now)).catch((e) => console.error(`[${name}] 動かせませんでした:`, e)).finally(() => busy.delete(name));
    }
  };
}

export default function startup() {
  import("./instance").then(({ env, db, schedules, sets, library, telemetry, updates, events, backups, worlds, saved }) => {
    // 利用状況の送信(同意したパネルだけ。1 時間ごとに確かめ、前に送ってから 1 日たっていれば送る)
    const tele = setInterval(() => { telemetry.sendIfDue().catch(() => {}); }, 60 * 60_000);
    tele.unref?.();
    setTimeout(() => { telemetry.sendIfDue().catch(() => {}); }, 60_000).unref?.();
    // パネルの新しい版を知らせ、自動アップデートを使うなら入れて再起動する(自分用の版だけ。GitHub の API の回数に上限があるので 6 時間ごと)
    if (updates) {
      const panel = async () => {
        if (await updates.check()) {
          console.log("[版] 自動アップデートを入れました。再起動します");
          setTimeout(() => process.exit(0), 800);
        }
      };
      setInterval(() => { panel().catch((e) => console.error("[版] 確かめられませんでした:", e instanceof Error ? e.message : e)); }, 6 * 60 * 60_000).unref?.();
      setTimeout(() => { panel().catch(() => {}); }, 2 * 60_000).unref?.();
    }
    // サーバーの上のコマンド(launcher.mjs reset-owner)からの、ログインを戻す頼みごと(自分用の版だけ。数秒ごとに見る)
    if (env.mode === "self") {
      let busy = false;
      setInterval(() => {
        if (busy) return;
        busy = true;
        import("./owner-reset").then(({ applyOwnerReset }) => applyOwnerReset(db, env.v03Dir, events.record))
          .then((r) => { if (r) console.log(r.ok ? `[ログインを戻す] ${r.user} の二段階認証・パスキーを外し、パスワードを置き換えました` : `[ログインを戻す] できませんでした: ${r.error}`); })
          .catch((e) => console.error("[ログインを戻す] 動かせませんでした:", e))
          .finally(() => { busy = false; });
      }, 3000).unref?.();
    }
    // 予約と、サーバーごとの自動更新・新しい版の見回り・定期バックアップ(ワールドは始めるだけで、終わるのを待たない)・保存を有効にしたアイテムのいちばん新しい版を取ってくる
    const tick = minuteTasks([
      ["予約", (n) => schedules.tick(n)],
      ["サーバーの予約", (n) => schedules.serverTick(n)],
      ["自動更新", (n) => sets.runAutoUpdates(n)],
      ["新しい版の見回り", (n) => sets.runUpdateChecks(n)],
      ["定期バックアップ", (n) => backups.tick(n)],
      ["ワールドのバックアップ", (n) => worlds.tick(n)],
      ["対応 MC の取り直し", (n) => library.refreshInfo(n)],
      ["保存した版の見回り", (n) => saved.tick(n)],
    ]);
    const timer = setInterval(() => tick(), 60_000);
    timer.unref?.();
  }).catch((e) => console.error("[起動] 準備に失敗しました:", e));
}
