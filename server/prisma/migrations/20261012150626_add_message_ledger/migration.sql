-- KIE-532: Zählerbuch für Kontingent und Statistik.
-- Rein additiv: nur CREATE TABLE und CREATE INDEX, keine bestehende Zeile wird
-- geändert oder gelöscht. IF NOT EXISTS: Der Fallback in docker-entrypoint.sh
-- legt Tabelle und Indizes mit denselben Anweisungen an, und eine als
-- fehlgeschlagen markierte Migration wird wiederholt - beides muss auf
-- denselben Stand führen.

-- CreateTable
CREATE TABLE IF NOT EXISTS "message_ledger" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspace_id" INTEGER NOT NULL,
    "embed_id" INTEGER NOT NULL DEFAULT 0,
    "day" TEXT NOT NULL,
    "hour" INTEGER NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "copied" INTEGER NOT NULL DEFAULT 0,
    "conversations_started" INTEGER NOT NULL DEFAULT 0,
    "feedback_positive" INTEGER NOT NULL DEFAULT 0,
    "feedback_negative" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "message_ledger_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "message_ledger_workspace_id_day_idx" ON "message_ledger"("workspace_id", "day");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "message_ledger_embed_id_day_idx" ON "message_ledger"("embed_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "message_ledger_workspace_id_embed_id_day_hour_key" ON "message_ledger"("workspace_id", "embed_id", "day", "hour");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "embed_chats_embed_id_createdAt_idx" ON "embed_chats"("embed_id", "createdAt");
