// 起動したときに、データベースの準備(移行・v02 の取り込み)と「起動できた」しるしを済ませる。
// 最初のリクエストを待つと、だれも開かないうちの再起動で「起動できなかった」と見なされてしまうため
export default function startup() {
  import("./instance").catch((e) => console.error("[起動] 準備に失敗しました:", e));
}
