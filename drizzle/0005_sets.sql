CREATE TABLE "addon_set" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "addon_set_item" (
	"set_id" text NOT NULL,
	"item_id" text NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "addon_set_item_set_id_item_id_pk" PRIMARY KEY("set_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "addon_set" ADD CONSTRAINT "addon_set_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_set" ADD CONSTRAINT "addon_set_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_set_item" ADD CONSTRAINT "addon_set_item_set_id_addon_set_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."addon_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_set_item" ADD CONSTRAINT "addon_set_item_item_id_library_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."library_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addon_set_team_idx" ON "addon_set" USING btree ("team_id");