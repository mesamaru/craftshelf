ALTER TABLE "library_file" ADD COLUMN "upstream_version_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_item" ADD COLUMN "keep_files" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_item" ADD COLUMN "keep_versions" integer;--> statement-breakpoint
ALTER TABLE "team_option" ADD COLUMN "keep_files" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_option" ADD COLUMN "keep_versions" integer DEFAULT 0 NOT NULL;