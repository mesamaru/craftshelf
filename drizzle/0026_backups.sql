CREATE TABLE "backup_schedule" (
	"team_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"time" text DEFAULT '04:00' NOT NULL,
	"tz" text DEFAULT 'Asia/Tokyo' NOT NULL,
	"keep" integer DEFAULT 5 NOT NULL,
	"target_id" text,
	"last_run_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_backup" (
	"server_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"time" text DEFAULT '05:00' NOT NULL,
	"dow" integer DEFAULT 0 NOT NULL,
	"tz" text DEFAULT 'Asia/Tokyo' NOT NULL,
	"keep" integer DEFAULT 5 NOT NULL,
	"target_id" text,
	"last_run_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backup_schedule" ADD CONSTRAINT "backup_schedule_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_schedule" ADD CONSTRAINT "backup_schedule_target_id_storage_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."storage_target"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_backup" ADD CONSTRAINT "world_backup_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_backup" ADD CONSTRAINT "world_backup_target_id_storage_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."storage_target"("id") ON DELETE set null ON UPDATE no action;