// 起動したときに、データベースの準備(移行・v02 の取り込み)と「起動できた」しるしを済ませる。
// 最初のリクエストを待つと、だれも開かないうちの再起動で「起動できなかった」と見なされてしまうため。
// あわせて、予約を 1 分ごとに確かめる(前の回が終わっていなければ、その回は飛ばす)
export default function startup() {
  import("./instance").then(({ schedules, sets, telemetry, versions, events, backups, worlds }) => {
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
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      const now = new Date();
      // 予約と、サーバーごとの自動更新・新しい版の見回り・定期バックアップ(ワールドは始めるだけで、終わるのを待たない)
      Promise.all([
        schedules.tick(now).catch((e) => console.error("[予約] 確かめられませんでした:", e)),
        schedules.serverTick(now).catch((e) => console.error("[サーバーの予約] 確かめられませんでした:", e)),
        sets.runAutoUpdates(now).catch((e) => console.error("[自動更新] 確かめられませんでした:", e)),
        sets.runUpdateChecks(now).catch((e) => console.error("[新しい版の見回り] 確かめられませんでした:", e)),
        backups.tick(now).catch((e) => console.error("[定期バックアップ] 確かめられませんでした:", e)),
        worlds.tick(now).catch((e) => console.error("[ワールドのバックアップ] 確かめられませんでした:", e)),
      ]).finally(() => { busy = false; });
    }, 60_000);
    timer.unref?.();
  }).catch((e) => console.error("[起動] 準備に失敗しました:", e));
}
