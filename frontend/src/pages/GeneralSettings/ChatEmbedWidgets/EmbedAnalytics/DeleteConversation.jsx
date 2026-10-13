import { useEffect, useState } from "react";
import { Trash, Warning, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import ModalWrapper from "@/components/ModalWrapper";
import Embed from "@/models/embed";
import { formatNumber } from "@/utils/analyticsTimeline";
import showToast from "@/utils/toast";

// KIE-538: „Konversation löschen" am Fuß einer aufgeklappten Konversation –
// etwa bei der Löschanfrage eines Besuchers. Gelöscht wird die ganze
// Konversation, nach einer Rückfrage mit erster Frage und Zahl der
// Nachrichten. Hat derselbe Browser in diesem Widget weitere Konversationen,
// lassen sich alle auf einmal löschen (AK-12). Kennzahlen, Diagramm und
// Kontingent bleiben unverändert: Sie kommen aus dem Zählerbuch.

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

const ACTION_CLASS =
  "inline-flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-xs text-theme-text-secondary transition-colors hover:bg-theme-button-delete-hover-bg hover:text-theme-button-delete-hover-text";

/**
 * @param {Object} props
 * @param {number} props.embedId
 * @param {{conversation_id: string, preview?: string, message_count: number}} props.conversation - Eintrag der Liste
 * @param {() => void} props.onDeleted - nach dem Löschen (auch nach einem Fehlschlag: Die Liste lädt dann den tatsächlichen Stand)
 */
export default function DeleteConversation({
  embedId,
  conversation,
  onDeleted = () => {},
}) {
  const { t } = useTranslation();
  // Was das Löschen entfernen würde: { messageCount, visitor } – nur Zahlen
  const [preview, setPreview] = useState(null);
  // offene Rückfrage: null | "conversation" | "visitor"
  const [dialog, setDialog] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const conversationId = conversation.conversation_id;

  useEffect(() => {
    let ignore = false;
    async function loadPreview() {
      const data = await Embed.getConversationDeletionPreview(
        embedId,
        conversationId
      );
      if (!ignore && data?.success) setPreview(data);
    }
    loadPreview();
    return () => {
      ignore = true;
    };
  }, [embedId, conversationId]);

  // Die Liste zählt nur einsehbare Nachrichten im Zeitraum; gelöscht wird die
  // ganze Konversation – die Rückfrage nennt die Zahl vom Server.
  const messageCount = preview?.messageCount ?? conversation.message_count;
  const visitor = preview?.visitor ?? null;
  const offerVisitor = (visitor?.conversationCount ?? 0) > 1;

  const close = () => {
    if (!deleting) setDialog(null);
  };

  const handleDelete = async () => {
    setDeleting(true);
    const wholeVisitor = dialog === "visitor";
    const result = wholeVisitor
      ? await Embed.deleteVisitorConversations(embedId, conversationId)
      : await Embed.deleteConversation(embedId, conversationId);
    setDeleting(false);
    setDialog(null);

    if (!result?.success) {
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
    onDeleted();
  };

  return (
    <div
      data-conversation-actions=""
      className="mt-5 flex flex-wrap justify-end gap-x-4 gap-y-1 border-t border-white/10 pt-3 light:border-gray-200"
    >
      {offerVisitor && (
        <button
          type="button"
          data-delete-visitor=""
          onClick={() => setDialog("visitor")}
          className={ACTION_CLASS}
        >
          <Trash size={14} aria-hidden="true" className="shrink-0" />
          {t("embed-analytics.delete.visitor")}
        </button>
      )}
      <button
        type="button"
        data-delete-conversation=""
        onClick={() => setDialog("conversation")}
        className={ACTION_CLASS}
      >
        <Trash size={14} aria-hidden="true" className="shrink-0" />
        {t("embed-analytics.delete.conversation")}
      </button>

      {dialog === "conversation" && (
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
      )}
      {dialog === "visitor" && visitor && (
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
      )}
    </div>
  );
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
