CREATE TABLE "server_software" (
	"server_id" text PRIMARY KEY NOT NULL,
	"jar" text NOT NULL,
	"build" text DEFAULT '' NOT NULL,
	"mc" text DEFAULT '' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"backup_jar" text DEFAULT '' NOT NULL,
	"backup_build" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_software" ADD CONSTRAINT "server_software_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;