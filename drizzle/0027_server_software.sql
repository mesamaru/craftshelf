ALTER TABLE "server_software" ADD COLUMN "software" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "server_software" ADD COLUMN "old_jars" text DEFAULT '[]' NOT NULL;