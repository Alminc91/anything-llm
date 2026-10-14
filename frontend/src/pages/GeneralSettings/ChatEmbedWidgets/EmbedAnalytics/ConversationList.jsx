import { useState, useEffect } from "react";
import {
  CaretDown,
  CaretUp,
  ChatCircle,
  User,
  Copy,
  ThumbsUp,
  ThumbsDown,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import Embed from "@/models/embed";
import { formatNumber } from "@/utils/analyticsTimeline";
import { formatDateTimeDE } from "@/utils/directories";
import showToast from "@/utils/toast";
import MarkdownRenderer from "./MarkdownRenderer";
import Pagination from "@/components/Pagination";
import DeleteConversation from "./DeleteConversation";
import ExportMenu from "./ExportMenu";

function timeAgo(timestamp, t) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return t("embed-analytics.conversations.seconds-ago");
  if (minutes < 60)
    return t("embed-analytics.conversations.minutes-ago", { count: minutes });
  if (hours < 24)
    return t("embed-analytics.conversations.hours-ago", { count: hours });
  if (days < 30)
    return t("embed-analytics.conversations.days-ago", { count: days });

  const months = Math.floor(days / 30);
  if (months < 12)
    return t("embed-analytics.conversations.months-ago", { count: months });

  const years = Math.floor(months / 12);
  return t("embed-analytics.conversations.years-ago", { count: years });
}

// KIE-508/527: die beiden exklusiven Feedback-Filter (ein Zustand:
// "all" | "negative" | "positive"), als Config statt Copy-Paste-Buttons.
const FEEDBACK_FILTERS = [
  {
    mode: "positive",
    Icon: ThumbsUp,
    labelKey: "embed-analytics.conversations.only-positive",
    activeClass:
      "border-emerald-400 bg-emerald-500/10 text-emerald-400 light:bg-emerald-50 light:text-emerald-600",
  },
  {
    mode: "negative",
    Icon: ThumbsDown,
    labelKey: "embed-analytics.conversations.only-negative",
    activeClass:
      "border-red-400 bg-red-500/10 text-red-400 light:bg-red-50 light:text-red-600",
  },
];

const EMPTY_STATE_KEYS = {
  all: "embed-analytics.no-conversations",
  negative: "embed-analytics.conversations.no-negative",
  positive: "embed-analytics.conversations.no-positive",
};

// KIE-508/527: Badge „👍 n" / „👎 n" pro Konversation.
function FeedbackCountBadge({ count, Icon, tone, labelKey }) {
  const { t } = useTranslation();
  if (!(count > 0)) return null;
  const toneClass =
    tone === "positive"
      ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 light:bg-emerald-50 light:text-emerald-600 light:border-emerald-200"
      : "bg-red-500/20 text-red-400 border-red-500/30 light:bg-red-50 light:text-red-600 light:border-red-200";
  return (
    <span
      className={`flex items-center gap-1 px-2 py-0.5 text-xs font-bold rounded border ${toneClass}`}
      title={t(labelKey, { count })}
    >
      <Icon size={12} weight="fill" />
      {count}
    </span>
  );
}

const MUTED = "text-[color:var(--theme-analytics-text-muted)]";

/**
 * Konversationsliste der Auswertung. Sie liest embed_chats – also nur
 * Konversationen, deren Inhalte noch vorhanden und nicht vom Besucher geleert
 * sind („einsehbar"). Die Kennzahl „Konversationen" kommt dagegen aus dem
 * Zählerbuch; beide Zahlen können sich unterscheiden.
 *
 * @param {Object} props
 * @param {number} props.embedId
 * @param {string|null} props.startDate - ISO-Zeitstempel des Browsers
 * @param {string|null} props.endDate
 * @param {"all"|"negative"|"positive"} props.feedbackFilter - KIE-508/527
 * @param {(filter: "all"|"negative"|"positive") => void} props.onFeedbackFilterChange
 * @param {{start: string, end: string, label: string}|null} [props.bucket] -
 *   KIE-536: Abschnitt aus dem Diagramm (Kalendertage). Gezeigt werden nur
 *   Konversationen, deren erste vorhandene Nachricht darin liegt.
 * @param {() => void} [props.onClearBucket]
 * @param {boolean} [props.showDeletedHint] - Hinweis auf gelöschte Inhalte
 */
export default function ConversationList({
  embedId,
  startDate,
  endDate,
  feedbackFilter = "all",
  onFeedbackFilterChange = () => {},
  bucket = null,
  onClearBucket = () => {},
  showDeletedHint = false,
}) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const ITEMS_PER_PAGE = 20;
  const bucketStart = bucket?.start ?? null;
  const bucketEnd = bucket?.end ?? null;

  // Die Seite gilt für genau einen Zuschnitt der Liste. Ändert sich Widget,
  // Zeitraum, Filter oder Abschnitt, beginnt sie im selben Render wieder
  // vorn → genau ein Request.
  const scope = [
    embedId,
    startDate,
    endDate,
    feedbackFilter,
    bucketStart,
    bucketEnd,
  ].join("|");
  const [page, setPage] = useState({ scope, offset: 0 });
  // Mit dem Zuschnitt verfällt die gemerkte Seite – sonst käme sie zurück,
  // sobald der frühere Zuschnitt wieder gilt (Filter an und wieder aus).
  if (page.scope !== scope) setPage({ scope, offset: 0 });
  const offset = page.scope === scope ? page.offset : 0;
  // KIE-538: Nach dem Löschen einer Konversation lädt die Liste neu.
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    if (!embedId) return;
    // KIE-527: Antworten überholter Requests (z. B. Filterwechsel während ein
    // Ladevorgang läuft) dürfen den aktuellen Zustand nicht überschreiben.
    let ignore = false;

    async function loadConversations() {
      setLoading(true);
      const {
        success,
        conversations: data,
        hasMore: more,
        totalCount: total,
      } = await Embed.getConversations(
        embedId,
        offset,
        ITEMS_PER_PAGE,
        startDate,
        endDate,
        feedbackFilter,
        bucketStart && bucketEnd
          ? { fromDay: bucketStart, toDay: bucketEnd }
          : null
      );
      if (ignore) return;

      if (success) {
        // KIE-538: Die Seite gibt es nicht mehr (ihre letzten Konversationen
        // wurden gelöscht) → zur letzten vorhandenen Seite. Nur, wenn die
        // weiter vorn liegt: Liste und Zähler sind auf dem Server zwei
        // Abfragen. Nennt der Zähler zu einer leeren Seite dieselbe Seite,
        // lädt nichts mehr nach – die Liste bliebe bei „Laden…" stehen.
        const lastOffset =
          (Math.ceil(total / ITEMS_PER_PAGE) - 1) * ITEMS_PER_PAGE;
        if ((data || []).length === 0 && total > 0 && lastOffset < offset) {
          setPage({ scope, offset: lastOffset });
          return;
        }
        setConversations(data || []);
        setHasMore(more);
        setTotalCount(total || 0);
      } else {
        showToast(t("embed-analytics.load-error"), "error");
      }
      setLoading(false);
    }

    loadConversations();
    return () => {
      ignore = true;
    };
  }, [
    embedId,
    startDate,
    endDate,
    offset,
    feedbackFilter,
    bucketStart,
    bucketEnd,
    scope,
    reloadCount,
    t,
  ]);

  // KIE-508/527: Toggles wechselseitig exklusiv, erneuter Klick hebt den
  // Filter auf.
  const toggleFilter = (mode) =>
    onFeedbackFilterChange(feedbackFilter === mode ? "all" : mode);

  const toggleBaseClass =
    "flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border transition-colors";
  const toggleInactiveClass =
    "border-white/10 text-theme-text-secondary hover:border-white/20 light:border-gray-200";

  return (
    <div>
      {/* Kopfzeile – immer sichtbar, auch im Lade- und Leer-Zustand. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="text-base font-semibold text-theme-text-primary">
            {t("embed-analytics.list.title")}
          </h3>
          {!loading && (
            <span
              data-viewable-count=""
              title={t("embed-analytics.list.viewable-hint")}
              className={`text-sm ${MUTED}`}
            >
              {t("embed-analytics.list.viewable", {
                count: totalCount,
                formatted: formatNumber(totalCount),
              })}
            </span>
          )}
          {bucket && (
            <span
              data-bucket-filter=""
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-white/10 bg-theme-settings-input-bg py-0.5 pl-3 pr-1 text-sm text-theme-text-primary"
            >
              <span className="truncate">
                {t("embed-analytics.list.only-bucket", {
                  period: bucket.label,
                })}
              </span>
              <button
                type="button"
                onClick={onClearBucket}
                aria-label={t("embed-analytics.list.clear-bucket", {
                  period: bucket.label,
                })}
                title={t("embed-analytics.list.clear-bucket", {
                  period: bucket.label,
                })}
                className="shrink-0 rounded-full p-1 hover:bg-white/10 light:hover:bg-black/10"
              >
                <X size={12} weight="bold" aria-hidden="true" />
              </button>
            </span>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {FEEDBACK_FILTERS.map(({ mode, Icon, labelKey, activeClass }) => {
            const active = feedbackFilter === mode;
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={active}
                onClick={() => toggleFilter(mode)}
                className={`${toggleBaseClass} ${active ? activeClass : toggleInactiveClass}`}
              >
                <Icon size={15} weight={active ? "fill" : "regular"} />
                {t(labelKey)}
              </button>
            );
          })}
          {/* KIE-538: Export der Auswahl, die die Liste gerade zeigt */}
          <ExportMenu
            embedId={embedId}
            startDate={startDate}
            endDate={endDate}
            feedbackFilter={feedbackFilter}
            bucket={bucket}
            disabled={loading || totalCount === 0}
            className={`${toggleBaseClass} ${toggleInactiveClass}`}
          />
        </div>
      </div>

      {loading ? (
        <div className="text-white">{t("common.loading")}</div>
      ) : conversations.length === 0 ? (
        <div className="text-white/60 text-center py-8">
          {t(EMPTY_STATE_KEYS[feedbackFilter])}
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {conversations.map((conv) => (
              <ConversationCard
                // KIE-538: Die Kennung vergibt der Besucher, zwei Sitzungen
                // können dieselbe tragen – eindeutig ist die erste Zeile.
                key={conv.first_chat_id}
                conversation={conv}
                embedId={embedId}
                onDeleted={() => setReloadCount((count) => count + 1)}
              />
            ))}
          </div>

          {/* Die Seitenleiste ist breiter als ein schmales Fenster: Sie
              scrollt dann in sich, nicht die Seite. */}
          {totalCount > 0 && (
            <div className="max-w-full overflow-x-auto">
              <Pagination
                currentPage={offset / ITEMS_PER_PAGE}
                totalPages={Math.ceil(totalCount / ITEMS_PER_PAGE)}
                onPageChange={(next) =>
                  setPage({ scope, offset: next * ITEMS_PER_PAGE })
                }
                totalItems={totalCount}
                itemsPerPage={ITEMS_PER_PAGE}
              />
            </div>
          )}
        </>
      )}

      {/* KIE-536: Das Diagramm zählt weiter, die Inhalte sind gelöscht. */}
      {showDeletedHint && !loading && !hasMore && (
        <p data-deleted-hint="" className={`mt-4 text-center text-xs ${MUTED}`}>
          {t("embed-analytics.list.deleted-hint")}
        </p>
      )}
    </div>
  );
}

function ConversationCard({ conversation, embedId, onDeleted }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState(null);
  const [loading, setLoading] = useState(false);

  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const isNew = Date.now() - conversation.started_at < FOUR_HOURS_MS;

  const handleToggle = async () => {
    if (!expanded && !messages) {
      setLoading(true);
      // KIE-538: über die erste Zeile der Karte laden (first_chat_id), nicht
      // über conversation_id oder session_id — der Detail-Abruf liefert so
      // genau die Nachrichten dieser einen Konversation, auch wenn eine
      // andere Sitzung dieselbe Kennung trägt.
      const { success, messages: data } = await Embed.getConversationDetails(
        embedId,
        conversation.first_chat_id
      );

      if (success) {
        setMessages(data || []);
      } else {
        showToast(t("embed-analytics.load-error"), "error");
      }
      setLoading(false);
    }
    setExpanded(!expanded);
  };

  const handleCopyConversationId = async (e) => {
    e.stopPropagation();
    // Erfolg erst melden, wenn die ID in der Zwischenablage ist – der Browser
    // kann das Kopieren ablehnen, ohne HTTPS fehlt navigator.clipboard.
    try {
      await navigator.clipboard.writeText(conversation.conversation_id);
    } catch {
      showToast(t("code-snippet-modal.copy-failed"), "error");
      return;
    }
    showToast(t("embed-analytics.conversations.id-copied"), "success");
  };

  return (
    <div className="border border-white/10 light:border-gray-200 rounded-lg bg-theme-bg-primary hover:border-white/20 light:hover:border-gray-400 transition-all">
      {/* Header */}
      <div className="p-4 cursor-pointer" onClick={handleToggle}>
        {/* Schmale Fenster: ID und Aufklapp-Symbol stehen über dem Inhalt
            statt daneben, sonst bleibt für ihn kein Platz. */}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              {/* Workspace Name */}
              <h3 className="text-sm font-semibold text-white truncate">
                {t("embed-analytics.conversations.conversation-number", {
                  number: conversation.conversation_number || "?",
                })}
              </h3>
              {/* NEU Badge */}
              {isNew && (
                <span className="px-2 py-0.5 text-xs font-bold bg-green-500/20 text-green-400 rounded border border-green-500/30">
                  {t("embed-analytics.conversations.new-badge")}
                </span>
              )}
              {/* KIE-508/527: Badges mit Anzahl positiver / negativer Bewertungen */}
              <FeedbackCountBadge
                count={conversation.positive_count}
                Icon={ThumbsUp}
                tone="positive"
                labelKey="embed-analytics.conversations.positive-count"
              />
              <FeedbackCountBadge
                count={conversation.negative_count}
                Icon={ThumbsDown}
                tone="negative"
                labelKey="embed-analytics.conversations.negative-count"
              />
            </div>

            {/* Preview */}
            <p className="text-xs text-theme-text-secondary mb-3 line-clamp-2 italic">
              &quot;
              {conversation.preview ||
                t("embed-analytics.conversations.no-preview")}
              &quot;
            </p>

            {/* Metadata */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-theme-text-secondary">
              <span>
                {t("embed-analytics.conversations.created")}{" "}
                {formatDateTimeDE(conversation.started_at)}
              </span>
              <span>•</span>
              <span>
                {t("embed-analytics.conversations.last-message")}{" "}
                {timeAgo(conversation.last_message_at, t)}
              </span>
              <span>•</span>
              <span>
                {t("embed-analytics.conversations.message-count", {
                  count: conversation.message_count,
                })}
              </span>
            </div>
          </div>

          {/* Right side: Conversation ID Badge + Expand Icon */}
          <div className="flex min-w-0 items-center justify-between gap-3 sm:flex-shrink-0 sm:justify-start">
            {/* Conversation ID Badge — entire badge is clickable */}
            <button
              type="button"
              className="relative z-10 flex min-w-0 items-center gap-2 bg-theme-settings-input-bg px-2 py-1 rounded border border-white/10 light:border-gray-300 cursor-pointer hover:bg-white/15 hover:border-white/30 light:hover:bg-gray-100 light:hover:border-gray-400 transition-all group"
              onClick={handleCopyConversationId}
              title={t("embed-analytics.conversations.copy-id")}
            >
              <span className="text-theme-text-secondary text-[10px] font-semibold uppercase">
                ID:
              </span>
              <span className="min-w-0 truncate text-theme-text-primary text-[10px] font-mono">
                {conversation.conversation_id}
              </span>
              <Copy
                size={12}
                weight="bold"
                className="text-theme-text-secondary group-hover:text-theme-text-primary transition-colors flex-shrink-0"
              />
            </button>

            {/* Expand Icon */}
            {expanded ? (
              <CaretUp size={20} className="text-theme-text-secondary" />
            ) : (
              <CaretDown size={20} className="text-theme-text-secondary" />
            )}
          </div>
        </div>
      </div>

      {/* Expanded Messages */}
      {expanded && (
        <div className="border-t border-white/10 light:border-gray-200 p-6 bg-theme-bg-secondary">
          {loading ? (
            <div className="text-center py-4 text-theme-text-secondary text-sm">
              {t("common.loading")}
            </div>
          ) : messages && messages.length > 0 ? (
            <div className="space-y-5">
              {messages.map((msg, idx) => (
                <div key={msg.id}>
                  {/* User Message */}
                  <div className="bg-blue-900/20 border-l-4 border-blue-400 p-4 rounded-lg mb-3 light:bg-blue-100 light:border-blue-600">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <User
                          size={18}
                          weight="fill"
                          className="text-blue-400 light:text-blue-600"
                        />
                        <h5 className="text-blue-300 text-sm font-bold uppercase light:text-blue-700">
                          {t("embed-analytics.request")}
                        </h5>
                      </div>
                      <span className="text-blue-300/60 text-xs font-mono light:text-blue-600/70">
                        {formatDateTimeDE(msg.createdAt)}
                      </span>
                    </div>
                    <p className="text-theme-text-primary text-sm leading-relaxed whitespace-pre-wrap">
                      {msg.prompt}
                    </p>
                  </div>

                  {/* Bot Response */}
                  <div className="bg-gray-800/20 border-l-4 border-gray-500 p-4 rounded-lg light:bg-gray-100 light:border-gray-400">
                    <div className="flex items-center gap-2 mb-2">
                      <ChatCircle
                        size={18}
                        weight="fill"
                        className="text-gray-400 light:text-gray-600"
                      />
                      <h5 className="text-gray-300 text-sm font-bold uppercase light:text-gray-700">
                        {t("embed-analytics.response")}
                      </h5>
                      {/* Feedback (Daumen hoch/runter) — KIE-504, read-only */}
                      {msg.feedbackScore === true && (
                        <span
                          className="inline-flex items-center"
                          title={t("embed-analytics.feedback.positive")}
                          aria-label={t("embed-analytics.feedback.positive")}
                        >
                          <ThumbsUp
                            size={16}
                            weight="fill"
                            className="text-green-500 light:text-green-600"
                          />
                        </span>
                      )}
                      {msg.feedbackScore === false && (
                        <span
                          className="inline-flex items-center"
                          title={t("embed-analytics.feedback.negative")}
                          aria-label={t("embed-analytics.feedback.negative")}
                        >
                          <ThumbsDown
                            size={16}
                            weight="fill"
                            className="text-red-500 light:text-red-600"
                          />
                        </span>
                      )}
                    </div>
                    <div className="text-theme-text-primary text-sm leading-relaxed prose prose-sm max-w-none analytics-bot-response">
                      <MarkdownRenderer
                        content={(() => {
                          try {
                            const parsed = JSON.parse(msg.response);
                            return parsed?.text || msg.response;
                          } catch {
                            return msg.response;
                          }
                        })()}
                      />
                    </div>
                    {/* KIE-507: 👎-Drill-down — Grund + Freitext des Nutzers */}
                    {msg.feedbackScore === false &&
                      (msg.feedbackReason || msg.feedbackText) && (
                        <div className="mt-3 rounded-md border border-red-400/40 bg-red-500/10 p-3 light:bg-red-50 light:border-red-200">
                          {msg.feedbackReason && (
                            <span className="inline-block text-xs font-medium px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 light:bg-red-100 light:text-red-700">
                              {msg.feedbackReason}
                            </span>
                          )}
                          {msg.feedbackText && (
                            <p
                              className={`text-sm text-theme-text-secondary italic ${msg.feedbackReason ? "mt-2" : ""}`}
                            >
                              „{msg.feedbackText}"
                            </p>
                          )}
                        </div>
                      )}
                  </div>

                  {idx < messages.length - 1 && (
                    <div className="h-0.5 bg-white/20 my-5 light:bg-gray-300"></div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-theme-text-secondary text-sm">
              {t("embed-analytics.conversations.no-messages")}
            </div>
          )}
          {/* KIE-538: „Konversation löschen" am Fuß der aufgeklappten Konversation */}
          {!loading && (
            <DeleteConversation
              embedId={embedId}
              conversation={conversation}
              onDeleted={onDeleted}
            />
          )}
        </div>
      )}
    </div>
  );
}
