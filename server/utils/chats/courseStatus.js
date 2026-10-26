// KB-3 (issues/P-kursbestand/KB-3-status-seite.md): Ampel des Kursbestands
// je Workspace (Kursprogramm), eine Quelle für Status-Seite, Menüpunkt und
// Mail (KB-5, D-KB3-1). Nur lesend: Kursliste und Index kommen aus
// courseInventory.js (courseInventoryDetails), geschrieben wird nur der
// eigene Verlauf der Bewertungen.
//
// Ampel:
//   Grün  0 fehlen, Abgleich jünger als 3 h.
//   Gelb  mindestens 1 fehlt, aber unter 5 % und unter 50; oder Abgleich 3
//         bis 24 h alt.
//   Rot   ab 5 % oder ab 50 fehlen; oder Abgleich älter als 24 h; oder das
//         Kursprogramm ist seit dem vorigen Lauf nicht erreichbar
//         (run.cause feed_nicht_erreichbar).
// Alter des Abgleichs: der jüngere Zeitpunkt aus created und run.at eines
// Laufs mit result "ok" (Version 1: created). Ein Lauf mit Störung schreibt
// keine neue Liste (KB-4, D-KB4-2) und verjüngt den Stand deshalb nicht;
// über 24 h nutzt der Chat die Liste nicht mehr (loadCourseInventory).
//
// Zwei Läufe in Folge (D-KB3-2): Der Verlauf (SystemSetting
// kufer_course_status_history) merkt sich je Workspace die Bewertung der
// letzten höchstens 5 Läufe (fehlende Kurse und Erreichbarkeit). Ein neuer
// Eintrag entsteht nur, wenn sich created oder run.at ändern. Gelb oder Rot
// aus einem Lauf gilt erst, wenn auch der vorige Lauf mindestens so schlecht
// war; ohne vorigen Lauf gilt der aktuelle allein. Das Alter wirkt sofort.
// Gespeichert werden außerdem der Zustand und seit wann er gilt (since).
//
// Ohne gültige Kursliste oder ohne angebotenen Kurs im Workspace gilt
// „nicht eingerichtet“ (D-KB3-3); dann wird nichts gespeichert.

const prisma = require("../prisma");
const { courseInventoryDetails } = require("./courseInventory");

const HISTORY_LABEL = "kufer_course_status_history";
const HISTORY_MAX = 5;
const HOUR_MS = 60 * 60 * 1000;
const AGE_YELLOW_MS = 3 * HOUR_MS;
const AGE_RED_MS = 24 * HOUR_MS;
const MISSING_RED_SHARE = 0.05;
const MISSING_RED_COUNT = 50;
// Zustand je Stufe 0, 1, 2
const STATES = ["gruen", "gelb", "rot"];
const NOT_SET_UP = "nicht_eingerichtet";
const UNREACHABLE = "feed_nicht_erreichbar";
// Menüpunkt (AK-5): Zustand je Workspace höchstens so lange gemerkt
const STATE_CACHE_MS = 5 * 60 * 1000;

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Letzter Lauf: run aus Version 2, sonst created als Lauf ohne Störung.
 * @param {object} inventory - Laufzeitform aus courseInventoryRecord
 * @returns {{at: string, atMs: number, result: string, cause: string|null}}
 */
function lastRunOf(inventory) {
  return (
    inventory.run || {
      at: inventory.stand,
      atMs: inventory.createdMs,
      result: "ok",
      cause: null,
    }
  );
}

/** Alter des letzten erfolgreichen Abgleichs in ms. */
function syncAgeMs(inventory, now) {
  const run = inventory.run;
  const okAt = run?.result === "ok" ? run.atMs : -Infinity;
  return now - Math.max(inventory.createdMs, okAt);
}

function ageLevel(ageMs) {
  if (ageMs > AGE_RED_MS) return 2;
  if (ageMs >= AGE_YELLOW_MS) return 1;
  return 0;
}

function missingLevel({ offered, count }) {
  const missing = offered - count;
  if (missing <= 0) return 0;
  if (missing >= MISSING_RED_COUNT || missing >= offered * MISSING_RED_SHARE)
    return 2;
  return 1;
}

// Bewertung eines Laufs: fehlende Kurse und Erreichbarkeit
const runLevel = (counts, run) =>
  Math.max(missingLevel(counts), run.cause === UNREACHABLE ? 2 : 0);

// Ein Lauf ist neu, wenn sich created oder run.at ändern
const runKey = (inventory) => `${inventory.stand}|${inventory.run?.at ?? ""}`;

let deps = defaultDeps();

function defaultDeps() {
  return {
    readHistory: async () =>
      (
        await prisma.system_settings.findFirst({
          where: { label: HISTORY_LABEL },
          select: { value: true },
        })
      )?.value ?? null,
    writeHistory: async (value) =>
      await prisma.system_settings.upsert({
        where: { label: HISTORY_LABEL },
        update: { value },
        create: { label: HISTORY_LABEL, value },
      }),
  };
}

function parseHistory(raw) {
  try {
    const data = JSON.parse(raw);
    return isPlainObject(data) ? data : {};
  } catch {
    return {};
  }
}

// Verlauf nacheinander lesen und schreiben (ein Prozess, mehrere Anfragen)
let historyQueue = Promise.resolve();

/**
 * Zustand eines Workspace nach Ampel und Verlauf; schreibt den Verlauf nur,
 * wenn ein neuer Lauf dazukommt oder sich Bewertung oder Zustand ändern.
 * @returns {Promise<{state: string, since: string, reason: "fehlen"|"alter"|"nicht_erreichbar"|null}>}
 */
function evaluate(slug, inventory, counts, now) {
  const task = historyQueue.then(async () => {
    const history = parseHistory(await deps.readHistory());
    const entry = isPlainObject(history[slug]) ? history[slug] : {};
    const runs = (Array.isArray(entry.runs) ? entry.runs : [])
      .filter((run) => isPlainObject(run) && typeof run.key === "string")
      .slice(0, HISTORY_MAX);

    const run = lastRunOf(inventory);
    const key = runKey(inventory);
    const current = runLevel(counts, run);
    let changed = false;
    if (runs[0]?.key !== key) {
      runs.unshift({ key, level: current });
      runs.splice(HISTORY_MAX);
      changed = true;
    } else if (runs[0].level !== current) {
      runs[0] = { key, level: current };
      changed = true;
    }
    const previous = Number.isInteger(runs[1]?.level) ? runs[1].level : null;
    const fromRuns = previous === null ? current : Math.min(current, previous);
    const fromAge = ageLevel(syncAgeMs(inventory, now));
    const level = Math.max(fromRuns, fromAge);
    const state = STATES[level];

    let reason = null;
    if (level > 0 && fromAge === level) reason = "alter";
    else if (level > 0)
      reason =
        missingLevel(counts) < level && run.cause === UNREACHABLE
          ? "nicht_erreichbar"
          : "fehlen";

    let since = typeof entry.since === "string" ? entry.since : null;
    if (entry.state !== state || since === null) {
      since = new Date(now).toISOString();
      changed = true;
    }
    if (changed) {
      history[slug] = { state, since, runs };
      await deps.writeHistory(JSON.stringify(history));
    }
    return { state, since, reason };
  });
  // ein Fehler hält die Warteschlange nicht an
  historyQueue = task.catch(() => {});
  return task;
}

// Wer handelt (AK-6): bei Gelb und Rot die Einrichtung, wenn das
// Kursprogramm nicht erreichbar ist, sonst Kufer; bei Grün niemand
function whoActs(state, run) {
  if (state !== "gelb" && state !== "rot") return null;
  return run.cause === UNREACHABLE ? "einrichtung" : "kufer";
}

const notSetUp = () => ({
  state: NOT_SET_UP,
  since: null,
  reason: null,
  whoActs: null,
  counts: null,
  missing: [],
  hidden: [],
  lastRun: null,
  estimatedEnd: false,
});

/**
 * Bewertung des Kursbestands eines Workspace (AK-1, AK-2): Zustand, seit
 * wann, Grund, wer handelt, Zahlen, die Listen (je höchstens 500, die
 * Gesamtzahl steht in counts), letzter Lauf und ob das Ende geschätzt ist.
 * Wirft nur, wenn der Verlauf nicht lesbar oder schreibbar ist.
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
  const run = lastRunOf(inventory);
  const { state, since, reason } = await evaluate(
    workspace.slug,
    inventory,
    counts,
    now
  );
  return {
    state,
    since,
    reason,
    whoActs: whoActs(state, run),
    counts: {
      offered: counts.offered,
      count: counts.count,
      missing: counts.offered - counts.count,
      hidden: counts.hidden,
    },
    missing: details.missing ?? [],
    hidden: details.hidden ?? [],
    lastRun: { at: run.at, result: run.result, cause: run.cause },
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
  HISTORY_LABEL,
  NOT_SET_UP,
  courseStatus,
  courseStatusState,
  worstState,
  // nur für Tests
  __test__: {
    HISTORY_MAX,
    STATE_CACHE_MS,
    setDeps: (overrides = {}) => {
      deps = { ...defaultDeps(), ...overrides };
    },
    reset: () => {
      deps = defaultDeps();
      stateCache.clear();
      historyQueue = Promise.resolve();
    },
  },
};
