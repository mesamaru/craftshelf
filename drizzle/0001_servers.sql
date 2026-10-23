CREATE TABLE "ptero_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"api_key_sealed" text NOT NULL,
	"api_key_hint" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"ptero_connection_id" text,
	"remote_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ptero_connection" ADD CONSTRAINT "ptero_connection_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ptero_connection" ADD CONSTRAINT "ptero_connection_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_ptero_connection_id_ptero_connection_id_fk" FOREIGN KEY ("ptero_connection_id") REFERENCES "public"."ptero_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ptero_connection_team_idx" ON "ptero_connection" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "server_team_idx" ON "server" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "server_ptero_remote_uq" ON "server" USING btree ("ptero_connection_id","remote_id");