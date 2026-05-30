ALTER TABLE "media_library" ADD COLUMN "name_normalized" varchar(255);--> statement-breakpoint
ALTER TABLE "media_library" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "media_library" ADD COLUMN "use_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_library" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_library_name_norm_idx" ON "media_library" USING btree ("account_id","name_normalized");