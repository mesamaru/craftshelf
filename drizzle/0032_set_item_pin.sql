ALTER TABLE "addon_set_item" ADD COLUMN "version_id" text;--> statement-breakpoint
ALTER TABLE "addon_set_item" ADD COLUMN "version_number" text DEFAULT '' NOT NULL;