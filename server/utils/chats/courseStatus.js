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
// Alter des Abgleichs: created (syncedAt, D-r6-3). Ein Lauf mit result "ok"
// schreibt immer ein neues created, ein Lauf mit Störung schreibt keine neue
// Liste (KB-4, D-KB4-2) und verjüngt den Stand deshalb nicht. listApplied
// rechnet mit demselben Zeitpunkt (courseListApplies).
//
// Ohne gültige Kursliste oder in einem anderen Workspace als dem der
// Kursliste (Feld workspace, Fixliste r5) gilt „nicht eingerichtet“
// (D-KB3-3). Im Workspace der Kursliste wird immer bewertet, auch wenn dort
// kein angebotener Kurs eingelernt ist (dann fehlt alles, Rot; die frühere
// Sonderregel E-KB3-4 entfällt). Ein Fehler beim Aufbau (Datenbank) ist
// kein „nicht eingerichtet“: courseStatus wirft, Status und Menüpunkt
// antworten mit 500 ohne Details (Fixliste r2 Nr. 6). Eine unlesbare
// Dokumentdatei ist kein Fehler: Ist es ein Kurs, fehlt er (D-r6-1).
//
// Vertrag mit Status-Seite und Mail (KB-5, fixliste-kb-r4.md „Vertrag“):
// Überschrift (headline), Zeilen (details), Anteil der fehlenden Kurse
// (missingPercent), ob der Chat die Kursliste anwendet (listApplied) und die
// Hinweiszeile (notice, D-r6-3) rechnet nur der Server; Seite und Mail lesen
// sie ab. Ausgeblendete Kurse (hidden, counts.hidden) liefert er nur, solange
// der Chat die Kursliste anwendet, sonst [] und 0: dann blendet der Chat
// nichts aus (Fixliste r7 Nr. 1).

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
// Ursache eines Laufs, bei der das Alter „nicht abrufbar“ heißt (KB-4)
const CAUSE_UNREACHABLE = "feed_nicht_erreichbar";
// Menüpunkt (AK-5): Zustand je Workspace höchstens so lange gemerkt
const STATE_CACHE_MS = 5 * 60 * 1000;
// Hinweiszeile (notice): Gelb oder Rot, und der Chat wendet die Kursliste
// nicht an (D-r6-3)
const NOTICE_LIST_NOT_APPLIED = "liste_nicht_angewendet";

/**
 * Letzter Lauf: run der Kursliste, ohne gültiges run created als Lauf ohne
 * Störung.
 * @param {object} inventory - Laufzeitform aus courseInventoryRecord
 * @returns {{at: string, result: string, cause: string|null}}
 */
function lastRunOf({ run, stand }) {
  if (!run) return { at: stand, result: "ok", cause: null };
  return { at: run.at, result: run.result, cause: run.cause };
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

/**
 * Anteil der fehlenden Kurse in ganzen Prozent, abgerundet und ganzzahlig
 * gerechnet wie die Schwellen (29 von 100 ergibt 29, nie 28); 0 ohne
 * angebotenen Kurs.
 * @param {number} missing
 * @param {number} offered
 * @returns {number}
 */
function missingPercentOf(missing, offered) {
  if (!(offered > 0)) return 0;
  const scaled = missing * 100;
  return (scaled - (scaled % offered)) / offered;
}

/**
 * Zeilen der Meldung in Anzeigereihenfolge (Vertrag „details“): das Alter
 * genau einmal („nicht_abrufbar“, wenn der letzte Lauf die Website nicht
 * erreicht hat, sonst „nicht_aktualisiert“), dann „unvollstaendig“. Leer bei
 * Grün.
 */
function detailsOf(byMissing, byAge, lastRun) {
  const details = [];
  if (byAge > 0)
    details.push(
      lastRun.cause === CAUSE_UNREACHABLE
        ? "nicht_abrufbar"
        : "nicht_aktualisiert"
    );
  if (byMissing > 0) details.push("unvollstaendig");
  return details;
}

const notSetUp = () => ({
  state: NOT_SET_UP,
  headline: null,
  details: [],
  reasons: [],
  counts: null,
  missingPercent: 0,
  missing: [],
  hidden: [],
  lastRun: null,
  syncedAt: null,
  listApplied: false,
  notice: null,
  estimatedEnd: false,
});

/**
 * Bewertung des Kursbestands eines Workspace (AK-1, AK-2): Zustand,
 * Überschrift und Zeilen der Meldung (Vertrag r4), Gründe für Gelb oder Rot
 * („fehlen“, „alter“; beide, wenn beides zutrifft), Zahlen mit dem Anteil
 * der fehlenden Kurse, die Listen (je höchstens 500, die Gesamtzahl steht in
 * counts), letzter Lauf, letzter erfolgreicher Abgleich (created), ob der
 * Chat die Kursliste anwendet (ausgeblendete Kurse nur dann, sonst [] und
 * 0), die Hinweiszeile (notice: nur bei Gelb oder Rot und listApplied false)
 * und ob das Ende geschätzt ist. Nur lesend;
 * wirft bei einem Lesefehler.
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
  const byMissing = missingLevel(missing, counts.offered);
  const byAge = ageLevel(now - inventory.createdMs);
  const level = Math.max(byMissing, byAge);
  const { listApplied } = details;
  const reasons = [];
  if (byMissing > 0) reasons.push("fehlen");
  if (byAge > 0) reasons.push("alter");
  const lastRun = lastRunOf(inventory);
  const lines = detailsOf(byMissing, byAge, lastRun);
  return {
    state: STATES[level],
    // die Zeile zur Überschrift steht zuerst; Grün „aktuell“
    headline: lines[0] ?? "aktuell",
    details: lines,
    reasons,
    counts: {
      offered: counts.offered,
      count: counts.count,
      missing,
      hidden: listApplied ? counts.hidden : 0,
    },
    missingPercent: missingPercentOf(missing, counts.offered),
    missing: details.missing ?? [],
    hidden: listApplied ? details.hidden ?? [] : [],
    lastRun,
    syncedAt: inventory.stand,
    listApplied,
    notice: level > 0 && !listApplied ? NOTICE_LIST_NOT_APPLIED : null,
    estimatedEnd: inventory.estimatedEnd,
  };
}

// Menüpunkt (AK-5): slug -> {at, state}
const stateCache = new Map();

/**
 * Nur der Zustand eines Workspace für den Punkt am Menü (AK-5): ohne
 * Listen, je Workspace höchstens 5 min gemerkt; ein Lesefehler wird nicht
 * gemerkt, er wirft.
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

/**
 * Zustand für den Punkt am Menü (AK-5): der schlechteste der Workspaces.
 * Bewertet wird nur der Workspace der Kursliste (Fixliste r5), die übrigen
 * sind ohne Lesen nicht eingerichtet. Ein Lesefehler wirft deshalb, statt
 * hinter „nicht eingerichtet“ der übrigen zu verschwinden (r5 ersetzt die
 * Auswahl der lesbaren Workspaces aus r4 Nr. 4).
 * @param {Array<{slug?: string}>} workspaces
 * @param {{now?: number}} [options]
 * @returns {Promise<string>}
 */
async function courseMenuState(workspaces, { now = Date.now() } = {}) {
  const states = [];
  for (const workspace of workspaces)
    states.push(await courseStatusState(workspace, { now }));
  return worstState(states);
}

module.exports = {
  NOT_SET_UP,
  courseStatus,
  courseStatusState,
  courseMenuState,
  worstState,
  // nur für Tests
  __test__: {
    STATE_CACHE_MS,
    reset: () => stateCache.clear(),
  },
};
