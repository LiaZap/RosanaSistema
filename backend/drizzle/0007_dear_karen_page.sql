ALTER TABLE "produtos_catalogo" ADD COLUMN "imagem_minio" text;--> statement-breakpoint
ALTER TABLE "produtos_catalogo" ADD COLUMN "minio_uploaded_at" timestamp with time zone;