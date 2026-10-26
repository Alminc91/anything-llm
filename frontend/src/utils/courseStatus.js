// Status-Seite des Kursbestands (KB-3, issues/P-kursbestand/
// KB-3-status-seite.md): was die Seite und der Punkt am Menü aus der
// Bewertung des Servers machen. Die Ampel rechnet der Server
// (GET /api/embed/course-status, server/utils/chats/courseStatus.js); hier
// stehen nur Darstellung und der gemerkte Zustand für den Menüpunkt.
import { useEffect, useState } from "react";
import Embed from "@/models/embed";

/**
 * AK-4: Seit wann der Hinweis zum Ausschließen vergangener Kurse gilt (als
 * Text, wie er auf der Seite steht).
 */
export const OPTIMIZATION_NOTICE_SINCE = "26.10.2026";

/**
 * Adresse im Schlusssatz bei Gelb und Rot (Nutzerentscheidung 26.10.2026
 * abends: support@kufer.de statt info@kufer.de).
 */
export const KUFER_CONTACT_EMAIL = "support@kufer.de";

/**
 * Farben je Zustand (Punkt, Fläche, Rand, Text) als Theme-Variablen
 * (index.css, „Status-Seite des Kursbestands“): je eine Variante für das
 * dunkle und das helle Design.
 */
const colorsOf = (state) => ({
  dot: `var(--course-status-${state}-dot)`,
  bg: `var(--course-status-${state}-bg)`,
  border: `var(--course-status-${state}-border)`,
  text: `var(--course-status-${state}-text)`,
});
export const STATE_COLORS = {
  gruen: colorsOf("gruen"),
  gelb: colorsOf("gelb"),
  rot: colorsOf("rot"),
  nicht_eingerichtet: colorsOf("nicht_eingerichtet"),
};

/** Farben des Hinweises bei den ausgeblendeten Kursen (AK-4). */
export const NOTICE_COLORS = {
  background: "var(--course-status-notice-bg)",
  color: "var(--course-status-notice-text)",
};

/**
 * AK-4: Der Hinweis „Seit 26.10.2026: …“ steht nur bei geschätztem Ende und
 * mindestens einem ausgeblendeten Kurs.
 * @param {{estimatedEnd?: boolean, counts?: {hidden?: number}|null}|null} status
 * @returns {boolean}
 */
export function showsOptimizationNotice(status) {
  return status?.estimatedEnd === true && (status?.counts?.hidden ?? 0) > 0;
}

/**
 * AK-5: Zustand für den Punkt am Menü: nur Gelb und Rot, sonst null.
 * @param {string|null} state
 * @returns {"gelb"|"rot"|null}
 */
export function menuDotState(state) {
  return state === "gelb" || state === "rot" ? state : null;
}

/**
 * Ist das Kursprogramm beim letzten Lauf auf der Website des Kunden nicht
 * abrufbar gewesen?
 * @param {{lastRun?: {cause?: string|null}|null}|null} status
 * @returns {boolean}
 */
export function isUnreachable(status) {
  return status?.lastRun?.cause === "feed_nicht_erreichbar";
}

/**
 * Überschrift der Ampel-Meldung (Fixliste KB-3 r3 Nr. 2 und 3): Grün
 * „aktuell“; Gelb und Rot nennen den Grund. Löst das Alter aus, ist das
 * Kursprogramm „nicht abrufbar“, wenn der letzte Lauf die Website nicht
 * erreicht hat, sonst „nicht aktualisiert“; sonst „unvollständig“.
 * @param {{state?: string, reasons?: string[]|null, lastRun?: object|null}} status
 * @returns {"aktuell"|"nicht-abrufbar"|"nicht-aktualisiert"|"unvollstaendig"|"nicht_eingerichtet"}
 */
export function bannerTitle(status) {
  if (status?.state === "gruen") return "aktuell";
  if (status?.state !== "gelb" && status?.state !== "rot")
    return "nicht_eingerichtet";
  if (!(status.reasons ?? []).includes("alter")) return "unvollstaendig";
  return isUnreachable(status) ? "nicht-abrufbar" : "nicht-aktualisiert";
}

/**
 * Textzeilen der Ampel-Meldung bei Gelb und Rot (Fixliste KB-3 r3 Nr. 4):
 * alle zutreffenden in der Reihenfolge „unvollständig“, „nicht
 * aktualisiert“, „nicht abrufbar“, die zur Überschrift passende zuerst. Das
 * Alter ergibt genau eine Zeile: „nicht abrufbar“ oder „nicht aktualisiert“.
 * @param {{state?: string, reasons?: string[]|null, lastRun?: object|null}} status
 * @returns {Array<"unvollstaendig"|"nicht-aktualisiert"|"nicht-abrufbar">}
 */
export function bannerDetails(status) {
  if (status?.state !== "gelb" && status?.state !== "rot") return [];
  const reasons = status.reasons ?? [];
  const age = isUnreachable(status) ? "nicht-abrufbar" : "nicht-aktualisiert";
  const details = [
    ...(reasons.includes("fehlen") ? ["unvollstaendig"] : []),
    ...(reasons.includes("alter") ? [age] : []),
  ];
  const title = bannerTitle(status);
  return [
    ...details.filter((key) => key === title),
    ...details.filter((key) => key !== title),
  ];
}

/**
 * Anteil der fehlenden Kurse in ganzen Prozent, abgerundet wie die Schwellen
 * der Ampel (4,9 % zeigt „4 %“, nie „5 %“ bei Grün); unter 1 % als „unter
 * 1 %“.
 * @param {{offered: number, missing: number}} counts
 * @returns {{value: number}|{small: true}|null} null ohne fehlende Kurse
 */
export function missingShare({ offered, missing }) {
  if (!(missing > 0) || !(offered > 0)) return null;
  const value = Math.floor((missing / offered) * 100);
  return value < 1 ? { small: true } : { value };
}

// Kalendertag und Uhrzeit in Berliner Zeit
const berlinDay = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const berlinTime = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
});
// Ein Kalendertag ohne Zeitzone, im selben Format wie berlinDay
const plainDay = new Intl.DateTimeFormat("de-DE", {
  timeZone: "UTC",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/**
 * Berliner Kalendertag von now, um days Tage verschoben („TT.MM.JJJJ“). Nach
 * Kalendertagen, nicht ± 24 h: Die Tage der Zeitumstellung haben 23 oder
 * 25 Stunden.
 * @param {number} now
 * @param {number} days
 * @returns {string}
 */
function berlinDayShifted(now, days) {
  const [d, m, y] = berlinDay.format(now).split(".").map(Number);
  return plainDay.format(Date.UTC(y, m - 1, d + days));
}

/**
 * Zeitpunkt eines Abgleichs: „heute, 10:00 Uhr“, „gestern, 10:00 Uhr“,
 * „morgen, …“ oder „24.10., 10:00 Uhr“ (anderes Jahr mit Jahr), in Berliner
 * Zeit; nach „seit“ (formatSyncedAt) als „dem 24.10., …“.
 * Ohne gültigen Zeitpunkt „k. A.“.
 * @param {(key: string, options?: object) => string} t
 * @param {string|number|null} at
 * @param {number} [now]
 * @param {string} [dateKey]
 * @returns {string}
 */
export function formatRunTime(
  t,
  at,
  now = Date.now(),
  dateKey = "course-status.on-date"
) {
  const ms = typeof at === "number" ? at : Date.parse(at ?? "");
  if (!Number.isFinite(ms)) return t("course-status.none");
  const day = berlinDay.format(ms);
  const time = berlinTime.format(ms);
  if (day === berlinDay.format(now)) return t("course-status.today", { time });
  if (day === berlinDayShifted(now, -1))
    return t("course-status.yesterday", { time });
  if (day === berlinDayShifted(now, 1))
    return t("course-status.tomorrow", { time });
  const [d, m, y] = day.split(".");
  const date = y === berlinDay.format(now).split(".")[2] ? `${d}.${m}.` : day;
  return t(dateKey, { date, time });
}

/**
 * Letzter erfolgreicher Abgleich nach „seit“ („Das Kursprogramm wurde seit …
 * nicht aktualisiert.“): wie formatRunTime, ein Datum als „dem 24.10.,
 * 10:00 Uhr“.
 * @param {(key: string, options?: object) => string} t
 * @param {string|null} at
 * @param {number} [now]
 * @returns {string}
 */
export function formatSyncedAt(t, at, now = Date.now()) {
  return formatRunTime(t, at, now, "course-status.since-date");
}

/**
 * Nächster Abgleich: stündlich, eine Stunde nach dem letzten; liegt das
 * zurück, ist er ausstehend.
 * @param {(key: string, options?: object) => string} t
 * @param {string|null} lastAt
 * @param {number} [now]
 * @returns {string}
 */
export function formatNextRun(t, lastAt, now = Date.now()) {
  const last = Date.parse(lastAt ?? "");
  if (!Number.isFinite(last)) return t("course-status.none");
  const next = last + 60 * 60 * 1000;
  return next < now
    ? t("course-status.sync.pending")
    : formatRunTime(t, next, now);
}

/**
 * Beginn und Dauer eines ausgeblendeten Kurses: „ab 02.09., 6 Termine“,
 * bei einem Termin ohne „ab“; fehlt beides „k. A.“.
 * @param {(key: string, options?: object) => string} t
 * @param {{start?: string|null, duration?: string|null}} entry
 * @param {number} [now]
 * @returns {string}
 */
export function hiddenWhen(
  t,
  { start = null, duration = null },
  now = Date.now()
) {
  let date = null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start ?? "");
  if (match) {
    const [, y, m, d] = match;
    const thisYear = berlinDay.format(now).split(".")[2];
    date = y === thisYear ? `${d}.${m}.` : `${d}.${m}.${y}`;
  }
  const single = /^1\s/.test(duration ?? "");
  const parts = [];
  if (date)
    parts.push(single ? date : t("course-status.hidden.from", { date }));
  if (duration) parts.push(duration);
  return parts.length > 0 ? parts.join(", ") : t("course-status.none");
}

// AK-5: zuletzt geladener Zustand für den Punkt am Menü. Jede Seite der
// Einstellungen hängt die Seitenleiste neu ein und fragt neu (gemerkt wird
// nur auf dem Server, 5 min je Workspace); bis zur Antwort steht der zuletzt
// geladene Zustand da, damit der Punkt nicht flackert.
let lastDotState = null;

/**
 * Zustand für den Punkt am Menü (AK-5): bei jedem Einhängen neu abgefragt;
 * null ohne Punkt oder bei einem Fehler.
 * @returns {"gelb"|"rot"|null}
 */
export function useCourseStatusDot() {
  const [state, setState] = useState(lastDotState);
  useEffect(() => {
    let ignore = false;
    Embed.courseStatusState().then((value) => {
      lastDotState = menuDotState(value);
      if (!ignore) setState(lastDotState);
    });
    return () => {
      ignore = true;
    };
  }, []);
  return state;
}
