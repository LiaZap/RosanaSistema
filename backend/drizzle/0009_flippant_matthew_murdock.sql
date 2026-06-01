ALTER TABLE "conversations" ADD COLUMN "last_human_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nina_settings" ADD COLUMN "pause_after_human_minutes" integer DEFAULT 60 NOT NULL;