CREATE TABLE "library_item" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"source" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"slug" text DEFAULT '' NOT NULL,
	"project_type" text NOT NULL,
	"icon_url" text DEFAULT '' NOT NULL,
	"added_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_item" ADD CONSTRAINT "library_item_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_item" ADD CONSTRAINT "library_item_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_item_team_project_uq" ON "library_item" USING btree ("team_id","source","project_id");