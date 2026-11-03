CREATE TABLE "library_file" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"target_id" text,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"loaders" text DEFAULT '[]' NOT NULL,
	"mc_versions" text DEFAULT '[]' NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_target" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config_sealed" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_file" ADD CONSTRAINT "library_file_item_id_library_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."library_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_file" ADD CONSTRAINT "library_file_target_id_storage_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."storage_target"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_file" ADD CONSTRAINT "library_file_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_target" ADD CONSTRAINT "storage_target_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_file_item_idx" ON "library_file" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "library_file_sha_idx" ON "library_file" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "storage_target_team_idx" ON "storage_target" USING btree ("team_id");