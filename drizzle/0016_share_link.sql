CREATE TABLE "share_link" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"file_ids" text NOT NULL,
	"filename" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"downloads" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_link_token_uq" ON "share_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_link_team_idx" ON "share_link" USING btree ("team_id");