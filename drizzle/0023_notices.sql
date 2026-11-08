CREATE TABLE "notice_seen" (
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"seen_at" timestamp NOT NULL,
	CONSTRAINT "notice_seen_user_id_team_id_pk" PRIMARY KEY("user_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "update_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "update_notice" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "notice_seen" ADD CONSTRAINT "notice_seen_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_seen" ADD CONSTRAINT "notice_seen_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;