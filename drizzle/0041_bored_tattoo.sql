ALTER TABLE "job" ADD COLUMN "progress_done" integer;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "progress_total" integer;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "progress_note" text DEFAULT '' NOT NULL;