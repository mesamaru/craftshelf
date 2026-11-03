CREATE TABLE "team_schedule" (
	"team_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'check' NOT NULL,
	"time" text DEFAULT '04:00' NOT NULL,
	"days" text DEFAULT '[0,1,2,3,4,5,6]' NOT NULL,
	"tz" text DEFAULT 'Asia/Tokyo' NOT NULL,
	"last_run_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_schedule" ADD CONSTRAINT "team_schedule_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;