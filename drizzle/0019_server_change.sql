CREATE TABLE "server_change" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"title" text NOT NULL,
	"added" text DEFAULT '' NOT NULL,
	"removed" text DEFAULT '' NOT NULL,
	"backup" text DEFAULT '' NOT NULL,
	"undone" boolean DEFAULT false NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_change" ADD CONSTRAINT "server_change_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_change" ADD CONSTRAINT "server_change_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_change_server_idx" ON "server_change" USING btree ("server_id","at");