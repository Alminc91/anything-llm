-- KIE-503: Index für die Konversations-Listen-Query des "Frühere Chats"-Panels
-- (WHERE embed_id = ? AND session_id = ? ... GROUP BY). Rein additiv,
-- idempotenzvertraeglich mit dem docker-entrypoint Migrations-Fallback.
CREATE INDEX "embed_chats_embed_id_session_id_idx" ON "embed_chats"("embed_id", "session_id");
