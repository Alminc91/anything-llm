// KB-3 (issues/P-kursbestand/KB-3-status-seite.md, Nutzerentscheidung Ampel
// vom 26.10.2026, fixliste-kb3-r1.md): Ampel des Kursbestands je Workspace
// (Kursprogramm), eine Quelle für Status-Seite, Menüpunkt und Mail (KB-5,
// D-KB3-1). Nur lesend: Kursliste und Index kommen aus courseInventory.js
// (courseInventoryDetails), geschrieben wird nichts.
//
// Ampel (es zählt die schlechtere der beiden Bewertungen):
//   Grün  unter 5 % fehlen und letzter erfolgreicher Abgleich jünger als 24 h.
//   Gelb  5 % bis einschließlich 10 % fehlen, oder Abgleich 24 h bis 72 h alt.
//   Rot   über 10 % fehlen, oder Abgleich älter als 72 h.
// Alter des Abgleichs: der jüngere Zeitpunkt aus created und run.at eines
// Laufs mit result "ok" (Version 1: created, E-KB3-1). Ein Lauf mit Störung
// schreibt keine neue Liste (KB-4, D-KB4-2) und verjüngt den Stand deshalb
// nicht.
//
// Ohne gültige Kursliste oder ohne angebotenen Kurs im Workspace gilt
// „nicht eingerichtet“ (D-KB3-3).

const { courseInventoryDetails } = require("./courseInventory");

// Schwellen der Ampel (anfangs locker, später strenger)
const HOUR_MS = 60 * 60 * 1000;
const MISSING_YELLOW_PERCENT = 5; // ab 5 % gelb
const MISSING_RED_PERCENT = 10; // über 10 % rot
const AGE_YELLOW_MS = 24 * HOUR_MS; // ab 24 h gelb
const AGE_RED_MS = 72 * HOUR_MS; // über 72 h rot

// Zustand je Stufe 0, 1, 2
const STATES = ["gruen", "gelb", "rot"];
const NOT_SET_UP = "nicht_eingerichtet";
// Menüpunkt (AK-5): Zustand je Workspace höchstens so lange gemerkt
const STATE_CACHE_MS = 5 * 60 * 1000;

/**
 * Letzter Lauf: run aus Version 2, sonst created als Lauf ohne Störung.
 * @param {object} inventory - Laufzeitform aus courseInventoryRecord
 * @returns {{at: string, result: string, cause: string|null}}
 */
function lastRunOf({ run, stand }) {
  if (!run) return { at: stand, result: "ok", cause: null };
  return { at: run.at, result: run.result, cause: run.cause };
}

/** Zeitpunkt des letzten erfolgreichen Abgleichs in ms. */
function syncedAtMs({ run, createdMs }) {
  return Math.max(createdMs, run?.result === "ok" ? run.atMs : -Infinity);
}

/** Stufe nach dem Anteil der fehlenden Kurse (ganzzahlig verglichen). */
function missingLevel(missing, offered) {
  if (missing <= 0) return 0;
  if (missing * 100 > offered * MISSING_RED_PERCENT) return 2;
  if (missing * 100 >= offered * MISSING_YELLOW_PERCENT) return 1;
  return 0;
}

/** Stufe nach dem Alter des letzten erfolgreichen Abgleichs. */
function ageLevel(ageMs) {
  if (ageMs > AGE_RED_MS) return 2;
  if (ageMs >= AGE_YELLOW_MS) return 1;
  return 0;
}

const notSetUp = () => ({
  state: NOT_SET_UP,
  reasons: [],
  counts: null,
  missing: [],
  hidden: [],
  lastRun: null,
  syncedAt: null,
  estimatedEnd: false,
});

/**
 * Bewertung des Kursbestands eines Workspace (AK-1, AK-2): Zustand, Gründe
 * für Gelb oder Rot („fehlen“, „alter“; beide, wenn beides zutrifft),
 * Zahlen, die Listen (je höchstens 500, die Gesamtzahl steht in counts),
 * letzter Lauf, letzter erfolgreicher Abgleich und ob das Ende geschätzt
 * ist. Nur lesend, wirft nie.
 * @param {{slug?: string}|null} workspace
 * @param {{now?: number, lists?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function courseStatus(
  workspace,
  { now = Date.now(), lists = true } = {}
) {
  const details = await courseInventoryDetails(workspace, { now, lists });
  if (!details) return notSetUp();
  const { inventory, counts } = details;
  const missing = Math.max(0, counts.offered - counts.count);
  const syncedAt = syncedAtMs(inventory);
  const byMissing = missingLevel(missing, counts.offered);
  const byAge = ageLevel(now - syncedAt);
  const reasons = [];
  if (byMissing > 0) reasons.push("fehlen");
  if (byAge > 0) reasons.push("alter");
  return {
    state: STATES[Math.max(byMissing, byAge)],
    reasons,
    counts: {
      offered: counts.offered,
      count: counts.count,
      missing,
      hidden: counts.hidden,
    },
    missing: details.missing ?? [],
    hidden: details.hidden ?? [],
    lastRun: lastRunOf(inventory),
    syncedAt: new Date(syncedAt).toISOString(),
    estimatedEnd: inventory.estimatedEnd,
  };
}

// Menüpunkt (AK-5): slug -> {at, state}
const stateCache = new Map();

/**
 * Nur der Zustand eines Workspace für den Punkt am Menü (AK-5): ohne
 * Listen, je Workspace höchstens 5 min gemerkt.
 * @param {{slug?: string}|null} workspace
 * @param {{now?: number}} [options]
 * @returns {Promise<string>}
 */
async function courseStatusState(workspace, { now = Date.now() } = {}) {
  const slug = workspace?.slug;
  const cached = stateCache.get(slug);
  if (cached && now - cached.at >= 0 && now - cached.at < STATE_CACHE_MS)
    return cached.state;
  const { state } = await courseStatus(workspace, { now, lists: false });
  stateCache.set(slug, { at: now, state });
  return state;
}

// Reihenfolge für den Punkt am Menü: der schlechteste Zustand zählt
const SEVERITY = [NOT_SET_UP, ...STATES];

/**
 * Der schlechteste Zustand mehrerer Workspaces (Punkt am Menü).
 * @param {string[]} states
 * @returns {string}
 */
function worstState(states) {
  return states.reduce(
    (worst, state) =>
      SEVERITY.indexOf(state) > SEVERITY.indexOf(worst) ? state : worst,
    NOT_SET_UP
  );
}

module.exports = {
  NOT_SET_UP,
  courseStatus,
  courseStatusState,
  worstState,
  // nur für Tests
  __test__: {
    STATE_CACHE_MS,
    reset: () => stateCache.clear(),
  },
};
