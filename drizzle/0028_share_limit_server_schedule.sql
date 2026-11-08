CREATE TABLE "server_schedule" (
	"server_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"action" text DEFAULT 'update' NOT NULL,
	"time" text DEFAULT '04:00' NOT NULL,
	"dow" integer DEFAULT 0 NOT NULL,
	"tz" text DEFAULT 'Asia/Tokyo' NOT NULL,
	"restart" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_link" ADD COLUMN "max_downloads" integer;--> statement-breakpoint
ALTER TABLE "server_schedule" ADD CONSTRAINT "server_schedule_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;