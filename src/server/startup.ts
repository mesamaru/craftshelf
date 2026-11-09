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
  import("./instance").then(({ schedules, sets, library, telemetry, versions, events, backups, worlds }) => {
    // 利用状況の送信(同意したパネルだけ。1 時間ごとに確かめ、前に送ってから 1 日たっていれば送る)
    const tele = setInterval(() => { telemetry.sendIfDue().catch(() => {}); }, 60 * 60_000);
    tele.unref?.();
    setTimeout(() => { telemetry.sendIfDue().catch(() => {}); }, 60_000).unref?.();
    // パネルの新しい版(自分用の版だけ。GitHub の API の回数に上限があるので 6 時間ごと)
    if (versions) {
      const panel = async () => {
        const [newest] = await versions.list();
        if (newest && newest.version > versions.state().current) await events.announcePanel(newest.version);
      };
      setInterval(() => { panel().catch(() => {}); }, 6 * 60 * 60_000).unref?.();
      setTimeout(() => { panel().catch(() => {}); }, 2 * 60_000).unref?.();
    }
    // 予約と、サーバーごとの自動更新・新しい版の見回り・定期バックアップ(ワールドは始めるだけで、終わるのを待たない)
    const tick = minuteTasks([
      ["予約", (n) => schedules.tick(n)],
      ["サーバーの予約", (n) => schedules.serverTick(n)],
      ["自動更新", (n) => sets.runAutoUpdates(n)],
      ["新しい版の見回り", (n) => sets.runUpdateChecks(n)],
      ["定期バックアップ", (n) => backups.tick(n)],
      ["ワールドのバックアップ", (n) => worlds.tick(n)],
      ["対応 MC の取り直し", (n) => library.refreshInfo(n)],
    ]);
    const timer = setInterval(() => tick(), 60_000);
    timer.unref?.();
  }).catch((e) => console.error("[起動] 準備に失敗しました:", e));
}
