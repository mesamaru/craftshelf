CREATE TABLE "library_dep" (
	"item_id" text NOT NULL,
	"dep_item_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "library_dep_item_id_dep_item_id_pk" PRIMARY KEY("item_id","dep_item_id")
);
--> statement-breakpoint
ALTER TABLE "library_item" ADD COLUMN "channel" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_item" ADD COLUMN "loaders" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_item" ADD COLUMN "mc_versions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_item" ADD COLUMN "upstream_mc" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_item" ADD COLUMN "info_at" timestamp;--> statement-breakpoint
ALTER TABLE "team_option" ADD COLUMN "channel" text DEFAULT 'release' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_dep" ADD CONSTRAINT "library_dep_item_id_library_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."library_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_dep" ADD CONSTRAINT "library_dep_dep_item_id_library_item_id_fk" FOREIGN KEY ("dep_item_id") REFERENCES "public"."library_item"("id") ON DELETE cascade ON UPDATE no action;