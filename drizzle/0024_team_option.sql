CREATE TABLE "team_option" (
	"team_id" text PRIMARY KEY NOT NULL,
	"editor_files" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_option" ADD CONSTRAINT "team_option_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;