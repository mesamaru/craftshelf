#!/bin/sh
# 起動のたびに GITHUB_REPO の最新コードを取得して /app に反映してから
# アプリを起動する。GITHUB_REPO が未設定、またはネットワークに出られない
# 場合は、イメージに焼き込まれている(または前回取得済みの)コードで
# そのまま起動する(=起動を止めない)。
set -e

VERSION_FILE="/app/.version"

if [ "${AUTO_UPDATE:-true}" = "true" ] && [ -n "${GITHUB_REPO:-}" ]; then
    BRANCH="${GITHUB_BRANCH:-main}"
    # v02 は main だけを取得する(02.21.00 までの開発ビルド = dev は v03 になり、プレビュー = next は無くなった)
    CFG_DIR="${CONFIG_DIR:-${DB_DIR:-${DATA_DIR:-/data}}}"
    # いまのデータの保存方法の番号(パネルが書く)。取得したコードが読めない番号なら入れ替えない
    IN_USE="$( [ -f "$CFG_DIR/data-format" ] && tr -cd '0-9' < "$CFG_DIR/data-format" )"
    IN_USE="${IN_USE:-1}"
    echo "[update] https://github.com/${GITHUB_REPO} (${BRANCH}) を確認しています..."
    TMP_DIR="$(mktemp -d)"
    if git clone --depth 1 --branch "$BRANCH" "https://github.com/${GITHUB_REPO}.git" "$TMP_DIR" > /tmp/update.log 2>&1; then
        COMMIT="$(git -C "$TMP_DIR" rev-parse --short HEAD)"
        READS="$( [ -f "$TMP_DIR/DATA_FORMAT" ] && sed -n 's/^[[:space:]]*read[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TMP_DIR/DATA_FORMAT" | head -n 1 )"
        READS="${READS:-1}"
        if [ "$READS" -lt "$IN_USE" ]; then
            echo "[update] 取得した版(v$(cat "$TMP_DIR/VERSION" 2>/dev/null))は、いまのデータ(保存方法 $IN_USE)を読めないため入れ替えません"
            rm -rf "$TMP_DIR"
        else
        # data/永続データには触れず、アプリのコードだけを入れ替える
        rsync -a --delete \
            --exclude ".git" --exclude "data" --exclude ".version" \
            "$TMP_DIR"/ /app/
        echo "$COMMIT ($(date -u +%Y-%m-%dT%H:%M:%SZ))" > "$VERSION_FILE"
        echo "[update] 最新化しました: v$(cat /app/VERSION 2>/dev/null) ($COMMIT)"
        echo "[update] 依存パッケージを確認しています..."
        pip install --no-cache-dir --quiet -r /app/requirements.txt || \
            echo "[update] 依存パッケージのインストールに失敗しました(起動は続行します)"
        fi
    else
        echo "[update] 取得に失敗したため、現在のコードのまま起動します:"
        cat /tmp/update.log
    fi
    rm -rf "$TMP_DIR"
else
    echo "[update] GITHUB_REPO 未設定、または AUTO_UPDATE=false のためスキップします"
fi

exec "$@"
