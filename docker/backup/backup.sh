#!/bin/sh
# データベースのバックアップ。保存先は BACKUP_TARGETS で選ぶ(nas・r2 をカンマ区切り。両方を勧める)
#   backup.sh loop       … 毎日 BACKUP_TIME(既定 04:00)に取る
#   backup.sh now        … いますぐ 1 回取る
#   backup.sh restore <ファイル名> [nas|r2] … そのバックアップでデータベースを戻す
set -eu

TARGETS="${BACKUP_TARGETS:-nas,r2}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
NAS_DIR=/backup/nas
WORK=/tmp/backup

log() { echo "[backup] $(date '+%F %T') $*"; }
has() { case ",$TARGETS," in *",$1,"*) return 0 ;; esac; return 1; }

# R2 は S3 互換。rclone の設定は環境変数で渡す(設定ファイルを置かない)
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${BACKUP_R2_ACCESS_KEY_ID:-}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${BACKUP_R2_SECRET_ACCESS_KEY:-}"
export RCLONE_CONFIG_R2_ENDPOINT="https://${BACKUP_R2_ACCOUNT_ID:-none}.r2.cloudflarestorage.com"
R2_PATH="r2:${BACKUP_R2_BUCKET:-craftshelf-backup}/${BACKUP_R2_PREFIX:-db}"

check() {
  [ -n "${BACKUP_AGE_RECIPIENT:-}" ] || log "注意: BACKUP_AGE_RECIPIENT が無いので暗号化せずに保存します"
  if has nas && ! grep -qE " $NAS_DIR (cifs|smb3|nfs|nfs4) " /proc/mounts; then
    log "エラー: NAS がつながっていません(docker-compose.nas-smb.yml か nas-nfs.yml を重ねてください)"
    return 1
  fi
  if has r2 && [ -z "${BACKUP_R2_ACCESS_KEY_ID:-}" ]; then
    log "エラー: R2 の設定(BACKUP_R2_*)がありません"
    return 1
  fi
}

run_once() {
  check
  mkdir -p "$WORK"
  name="craftshelf-$(date -u +%Y%m%dT%H%M%SZ).dump"
  pg_dump --format=custom --compress=9 --file="$WORK/$name"
  if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
    age -r "$BACKUP_AGE_RECIPIENT" -o "$WORK/$name.age" "$WORK/$name"
    rm -f "$WORK/$name"
    name="$name.age"
  fi
  ok=0
  if has nas; then
    cp "$WORK/$name" "$NAS_DIR/$name.part" && mv "$NAS_DIR/$name.part" "$NAS_DIR/$name" && ok=$((ok + 1)) && log "NAS に保存: $name"
    find "$NAS_DIR" -name 'craftshelf-*.dump*' -mtime "+$KEEP_DAYS" -delete
  fi
  if has r2; then
    rclone copyto "$WORK/$name" "$R2_PATH/$name" && ok=$((ok + 1)) && log "R2 に保存: $name"
    rclone delete "$R2_PATH" --min-age "${KEEP_DAYS}d" --include 'craftshelf-*.dump*'
  fi
  rm -f "$WORK/$name"
  [ "$ok" -gt 0 ] || { log "エラー: どこにも保存できませんでした"; return 1; }
}

restore() {
  file="$1"; from="${2:-nas}"
  mkdir -p "$WORK"
  case "$from" in
    nas) cp "$NAS_DIR/$file" "$WORK/$file" ;;
    r2) rclone copyto "$R2_PATH/$file" "$WORK/$file" ;;
    *) log "保存先は nas か r2 を指定してください"; exit 2 ;;
  esac
  if [ "${file%.age}" != "$file" ]; then
    [ -n "${BACKUP_AGE_IDENTITY:-}" ] || { log "暗号化を解く鍵(BACKUP_AGE_IDENTITY に鍵のファイル)がありません"; exit 2; }
    age -d -i "$BACKUP_AGE_IDENTITY" -o "$WORK/${file%.age}" "$WORK/$file"
    rm -f "$WORK/$file"; file="${file%.age}"
  fi
  log "データベースを $file の内容で置き換えます"
  pg_restore --clean --if-exists --no-owner --dbname="$PGDATABASE" "$WORK/$file"
  rm -f "$WORK/$file"
  log "戻しました。app を再起動してください"
}

case "${1:-loop}" in
  now) run_once ;;
  restore) [ $# -ge 2 ] || { echo "使い方: backup.sh restore <ファイル名> [nas|r2]"; exit 2; }; restore "$2" "${3:-nas}" ;;
  loop)
    check || log "設定を直すまで、バックアップは失敗します"
    at="${BACKUP_TIME:-04:00}"
    while :; do
      now=$(date +%s); next=$(date -d "$(date +%F) $at" +%s 2>/dev/null || date -D '%F %H:%M' -d "$(date +%F) $at" +%s)
      [ "$next" -gt "$now" ] || next=$((next + 86400))
      sleep $((next - now))
      run_once || log "バックアップに失敗しました"
    done ;;
  *) echo "使い方: backup.sh [loop|now|restore <ファイル名> [nas|r2]]"; exit 2 ;;
esac
