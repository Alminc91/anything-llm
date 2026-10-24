// KIE-576 Paket 3: Kursbestand des Kursprogramms (SystemSetting
// kufer_course_inventory) und was daraus im Chatbot folgt.
//
// Vertrag (issues/KIE-576/KIE-576-kursanzahl.md, Abschnitt „Vertrag“):
//   {"version": 1, "client": "<kunde>", "created": "<ISO-8601 UTC>",
//    "offered": ["<kursnummer>", ...]}
// JSON in UTF-8, höchstens 512 KiB, geschrieben nur von der Pipeline über
// _updateSettings (docker exec), nicht über HTTP (das Label steht nicht in
// supportedFields). offered = A, die Kursnummern im Feed nach dem
// Ablauffilter.
//
// Der Server bestimmt B selbst: die Kursnummern seiner eigenen Kursdokumente
// des Workspace (Kopfzeile „Kursnummer:“ im Kopfblock, embedCourseSources
// courseNumberFromText). Daraus:
//   count   = |A ∩ B|   (Zahl im Untertitel, nie größer, NAK-K3)
//   offered = |A|
//   stale   = |B \ A|   (veraltet, ausgeblendet)
//   missing = |A \ B|
// B zählt nur eingelernte Dokumente (AK-K9, E34 Stufe 2): Zu jedem
// Kursdokument muss es Suchdaten geben, also Einträge in document_vectors
// und (bei LanceDB) mindestens eine dieser Zeilen in der Tabelle des
// Workspace. Die Prüfung läuft im Serverprozess selbst (kein fremder
// Prozess auf LanceDB) und höchstens einmal je Stunde mit dem Index.
//
// Ausblenden (E35): Kursdokumente mit Kursnummer außerhalb von A kommen in
// keinen Schritt der Suche. Der Ausschluss sitzt als Filterbedingung
// „id NOT IN (…)“ in der Anfrage an LanceDB (lance/index.js
// filteredQueryRows, wie der Metadatenfilter aus KIE-480), also vor
// Vektor- und Stichwortsuche und vor dem Reranker. Angeheftete Dokumente,
// der Rückgriff über fillSourceWindow und die Kurskarten prüfen dieselben
// Regeln (guard). Dokumente ohne Kursnummer sind nie betroffen.
//
// Ohne gültigen Wert (fehlt, kein JSON, version ≠ 1, leeres offered, älter
// als 24 h) oder ohne einen einzigen angebotenen Kurs im Workspace
// (|A ∩ B| = 0, etwa die Liste eines anderen Kunden) gibt es weder Zahl noch
// Ausblenden: alles wie vorher (NAK-K1, NAK-K2). Ein kaputter Eintrag kippt
// nie den Chat: alle Einstiege fangen Fehler ab.

const fs = require("fs");
const prisma = require("../prisma");
const { courseNumberFromText } = require("./embedCourseSources");

const COURSE_INVENTORY_LABEL = "kufer_course_inventory";
// Vertrag: höchstens 512 KiB (UTF-8)
const INVENTORY_MAX_BYTES = 512 * 1024;
// Vertrag: älter als 24 h -> kein Ausblenden, keine Zahl
const INVENTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Uhrabweichung zwischen Pipeline und Container (created in der Zukunft)
const INVENTORY_FUTURE_MS = 60 * 60 * 1000;
// AK-K4: Index je Workspace und Wert höchstens 1 h gemerkt
const INDEX_MAX_AGE_MS = 60 * 60 * 1000;
const COURSE_NUMBER_MAX_LEN = 64;
const CLIENT_MAX_LEN = 200;
const CONTROL_RX = /[\p{Cc}\u2028\u2029]/u;
// Kursdokumente sind klein; größere Dateien (PDF, lange Seiten) werden für
// die Kursnummer nicht gelesen und zählen als Dokument ohne Kursnummer
const DOC_FILE_MAX_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 8;
// Größe der IN-Listen an Datenbank und LanceDB
const QUERY_BATCH = 500;
// Höchstzahl Abschnitte im Vorfilter „id NOT IN (…)“; darüber nur der
// dokumentierte Rückfall (mehr Treffer holen, vor dem Reranker filtern)
const EXCLUSION_WHERE_MAX_IDS = 5000;
// Rückfall: so viele Treffer zusätzlich, höchstens
const FALLBACK_EXTRA_MAX = 500;
// Vektor-IDs (uuidv4) für die Filterbedingung; andere werden nur nachträglich
// geprüft, nie in die Anfrage geschrieben
const VECTOR_ID_RX = /^[A-Za-z0-9_.:-]{1,100}$/;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Vergleichsform einer Kursnummer (Feed und Kopfzeile): NFC, getrimmt,
 * Leerraum zu einem Leerzeichen, klein geschrieben. Leer, zu lang oder mit
 * Steuerzeichen -> null.
 * @param {*} value
 * @returns {string|null}
 */
function courseKey(value) {
  if (typeof value !== "string") return null;
  const key = value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  if (key.length === 0 || key.length > COURSE_NUMBER_MAX_LEN) return null;
  if (CONTROL_RX.test(key)) return null;
  return key;
}

/**
 * Kursnummer eines Dokument- oder Abschnittstexts (Kopfblock), als
 * Vergleichsform; kein Kursdokument -> null.
 * @param {*} text
 * @returns {string|null}
 */
function courseKeyOfText(text) {
  const number = courseNumberFromText(text);
  return number ? courseKey(number) : null;
}

// Grobe Vertragsprüfung (Form); null = in Ordnung, sonst der Grund
function contractProblem(data) {
  if (!isPlainObject(data)) return "kein JSON-Objekt";
  if (data.version !== 1) return "version ist nicht 1";
  if (
    typeof data.client !== "string" ||
    data.client.trim().length === 0 ||
    data.client.length > CLIENT_MAX_LEN
  )
    return "client fehlt";
  if (
    typeof data.created !== "string" ||
    !Number.isFinite(Date.parse(data.created))
  )
    return "created ist kein Zeitpunkt";
  if (!Array.isArray(data.offered)) return "offered ist keine Liste";
  if (data.offered.length === 0) return "offered ist leer";
  for (const number of data.offered)
    if (courseKey(number) === null)
      return "offered enthält eine ungültige Kursnummer";
  return null;
}

/**
 * Gespeicherten Wert nach Vertrag lesen (gemeinsam für Validator und Leser).
 * @param {*} raw
 * @returns {{data: object, problem?: undefined}|{problem: string, data?: undefined}}
 */
function readContract(raw) {
  if (typeof raw !== "string") return { problem: "Wert ist kein JSON-String" };
  if (Buffer.byteLength(raw, "utf8") > INVENTORY_MAX_BYTES)
    return { problem: "größer als 512 KiB" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { problem: "kein gültiges JSON" };
  }
  const problem = contractProblem(data);
  return problem ? { problem } : { data };
}

// Alter des Werts nach Vertrag: höchstens 24 h, höchstens 1 h in der Zukunft
function ageProblem(createdMs, now) {
  const age = now - createdMs;
  if (age > INVENTORY_MAX_AGE_MS) return "created älter als 24 h";
  if (age < -INVENTORY_FUTURE_MS) return "created liegt in der Zukunft";
  return null;
}

/**
 * Validator des SystemSettings (Whitelist wie die Kategorie-Karte): leer ->
 * null (Wert entfernt, der Server verhält sich wie heute); gültig nach
 * Vertrag, höchstens 512 KiB und höchstens 24 h alt -> derselbe String;
 * sonst Fehler: das Update wird abgelehnt, der alte Wert bleibt.
 * @param {*} update
 * @param {{now?: number}} [options]
 * @returns {string|null}
 */
function validateCourseInventorySetting(update, { now = Date.now() } = {}) {
  if (update === null || update === undefined || update === "") return null;
  const { data, problem } = readContract(update);
  const reason = problem || ageProblem(Date.parse(data.created), now);
  if (reason) throw new Error(`${COURSE_INVENTORY_LABEL}: ${reason}`);
  return update;
}

/**
 * Laufzeitform eines gespeicherten Werts (ohne Altersprüfung, die macht
 * loadCourseInventory je Aufruf). Leer -> {inventory: null} ohne problem.
 * @param {*} raw
 * @returns {{inventory: {raw: string, createdMs: number, stand: string, offered: Set<string>}|null, problem?: string}}
 */
function readCourseInventory(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { inventory: null };
  const { data, problem } = readContract(raw);
  if (problem) return { inventory: null, problem };
  const createdMs = Date.parse(data.created);
  const offered = new Set(data.offered.map(courseKey));
  return {
    inventory: {
      raw,
      createdMs,
      stand: new Date(createdMs).toISOString(),
      offered,
    },
  };
}

// Zuletzt gelesener Wert und seine Laufzeitform: neu geparst wird nur, wenn
// sich der gespeicherte Wert ändert (die Pipeline schreibt aus einem anderen
// Prozess, deshalb wird der Wert je Anfrage gelesen, eine Zeile per Label).
let cached = { raw: null, inventory: null };

async function readStoredInventory() {
  try {
    const row = await prisma.system_settings.findFirst({
      where: { label: COURSE_INVENTORY_LABEL },
      select: { value: true },
    });
    return row?.value ?? null;
  } catch (error) {
    console.error(`[courseInventory] ${error.message}`);
    return null;
  }
}

/**
 * Kursbestand des Containers, falls gültig und höchstens 24 h alt, sonst
 * null. Wirft nie.
 * @param {{now?: number}} [options]
 * @returns {Promise<{raw: string, createdMs: number, stand: string, offered: Set<string>}|null>}
 */
async function loadCourseInventory({ now = Date.now() } = {}) {
  const raw = await readStoredInventory();
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw !== cached.raw) {
    const { inventory, problem } = readCourseInventory(raw);
    // verworfenen Wert melden, dank Cache einmal je Wert
    if (problem)
      console.error(`[courseInventory] Kursliste verworfen: ${problem}`);
    cached = { raw, inventory };
  }
  const inventory = cached.inventory;
  if (!inventory) return null;
  return ageProblem(inventory.createdMs, now) ? null : inventory;
}

// ---------------------------------------------------------------------------
// Index je Workspace (B, veraltete Dokumente, Vorfilter)
// ---------------------------------------------------------------------------

function defaultDeps() {
  return {
    findWorkspaceId: async (slug) =>
      (
        await prisma.workspaces.findFirst({
          where: { slug },
          select: { id: true },
        })
      )?.id ?? null,
    listDocuments: async (workspaceId) =>
      await prisma.workspace_documents.findMany({
        where: { workspaceId },
        select: { docId: true, docpath: true },
      }),
    listVectors: async (docIds) => {
      const rows = [];
      for (let i = 0; i < docIds.length; i += QUERY_BATCH)
        rows.push(
          ...(await prisma.document_vectors.findMany({
            where: { docId: { in: docIds.slice(i, i + QUERY_BATCH) } },
            select: { docId: true, vectorId: true },
          }))
        );
      return rows;
    },
    // Text eines Dokuments (pageContent) oder null (fehlt, zu groß, unlesbar)
    readDocumentText: async (docpath) => {
      const { documentsPath, isWithin, normalizePath } = require("../files");
      const path = require("path");
      const full = path.resolve(documentsPath, normalizePath(docpath));
      if (!isWithin(path.resolve(documentsPath), full)) return null;
      const stat = await fs.promises.stat(full);
      if (!stat.isFile() || stat.size > DOC_FILE_MAX_BYTES) return null;
      const doc = JSON.parse(await fs.promises.readFile(full, "utf8"));
      return typeof doc?.pageContent === "string" ? doc.pageContent : null;
    },
    // AK-K9: vorhandene Zeilen im Vektorspeicher; null = nicht prüfbar
    // (anderer Vektorspeicher, Fehler) -> es zählt document_vectors
    existingVectorIds: async (slug, ids) => {
      const { getVectorDbClass } = require("../helpers");
      const VectorDb = getVectorDbClass();
      if (typeof VectorDb?.existingVectorIds !== "function") return null;
      return await VectorDb.existingVectorIds(slug, ids);
    },
  };
}

let deps = defaultDeps();
// slug -> {raw, builtAt, promise}
const indexCache = new Map();
// slug -> Map(docpath -> Kursnummer|null): Dokumentdateien ändern sich nicht
// (ein neuer Upload bekommt einen neuen docpath), deshalb über die Stunde
// hinaus gemerkt; Einträge entfallener Dokumente werden beim Neuaufbau
// entfernt.
const docKeyMemo = new Map();

async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

async function documentKeys(slug, documents) {
  const previous = docKeyMemo.get(slug) || new Map();
  const memo = new Map();
  await mapWithLimit(documents, READ_CONCURRENCY, async ({ docpath }) => {
    if (typeof docpath !== "string" || memo.has(docpath)) return;
    if (previous.has(docpath)) {
      memo.set(docpath, previous.get(docpath));
      return;
    }
    let key = null;
    try {
      key = courseKeyOfText(await deps.readDocumentText(docpath));
    } catch {
      key = null;
    }
    memo.set(docpath, key);
  });
  docKeyMemo.set(slug, memo);
  return memo;
}

function exclusionWhere(ids) {
  const safe = [...ids].filter((id) => VECTOR_ID_RX.test(id));
  if (safe.length === 0 || safe.length > EXCLUSION_WHERE_MAX_IDS) return null;
  return `id NOT IN (${safe.map((id) => `'${id}'`).join(",")})`;
}

/**
 * Index eines Workspace zu einem gültigen Kursbestand bauen.
 * @param {string} slug
 * @param {{offered: Set<string>, raw: string, stand: string}} inventory
 * @returns {Promise<object|null>} null: Workspace unbekannt
 */
async function buildIndex(slug, inventory) {
  const workspaceId = await deps.findWorkspaceId(slug);
  if (!workspaceId) return null;
  const documents = (await deps.listDocuments(workspaceId)) || [];
  const keys = await documentKeys(slug, documents);

  const courseDocs = documents
    .map((doc) => ({ ...doc, key: keys.get(doc.docpath) ?? null }))
    .filter((doc) => doc.key !== null);
  const vectorsByDoc = new Map();
  for (const { docId, vectorId } of await deps.listVectors(
    courseDocs.map((doc) => doc.docId)
  )) {
    if (!vectorsByDoc.has(docId)) vectorsByDoc.set(docId, []);
    vectorsByDoc.get(docId).push(vectorId);
  }

  // AK-K9: welche Abschnitte gibt es wirklich im Vektorspeicher?
  const allIds = courseDocs.flatMap((doc) => vectorsByDoc.get(doc.docId) || []);
  let present = null;
  try {
    present =
      allIds.length > 0 ? await deps.existingVectorIds(slug, allIds) : null;
  } catch (error) {
    console.error(
      `[courseInventory] Suchdaten nicht prüfbar: ${error.message}`
    );
    present = null;
  }
  const embedded = (doc) => {
    const ids = vectorsByDoc.get(doc.docId) || [];
    if (ids.length === 0) return false;
    return present === null ? true : ids.some((id) => present.has(id));
  };

  const offered = inventory.offered;
  const allKeys = new Set(courseDocs.map((doc) => doc.key));
  const known = new Set(courseDocs.filter(embedded).map((doc) => doc.key));
  let count = 0;
  for (const key of known) if (offered.has(key)) count++;
  let anyOffered = false;
  for (const key of allKeys)
    if (offered.has(key)) {
      anyOffered = true;
      break;
    }
  const staleDocs = courseDocs.filter((doc) => !offered.has(doc.key));
  const excludedIds = new Set(
    staleDocs.flatMap((doc) => vectorsByDoc.get(doc.docId) || [])
  );
  return {
    slug,
    raw: inventory.raw,
    stand: inventory.stand,
    offered,
    // NAK-K2: ohne einen einzigen angebotenen Kurs im Workspace (Liste eines
    // anderen Kunden, Workspace ohne Kurse) wird nichts ausgeblendet
    active: anyOffered,
    counts: {
      count,
      offered: offered.size,
      stale: [...known].filter((key) => !offered.has(key)).length,
      missing: [...offered].filter((key) => !known.has(key)).length,
    },
    staleDocCount: staleDocs.length,
    excludedIds,
    where: exclusionWhere(excludedIds),
  };
}

/**
 * Index eines Workspace (Namespace = slug) zum gültigen Kursbestand, gemerkt
 * höchstens 1 h je Workspace und Wert (AK-K4); null ohne gültigen Wert,
 * ohne Workspace oder bei einem Fehler (dann ohne Merken, der nächste Aufruf
 * versucht es erneut). Wirft nie.
 * @param {string} slug
 * @param {{now?: number}} [options]
 * @returns {Promise<object|null>}
 */
async function workspaceInventory(slug, { now = Date.now() } = {}) {
  try {
    if (typeof slug !== "string" || slug.length === 0) return null;
    const inventory = await loadCourseInventory({ now });
    if (!inventory) return null;
    const entry = indexCache.get(slug);
    if (
      entry &&
      entry.raw === inventory.raw &&
      now - entry.builtAt >= 0 &&
      now - entry.builtAt < INDEX_MAX_AGE_MS
    )
      return await entry.promise;
    const fresh = { raw: inventory.raw, builtAt: now, promise: null };
    fresh.promise = buildIndex(slug, inventory).catch((error) => {
      console.error(`[courseInventory] Index nicht gebaut: ${error.message}`);
      return null;
    });
    indexCache.set(slug, fresh);
    const index = await fresh.promise;
    if (!index && indexCache.get(slug) === fresh) indexCache.delete(slug);
    return index;
  } catch (error) {
    console.error(`[courseInventory] ${error.message}`);
    return null;
  }
}

// Ist ein Abschnitt (Treffer oder gespeicherte Quelle) veraltet? Über seine
// Vektor-ID (Dokument des Workspace mit Kursnummer außerhalb von A) oder über
// seinen eigenen Kopfblock (auch ein Abschnitt, dessen Dokument der
// Workspace nicht mehr kennt). Ohne Kursnummer nie.
function rowIsStale(index, row) {
  if (!row || typeof row !== "object") return false;
  if (typeof row.id === "string" && index.excludedIds.has(row.id)) return true;
  const key = courseKeyOfText(row.text);
  return key !== null && !index.offered.has(key);
}

function textIsStale(index, text) {
  const key = courseKeyOfText(text);
  return key !== null && !index.offered.has(key);
}

/**
 * Ausschluss für eine Suche im Vektorspeicher (lance/index.js): where =
 * Filterbedingung „id NOT IN (…)“ (null, wenn nichts auszuschließen ist
 * oder die Liste zu lang ist), hides(row) für den Rückfall und für
 * Abschnitte, die nur ihr Kopfblock verrät; extra = zusätzliche Treffer im
 * Rückfall. stats zählt je Suche. null: nichts auszublenden (kein gültiger
 * Wert, Workspace ohne angebotene Kurse). Wirft nie.
 * @param {string} namespace
 * @returns {Promise<{where: string|null, hides: (row: object) => boolean, extra: number, staleDocs: number, stats: {dropped: number}}|null>}
 */
async function courseSearchExclusion(namespace) {
  const index = await workspaceInventory(namespace);
  if (!index?.active) return null;
  return {
    where: index.where,
    hides: (row) => rowIsStale(index, row),
    extra: Math.min(index.excludedIds.size, FALLBACK_EXTRA_MAX),
    excludedIds: index.excludedIds.size,
    staleDocs: index.staleDocCount,
    stats: { dropped: 0 },
  };
}

/**
 * Prüfer für die Chatpfade (angeheftete Dokumente, Rückgriff über
 * fillSourceWindow, Kurskarten). null ohne aktiven Kursbestand: dann bleibt
 * alles wie heute (NAK-K1). Wirft nie.
 * @param {{slug?: string}|null} workspace
 * @returns {Promise<object|null>}
 */
async function courseInventoryGuard(workspace) {
  const index = await workspaceInventory(workspace?.slug);
  if (!index?.active) return null;
  const counts = { pinned: 0, history: 0 };
  // angeheftetes Dokument bzw. Dokumentdatei der Kurskarten ({pageContent})
  const hidesDocument = (doc) => textIsStale(index, doc?.pageContent);
  // gespeicherte Quelle früherer Antworten ({id, text, ...}) für den
  // Rückgriff über fillSourceWindow (gezählt)
  const hidesSource = (source) => {
    const stale = rowIsStale(index, source);
    if (stale) counts.history++;
    return stale;
  };
  return {
    hidesDocument,
    hidesSource,
    filterPinned: (docs = []) => {
      const kept = docs.filter((doc) => !hidesDocument(doc));
      counts.pinned += docs.length - kept.length;
      return kept;
    },
    // Je Anfrage nur Zahl und Workspace, keine Inhalte
    report() {
      if (counts.pinned + counts.history === 0) return;
      console.log(
        `[courseInventory] ${index.slug}: ausgeblendet ${counts.pinned} angeheftete Dokumente, ${counts.history} Quellen aus dem Verlauf`
      );
    },
  };
}

/**
 * Zahlen für /config und das Design Center: {count, offered, stale,
 * missing, stand}; null ohne gültigen Wert oder ohne angebotenen Kurs im
 * Workspace. Wirft nie.
 * @param {{slug?: string}|null} workspace
 * @returns {Promise<{count: number, offered: number, stale: number, missing: number, stand: string}|null>}
 */
async function courseInventoryStatus(workspace) {
  const index = await workspaceInventory(workspace?.slug);
  if (!index?.active) return null;
  return { ...index.counts, stand: index.stand };
}

/**
 * Feld courseCount für GET /embed/:id/config nach Vertrag: nur mit Anzeige
 * an, gültigem Wert und count ≥ 1, sonst null (das Feld fehlt ganz).
 * @param {{slug?: string}|null} workspace
 * @param {{mode: "on"|"off", word: string}} options
 * @returns {Promise<{count: number, offered: number, stand: string, word: string}|null>}
 */
async function courseCountField(workspace, { mode, word }) {
  if (mode !== "on") return null;
  const status = await courseInventoryStatus(workspace);
  if (!status || status.count < 1) return null;
  return {
    count: status.count,
    offered: status.offered,
    stand: status.stand,
    word,
  };
}

module.exports = {
  COURSE_INVENTORY_LABEL,
  validateCourseInventorySetting,
  loadCourseInventory,
  courseSearchExclusion,
  courseInventoryGuard,
  courseInventoryStatus,
  courseCountField,
  // nur für Tests
  __test__: {
    INVENTORY_MAX_BYTES,
    INVENTORY_MAX_AGE_MS,
    INDEX_MAX_AGE_MS,
    EXCLUSION_WHERE_MAX_IDS,
    courseKey,
    courseKeyOfText,
    readCourseInventory,
    workspaceInventory,
    setDeps: (overrides = {}) => {
      deps = { ...defaultDeps(), ...overrides };
    },
    reset: () => {
      cached = { raw: null, inventory: null };
      indexCache.clear();
      docKeyMemo.clear();
      deps = defaultDeps();
    },
  },
};
