CREATE TABLE "server_hold" (
	"server_id" text NOT NULL,
	"source" text NOT NULL,
	"project_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "server_hold_server_id_source_project_id_pk" PRIMARY KEY("server_id","source","project_id")
);
--> statement-breakpoint
ALTER TABLE "server_hold" ADD CONSTRAINT "server_hold_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_hold" ADD CONSTRAINT "server_hold_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;