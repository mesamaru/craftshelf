#!/usr/bin/env bash
# CraftShelf v03 を Linux(systemd)に入れ、サービスとして常駐させる(v02 の install.sh と同じ流れ)。
#
#   curl -fsSL https://raw.githubusercontent.com/mesamaru/craftshelf/dev/install.sh | sudo bash
#
# GitHub のリリースから、Node.js ごとまとめた一式(craftshelf-v03-<版>-linux-<x64|arm64>.tar.gz)を取ってきて、
# チェックサムを確かめて /opt/craftshelf-v03 に置く。もう一度動かすと新しい版に入れ替える(データはそのまま)。
# パネルの「パネルのバージョン」での切り替え・自動アップデートも使える(取ってきた版は データ/v03/versions に置く)。
# v02 の install.sh で入れていたときは、同じデータ(/var/lib/craftshelf)を使うので、初めての起動で v02 のデータを取り込む
# (v02 のデータは書き換えない。v02 に戻すときは v02 の install.sh をもう一度動かす)。
#
# 変えられる設定(環境変数): CRAFTSHELF_PORT(既定 8765)/ CRAFTSHELF_HOST(既定 0.0.0.0)/
#   CRAFTSHELF_CHANNEL(stable = 安定版 v03.xx.xx〔既定〕/ dev = 開発版 dev-v03.xx.xx も)/ CRAFTSHELF_VERSION(03.62.00 のように版を決める)
# 取り除く: sudo bash install.sh --uninstall  (データ /var/lib/craftshelf は残す)
set -euo pipefail

REPO="mesamaru/craftshelf"
PORT="${CRAFTSHELF_PORT:-8765}"
HOST="${CRAFTSHELF_HOST:-0.0.0.0}"
CHANNEL="${CRAFTSHELF_CHANNEL:-stable}"
WANT="${CRAFTSHELF_VERSION:-}"
APP_DIR=/opt/craftshelf-v03
DATA_DIR=/var/lib/craftshelf
SVC_USER=craftshelf
UNIT=/etc/systemd/system/craftshelf.service

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mエラー:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root で動かしてください(例: curl ... | sudo bash)"
command -v systemctl >/dev/null || die "systemd が必要です(ほかの環境では Docker 版をお使いください)"

if [ "${1:-}" = "--uninstall" ]; then
    say "CraftShelf を止めて取り除きます(データ ${DATA_DIR} は残します)"
    systemctl disable --now craftshelf 2>/dev/null || true
    rm -f "$UNIT"; systemctl daemon-reload
    rm -rf "$APP_DIR"
    say "取り除きました"
    exit 0
fi

case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "この CPU($(uname -m))向けの一式はありません(Docker 版をお使いください)" ;;
esac
for c in curl tar sha256sum; do
    if ! command -v "$c" >/dev/null; then
        command -v apt-get >/dev/null || die "$c が必要です"
        say "必要なパッケージを入れています"
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl tar coreutils ca-certificates >/dev/null
        break
    fi
done

# 入れる版のリリース(新しい順の一覧から、安定版 v03.xx.xx か、開発版 dev-v03.xx.xx も)
case "$CHANNEL" in stable) TAGRE='v03\.[0-9]{2}\.[0-9]{2}' ;; dev) TAGRE='(dev-)?v03\.[0-9]{2}\.[0-9]{2}' ;; *) die "CRAFTSHELF_CHANNEL は stable か dev にしてください" ;; esac
[ -z "$WANT" ] || TAGRE="(dev-)?v${WANT//./\\.}"
say "https://github.com/${REPO} のリリースを確かめています"
URL="$(curl -fsSL -H "User-Agent: CraftShelf" "https://api.github.com/repos/${REPO}/releases?per_page=50" \
    | grep -oE "https://github.com/${REPO}/releases/download/${TAGRE}/craftshelf-v03-[0-9.]+-linux-${ARCH}\.tar\.gz" | head -n 1 || true)"
[ -n "$URL" ] || die "入れられる版が見つかりません(${CHANNEL}${WANT:+・$WANT}・linux-${ARCH})"
FILE="${URL##*/}"
VER="$(echo "$FILE" | sed -E 's/^craftshelf-v03-([0-9.]+)-linux-.*/\1/')"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
say "v${VER} を取ってきています"
curl -fsSL -o "$TMP/$FILE" "$URL"
curl -fsSL -o "$TMP/SHA256SUMS" "${URL%/*}/SHA256SUMS"
(cd "$TMP" && grep -E "  \*?${FILE}\$" SHA256SUMS | sed 's/ \*/  /' | sha256sum -c --status) || die "ダウンロードした一式が壊れています(チェックサムが合いません)"
tar -xzf "$TMP/$FILE" -C "$TMP"
[ -f "$TMP/CraftShelf/app/.output/server/index.mjs" ] || die "一式の中身が足りません"

id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$DATA_DIR"
systemctl stop craftshelf 2>/dev/null || true
rm -rf "$APP_DIR.new"; mv "$TMP/CraftShelf" "$APP_DIR.new"
rm -rf "$APP_DIR"; mv "$APP_DIR.new" "$APP_DIR"
# 一式は root のもの(書き換えない)。データはサービスのユーザーのもの(パネルで取ってきた版もここに置く)
chown -R root:root "$APP_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=CraftShelf v03 (Minecraft plugin/mod library)
After=network-online.target
Wants=network-online.target

[Service]
User=${SVC_USER}
Group=${SVC_USER}
Environment=DATA_DIR=${DATA_DIR}
Environment=CRAFTSHELF_DIST=script
ExecStart=${APP_DIR}/node/bin/node ${APP_DIR}/launcher.mjs --no-browser --host ${HOST} --port ${PORT}
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable -q craftshelf
systemctl restart craftshelf

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "入れました: v${VER}"
echo "    ブラウザで http://${IP:-<このサーバーのアドレス>}:${PORT} を開いてください(初めてなら、最初の 1 人が管理者になります)"
echo "    状態: systemctl status craftshelf / ログ: journalctl -u craftshelf -f"
echo "    データ: ${DATA_DIR}"
echo "    ログインを戻す: sudo -u ${SVC_USER} ${APP_DIR}/node/bin/node ${APP_DIR}/launcher.mjs reset-owner <メールアドレスか名前> --data-dir ${DATA_DIR}"
