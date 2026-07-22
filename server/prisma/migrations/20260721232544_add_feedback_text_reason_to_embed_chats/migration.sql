-- KIE-507: Freitext-Kommentar + 1-Klick-Grund bei 👎 pro Embed-Antwort.
-- Beide nullable, kein Default, kein Backfill -> idempotenzvertraeglich mit dem
-- docker-entrypoint Migrations-Fallback (KIE Prisma-Safety-Regel).
ALTER TABLE "embed_chats" ADD COLUMN "feedbackText" TEXT;
ALTER TABLE "embed_chats" ADD COLUMN "feedbackReason" TEXT;
