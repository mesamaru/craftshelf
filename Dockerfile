FROM python:3.12-slim

# git/rsync/ca-certificates: 起動時の自動更新(GitHubから最新コードを取得)に使う
# SMB / WebDAV の保存先はアプリ(Python)が直接通信するので、mount 用のパッケージは不要
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends git rsync ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 保存先(NASの共有フォルダをここにマウントする)
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8080

# 起動のたびに GitHub (GITHUB_REPO) の最新コードを取得してから起動する。
# 止めたい場合は AUTO_UPDATE=false。詳しくは README の「アップデート」参照。
ENV AUTO_UPDATE=true
ENV GITHUB_REPO="mesamaru/craftshelf"
ENV GITHUB_BRANCH=main

# 排他制御をプロセス内のロックで行っているため worker は 1 つ、スレッドで並列処理します。
# 大きなファイルのアップロードで切れないよう timeout は無効化。
ENTRYPOINT ["/entrypoint.sh"]
CMD ["gunicorn", "-b", "0.0.0.0:8080", "-k", "gthread", "-w", "1", "--threads", "8", "--timeout", "0", "app:app"]
