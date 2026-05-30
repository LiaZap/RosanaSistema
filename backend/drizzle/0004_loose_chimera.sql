ALTER TABLE "conversations" ADD COLUMN "assigned_to_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "followup_state" varchar(20) DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "followup_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "followup_last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "sentiment" varchar(20);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "lead_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "intent_label" varchar(50);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_followup_idx" ON "conversations" USING btree ("followup_state","last_message_at");