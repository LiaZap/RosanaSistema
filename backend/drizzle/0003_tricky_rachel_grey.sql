CREATE TABLE IF NOT EXISTS "knowledge_base" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"category" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"priority" integer DEFAULT 50 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"always_include" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_account_category_idx" ON "knowledge_base" USING btree ("account_id","category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_account_active_idx" ON "knowledge_base" USING btree ("account_id","is_active");