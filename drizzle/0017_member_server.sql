CREATE TABLE "member_server" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"server_id" text NOT NULL,
	CONSTRAINT "member_server_team_id_user_id_server_id_pk" PRIMARY KEY("team_id","user_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "member_server_limit" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "member_server_limit_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "member_server" ADD CONSTRAINT "member_server_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_server" ADD CONSTRAINT "member_server_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_server" ADD CONSTRAINT "member_server_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_server_limit" ADD CONSTRAINT "member_server_limit_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_server_limit" ADD CONSTRAINT "member_server_limit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;