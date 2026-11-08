-- 時刻を UTC にそろえる(03.52.01)。これまでは、データベースの既定(DEFAULT now())で入れた時刻が、
-- つないだときの時間帯(PGlite はパソコンの時間帯。Docker の自分用の版は TZ=Asia/Tokyo)のまま保存され、読むときは UTC とみなしていた。
-- この移行はその時間帯のままのつなぎで流れる(src/server/db/index.ts。流したあとで UTC に切り替える)ので、
-- 既定で入れた時刻だけを UTC に直す。時間帯が UTC なら何も変わらない。アプリが時刻を渡していた列(もともと UTC)は触らない
UPDATE "audit_log" SET "at" = ("at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "notice_seen" SET "seen_at" = ("seen_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "server_file_history" SET "saved_at" = ("saved_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "server_change" SET "at" = ("at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "install_history" SET "replaced_at" = ("replaced_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "share_link" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "ptero_connection" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "server" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "library_item" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
-- v02 から取り込んだ版(uploaded_by が空)は、v02 の時刻(UTC)を渡していたので直さない
UPDATE "library_file" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC' WHERE "uploaded_by" IS NOT NULL;
--> statement-breakpoint
UPDATE "addon_set" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "addon_set_item" SET "added_at" = ("added_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "library_tag" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "library_favorite" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "storage_target" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "agent" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "member_server_limit" SET "updated_at" = ("updated_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--> statement-breakpoint
UPDATE "legacy_totp" SET "created_at" = ("created_at" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
