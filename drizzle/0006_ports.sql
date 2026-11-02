CREATE TABLE "port_group" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "port_kind" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"mode" text DEFAULT 'free' NOT NULL,
	"start" integer,
	"size" integer,
	"range_from" integer,
	"range_to" integer,
	"proto" text DEFAULT 'TCP' NOT NULL,
	"file" text DEFAULT '' NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_port" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"kind_id" text,
	"port" integer NOT NULL,
	"source" text NOT NULL,
	"file" text DEFAULT '' NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"memo" text DEFAULT '' NOT NULL,
	"ignored" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_port_info" (
	"server_id" text PRIMARY KEY NOT NULL,
	"group_id" text,
	"memo" text DEFAULT '' NOT NULL,
	"machine" text DEFAULT '' NOT NULL,
	"scanned_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "port_group" ADD CONSTRAINT "port_group_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "port_kind" ADD CONSTRAINT "port_kind_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_port" ADD CONSTRAINT "server_port_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_port" ADD CONSTRAINT "server_port_kind_id_port_kind_id_fk" FOREIGN KEY ("kind_id") REFERENCES "public"."port_kind"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_port_info" ADD CONSTRAINT "server_port_info_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_port_info" ADD CONSTRAINT "server_port_info_group_id_port_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."port_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "port_group_team_idx" ON "port_group" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "port_kind_team_idx" ON "port_kind" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "server_port_server_idx" ON "server_port" USING btree ("server_id");