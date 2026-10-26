import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Embed from "@/models/embed";
import { embedLabels } from "@/utils/embedLabel";
import { formatNumber } from "@/utils/analyticsTimeline";
import { AVATAR_CLEARANCE, MUTED } from "@/utils/conversationView";
import {
  KUFER_CONTACT_EMAIL,
  NOTICE_COLORS,
  OPTIMIZATION_NOTICE_SINCE,
  STATE_COLORS,
  bannerDetails,
  bannerTitle,
  formatNextRun,
  formatRunTime,
  formatSyncedAt,
  hiddenWhen,
  missingShare,
  showsOptimizationNotice,
} from "@/utils/courseStatus";
import { WidgetPicker, useWidgetSelection } from "../WidgetSelection";

// Seite „Status“ (KB-3, Mockup Tafel 3, Ampel nach Nutzerentscheidung vom
// 26.10.2026): ob der KI-Berater das Kursprogramm vollständig kennt, und wenn
// nicht, was fehlt und was ausgeblendet ist. Wenige, ruhige Meldungen, Wortlaut
// nach Fixliste KB-3 r3. Ein Status je Kursprogramm (Workspace),
// gewählt über die gemeinsame Widget-Auswahl (KB-2). Nur lesend: Die Seite
// hat außer der Widget-Auswahl, dem Aufklappen der Listen und dem Mail-Link
// keine Bedienelemente (NAK-3).

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

  const labels = useMemo(() => embedLabels(embeds, t), [embeds, t]);
  const loading = result.widgetId !== widgetId;
  const status = loading ? null : result.status;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-2 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-2xl font-bold text-theme-text-primary">
            {t("course-status.title")}
          </h2>
          {status?.workspace && (
            <p data-course-status-program="" className={`text-sm ${MUTED}`}>
              {programLine(t, status, labels, i18n.language)}
            </p>
          )}
          <p className={`text-sm ${MUTED}`}>{t("course-status.principle")}</p>
        </div>
        <div className={AVATAR_CLEARANCE.headerEnd}>
          <WidgetPicker
            embeds={embeds}
            selectedId={widgetId}
            onSelect={selectWidget}
          />
        </div>
      </div>

      {loading ? (
        <p className="text-theme-text-primary">{t("common.loading")}</p>
      ) : status ? (
        <StatusBody status={status} />
      ) : (
        <p role="alert" className="text-theme-text-primary">
          {t("course-status.load-failed")}
        </p>
      )}
    </div>
  );
}

/**
 * „Kursprogramm: <Name>“, bei mehreren Widgets dieses Kursprogramms dazu
 * „· gilt für die Widgets „A“ und „B““.
 */
function programLine(t, status, labels, language) {
  const program = t("course-status.program", { name: status.workspace.name });
  const widgets = status.widgets ?? [];
  if (widgets.length < 2) return program;
  const names = widgets.map((widget) =>
    t("course-status.quoted", {
      name: labels.get(widget.id)?.label ?? widget.name,
    })
  );
  const list = listFormat(language).format(names);
  return `${program} · ${t("course-status.applies-to", { widgets: list })}`;
}

// Aufzählung der Sprache („A, B und C“); unbekannte Sprache: die des Systems
function listFormat(language) {
  try {
    return new Intl.ListFormat(language, { type: "conjunction" });
  } catch {
    return new Intl.ListFormat(undefined, { type: "conjunction" });
  }
}

function StatusBody({ status }) {
  if (status.state === "nicht_eingerichtet") return <Banner status={status} />;
  return (
    <>
      <Banner status={status} />
      <Counts status={status} />
      {(status.counts.missing > 0 || status.counts.hidden > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {status.counts.missing > 0 && <MissingList status={status} />}
          {status.counts.hidden > 0 && <HiddenList status={status} />}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SyncCard status={status} />
      </div>
    </>
  );
}

/**
 * Meldung der Ampel (Fixliste KB-3 r3): Statusangabe als Text („In Ordnung“,
 * „Eingeschränkt“, „Gestört“), darunter die Überschrift mit dem Grund. Grün
 * nennt, wie viele Kurse im KI-Berater verfügbar sind; Gelb und Rot nennen je
 * Grund eine Zeile und zum Schluss die Adresse für Fragen.
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
          <p data-course-status-level={state} className="text-xs font-semibold">
            {t(`course-status.banner.level.${state}`)}
          </p>
        )}
        <h3 className="text-base font-bold">
          {t(`course-status.banner.title.${bannerTitle({ ...status, state })}`)}
        </h3>
        <BannerLines status={status} state={state} />
      </div>
    </div>
  );
}

// Platzhalter für die Adresse im Schlusssatz ({{email}} in den
// Sprachdateien), an dessen Stelle der Mail-Link steht
const EMAIL_MARK = "\u0000";

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
    "nicht-aktualisiert": () => t("course-status.banner.not-updated", { time }),
    "nicht-abrufbar": () => t("course-status.banner.unreachable", { time }),
  };
  const unreachable = bannerTitle(status) === "nicht-abrufbar";
  const [before, after = ""] = t(
    `course-status.banner.${unreachable ? "closing-unreachable" : "closing"}`,
    { email: EMAIL_MARK }
  ).split(EMAIL_MARK);
  return (
    <>
      {bannerDetails(status).map((key) => (
        <p key={key} data-course-detail={key}>
          {lines[key]()}
        </p>
      ))}
      <p data-course-contact={unreachable ? "nicht-abrufbar" : "standard"}>
        {before}
        <a
          href={`mailto:${KUFER_CONTACT_EMAIL}`}
          className="font-semibold underline underline-offset-2"
        >
          {KUFER_CONTACT_EMAIL}
        </a>
        {after}
      </p>
    </>
  );
}

/** Kennzahlen: im Kursprogramm, im KI-Berater, fehlen, ausgeblendet. */
function Counts({ status }) {
  const { t } = useTranslation();
  const { counts } = status;
  const share = missingShare(counts);
  const fields = [
    { key: "offered", value: formatNumber(counts.offered) },
    { key: "count", value: formatNumber(counts.count) },
    {
      key: "missing",
      value: formatNumber(counts.missing),
      detail: share
        ? share.small
          ? t("course-status.kpi.share-small")
          : t("course-status.kpi.share", { value: share.value })
        : null,
      accent: counts.missing > 0 ? STATE_COLORS[status.state]?.dot : null,
    },
    { key: "hidden", value: formatNumber(counts.hidden) },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
          <li
            key={`${item.knr}-${i}`}
            className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 border-b border-white/5 px-4 py-2 text-sm sm:grid-cols-[110px_minmax(0,1fr)_auto]"
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
          {status.estimatedEnd && (
            <p
              data-course-estimated=""
              className={`text-sm leading-normal ${MUTED}`}
            >
              {t("course-status.hidden.estimated")}
            </p>
          )}
          {showsOptimizationNotice(status) && (
            <p
              data-course-notice=""
              className="mt-1 self-start rounded-lg px-3 py-1 text-xs font-semibold"
              style={NOTICE_COLORS}
            >
              {t("course-status.hidden.notice", {
                date: OPTIMIZATION_NOTICE_SINCE,
              })}
            </p>
          )}
        </>
      }
      renderRow={(item) => (
        <>
          <span className={MUTED}>{item.knr}</span>
          <span className="min-w-0 break-words">
            {item.title ?? t("course-status.none")}
          </span>
          <span className={`col-start-2 sm:col-start-auto ${MUTED}`}>
            {hiddenWhen(t, item)}
          </span>
        </>
      )}
    />
  );
}

/** Abgleich: letzter, nächster, was Besucher sehen. */
function SyncCard({ status }) {
  const { t } = useTranslation();
  const run = status.lastRun;
  const rows = [
    ["last", formatRunTime(t, run?.at)],
    ["next", formatNextRun(t, run?.at)],
  ];
  rows.push([
    "visitors",
    status.visitors
      ? t("course-status.sync.visitors-count", {
          count: formatNumber(status.visitors.count),
          word: status.visitors.word,
        })
      : t("course-status.sync.visitors-none"),
  ]);
  return (
    <section
      data-course-sync=""
      className={`${CARD} flex flex-col gap-2 px-4 py-3 text-sm`}
    >
      <h3 className="text-base font-semibold">
        {t("course-status.sync.title")}
      </h3>
      <dl className="flex flex-col gap-2">
        {rows.map(([key, value]) => (
          <div key={key} className="flex justify-between gap-3">
            <dt className={MUTED}>{t(`course-status.sync.${key}`)}</dt>
            <dd className="text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
