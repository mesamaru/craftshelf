FROM python:3.12-slim

# 起動時の自動更新(GitHubから最新コードを取得)に使うツール
RUN apt-get update \
    && apt-get install -y --no-install-recommends git rsync ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 保存先(NASの共有フォルダをここにマウントする)
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8080

# GITHUB_REPO (例: yourname/mc-pack-library) を設定すると、起動のたびに
# そのリポジトリの最新コードを取得してから起動する。未設定ならこのイメージの
# コードのまま起動する。詳しくは README の「自動更新」参照。
ENV AUTO_UPDATE=true
ENV GITHUB_REPO=""
ENV GITHUB_BRANCH=main

# 排他制御をプロセス内のロックで行っているため worker は 1 つ、スレッドで並列処理します。
# 大きなファイルのアップロードで切れないよう timeout は無効化。
ENTRYPOINT ["/entrypoint.sh"]
CMD ["gunicorn", "-b", "0.0.0.0:8080", "-k", "gthread", "-w", "1", "--threads", "8", "--timeout", "0", "app:app"]
