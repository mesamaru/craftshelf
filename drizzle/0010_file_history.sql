CREATE TABLE "server_file_history" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"saved_by" text,
	"saved_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_file_history" ADD CONSTRAINT "server_file_history_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_file_history" ADD CONSTRAINT "server_file_history_saved_by_user_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_file_history_idx" ON "server_file_history" USING btree ("server_id","path","saved_at");