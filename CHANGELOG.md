# 変更履歴

バージョンは `00.00.00`(メジャー.マイナー.修正)の形式です。

## 00.01.00 - 2026-10-23 土台を作成

- TanStack Start・PostgreSQL(Drizzle)・Better Auth で土台を作成
- アカウントの作成・ログイン・二段階認証(認証アプリ・予備のコード)・パスキー・ログアウト(アカウントの設定の中)
- 手元のサーバー機で動かす Docker の構成(app・PostgreSQL・Cloudflare Tunnel・バックアップ)
- バックアップ先に NAS(SMB・NFS)と Cloudflare R2 を選べる(暗号化もできる)
