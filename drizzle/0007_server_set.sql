CREATE TABLE "server_set" (
	"server_id" text PRIMARY KEY NOT NULL,
	"set_id" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_set" ADD CONSTRAINT "server_set_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_set" ADD CONSTRAINT "server_set_set_id_addon_set_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."addon_set"("id") ON DELETE cascade ON UPDATE no action;