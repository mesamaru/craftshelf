#!/usr/bin/env bash
# CraftShelf を Ubuntu / Debian にインストールし、systemd のサービスとして常駐させる。
#
#   curl -fsSL https://raw.githubusercontent.com/mesamaru/craftshelf/main/install.sh | sudo bash
#
# もう一度実行すると最新版に更新される(保存したデータはそのまま)。
# 変更できる設定(環境変数): CRAFTSHELF_PORT(既定 8765)/ CRAFTSHELF_HOST(既定 0.0.0.0)/
#                          CRAFTSHELF_REPO(既定 mesamaru/craftshelf)/ CRAFTSHELF_BRANCH(既定 main)
# アンインストール: sudo bash install.sh --uninstall  (データ /var/lib/craftshelf は残す)
set -euo pipefail

REPO="${CRAFTSHELF_REPO:-mesamaru/craftshelf}"
BRANCH="${CRAFTSHELF_BRANCH:-main}"
PORT="${CRAFTSHELF_PORT:-8765}"
HOST="${CRAFTSHELF_HOST:-0.0.0.0}"
APP_DIR=/opt/craftshelf
VENV_DIR=/opt/craftshelf-venv
DATA_DIR=/var/lib/craftshelf
SVC_USER=craftshelf
UNIT=/etc/systemd/system/craftshelf.service

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mエラー:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root で実行してください(例: curl ... | sudo bash)"
command -v systemctl >/dev/null || die "systemd が必要です"

if [ "${1:-}" = "--uninstall" ]; then
    say "CraftShelf を停止して削除します(データ ${DATA_DIR} は残します)"
    systemctl disable --now craftshelf 2>/dev/null || true
    rm -f "$UNIT"; systemctl daemon-reload
    rm -rf "$APP_DIR" "$VENV_DIR"
    say "削除しました"
    exit 0
fi

command -v apt-get >/dev/null || die "このスクリプトは Ubuntu / Debian 用です(ほかの環境では Docker 版をお使いください)"
say "必要なパッケージをインストールしています"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-venv python3-pip git rsync ca-certificates >/dev/null

id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"

say "https://github.com/${REPO} (${BRANCH}) から取得しています"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git clone -q --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$TMP/src"
COMMIT="$(git -C "$TMP/src" rev-parse --short HEAD)"
rsync -a --delete --exclude ".git" --exclude "data" --exclude ".version" "$TMP/src/" "$APP_DIR/"
echo "$COMMIT ($(date -u +%Y-%m-%dT%H:%M:%SZ))" > "$APP_DIR/.version"

say "Python の環境を準備しています"
[ -x "$VENV_DIR/bin/python" ] || python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install -q --upgrade pip
"$VENV_DIR/bin/pip" install -q -r "$APP_DIR/requirements.txt"

# パネルからのアップデートでコードとライブラリを入れ替えられるよう、サービスのユーザーを所有者にする
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR" "$VENV_DIR" "$DATA_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=CraftShelf (Minecraft plugin/mod library)
After=network-online.target
Wants=network-online.target

[Service]
User=${SVC_USER}
Group=${SVC_USER}
Environment=DATA_DIR=${DATA_DIR}
Environment=GITHUB_REPO=${REPO}
Environment=GITHUB_BRANCH=${BRANCH}
ExecStart=${VENV_DIR}/bin/python ${APP_DIR}/launcher.py --no-browser --no-tray --host ${HOST} --port ${PORT}
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
say "インストールしました: v$(cat "$APP_DIR/VERSION")"
echo "    ブラウザで http://${IP:-<このサーバーのIP>}:${PORT} を開き、管理者アカウントを作成してください"
echo "    状態の確認: systemctl status craftshelf / ログ: journalctl -u craftshelf -f"
echo "    データの保存先: ${DATA_DIR}"
