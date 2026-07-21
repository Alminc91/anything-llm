-- KIE-504: Bewertungsfunktion (Daumen hoch/runter) pro Embed-Antwort.
-- feedbackScore: NULL = keine Bewertung, true = 👍, false = 👎.
-- Nullable, kein Default, kein Backfill -> idempotenzvertraeglich mit dem
-- docker-entrypoint Migrations-Fallback (KIE Prisma-Safety-Regel).
ALTER TABLE "embed_chats" ADD COLUMN "feedbackScore" BOOLEAN;
