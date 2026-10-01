"""Discord の Webhook への通知。

チャンネルの「連携サービス → ウェブフック」で作った URL に、埋め込みメッセージを送る。
通知の失敗でアプリ本体の処理が止まらないよう、送信は別スレッドで行う。
"""
import threading
from urllib.parse import urlsplit

import requests

EVENTS = {
    "updates": "配布元に新しいバージョンが見つかったとき",
    "downloaded": "新しいバージョンを自動で保存したとき",
    "errors": "エラーが起きたとき",
    "servers": "サーバーへの配布・同期をしたとき",
    "backup": "バックアップを作成したとき",
    "selfupdate": "CraftShelf をアップデートしたとき",
}
COLORS = {"info": 0x34C759, "warn": 0xFF9500, "error": 0xFF3B30}


class NotifyError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def validate_webhook(url):
    u = urlsplit((url or "").strip())
    host = (u.hostname or "").lower()
    if u.scheme != "https" or host not in ("discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com") \
            or not u.path.startswith("/api/webhooks/"):
        raise NotifyError("Discord の Webhook URL(https://discord.com/api/webhooks/…)を入力してください")
    return url.strip()


def webhook_info(url):
    """Webhook の名前など(登録済みの内容を画面に出すため)。取れなければ空の dict。"""
    try:
        r = requests.get(validate_webhook(url), timeout=10)
        if r.status_code == 200:
            d = r.json()
            return {"name": str(d.get("name") or "")[:80], "channel_id": str(d.get("channel_id") or ""),
                    "guild_id": str(d.get("guild_id") or "")}
    except (requests.RequestException, ValueError, NotifyError):
        pass
    return {}


def _payload(title, lines, level):
    desc = "\n".join(str(x) for x in lines)[:3900]
    return {"username": "CraftShelf", "embeds": [{"title": title[:250], "description": desc,
                                                  "color": COLORS.get(level, COLORS["info"])}]}


def send_now(url, title, lines, level="info"):
    try:
        r = requests.post(validate_webhook(url), json=_payload(title, lines, level), timeout=15)
    except requests.RequestException:
        raise NotifyError("Discord に接続できません")
    if r.status_code not in (200, 204):
        raise NotifyError(f"Discord からエラーが返りました (HTTP {r.status_code})")


def send(url, title, lines, level="info"):
    def run():
        try:
            send_now(url, title, lines, level)
        except NotifyError:
            pass
    threading.Thread(target=run, daemon=True, name="discord").start()
