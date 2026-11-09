ALTER TABLE "library_item" ADD COLUMN "saved_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_pref" ADD COLUMN "background" text;--> statement-breakpoint
ALTER TABLE "user_pref" ADD COLUMN "background_at" timestamp;