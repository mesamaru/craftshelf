ALTER TABLE "storage_target" ADD COLUMN "v02" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "storage_target" SET "v02" = true WHERE "name" LIKE 'v02: %';
