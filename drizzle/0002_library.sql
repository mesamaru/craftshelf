CREATE TABLE "installed_mod" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"source" text NOT NULL,
	"project_id" text NOT NULL,
	"version_id" text NOT NULL,
	"version_number" text NOT NULL,
	"title" text NOT NULL,
	"filename" text NOT NULL,
	"installed_by" text,
	"installed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_profile" (
	"server_id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"mc_version" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "installed_mod" ADD CONSTRAINT "installed_mod_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_mod" ADD CONSTRAINT "installed_mod_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_profile" ADD CONSTRAINT "server_profile_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "installed_mod_server_file_uq" ON "installed_mod" USING btree ("server_id","filename");--> statement-breakpoint
CREATE INDEX "installed_mod_server_idx" ON "installed_mod" USING btree ("server_id");