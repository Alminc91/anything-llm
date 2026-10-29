import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "@phosphor-icons/react";
import Embed from "@/models/embed";
import { formatNumber } from "@/utils/analyticsTimeline";
import { AVATAR_CLEARANCE, MUTED } from "@/utils/conversationView";
import {
  KUFER_CONTACT_EMAIL,
  OPTIMIZATION_NOTICE_SINCE,
  STATE_COLORS,
  formatRunTime,
  formatSyncedAt,
  hiddenWhen,
  showsOptimizationNotice,
} from "@/utils/courseStatus";
import { ELEMENT_MARK, withElement } from "@/utils/withElement";
import { WidgetPicker, useWidgetSelection } from "../WidgetSelection";
import NotifyCard, { useCourseStatusNotify } from "./NotifyCard";

// Seite „Status“ (KB-3, Mockup Tafel 3, Ampel nach Nutzerentscheidung vom
// 26.10.2026): ob der KI-Berater das Kursprogramm vollständig kennt, und wenn
// nicht, was fehlt und was ausgeblendet ist. Wenige, ruhige Meldungen, Wortlaut
// nach Fixliste KB-3 r3 und r4. Ein Status je Kursprogramm (Workspace),
// gewählt über die gemeinsame Widget-Auswahl (KB-2). Überschrift, Zeilen,
// Anteil und ob der Chat die Kursliste anwendet liefert der Server (Vertrag
// r4), die Seite liest sie nur ab. Nur lesend: Die Seite
// hat außer der Widget-Auswahl, dem Aufklappen der Listen und dem Mail-Link
// keine Bedienelemente (NAK-3). Kopf, Grundsatz, Liste „Ausgeblendete Kurse“
// und Hinweis unten nach Fixliste r8; die Karte „Abgleich“ ist entfallen.
// KB-10 Teil 2: Einzige Ausnahme ist die Karte „Benachrichtigung per
// E-Mail“ (NotifyCard.jsx) mit Schalter, Empfängern und „Speichern“.

// So viele Einträge je Liste, bevor „Alle … anzeigen“ aufklappt
const LIST_PREVIEW = 5;
const CARD =
  "rounded-xl border border-white/10 bg-theme-bg-primary text-theme-text-primary";

/**
 * @param {{embeds: Array<object>, lastActivity?: Array<object>|null}} props -
 *   die sichtbaren Widgets (mindestens eines) und ihre letzte Nachricht
 */
export default function CourseStatusView({ embeds, lastActivity = null }) {
  const { t, i18n } = useTranslation();
  const { widgetId, unknownLink, selectWidget } = useWidgetSelection({
    embeds,
    lastActivity,
  });
  const [result, setResult] = useState({ widgetId: null, status: null });

  useEffect(() => {
    if (!widgetId || unknownLink) return;
    let ignore = false;
    Embed.courseStatus(widgetId).then((data) => {
      if (ignore) return;
      const valid = data && !data.notFound && typeof data.state === "string";
      setResult({ widgetId, status: valid ? data : null });
    });
    return () => {
      ignore = true;
    };
  }, [widgetId, unknownLink]);

  // KB-10 Teil 2: Benachrichtigung einmal je Seite laden, parallel zum
  // Status (gleich nach ihm angestoßen); sie gilt für die Instanz, nicht je
  // Widget. Hier gehalten, damit ein Widget-Wechsel die Karte nicht neu
  // lädt und Eingaben stehen bleiben
  const notify = useCourseStatusNotify();

  const loading = result.widgetId !== widgetId;
  const status = loading ? null : result.status;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-2 md:p-6">
      {/* Kopfzeile wie bei Konversationen (Fixliste r4 Nr. 9): Überschrift
          links, Widget-Auswahl oben rechts; darunter Arbeitsbereich mit
          Widgets, Grundsatz und letzter Abgleich über die ganze Breite */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-bold text-theme-text-primary">
            {t("course-status.title")}
          </h2>
          <div className={AVATAR_CLEARANCE.headerEnd}>
            <WidgetPicker
              embeds={embeds}
              selectedId={widgetId}
              onSelect={selectWidget}
            />
          </div>
        </div>
        {status?.workspace && (
          <p data-course-status-program="" className={`text-sm ${MUTED}`}>
            {programLine(t, status, i18n.language)}
          </p>
        )}
        {/* Nicht eingerichtet: kein Grundsatz, er widerspräche der Meldung
            (Fixliste r4 Nr. 8). KB-9: Ohne Kurse (der Abgleich hat noch
            nie eine Liste geliefert) gab es keinen erfolgreichen Abgleich,
            syncedAt ist dann die erste Störung und steht nur im Satz
            „seit …“ der Meldung. Auch der Grundsatz entfällt dann, er
            widerspräche der Störung (Fixliste KB-9 r2 Nr. 1) */}
        {status &&
          status.state !== "nicht_eingerichtet" &&
          hasCourses(status) && (
            <>
              <p data-course-principle="" className={`text-sm ${MUTED}`}>
                {t("course-status.principle")}
              </p>
              <p data-course-last-sync="" className={`text-sm ${MUTED}`}>
                {t("course-status.last-sync", {
                  time: formatRunTime(t, status.syncedAt),
                })}
              </p>
            </>
          )}
      </div>

      {loading ? (
        <p className="text-theme-text-primary">{t("common.loading")}</p>
      ) : status ? (
        <StatusBody status={status} notify={notify} />
      ) : (
        <p role="alert" className="text-theme-text-primary">
          {t("course-status.load-failed")}
        </p>
      )}
    </div>
  );
}

/**
 * „Arbeitsbereich „<Name>“ · Widgets: Widget 3 und Widget 9“, bei einem
 * Widget „· Widget: Widget 3“ (Fixliste r8 Nr. 1). Alle Widgets liegen im
 * selben Arbeitsbereich; sie heißen deshalb wie in der Widget-Auswahl ohne
 * den vorangestellten Arbeitsbereich, also nach ihrer Nummer.
 */
function programLine(t, status, language) {
  const workspace = t("course-status.workspace", {
    name: status.workspace.name,
  });
  const names = (status.widgets ?? []).map((widget) =>
    t("embed-analytics.embed-label.unnamed", { id: widget.id })
  );
  if (names.length === 0) return workspace;
  const widgets =
    names.length === 1
      ? t("course-status.widget", { name: names[0] })
      : t("course-status.widgets", {
          names: listFormat(language).format(names),
        });
  return `${workspace} · ${widgets}`;
}

// Aufzählung der Sprache („A, B und C“); unbekannte Sprache: die des Systems
function listFormat(language) {
  try {
    return new Intl.ListFormat(language, { type: "conjunction" });
  } catch {
    return new Intl.ListFormat(undefined, { type: "conjunction" });
  }
}

/**
 * KB-9: Gibt es Kurse im Kursprogramm? Nein bei der Störungsmeldung ohne
 * Liste (der Abgleich hat noch nie eine Liste geliefert, counts 0).
 */
function hasCourses(status) {
  return (status?.counts?.offered ?? 0) > 0;
}

function StatusBody({ status, notify }) {
  const { t } = useTranslation();
  if (status.state === "nicht_eingerichtet") return <Banner status={status} />;
  // Ausgeblendet liefert der Server nur, solange der Chat die Kursliste
  // anwendet (Fixliste r7 Nr. 1); die Seite zeigt ab, was kommt
  const showsHidden = status.counts.hidden > 0;
  return (
    <>
      <Banner status={status} />
      {/* KB-9: ohne Kurse keine leeren Kennzahlen; Listen und Hinweis
          entfallen ohnehin (counts 0) */}
      {hasCourses(status) && <Counts status={status} />}
      {(status.counts.missing > 0 || showsHidden) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {status.counts.missing > 0 && <MissingList status={status} />}
          {showsHidden && <HiddenList status={status} />}
        </div>
      )}
      {/* KB-10 Teil 2: Benachrichtigung per E-Mail unten, vor der
          Fußnote; nur, wenn der Kursbestand eingerichtet ist (oben
          zurückgekehrt) */}
      <NotifyCard notify={notify} />
      {/* Fixliste r8 Nr. 5: dezente Zeile ganz unten */}
      {showsOptimizationNotice(status) && (
        <p
          data-course-notice=""
          className={`flex items-center gap-2 text-xs ${MUTED}`}
        >
          <Info aria-hidden="true" className="h-4 w-4 flex-none" />
          {t("course-status.notice", { date: OPTIMIZATION_NOTICE_SINCE })}
        </p>
      )}
    </>
  );
}

/**
 * Meldung der Ampel (Fixliste KB-3 r3): Statusangabe als Text („In Ordnung“,
 * „Eingeschränkt“, „Gestört“, mindestens 14 px, Fixliste r4 Nr. 10),
 * darunter die Überschrift mit dem Grund (headline des Servers). Grün nennt,
 * wie viele Kurse im KI-Berater verfügbar sind; Gelb und Rot nennen je Grund
 * eine Zeile (details des Servers) und zum Schluss die Adresse für Fragen.
 */
function Banner({ status }) {
  const { t } = useTranslation();
  const state = STATE_COLORS[status.state]
    ? status.state
    : "nicht_eingerichtet";
  const colors = STATE_COLORS[state];
  return (
    <div
      data-course-status-banner={state}
      className="flex items-start gap-3 rounded-xl border px-4 py-4"
      style={{ background: colors.bg, borderColor: colors.border }}
    >
      <span
        aria-hidden="true"
        className="mt-1 h-3.5 w-3.5 flex-none rounded-full"
        style={{ background: colors.dot }}
      />
      <div
        className="flex flex-col gap-1 text-sm leading-normal"
        style={{ color: colors.text }}
      >
        {state !== "nicht_eingerichtet" && (
          <p data-course-status-level={state} className="text-sm font-semibold">
            {t(`course-status.banner.level.${state}`)}
          </p>
        )}
        <h3 className="text-base font-bold">
          {t(`course-status.banner.title.${status.headline ?? state}`)}
        </h3>
        <BannerLines status={status} state={state} />
      </div>
    </div>
  );
}

function BannerLines({ status, state }) {
  const { t } = useTranslation();
  if (state === "nicht_eingerichtet")
    return <p>{t("course-status.banner.not-set-up")}</p>;
  const counts = status.counts ?? {};
  const missing = counts.missing ?? 0;
  const offered = formatNumber(counts.offered ?? 0);
  if (state === "gruen")
    return missing > 0 ? (
      <p data-course-available="">
        {t("course-status.banner.available", {
          available: formatNumber(counts.count ?? 0),
          offered,
        })}{" "}
        {t("course-status.banner.pending", {
          count: missing,
          number: formatNumber(missing),
        })}
      </p>
    ) : (
      <p data-course-available="">
        {t("course-status.banner.all-available", {
          count: counts.offered ?? 0,
          number: offered,
        })}
      </p>
    );
  const time = formatSyncedAt(t, status.syncedAt);
  const lines = {
    unvollstaendig: () =>
      t("course-status.banner.missing", {
        count: missing,
        number: formatNumber(missing),
        offered,
      }),
    nicht_aktualisiert: () => t("course-status.banner.not-updated", { time }),
    nicht_abrufbar: () => t("course-status.banner.unreachable", { time }),
  };
  const unreachable = status.headline === "nicht_abrufbar";
  return (
    <>
      {(status.details ?? [])
        .filter((key) => lines[key])
        .map((key) => (
          <p key={key} data-course-detail={key}>
            {lines[key]()}
          </p>
        ))}
      {/* D-r6-3: Hinweiszeile nur nach notice vom Server */}
      {status.notice === "liste_nicht_angewendet" && (
        <p data-course-list-not-applied="">
          {t("course-status.banner.list-not-applied")}
        </p>
      )}
      <p data-course-contact={unreachable ? "nicht_abrufbar" : "standard"}>
        {withElement(
          t(
            `course-status.banner.${unreachable ? "closing-unreachable" : "closing"}`,
            { email: ELEMENT_MARK }
          ),
          <a
            href={`mailto:${KUFER_CONTACT_EMAIL}`}
            className="font-semibold underline underline-offset-2"
          >
            {KUFER_CONTACT_EMAIL}
          </a>
        )}
      </p>
    </>
  );
}

/**
 * Kennzahlen: im Kursprogramm, im KI-Berater, fehlen (mit dem Anteil
 * missingPercent des Servers, unter 1 % als „unter 1 %“), ausgeblendet (nur
 * solange der Chat die Kursliste anwendet, Fixliste r4 Nr. 2).
 */
function Counts({ status }) {
  const { t } = useTranslation();
  const { counts } = status;
  const percent = status.missingPercent ?? 0;
  const fields = [
    { key: "offered", value: formatNumber(counts.offered) },
    { key: "count", value: formatNumber(counts.count) },
    {
      key: "missing",
      value: formatNumber(counts.missing),
      detail:
        counts.missing > 0
          ? percent < 1
            ? t("course-status.kpi.share-small")
            : t("course-status.kpi.share", { value: percent })
          : null,
      accent: counts.missing > 0 ? STATE_COLORS[status.state]?.dot : null,
    },
    ...(counts.hidden > 0
      ? [{ key: "hidden", value: formatNumber(counts.hidden) }]
      : []),
  ];
  return (
    <dl
      className={`grid grid-cols-2 gap-3 ${fields.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}
    >
      {fields.map((field) => (
        <div
          key={field.key}
          data-course-kpi={field.key}
          className={`${CARD} min-w-0 px-4 py-3`}
          style={field.accent ? { borderColor: field.accent } : undefined}
        >
          <dt className={`text-sm ${MUTED}`}>
            {t(`course-status.kpi.${field.key}`)}
          </dt>
          <dd className="mt-1 text-2xl font-bold">
            {field.value}
            {field.detail && (
              <span className="ml-1 text-sm font-semibold">{field.detail}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Eine Liste mit den ersten Einträgen; „Alle … anzeigen“ klappt die
 * geladenen auf (höchstens 500, darüber ein Hinweis mit der Gesamtzahl).
 */
function CourseList({ name, heading, total, items, renderRow }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, LIST_PREVIEW);
  return (
    <section
      data-course-list={name}
      aria-label={t(`course-status.${name}.label`)}
      className={`${CARD} overflow-hidden`}
    >
      <div className="flex flex-col gap-1 border-b border-white/10 px-4 py-3">
        {heading}
      </div>
      <ul>
        {shown.map((item, i) => (
          // KB-10 r1 (Mockup Variante D): am Handy Kursnummer 82 px und
          // 10 px Abstand, damit der Titel Platz hat (längste Kursnummern
          // wie „I600015-D“ etwa 74 px); ab sm unverändert. Trennlinie im
          // hellen Design hellgrau wie im Mockup, dunkel unverändert
          <li
            key={`${item.knr}-${i}`}
            className="grid grid-cols-[82px_minmax(0,1fr)] gap-x-2.5 border-b border-white/5 px-4 py-2 text-sm light:border-gray-100 sm:grid-cols-[110px_minmax(0,1fr)_auto] sm:gap-x-3"
          >
            {renderRow(item)}
          </li>
        ))}
      </ul>
      {open && total > items.length && (
        <p className={`px-4 py-2 text-sm ${MUTED}`}>
          {t("course-status.list.truncated", {
            shown: formatNumber(items.length),
            count: formatNumber(total),
          })}
        </p>
      )}
      {items.length > LIST_PREVIEW && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="px-4 py-2 text-left text-sm underline underline-offset-2 hover:text-theme-text-primary"
        >
          {open
            ? t("course-status.list.show-less")
            : t("course-status.list.show-all", { count: formatNumber(total) })}
        </button>
      )}
    </section>
  );
}

function MissingList({ status }) {
  const { t } = useTranslation();
  const total = status.counts.missing;
  return (
    <CourseList
      name="missing"
      total={total}
      items={status.missing}
      heading={
        <h3 className="text-base font-semibold">
          {t("course-status.missing.title", { count: formatNumber(total) })}
        </h3>
      }
      renderRow={(item) => (
        <>
          <span className={MUTED}>{item.knr}</span>
          <span className="min-w-0 break-words sm:col-span-2">
            {item.title ?? t("course-status.none")}
          </span>
        </>
      )}
    />
  );
}

function HiddenList({ status }) {
  const { t } = useTranslation();
  const total = status.counts.hidden;
  return (
    <CourseList
      name="hidden"
      total={total}
      items={status.hidden}
      heading={
        <>
          <h3 className="text-base font-semibold">
            {t("course-status.hidden.title", { count: formatNumber(total) })}
          </h3>
          <p
            data-course-hidden-description=""
            className={`mt-1 text-sm leading-normal ${MUTED}`}
          >
            {t("course-status.hidden.description")}
          </p>
        </>
      }
      renderRow={(item) => (
        <>
          <span className={MUTED}>{item.knr}</span>
          <span className="min-w-0 break-words">
            {/* KB-8: Titel als Link zur Kursseite, nur mit url vom Server
                (geprüft, nur http/https) */}
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                data-course-hidden-link=""
                className="text-sky-300 underline underline-offset-2 hover:no-underline light:text-sky-700"
              >
                {item.title ?? t("course-status.none")}
              </a>
            ) : (
              (item.title ?? t("course-status.none"))
            )}
          </span>
          <span className={`col-start-2 sm:col-start-auto ${MUTED}`}>
            {hiddenWhen(t, item)}
          </span>
          {/* KB-10 (Mockup Tafel 1, Variante D): Beginnt der Kurs heute
              oder später, ist er nicht beendet, steht aber nicht mehr auf
              der Website. Eigene Zeile über alle Spalten; ob, sagt der
              Server (offWebsite), die Seite rechnet nicht selbst */}
          {item.offWebsite === true && (
            <p
              data-course-off-website=""
              className="col-span-full mt-1 flex items-start gap-1.5 text-[13px] font-semibold leading-normal text-amber-300 light:text-amber-800"
            >
              {/* r1: Symbol an der ersten Textzeile (Zeilenhöhe 19,5 px,
                  Symbol 16 px), auch wenn der Satz am Handy umbricht */}
              <Info aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none" />
              <span>{t("course-status.hidden.off-website")}</span>
            </p>
          )}
        </>
      )}
    />
  );
}
