CREATE TABLE "team_curseforge" (
	"team_id" text PRIMARY KEY NOT NULL,
	"api_key_sealed" text NOT NULL,
	"api_key_hint" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_curseforge" ADD CONSTRAINT "team_curseforge_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;