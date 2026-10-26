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
 * Adresse, unter der die Einrichtung Kufer bei Gelb und Rot direkt Bescheid
 * geben kann (Nutzerentscheidung 26.10.2026).
 */
export const KUFER_CONTACT_EMAIL = "info@kufer.de";

/** Zustände der Ampel; dazu „nicht_eingerichtet“ (grau, ohne Punkt). */
export const STATES = ["gruen", "gelb", "rot", "nicht_eingerichtet"];

// Farben wie im Mockup (Tafel 3): Punkt, Fläche, Rand, Text
export const STATE_COLORS = {
  gruen: { dot: "#1E7F4F", bg: "#E3F1EA", border: "#B5DCC6", text: "#155E3B" },
  gelb: { dot: "#D9961A", bg: "#FDF1DC", border: "#F1D29A", text: "#5C3705" },
  rot: { dot: "#B42318", bg: "#FDE7E5", border: "#F3B8B2", text: "#8E1B12" },
  nicht_eingerichtet: {
    dot: "#5B646C",
    bg: "#F3F4F6",
    border: "#DDE2E5",
    text: "#3D454D",
  },
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
 * abrufbar gewesen? Dann steht bei Gelb und Rot ein eigener Schlusssatz.
 * @param {{lastRun?: {cause?: string|null}|null}|null} status
 * @returns {boolean}
 */
export function isUnreachable(status) {
  return status?.lastRun?.cause === "feed_nicht_erreichbar";
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
 * Zeit; im Satz (formatSyncedAt) als „am 24.10., …“.
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
 * Letzter erfolgreicher Abgleich im Satz „Der letzte erfolgreiche Abgleich
 * war …“: wie formatRunTime, ein Datum als „am 24.10., 10:00 Uhr“.
 * @param {(key: string, options?: object) => string} t
 * @param {string|null} at
 * @param {number} [now]
 * @returns {string}
 */
export function formatSyncedAt(t, at, now = Date.now()) {
  return formatRunTime(t, at, now, "course-status.on-date-at");
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

// AK-5: Zustand für den Menüpunkt, im Browser höchstens so lange gemerkt.
// Jede Seite der Einstellungen hängt die Seitenleiste neu ein: Ein schon
// geladener Zustand steht deshalb sofort da, ohne erneute Abfrage.
export const STATE_CACHE_MS = 5 * 60 * 1000;
let stateCache = null;

const fresh = (now) =>
  !!stateCache &&
  now - stateCache.at >= 0 &&
  now - stateCache.at < STATE_CACHE_MS;

/**
 * Zustand für den Punkt am Menü (schlechtester der sichtbaren Widgets), 5 min
 * gemerkt; bei einem Fehler null.
 * @param {number} [now]
 * @returns {Promise<string|null>}
 */
export function loadCourseStatusState(now = Date.now()) {
  if (fresh(now)) return stateCache.promise;
  const entry = { at: now, promise: null, value: undefined };
  entry.promise = Embed.courseStatusState().then((value) => {
    entry.value = value;
    return value;
  });
  stateCache = entry;
  return entry.promise;
}

/** Nur für Tests: vergisst den gemerkten Zustand. */
export function resetCourseStatusState() {
  stateCache = null;
}

/**
 * Zustand für den Punkt am Menü (AK-5): ein gemerkter sofort, sonst nach dem
 * Laden; null ohne Punkt oder wenn die Abfrage aus ist.
 * @param {boolean} enabled
 * @returns {"gelb"|"rot"|null}
 */
export function useCourseStatusDot(enabled) {
  const [state, setState] = useState(() =>
    enabled && fresh(Date.now()) ? menuDotState(stateCache.value) : null
  );
  useEffect(() => {
    if (!enabled) return;
    let ignore = false;
    loadCourseStatusState().then((value) => {
      if (!ignore) setState(menuDotState(value));
    });
    return () => {
      ignore = true;
    };
  }, [enabled]);
  return state;
}
