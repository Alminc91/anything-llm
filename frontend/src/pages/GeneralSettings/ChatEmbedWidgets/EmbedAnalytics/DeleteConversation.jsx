import { useCallback, useEffect, useRef, useState } from "react";
import { Warning, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import ModalWrapper from "@/components/ModalWrapper";
import Embed from "@/models/embed";
import { formatNumber } from "@/utils/analyticsTimeline";
import showToast from "@/utils/toast";
import { MUTED } from "@/utils/conversationView";

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

/**
 * Höchstdauer einer Lösch-Anfrage, bevor die Rückfrage aufgibt (Nachtrag
 * rc3): „Wird gelöscht …“ steht nie unbegrenzt. Der Server antwortet auch
 * unter einer Sperre der Datenbank nach rund 5 s („busy“, nichts gelöscht);
 * die Grenze lässt dafür und für eine ausgelastete Instanz Luft. Ein
 * Objekt, damit Tests sie verkürzen können.
 */
export const DELETE_LIMITS = { timeoutMs: 20_000 };

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
 *
 * Die Vorschau (was das Löschen entfernen würde) lädt im Hintergrund, sobald
 * das Panel eine Konversation zeigt – beim Öffnen und beim Blättern
 * (Nachtrag N1; die Abfragen dauern seit Fixliste 9 rund 2 ms). So steht
 * das Menü „⋯" beim Öffnen gleich im Endzustand: „Alle Konversationen
 * dieses Besuchers löschen" erscheint nur, wenn die Vorschau weitere
 * Konversationen kennt – nie gesperrt und nie angezeigt und wieder
 * entfernt.
 *
 * Aufgefrischt wird sie im Hintergrund beim Öffnen des Menüs
 * (refreshPreview) und jeder Rückfrage (Review 7.21.1): Die Rückfrage nennt
 * so die Zahl der Nachrichten von jetzt, nicht vom Öffnen des Panels.
 * Solange das Auffrischen läuft, bleibt der bekannte Stand stehen (kein
 * Ladehinweis, der aufblitzt); scheitert es, bleibt er ebenfalls. Eine
 * Antwort zählt nur, wenn seither nichts Neueres kam: weder ein späteres
 * Auffrischen noch der Stand aus einer „changed“-Antwort des Löschens
 * (Folgenummer, Nachtrag rc3 F03).
 *
 * Gibt es die Konversation nicht mehr (die Vorschau nennt keinen Besucher
 * mehr, nachdem „Alle Konversationen dieses Besuchers“ angeboten war),
 * schließt die Rückfrage mit einer Meldung, und Liste und Panel laden den
 * aktuellen Stand (rc3 F01). Scheitert das Löschen an einer gesperrten
 * Datenbank, bleibt die Rückfrage mit einem Hinweis offen; antwortet der
 * Server nicht in DELETE_LIMITS.timeoutMs, schließt sie mit einer Meldung –
 * die Schaltflächen sind in beiden Fällen wieder frei (rc3, Hänger).
 * @param {Object} props
 * @param {number} props.embedId
 * @param {number} props.previewChatId - id einer Zeile der gezeigten
 *   Konversation (Adresse des Panels): Für sie lädt die Vorschau, schon
 *   während der Verlauf lädt. Jede Zeile der Konversation liefert dieselbe
 *   Vorschau; die Adresse bleibt, auch wenn die Konversation später in der
 *   Liste auftaucht (dann mit ihrer ersten Zeile, first_chat_id).
 * @param {{first_chat_id: number, preview?: string, message_count: number}|null} props.conversation -
 *   first_chat_id: id einer Zeile der Konversation (für das Löschen); null,
 *   solange sie nicht geladen ist
 * @param {(result: {deleted: boolean, visitor?: boolean}) => void} props.onDeleted -
 *   nach dem Löschen (auch nach einem Fehlschlag: Die Liste lädt dann den
 *   tatsächlichen Stand); visitor: alle Konversationen des Besuchers
 * @returns {{offerVisitor: boolean, refreshPreview: () => void, openDialog: (kind: "conversation"|"visitor") => void, dialog: React.ReactNode}}
 */
export function useConversationDeletion({
  embedId,
  previewChatId,
  conversation,
  onDeleted = () => {},
}) {
  const { t } = useTranslation();
  // Die Konversation: eine ihrer Zeilen. Die conversation_id vergibt der
  // Besucher, eine zweite Sitzung kann dieselbe tragen.
  const chatId = conversation?.first_chat_id ?? null;
  // Was das Löschen entfernen würde: { messageCount, visitor } – nur Zahlen,
  // je Konversation (previewChatId) gemerkt; data null, wenn die erste
  // Anfrage scheiterte.
  const [preview, setPreview] = useState({ chatId: null, data: null });
  // Zähler fürs Auffrischen (Menü, Rückfrage)
  const [refresh, setRefresh] = useState(0);
  const refreshPreview = useCallback(() => setRefresh((n) => n + 1), []);
  // offene Rückfrage: { kind: "conversation" | "visitor", chatId } | null
  const [dialog, setDialog] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // Folgenummer der Vorschau: Jede Anfrage und jeder Stand aus dem Löschen
  // zieht eine neue; eine Antwort mit älterer Nummer wird verworfen (F03).
  const previewSequence = useRef(0);

  useEffect(() => {
    if (!previewChatId) return;
    let ignore = false;
    async function loadPreview() {
      const sequence = ++previewSequence.current;
      const data = await Embed.getConversationDeletionPreview(
        embedId,
        previewChatId
      );
      if (ignore || sequence !== previewSequence.current) return;
      // Scheitert das Auffrischen, bleibt der bekannte Stand derselben
      // Konversation (ihn prüft das Löschen des Besuchers ohnehin).
      setPreview((previous) => ({
        chatId: previewChatId,
        data: data?.success
          ? data
          : previous.chatId === previewChatId
            ? previous.data
            : null,
      }));
    }
    loadPreview();
    return () => {
      ignore = true;
    };
  }, [embedId, previewChatId, refresh]);

  const previewLoaded = chatId !== null && preview.chatId === previewChatId;
  const current = previewLoaded ? preview.data : null;
  // Die Liste zählt nur einsehbare Nachrichten im Zeitraum; gelöscht wird die
  // ganze Konversation – die Rückfrage nennt die Zahl vom Server. Scheiterte
  // die Vorschau, nennt sie keine Zahl statt einer falschen (Fixliste 2, R7).
  const messageCount = Number.isInteger(current?.messageCount)
    ? current.messageCount
    : null;
  const visitor = current?.visitor ?? null;
  const offerVisitor = (visitor?.conversationCount ?? 0) > 1;

  const close = useCallback(() => {
    if (!deleting) setDialog(null);
  }, [deleting]);

  // Die Konversation gibt es nicht mehr (rc3 F01): Meldung wie die übrigen
  // Fehlerhinweise der Seite, Rückfrage zu, Liste und Panel laden neu.
  const reportGone = () => {
    setDialog(null);
    showToast(t("embed-analytics.delete.gone"), "error");
    onDeleted({ deleted: false });
  };

  const handleDelete = async () => {
    if (deleting) return;
    const wholeVisitor = dialog?.kind === "visitor";
    if (wholeVisitor && !visitor) {
      reportGone();
      return;
    }
    setDeleting(true);
    // Der Hinweis auf eine gesperrte Datenbank gilt dem vorigen Versuch.
    if (dialog?.busy) setDialog({ ...dialog, busy: false });
    // Nie unbegrenzt „Wird gelöscht …“ (rc3, Hänger): Nach
    // DELETE_LIMITS.timeoutMs bricht die Anfrage ab.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELETE_LIMITS.timeoutMs);
    const options = { signal: controller.signal };
    // Gelöscht wird nur der Stand, den die Rückfrage nennt (Fixliste 7,
    // F10), samt seiner jüngsten Zeile (maxId, Fixliste 8, L1): Hat sich
    // inzwischen etwas geändert – der Besucher hat weiter geschrieben oder
    // etwas ist weggefallen –, löscht der Server nichts und nennt den neuen
    // Stand.
    let result = null;
    try {
      result = wholeVisitor
        ? await Embed.deleteVisitorConversations(
            embedId,
            chatId,
            {
              conversationCount: visitor.conversationCount,
              messageCount: visitor.messageCount,
              ...(Number.isInteger(visitor.maxId)
                ? { maxId: visitor.maxId }
                : {}),
            },
            options
          )
        : await Embed.deleteConversation(embedId, chatId, options);
    } catch {
      result = null;
    } finally {
      clearTimeout(timer);
      setDeleting(false);
    }

    if (
      wholeVisitor &&
      result?.reason === "changed" &&
      Number.isInteger(result.visitor?.conversationCount) &&
      Number.isInteger(result.visitor?.messageCount)
    ) {
      // Die Rückfrage bleibt offen und nennt die neuen Zahlen; ein erneutes
      // Bestätigen löscht genau diesen Stand. Ein Auffrischen, das noch
      // unterwegs ist, kennt einen älteren Stand – es wird verworfen (F03).
      // Zusammengeführt mit dem jüngsten Stand, nicht dem vom Klick (F04).
      previewSequence.current += 1;
      setPreview((previous) => ({
        chatId: previewChatId,
        data: {
          ...(previous.chatId === previewChatId ? (previous.data ?? {}) : {}),
          visitor: result.visitor,
        },
      }));
      setDialog({ kind: dialog.kind, chatId, changed: true });
      return;
    }
    // Datenbank gesperrt: nichts gelöscht, die Rückfrage bleibt mit Hinweis
    // offen, ein erneutes Bestätigen versucht es noch einmal (rc3, Hänger).
    if (result?.reason === "busy") {
      setDialog({ kind: dialog.kind, chatId, busy: true });
      return;
    }
    setDialog(null);
    if (result?.reason === "timeout") {
      // Ob der Server noch löscht, ist offen: Meldung, Liste und Panel
      // laden den Stand von jetzt.
      showToast(t("embed-analytics.delete.timeout"), "error");
      onDeleted({ deleted: false });
      return;
    }

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
    // visitor: alle Konversationen des Besuchers gelöscht (die Liste wählt
    // bis zu ihrer neuen Fassung keine davon vor, Review 7.22-rc15, K45)
    onDeleted({ deleted, visitor: wholeVisitor });
  };

  // Die Rückfrage frischt die Vorschau auf. „Alle Konversationen dieses
  // Besuchers“ öffnet, solange ein Besucher bekannt ist – auch wenn das
  // Auffrischen im offenen Menü weniger Konversationen fand: Der Eintrag
  // blieb dort stehen (N1), das Löschen prüft den genannten Stand.
  // Kennt die Vorschau keinen Besucher mehr, gibt es die Konversation nicht
  // mehr (der Eintrag blieb im offenen Menü stehen): Meldung statt stummem
  // Nichtstun (rc3 F01).
  const openDialog = (kind) => {
    if (!chatId) return;
    if (kind === "visitor" && !visitor) {
      reportGone();
      return;
    }
    refreshPreview();
    setDialog({ kind, chatId });
  };

  // Die Rückfrage gilt der Konversation, für die sie geöffnet wurde – zeigt
  // das Panel inzwischen eine andere (Zurück-Knopf), ist sie hinfällig.
  if (dialog && dialog.chatId !== chatId && !deleting) setDialog(null);
  // Sie erscheint sofort – solange die Vorschau lädt, mit Ladehinweis und
  // gesperrtem „Löschen"; Escape schließt dann nur sie, nicht das Panel
  // (Fixliste 2, S5).
  const kind = dialog && dialog.chatId === chatId ? dialog.kind : null;
  // Die offene Besucher-Rückfrage verliert ihren Besucher (die Konversation
  // wurde inzwischen gelöscht): nicht still verschwinden (rc3 F01).
  const visitorGone = kind === "visitor" && !visitor && !deleting;
  useEffect(() => {
    if (visitorGone) reportGone();
  }, [visitorGone]);
  const busyNotice = dialog?.busy ? (
    <p data-confirm-busy="" role="status" className="text-theme-text-primary">
      {t("embed-analytics.delete.busy")}
    </p>
  ) : null;

  let element = null;
  if (kind === "conversation" && conversation)
    element = (
      <ConfirmDialog
        title={t("embed-analytics.delete.confirm-title")}
        deleting={deleting}
        loading={!previewLoaded}
        onConfirm={handleDelete}
        onCancel={close}
      >
        {busyNotice}
        <Question text={conversation.preview} />
        <p data-confirm-count="">
          {!previewLoaded
            ? t("embed-analytics.loading")
            : messageCount === null
              ? t("embed-analytics.delete.confirm-unknown")
              : t("embed-analytics.delete.confirm-count", {
                  count: messageCount,
                  formatted: formatNumber(messageCount),
                })}
        </p>
      </ConfirmDialog>
    );
  else if (kind === "visitor" && visitor)
    element = (
      <ConfirmDialog
        title={t("embed-analytics.delete.visitor-title")}
        deleting={deleting}
        onConfirm={handleDelete}
        onCancel={close}
      >
        {busyNotice}
        {dialog.changed && (
          <p
            data-confirm-changed=""
            role="status"
            className="text-theme-text-primary"
          >
            {t("embed-analytics.delete.visitor-changed")}
          </p>
        )}
        <p data-confirm-visitor-count="">
          {t("embed-analytics.delete.visitor-count", {
            count: visitor.conversationCount,
            conversations: formatNumber(visitor.conversationCount),
            messages: formatNumber(visitor.messageCount),
          })}
        </p>
        <p>{t("embed-analytics.delete.visitor-note")}</p>
      </ConfirmDialog>
    );

  return {
    offerVisitor,
    refreshPreview,
    openDialog,
    dialog: element,
  };
}

/** Die erste Frage der Konversation, damit die richtige gelöscht wird. */
function Question({ text }) {
  const { t } = useTranslation();
  const question = shortQuestion(text);
  if (!question) return null;
  return (
    <p>
      {/* normale Schreibung wie im Rest der Ansicht – keine Versalien
          (Fixliste 7, B4) */}
      <span data-confirm-question-label="" className="block text-xs">
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
 * schließt nur sie. loading: Die Angaben laden noch – „Löschen" ist gesperrt.
 */
function ConfirmDialog({
  title,
  children,
  deleting,
  loading = false,
  onConfirm,
  onCancel,
}) {
  const { t } = useTranslation();

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== "Escape") return;
      // Escape gilt der Rückfrage – nicht auch dem Panel darunter (es
      // achtet auf defaultPrevented).
      e.preventDefault();
      onCancel();
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
            {/* mobil mindestens 44 × 44 px wie alle Bedienelemente der
                Ansicht (AK-9, Fixliste 7 F08), ab sm kompakter */}
            <button
              type="button"
              data-confirm-close=""
              onClick={onCancel}
              aria-label={t("embed-analytics.delete.cancel")}
              className={`-m-2 grid h-11 w-11 shrink-0 place-items-center rounded ${MUTED} transition-colors hover:bg-white/10 hover:text-theme-text-primary sm:m-0 sm:h-auto sm:w-auto sm:p-1 light:hover:bg-black/10`}
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          <div
            className={`space-y-3 p-5 text-sm leading-relaxed ${MUTED}`}
            aria-busy={loading ? "true" : undefined}
          >
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
              className={`min-h-11 rounded-lg px-4 py-2 text-sm ${MUTED} transition-colors hover:bg-white/10 hover:text-theme-text-primary sm:min-h-0 light:hover:bg-black/10`}
            >
              {t("embed-analytics.delete.cancel")}
            </button>
            <button
              type="button"
              data-confirm-delete=""
              onClick={onConfirm}
              disabled={deleting || loading}
              // Im hellen Theme wird text-white zur dunklen Textfarbe:
              // Die Schrift auf Rot bleibt in beiden Themes weiß.
              className="min-h-11 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-[#ffffff] transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0"
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
