CREATE TABLE "install_history" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"source" text NOT NULL,
	"project_id" text NOT NULL,
	"version_id" text NOT NULL,
	"version_number" text NOT NULL,
	"filename" text NOT NULL,
	"replaced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "install_history" ADD CONSTRAINT "install_history_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "install_history_idx" ON "install_history" USING btree ("server_id","source","project_id","replaced_at");