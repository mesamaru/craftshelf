"""CraftShelf: 時間のかかる処理(ジョブ)を別のスレッドで動かす(順番待ちつき)。"""

import threading
import uuid

from flask import jsonify

from .core import ApiError, app, utcnow
from .auth import current_user
from .events import notify_event


# --------------------------------------------------------------------------
# バックグラウンド処理(移行・更新確認など、時間のかかるもの)
# --------------------------------------------------------------------------
_JOBS = {}
_JOBS_LOCK = threading.Lock()


class Job:
    def __init__(self, kind, title, user):
        self.id = uuid.uuid4().hex[:12]
        self.kind, self.title, self.user = kind, title, user
        self.total = self.done = 0
        self.status = "running"
        self.log = []
        self.result = {}
        self.started = utcnow()
        self.finished = ""

    def note(self, msg):
        self.log.append(msg)
        del self.log[:-200]

    def public(self):
        return {k: getattr(self, k) for k in
                ("id", "kind", "title", "user", "total", "done", "status", "log", "result", "started", "finished")}


class _Lane:
    """同じ種類の処理を、受け付けた順に 1 件ずつ動かすための番号札。"""
    def __init__(self):
        self.cv = threading.Condition()
        self.next = self.serving = 0


_LANES = {}
QUEUE_MAX = 50


def start_job(kind, title, fn, *args, user="", queue=False):
    """処理を別のスレッドで動かす。同じ種類の処理が動いているとき、queue=True なら順番待ちにして
    前の処理が終わってから始める(同時には動かさないので、サーバーの負荷は増えない)。False なら断る。"""
    with _JOBS_LOCK:
        active = [j for j in _JOBS.values() if j.kind == kind and j.status in ("running", "queued")]
        if active and not queue:
            raise ApiError("同じ種類の処理がすでに実行中です。終わるまでお待ちください", 409)
        if len(active) >= QUEUE_MAX:
            raise ApiError("順番待ちの処理が多すぎます。少し待ってからお試しください", 429)
        job = Job(kind, title, user)
        if active:
            job.status = "queued"
            job.note(f"順番待ち: 前の {len(active)} 件が終わってから始めます")
        _JOBS[job.id] = job
        lane = _LANES.setdefault(kind, _Lane())
        ticket = lane.next
        lane.next += 1
        done_jobs = [j for j in sorted(_JOBS.values(), key=lambda j: j.started) if j.status not in ("running", "queued")]
        for old in done_jobs[:-20]:  # 古い記録は捨てる
            _JOBS.pop(old.id, None)

    def run():
        with lane.cv:
            while lane.serving != ticket:
                lane.cv.wait()
        job.status = "running"
        try:
            with app.app_context():
                try:
                    fn(job, *args)
                    job.status = "done"
                except Exception as e:  # noqa: BLE001
                    job.status = "error"
                    job.note(f"エラー: {getattr(e, 'message', e)}")
                    app.logger.exception("job failed")
                    notify_event("errors", f"{job.title} が失敗しました", [str(getattr(e, "message", e))[:500]], "error")
                finally:
                    job.finished = utcnow()
        finally:
            with lane.cv:
                lane.serving += 1
                lane.cv.notify_all()

    threading.Thread(target=run, daemon=True, name=f"job-{kind}").start()
    return job


# --------------------------------------------------------------------------
# バックグラウンド処理 API
# --------------------------------------------------------------------------
def _job_visible(job):
    """処理の進み具合・記録は、始めた本人と管理者だけが見られる(記録にアドオンの名前などが出るため)。"""
    u = current_user()
    return bool(u) and (u["role"] == "admin" or job.user == u["username"])


@app.get("/api/jobs")
def api_jobs():
    with _JOBS_LOCK:
        # 同じ秒に始まったものは、あとから足したもの(新しいもの)を先に
        jobs = sorted((j for j in reversed(list(_JOBS.values())) if _job_visible(j)), key=lambda j: j.started, reverse=True)
    return jsonify(jobs=[j.public() for j in jobs[:10]])


@app.get("/api/jobs/<job_id>")
def api_job(job_id):
    job = _JOBS.get(job_id)
    if not job or not _job_visible(job):
        raise ApiError("見つかりません", 404)
    return jsonify(job.public())
