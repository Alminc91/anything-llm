import { useCallback, useEffect, useState } from "react";
import { Warning, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import ModalWrapper from "@/components/ModalWrapper";
import Embed from "@/models/embed";
import { formatNumber } from "@/utils/analyticsTimeline";
import showToast from "@/utils/toast";

// KIE-538: „Konversation löschen" – etwa bei der Löschanfrage eines
// Besuchers. Gelöscht wird die ganze Konversation, nach einer Rückfrage mit
// erster Frage und Zahl der Nachrichten. Hat derselbe Browser in diesem
// Widget weitere Konversationen, lassen sich alle auf einmal löschen (AK-12).
// Kennzahlen, Diagramm und Kontingent bleiben unverändert: Sie kommen aus dem
// Zählerbuch.
//
// Konversationen-Ansicht: Die Schaltflächen stehen im Seitenpanel (Menü „⋯"
// und Fußzeile); dieses Modul liefert Vorschau, Rückfragen und das Löschen
// (useConversationDeletion).

const QUESTION_MAX_LENGTH = 80;

/** Erste Frage für die Rückfrage, auf eine Zeile gekürzt. */
function shortQuestion(text) {
  const line = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > QUESTION_MAX_LENGTH
    ? `${line.slice(0, QUESTION_MAX_LENGTH).trimEnd()}…`
    : line;
}

/**
 * Löschen einer Konversation (und aller Konversationen ihres Besuchers) mit
 * Rückfrage.
 * @param {Object} props
 * @param {number} props.embedId
 * @param {{first_chat_id: number, preview?: string, message_count: number}|null} props.conversation -
 *   first_chat_id: id einer Zeile der Konversation; null, solange sie nicht
 *   geladen ist
 * @param {() => void} props.onDeleted - nach dem Löschen (auch nach einem
 *   Fehlschlag: Die Liste lädt dann den tatsächlichen Stand)
 * @returns {{offerVisitor: boolean, openDialog: (kind: "conversation"|"visitor") => void, dialog: React.ReactNode}}
 */
export function useConversationDeletion({
  embedId,
  conversation,
  onDeleted = () => {},
}) {
  const { t } = useTranslation();
  // Was das Löschen entfernen würde: { messageCount, visitor } – nur Zahlen,
  // je Konversation (chatId) gemerkt.
  const [preview, setPreview] = useState({ chatId: null, data: null });
  // offene Rückfrage: null | "conversation" | "visitor"
  const [dialog, setDialog] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // Die Konversation: eine ihrer Zeilen. Die conversation_id vergibt der
  // Besucher, eine zweite Sitzung kann dieselbe tragen.
  const chatId = conversation?.first_chat_id ?? null;

  useEffect(() => {
    if (!chatId) return;
    let ignore = false;
    async function loadPreview() {
      const data = await Embed.getConversationDeletionPreview(embedId, chatId);
      if (!ignore && data?.success) setPreview({ chatId, data });
    }
    loadPreview();
    return () => {
      ignore = true;
    };
  }, [embedId, chatId]);

  const current = preview.chatId === chatId ? preview.data : null;
  // Die Liste zählt nur einsehbare Nachrichten im Zeitraum; gelöscht wird die
  // ganze Konversation – die Rückfrage nennt die Zahl vom Server.
  const messageCount = current?.messageCount ?? conversation?.message_count;
  const visitor = current?.visitor ?? null;
  const offerVisitor = (visitor?.conversationCount ?? 0) > 1;

  const close = useCallback(() => {
    if (!deleting) setDialog(null);
  }, [deleting]);

  const handleDelete = async () => {
    setDeleting(true);
    const wholeVisitor = dialog === "visitor";
    const result = wholeVisitor
      ? await Embed.deleteVisitorConversations(embedId, chatId)
      : await Embed.deleteConversation(embedId, chatId);
    setDeleting(false);
    setDialog(null);

    // Gelöscht ist nur, was der Server mit Zahlen belegt – ein bloßes
    // { success: true } einer anderen Route gilt nicht als Erfolg.
    const deleted =
      result?.success === true &&
      Number.isInteger(result.deletedCount) &&
      (!wholeVisitor || Number.isInteger(result.conversationCount));
    if (!deleted) {
      showToast(t("embed-analytics.delete.error"), "error");
    } else if (wholeVisitor) {
      showToast(
        t("embed-analytics.delete.visitor-success", {
          count: result.conversationCount,
          conversations: formatNumber(result.conversationCount),
          messages: formatNumber(result.deletedCount),
        }),
        "success"
      );
    } else {
      showToast(
        t("embed-analytics.delete.success", {
          count: result.deletedCount,
          formatted: formatNumber(result.deletedCount),
        }),
        "success"
      );
    }
    onDeleted({ deleted });
  };

  const openDialog = useCallback(
    (kind) => {
      if (!chatId) return;
      if (kind === "visitor" && !offerVisitor) return;
      setDialog(kind);
    },
    [chatId, offerVisitor]
  );

  let element = null;
  if (dialog === "conversation" && conversation)
    element = (
      <ConfirmDialog
        title={t("embed-analytics.delete.confirm-title")}
        deleting={deleting}
        onConfirm={handleDelete}
        onCancel={close}
      >
        <Question text={conversation.preview} />
        <p>
          {t("embed-analytics.delete.confirm-count", {
            count: messageCount,
            formatted: formatNumber(messageCount),
          })}
        </p>
      </ConfirmDialog>
    );
  else if (dialog === "visitor" && visitor)
    element = (
      <ConfirmDialog
        title={t("embed-analytics.delete.visitor-title")}
        deleting={deleting}
        onConfirm={handleDelete}
        onCancel={close}
      >
        <p>
          {t("embed-analytics.delete.visitor-count", {
            count: visitor.conversationCount,
            conversations: formatNumber(visitor.conversationCount),
            messages: formatNumber(visitor.messageCount),
          })}
        </p>
        <p>{t("embed-analytics.delete.visitor-note")}</p>
      </ConfirmDialog>
    );

  return { offerVisitor, openDialog, dialog: element };
}

/** Die erste Frage der Konversation, damit die richtige gelöscht wird. */
function Question({ text }) {
  const { t } = useTranslation();
  const question = shortQuestion(text);
  if (!question) return null;
  return (
    <p>
      <span className="block text-xs uppercase tracking-wide">
        {t("embed-analytics.delete.first-question")}
      </span>
      <span
        data-confirm-question=""
        className="block break-words italic text-theme-text-primary"
      >
        „{question}“
      </span>
    </p>
  );
}

/**
 * Rückfrage vor dem Löschen. Abbrechen ist die Vorgabe (Fokus); Escape
 * schließt.
 */
function ConfirmDialog({ title, children, deleting, onConfirm, onCancel }) {
  const { t } = useTranslation();

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <ModalWrapper isOpen={true}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-confirm-dialog=""
        className="w-full max-w-md p-4"
      >
        <div className="overflow-hidden rounded-lg border-2 border-theme-modal-border bg-theme-bg-secondary shadow">
          <div className="flex items-start justify-between gap-3 border-b border-theme-modal-border p-5">
            <div className="flex min-w-0 items-center gap-2">
              <Warning
                size={22}
                weight="fill"
                aria-hidden="true"
                className="shrink-0 text-red-400 light:text-red-600"
              />
              <h3 className="text-lg font-semibold text-theme-text-primary">
                {title}
              </h3>
            </div>
            <button
              type="button"
              onClick={onCancel}
              aria-label={t("embed-analytics.delete.cancel")}
              className="shrink-0 rounded p-1 text-theme-text-secondary transition-colors hover:bg-white/10 hover:text-theme-text-primary light:hover:bg-black/10"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          <div className="space-y-3 p-5 text-sm leading-relaxed text-theme-text-secondary">
            {children}
            <p>{t("embed-analytics.delete.confirm-note")}</p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-theme-modal-border p-5">
            <button
              type="button"
              autoFocus
              data-confirm-cancel=""
              onClick={onCancel}
              disabled={deleting}
              className="rounded-lg px-4 py-2 text-sm text-theme-text-secondary transition-colors hover:bg-white/10 hover:text-theme-text-primary light:hover:bg-black/10"
            >
              {t("embed-analytics.delete.cancel")}
            </button>
            <button
              type="button"
              data-confirm-delete=""
              onClick={onConfirm}
              disabled={deleting}
              // Im hellen Theme wird text-white zur dunklen Textfarbe:
              // Die Schrift auf Rot bleibt in beiden Themes weiß.
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-[#ffffff] transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleting
                ? t("embed-analytics.delete.deleting")
                : t("embed-analytics.delete.confirm")}
            </button>
          </div>
        </div>
      </div>
    </ModalWrapper>
  );
}
