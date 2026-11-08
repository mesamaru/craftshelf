ALTER TABLE "server" ADD COLUMN "auto_update" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "auto_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "server_change" ADD COLUMN "config_backup" text DEFAULT '' NOT NULL;