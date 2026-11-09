CREATE TABLE "member_perm" (
	"member_id" text PRIMARY KEY NOT NULL,
	"allow" text DEFAULT '[]' NOT NULL,
	"deny" text DEFAULT '[]' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_perm" ADD CONSTRAINT "member_perm_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;