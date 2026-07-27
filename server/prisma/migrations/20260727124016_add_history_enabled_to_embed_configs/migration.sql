-- KIE-503: "Frühere Chats" pro Embed abschaltbar (Widget-Einstellungen).
-- Nullable, KEIN Default: NULL = an (Fallback für Bestands-Embeds), false = aus.
-- Additiv, kein Backfill -> idempotenzvertraeglich mit dem docker-entrypoint-Fallback.
ALTER TABLE "embed_configs" ADD COLUMN "history_enabled" BOOLEAN;
