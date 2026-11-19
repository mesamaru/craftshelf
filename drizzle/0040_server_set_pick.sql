CREATE TABLE "server_set_pick" (
	"server_id" text NOT NULL,
	"item_id" text NOT NULL,
	"version_id" text,
	"version_number" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "server_set_pick_server_id_item_id_pk" PRIMARY KEY("server_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "server_set_pick" ADD CONSTRAINT "server_set_pick_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_set_pick" ADD CONSTRAINT "server_set_pick_item_id_library_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."library_item"("id") ON DELETE cascade ON UPDATE no action;