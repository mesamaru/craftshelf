CREATE TABLE "local_server" (
	"server_id" text PRIMARY KEY NOT NULL,
	"root_dir" text NOT NULL,
	"control" text DEFAULT 'none' NOT NULL,
	"start_cmd" text DEFAULT '' NOT NULL,
	"stop_cmd" text DEFAULT '' NOT NULL,
	"container" text DEFAULT '' NOT NULL,
	"rcon_port" integer,
	"rcon_password_sealed" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_server" ADD CONSTRAINT "local_server_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;