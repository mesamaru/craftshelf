-- CraftShelf の利用状況・お問い合わせの受け口(Cloudflare D1)
-- IP アドレスは保存しない。利用状況はランダムな設置 ID ごとに最新の 1 件だけを持つ。

CREATE TABLE IF NOT EXISTS installs (
    id          TEXT PRIMARY KEY,          -- パネルが作ったランダムな ID(32 桁の16進数)
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    version     TEXT NOT NULL DEFAULT '',
    channel     TEXT NOT NULL DEFAULT '',  -- stable / dev
    os          TEXT NOT NULL DEFAULT '',  -- linux / windows / macos
    arch        TEXT NOT NULL DEFAULT '',
    mode        TEXT NOT NULL DEFAULT '',  -- docker / installer / script / source
    lang        TEXT NOT NULL DEFAULT '',
    data        TEXT NOT NULL DEFAULT '{}' -- 件数の目安・使っている連携など(下の index.js の FIELDS だけ)
);

-- 日ごとに動いていたパネル(稼働数のグラフ用)
CREATE TABLE IF NOT EXISTS daily (
    day         TEXT NOT NULL,             -- YYYY-MM-DD(UTC)
    install_id  TEXT NOT NULL,
    version     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (day, install_id)
);

CREATE TABLE IF NOT EXISTS feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    kind        TEXT NOT NULL,             -- request / bug / question / other
    message     TEXT NOT NULL,
    contact     TEXT NOT NULL DEFAULT '',  -- 返信先(任意。送った人が書いたときだけ)
    version     TEXT NOT NULL DEFAULT '',
    os          TEXT NOT NULL DEFAULT '',
    mode        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'new' -- new / done
);

-- 送りすぎの制限(キーは「その日だけ有効な塩」で IP をハッシュしたもの。元の IP は残らない)
CREATE TABLE IF NOT EXISTS ratelimit (
    key         TEXT PRIMARY KEY,
    window      TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_daily_day ON daily(day);
CREATE INDEX IF NOT EXISTS idx_installs_last ON installs(last_seen);
