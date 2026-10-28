#!/bin/sh
# 自分用の版の起動。パネルで選んだ版(/data/v03/versions/current)があればそれを、無ければイメージの版を起動する。
# 選んだ版が前回うまく起動しなかった(.starting が消えていない)ときは、イメージの版に戻す(起動できなくなるのを防ぐ)
V03="${DATA_DIR:-/data}/v03/versions"
if [ -f "$V03/current" ]; then
  D="$V03/$(tr -cd '0-9.' < "$V03/current")"
  if [ -f "$D/.starting" ] || [ ! -f "$D/.output/server/index.mjs" ]; then
    echo "[版] $(cat "$V03/current") を起動できなかったので、イメージの版($(cat /app/VERSION))に戻します"
    rm -f "$V03/current" "$D/.starting"
  else
    touch "$D/.starting"
    cd "$D" && MIGRATIONS_DIR="$D/drizzle" exec node .output/server/index.mjs
  fi
fi
cd /app && exec node .output/server/index.mjs
