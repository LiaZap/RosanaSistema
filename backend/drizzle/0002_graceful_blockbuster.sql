ALTER TABLE "messages" ADD COLUMN "buffer_window_id" uuid;--> statement-breakpoint
ALTER TABLE "nina_settings" ADD COLUMN "buffer_window_ms" integer DEFAULT 15000 NOT NULL;--> statement-breakpoint
ALTER TABLE "nina_settings" ADD COLUMN "buffer_max_ms" integer DEFAULT 60000 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_buffer_idx" ON "messages" USING btree ("buffer_window_id");