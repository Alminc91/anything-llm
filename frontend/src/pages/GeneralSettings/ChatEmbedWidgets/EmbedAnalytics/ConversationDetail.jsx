import { useCallback, useEffect, useRef, useState } from "react";
import {
  CaretDown,
  CaretLeft,
  CaretUp,
  Copy,
  DotsThree,
  LinkSimple,
  Robot,
  ThumbsDown,
  ThumbsUp,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import Embed from "@/models/embed";
import { formatNumber } from "@/utils/analyticsTimeline";
import showToast from "@/utils/toast";
import {
  answerText,
  berlinDay,
  berlinTime,
  conversationSummary,
  highlightParts,
  longDateLabel,
  outsidePeriod,
  shortId,
} from "@/utils/conversationView";
import MarkdownRenderer from "./MarkdownRenderer";
import { useConversationDeletion } from "./DeleteConversation";

// Konversationen-Ansicht: der Gesprächsverlauf einer Konversation – auf
// breiten Bildschirmen (ab lg) als Seitenpanel rechts neben der Liste, darunter
// als eigene Vollbildansicht mit „‹ Konversationen". Kopf (erste Frage, Datum,
// Zeitspanne, Zahl der Fragen, Bewertungen, vorherige/nächste, ⋯, ✕) und
// Fußzeile (gekürzte Kennung, Löschen) bleiben stehen; dazwischen scrollt der
// Verlauf. Fragen als Sprechblase, Antworten über den MarkdownRenderer wie
// bisher, die Bewertung direkt unter der bewerteten Antwort.

const MUTED = "text-[color:var(--theme-analytics-text-muted)]";
// Schaltflächen im Kopf: mobil 44 px hoch, ab lg kompakter.
const ICON_BUTTON =
  "grid h-11 w-11 shrink-0 place-items-center rounded-lg text-theme-text-secondary transition-colors hover:bg-white/10 hover:text-theme-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent light:hover:bg-black/5 lg:h-9 lg:w-9";

/**
 * Text mit hervorgehobenen Treffern der Suche – als Text, nie als HTML.
 * @param {{text: string, term: string}} props
 */
export function HighlightedText({ text, term }) {
  return highlightParts(text, term).map((part, index) =>
    part.hit ? (
      <mark key={index} data-search-hit="">
        {part.text}
      </mark>
    ) : (
      part.text
    )
  );
}

/**
 * Zeitspanne einer Konversation: „07:47–07:48 Uhr", über mehrere Tage
 * „09.10. 08:25 – 13.10. 07:48 Uhr".
 */
function timeSpan(startedAt, lastAt, t) {
  const from = berlinTime(startedAt);
  const to = berlinTime(lastAt);
  const fromDay = berlinDay(startedAt);
  const toDay = berlinDay(lastAt);
  if (fromDay === toDay)
    return from === to
      ? t("embed-analytics.panel.time", { time: from })
      : t("embed-analytics.panel.span", { from, to });
  const short = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}.`;
  return t("embed-analytics.panel.span-days", {
    from: `${short(fromDay)} ${from}`,
    to: `${short(toDay)} ${to}`,
  });
}

/**
 * @param {Object} props
 * @param {number} props.embedId
 * @param {number} props.chatId - id einer Zeile der Konversation (Adresse)
 * @param {object|null} props.row - Eintrag der Liste, falls die Konversation
 *   dort steht
 * @param {string} props.search - aktiver Suchbegriff (hervorgehoben)
 * @param {string|null} props.startDate - Zeitraum der Liste (ISO)
 * @param {string|null} props.endDate
 * @param {boolean} props.canPrevious
 * @param {boolean} props.canNext
 * @param {(direction: -1|1) => void} props.onNavigate
 * @param {() => void} props.onClose
 * @param {(result: {deleted: boolean}) => void} props.onDeleted
 * @param {(summary: {key: string}|null) => void} [props.onLoaded] - die
 *   geladene Konversation (Schlüssel für die Markierung in der Liste)
 * @param {(chatId: number) => string} props.linkOf - Adresse der Konversation
 */
export default function ConversationDetail({
  embedId,
  chatId,
  row = null,
  search = "",
  startDate = null,
  endDate = null,
  canPrevious = false,
  canNext = false,
  onNavigate = () => {},
  onClose = () => {},
  onDeleted = () => {},
  onLoaded = () => {},
  linkOf = () => "",
}) {
  const { t, i18n } = useTranslation();
  // { chatId, reload, messages, failed } – zu genau einer Konversation
  const [detail, setDetail] = useState({
    chatId: null,
    reload: 0,
    messages: [],
    failed: false,
  });
  const [reload, setReload] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const bodyRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    let ignore = false;
    async function load() {
      const { success, messages } = await Embed.getConversationDetails(
        embedId,
        chatId
      );
      if (ignore) return;
      setDetail({
        chatId,
        reload,
        messages: success && Array.isArray(messages) ? messages : [],
        failed: !success,
      });
    }
    load();
    return () => {
      ignore = true;
    };
  }, [embedId, chatId, reload]);

  const loaded = detail.chatId === chatId && detail.reload === reload;
  const messages = loaded ? detail.messages : [];
  const summary = loaded ? conversationSummary(messages) : null;

  const summaryKey = summary?.key ?? null;
  useEffect(() => {
    if (loaded) onLoaded(summaryKey ? { key: summaryKey } : null);
  }, [loaded, summaryKey, onLoaded]);

  // Ohne Eintrag der Liste (geöffnet per Link) kommen die Angaben aus den
  // Nachrichten.
  const head = summary
    ? summary
    : row
      ? {
          firstQuestion: row.preview ?? "",
          startedAt: row.started_at,
          lastAt: row.last_message_at,
          questions: row.message_count,
          positive: row.positive_count,
          negative: row.negative_count,
          conversationId: row.conversation_id,
        }
      : null;
  const notFound = loaded && !summary && !row;
  const deletable = head
    ? {
        first_chat_id: row?.first_chat_id ?? chatId,
        preview: row?.preview ?? head.firstQuestion,
        message_count: row?.message_count ?? head.questions,
      }
    : null;

  const deletion = useConversationDeletion({
    embedId,
    conversation: deletable,
    onDeleted: (result) => {
      if (!result.deleted) setReload((count) => count + 1);
      onDeleted(result);
    },
  });

  // Treffer der Suche: zum ersten scrollen; sonst beim Wechsel nach oben.
  useEffect(() => {
    if (!loaded) return;
    const body = bodyRef.current;
    const hit = body?.querySelector?.("[data-search-hit]");
    if (hit) hit.scrollIntoView?.({ block: "center" });
    else if (body) body.scrollTop = 0;
  }, [loaded, chatId, search]);

  // Escape schließt das Panel – nicht, solange eine Rückfrage oder das Menü
  // offen ist oder in einem Eingabefeld getippt wird.
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const tag = String(event.target?.tagName ?? "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (document.querySelector?.("[data-confirm-dialog]")) return;
      if (menuOpen) return;
      onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen, onClose]);

  // Menü: Klick außerhalb oder Escape schließt.
  useEffect(() => {
    if (!menuOpen) return;
    function handleMouseDown(event) {
      if (menuRef.current && !menuRef.current.contains(event.target))
        setMenuOpen(false);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const conversationId = head?.conversationId ?? null;
  const copy = useCallback(
    async (text, successKey) => {
      // Erfolg erst melden, wenn der Text in der Zwischenablage ist – der
      // Browser kann das Kopieren ablehnen, ohne HTTPS fehlt
      // navigator.clipboard.
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        showToast(t("code-snippet-modal.copy-failed"), "error");
        return;
      }
      showToast(t(successKey), "success");
    },
    [t]
  );
  const copyId = () => {
    setMenuOpen(false);
    if (conversationId) copy(conversationId, "embed-analytics.panel.id-copied");
  };
  const copyLink = () => {
    setMenuOpen(false);
    copy(linkOf(chatId), "embed-analytics.panel.link-copied");
  };
  const openDelete = (kind) => {
    setMenuOpen(false);
    deletion.openDialog(kind);
  };

  const locale = i18n.language;
  const outside = loaded && outsidePeriod(messages, startDate, endDate);

  return (
    <aside
      data-conversation-panel=""
      aria-label={t("embed-analytics.panel.label")}
      className="fixed inset-0 z-50 flex flex-col bg-theme-bg-secondary lg:sticky lg:inset-auto lg:top-4 lg:z-auto lg:max-h-[calc(100vh-64px)] lg:w-[min(520px,48%)] lg:shrink-0 lg:overflow-hidden lg:rounded-xl lg:border lg:border-white/10 lg:bg-theme-bg-primary"
    >
      {/* Kopf – bleibt beim Scrollen stehen */}
      <header
        data-panel-head=""
        className="flex shrink-0 flex-col gap-2 border-b border-white/10 px-2 pb-3 pt-2 light:border-gray-200 lg:px-5 lg:pt-4"
      >
        <div className="flex items-center justify-between gap-2">
          {/* mobil: zurück zur Liste */}
          <button
            type="button"
            data-panel-back=""
            onClick={onClose}
            className="flex h-11 items-center gap-1 rounded-lg px-2 text-[15px] text-theme-text-primary hover:bg-white/10 light:hover:bg-black/5 lg:hidden"
          >
            <CaretLeft size={20} aria-hidden="true" />
            {t("embed-analytics.panel.back")}
          </button>
          <span
            data-panel-date=""
            className={`hidden text-sm ${MUTED} lg:block`}
          >
            {head ? longDateLabel(berlinDay(head.startedAt), locale) : ""}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              data-panel-previous=""
              aria-label={t("embed-analytics.panel.previous")}
              title={t("embed-analytics.panel.previous")}
              disabled={!canPrevious}
              onClick={() => onNavigate(-1)}
              className={ICON_BUTTON}
            >
              <CaretUp size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              data-panel-next=""
              aria-label={t("embed-analytics.panel.next")}
              title={t("embed-analytics.panel.next")}
              disabled={!canNext}
              onClick={() => onNavigate(1)}
              className={ICON_BUTTON}
            >
              <CaretDown size={18} aria-hidden="true" />
            </button>
            <span className="relative" ref={menuRef}>
              <button
                type="button"
                data-panel-menu-button=""
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t("embed-analytics.panel.more")}
                title={t("embed-analytics.panel.more")}
                disabled={!head}
                onClick={() => setMenuOpen(!menuOpen)}
                className={ICON_BUTTON}
              >
                <DotsThree size={20} weight="bold" aria-hidden="true" />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  data-panel-menu=""
                  aria-label={t("embed-analytics.panel.more")}
                  className="absolute right-0 top-full z-50 mt-1 min-w-[240px] overflow-hidden rounded-lg border border-white/10 bg-theme-bg-secondary py-1 shadow-xl light:border-gray-200"
                >
                  <MenuItem
                    data-menu-copy-id=""
                    Icon={Copy}
                    onClick={copyId}
                    label={t("embed-analytics.panel.copy-id")}
                  />
                  <MenuItem
                    data-menu-copy-link=""
                    Icon={LinkSimple}
                    onClick={copyLink}
                    label={t("embed-analytics.panel.copy-link")}
                  />
                  {deletion.offerVisitor && (
                    <MenuItem
                      data-delete-visitor=""
                      Icon={Trash}
                      danger
                      onClick={() => openDelete("visitor")}
                      label={t("embed-analytics.delete.visitor")}
                    />
                  )}
                  <MenuItem
                    data-menu-delete=""
                    Icon={Trash}
                    danger
                    onClick={() => openDelete("conversation")}
                    label={t("embed-analytics.delete.conversation")}
                  />
                </div>
              )}
            </span>
            <button
              type="button"
              data-panel-close=""
              aria-label={t("embed-analytics.panel.close")}
              title={t("embed-analytics.panel.close")}
              onClick={onClose}
              className={`${ICON_BUTTON} hidden lg:grid`}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </span>
        </div>

        {head && (
          <div className="flex flex-col gap-1.5 px-2 lg:px-0">
            <h3
              data-panel-question=""
              className="break-words text-[17px] font-semibold leading-snug text-theme-text-primary lg:text-lg"
            >
              <HighlightedText text={head.firstQuestion} term={search} />
            </h3>
            <p
              data-panel-meta=""
              className={`flex flex-wrap gap-x-1.5 text-[13px] ${MUTED}`}
            >
              <span className="lg:hidden">
                {longDateLabel(berlinDay(head.startedAt), locale)} ·
              </span>
              <span>
                {t("embed-analytics.rows.questions", {
                  count: head.questions,
                  formatted: formatNumber(head.questions),
                })}{" "}
                · {timeSpan(head.startedAt, head.lastAt, t)}
              </span>
              {head.negative > 0 && (
                <span className="text-orange-300 light:text-orange-700">
                  ·{" "}
                  {t("embed-analytics.panel.negative-count", {
                    count: head.negative,
                    formatted: formatNumber(head.negative),
                  })}
                </span>
              )}
              {head.positive > 0 && (
                <span className="text-sky-300 light:text-sky-700">
                  ·{" "}
                  {t("embed-analytics.panel.positive-count", {
                    count: head.positive,
                    formatted: formatNumber(head.positive),
                  })}
                </span>
              )}
            </p>
            {outside && (
              <p
                data-panel-outside=""
                className="text-[13px] text-theme-text-primary"
              >
                {t("embed-analytics.panel.outside")}
              </p>
            )}
          </div>
        )}
      </header>

      {/* Verlauf – scrollt */}
      <div
        ref={bodyRef}
        data-panel-body=""
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 lg:px-5"
      >
        {!loaded ? (
          <p className={`py-4 text-center text-sm ${MUTED}`}>
            {t("common.loading")}
          </p>
        ) : notFound ? (
          <p data-panel-not-found="" className={`py-4 text-sm ${MUTED}`}>
            {t("embed-analytics.panel.not-found")}
          </p>
        ) : messages.length === 0 ? (
          <p className={`py-4 text-center text-sm ${MUTED}`}>
            {t("embed-analytics.conversations.no-messages")}
          </p>
        ) : (
          <ol className="flex flex-col gap-5">
            {messages.map((message) => (
              <Message key={message.id} message={message} search={search} />
            ))}
          </ol>
        )}
      </div>

      {/* Fußzeile: gekürzte Kennung (kopieren) und Löschen */}
      {head && (
        <footer
          data-conversation-actions=""
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/10 px-3 py-2 light:border-gray-200 lg:px-4"
        >
          <button
            type="button"
            data-panel-id=""
            onClick={copyId}
            title={t("embed-analytics.panel.copy-id")}
            className={`flex h-11 items-center gap-1.5 rounded-md px-2 text-xs ${MUTED} hover:bg-white/10 hover:text-theme-text-primary light:hover:bg-black/5 lg:h-8`}
          >
            <Copy size={13} aria-hidden="true" />
            <span className="font-mono">
              {t("embed-analytics.panel.id", { id: shortId(conversationId) })}
            </span>
          </button>
          <button
            type="button"
            data-delete-conversation=""
            onClick={() => openDelete("conversation")}
            className="flex h-11 items-center gap-1.5 rounded-md px-2 text-[13px] text-theme-text-secondary transition-colors hover:bg-theme-button-delete-hover-bg hover:text-theme-button-delete-hover-text lg:h-8"
          >
            <Trash size={14} aria-hidden="true" />
            {t("embed-analytics.delete.conversation")}
          </button>
        </footer>
      )}
      {deletion.dialog}
    </aside>
  );
}

function MenuItem({ Icon, label, onClick, danger = false, ...rest }) {
  return (
    <button
      type="button"
      role="menuitem"
      {...rest}
      onClick={onClick}
      className={`flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors lg:min-h-0 ${
        danger
          ? "text-theme-text-secondary hover:bg-theme-button-delete-hover-bg hover:text-theme-button-delete-hover-text"
          : "text-theme-text-secondary hover:bg-white/5 hover:text-theme-text-primary light:hover:bg-black/5"
      }`}
    >
      <Icon size={15} aria-hidden="true" className="shrink-0" />
      {label}
    </button>
  );
}

/** Eine Frage des Besuchers und die Antwort darauf, mit ihrer Bewertung. */
function Message({ message, search }) {
  const { t } = useTranslation();
  const answer = answerText(message.response);
  return (
    <li data-message="" className="flex flex-col gap-2.5">
      <div className="flex flex-col items-end gap-1">
        <span className={`text-xs ${MUTED}`}>
          {t("embed-analytics.panel.visitor", {
            time: berlinTime(message.createdAt),
          })}
        </span>
        <div
          data-question=""
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-sky-900 px-3.5 py-2.5 text-sm leading-relaxed text-[#ffffff] light:bg-sky-100 light:text-sky-950"
        >
          <HighlightedText text={message.prompt} term={search} />
        </div>
      </div>
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10 text-theme-text-secondary light:bg-black/5"
        >
          <Robot size={15} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div
            data-answer=""
            className="analytics-bot-response prose prose-sm max-w-none break-words text-sm leading-relaxed text-theme-text-primary"
          >
            <MarkdownRenderer content={answer} highlight={search} />
          </div>
          <Rating message={message} search={search} />
        </div>
      </div>
    </li>
  );
}

/** Bewertung direkt unter der bewerteten Antwort (KIE-504/507). */
function Rating({ message, search }) {
  const { t } = useTranslation();
  if (message.feedbackScore === true)
    return (
      <span
        data-rating="positive"
        className="inline-flex items-center gap-1.5 self-start text-[13px] font-semibold text-sky-300 light:text-sky-700"
      >
        <ThumbsUp size={14} aria-hidden="true" />
        {t("embed-analytics.panel.positive")}
      </span>
    );
  if (message.feedbackScore !== false) return null;
  return (
    <div
      data-rating="negative"
      className="flex flex-col gap-1.5 rounded-lg border border-orange-400/30 bg-orange-500/10 px-3 py-2.5 light:border-orange-200 light:bg-orange-50"
    >
      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-orange-300 light:text-orange-800">
        <ThumbsDown size={14} aria-hidden="true" />
        <span>
          {t("embed-analytics.panel.negative")}
          {message.feedbackReason && (
            <>
              {" · "}
              <HighlightedText text={message.feedbackReason} term={search} />
            </>
          )}
        </span>
      </span>
      {message.feedbackText && (
        <p
          data-rating-comment=""
          className="whitespace-pre-wrap break-words text-[13px] text-theme-text-primary"
        >
          „<HighlightedText text={message.feedbackText} term={search} />“
        </p>
      )}
    </div>
  );
}
