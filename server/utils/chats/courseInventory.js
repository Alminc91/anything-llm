// KIE-576 Paket 3: Kursbestand des Kursprogramms (SystemSetting
// kufer_course_inventory) und was daraus im Chatbot folgt.
//
// Vertrag (Version 2, KB-4, issues/P-kursbestand/KB-4-pipeline-daten.md,
// Fixliste r5 „Vertrag“):
//   {"version": 2, "workspace": "<slug>", "client": "<kunde>",
//    "created": "<ISO-8601 UTC>", "offered": ["<kursnummer>", ...],
//    "titles": {"<kursnummer>": "<titel, höchstens 200 Zeichen>"},
//    "estimatedEnd": true|false,
//    "run": {"at": "<ISO>", "result": "ok"|"nicht_geschrieben"|"fehler",
//            "cause": null|"feed_nicht_erreichbar"|"feed_unsicher"|
//                     "feed_eingebrochen"|"einlernen_fehlgeschlagen"}}
// Die Kursliste gehört zu genau einem Workspace (Pflichtfeld workspace, der
// Slug des Workspace, in den die Pipeline die Kurse einlernt; r5). Der Server
// wendet sie nur dort an: Ausblenden im Chat, Kursanzahl in /config und
// Status. Jeder andere Workspace gilt als nicht eingerichtet und blendet
// nichts aus. Ein Wert ohne workspace oder mit anderer Version wird nicht
// angenommen (Version 1 entfällt, r5).
// Ungültige Titel (kein Text, leer, länger als 200 Zeichen, Steuerzeichen,
// Kursnummer nicht in offered) werden übersprungen, ein ungültiges run
// verworfen. Ohne neue Liste ersetzt die Pipeline nur run (Laufmeldung),
// created bleibt: Die 24-h-Regel hängt am letzten echten Stand (created), der
// Validator nimmt eine Laufmeldung an, solange run.at höchstens 24 h alt ist.
// Titel, run und estimatedEnd sind Betreiber-Info (Status-Seite, KB-3) über
// courseInventoryRecord; sie kommen nie in /config, Prompt oder Suche.
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
//   hidden  = |B \ A|   (veraltete Kursnummern, in der Suche ausgeblendet,
//             D-K5; gezählt wie count)
// B zählt nur eingelernte Dokumente (AK-K9, E34 Stufe 2): Zu jedem
// Kursdokument muss es Suchdaten geben, also Einträge in document_vectors
// und (bei LanceDB) mindestens eine dieser Zeilen in der Tabelle des
// Workspace. Die Prüfung läuft im Serverprozess selbst (kein fremder
// Prozess auf LanceDB) und höchstens einmal je Stunde mit dem Index.
//
// Ausblenden (E35, Nutzerregel 24.10.2026: alte Kurse kommen nie hinein,
// nicht erst später ausgeschlossen): Kursdokumente mit Kursnummer außerhalb
// von A kommen in keinen Schritt der Suche. Der Ausschluss sitzt als
// Filterbedingung „id NOT IN (…)“ in jeder Anfrage an LanceDB
// (lance/index.js filteredQueryRows, wie der Metadatenfilter aus KIE-480),
// also vor Vektor- und Stichwortsuche und vor dem Reranker. Es gibt keine
// Obergrenze und keinen Rückfall mit nachträglichem Verwerfen: Die Zeilen
// tragen keine Dokumentspalte (docId steht nur in document_vectors, title
// und url sind nicht eindeutig je Dokument), deshalb stehen alle
// Abschnitt-IDs in der Bedingung. Zwei Formen: eine Liste und, falls
// LanceDB die ablehnt, Blöcke per AND; die angenommene Form merkt sich der
// Index. Lehnt LanceDB beide ab, bringt die Anfrage keine Treffer
// (fail-closed), andere Fehler gehen wie ohne Ausschluss an den Aufrufer.
// Verwaiste Abschnitte (Zeile in der Tabelle, Dokument dem Workspace
// unbekannt) und Abschnitte von Dokumenten mit unlesbarer Datei werden beim
// stündlichen Aufbau über ihren Kopfblock geprüft und stehen ebenso in der
// Bedingung. Angeheftete Dokumente, der Rückgriff über fillSourceWindow und
// die Kurskarten wählen ihre Dokumente nach denselben Regeln aus (guard),
// dort wird nicht gesucht. Dokumente ohne Kursnummer sind nie betroffen.
//
// Ohne gültigen Wert (fehlt, kein JSON, version nicht 2, workspace fehlt,
// keine gültige Kursnummer in offered, älter als 24 h) oder in einem anderen
// Workspace als dem der Kursliste gibt es weder Zahl noch Ausblenden: alles
// wie vorher (NAK-K1, NAK-K2), das kostet je Aufruf nur das Lesen der einen
// Zeile. Im Workspace der Kursliste gilt sie auch, wenn dort kein
// angebotener Kurs eingelernt ist (count 0, alles fehlt, die Status-Seite
// zeigt Rot; r5 ersetzt die frühere Sonderregel E-KB3-4). Ungültige
// einzelne Einträge in offered werden übersprungen. Ein kaputter Eintrag
// kippt nie den Chat: alle Einstiege fangen Fehler ab. Eine Dokumentdatei,
// die sich nicht lesen lässt, zählt als nicht verfügbar: Ist es ein Kurs,
// erscheint er als fehlend wie jeder andere fehlende Kurs (D-r6-1). Ein
// unvollständiger Index (Vektorspeicher nicht lesbar) und ein gescheiterter
// Aufbau (Datenbankfehler) werden nur 2 min gemerkt.

const fs = require("fs");
const prisma = require("../prisma");
const {
  courseNumberFromText,
  courseDocumentSummary,
} = require("./embedCourseSources");

const COURSE_INVENTORY_LABEL = "kufer_course_inventory";
// Vertrag: höchstens 512 KiB (UTF-8)
const INVENTORY_MAX_BYTES = 512 * 1024;
// Vertrag: älter als 24 h -> kein Ausblenden, keine Zahl
const INVENTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Uhrabweichung zwischen Pipeline und Container (created in der Zukunft)
const INVENTORY_FUTURE_MS = 60 * 60 * 1000;
// AK-K4: Index je Workspace und Wert höchstens 1 h gemerkt
const INDEX_MAX_AGE_MS = 60 * 60 * 1000;
// r3-S3 a: ein unvollständiger oder gescheiterter Index nur 2 min
const INCOMPLETE_INDEX_MAX_AGE_MS = 2 * 60 * 1000;
const COURSE_NUMBER_MAX_LEN = 64;
const CLIENT_MAX_LEN = 200;
// KB-4, r5: nur Version 2 (mit workspace, Titeln und Laufmeldung)
const CONTRACT_VERSION = 2;
// r5: workspace im Format eines AnythingLLM-Slugs. Workspace.slugify (lower)
// erzeugt nur diese Zeichen (Kleinbuchstaben, Ziffern, „-“, „_“ und aus
// Ersetzungen wie „©“ -> „(c)“ auch . ' " ( ) * +), der Rückfall ist eine
// uuidv4. Verglichen wird nur auf Gleichheit, der Wert kommt in keine Anfrage.
const WORKSPACE_SLUG_RX = /^[a-z0-9_.'"()*+-]{1,255}$/;
const TITLE_MAX_LEN = 200;
const RUN_RESULTS = ["ok", "nicht_geschrieben", "fehler"];
const RUN_CAUSES = [
  null,
  "feed_nicht_erreichbar",
  "feed_unsicher",
  "feed_eingebrochen",
  "einlernen_fehlgeschlagen",
];
const CONTROL_RX = /[\p{Cc}\u2028\u2029]/u;
// Kursdokumente sind klein; größere Dateien (PDF, lange Seiten) werden für
// die Kursnummer nicht gelesen und zählen als Dokument ohne Kursnummer
const DOC_FILE_MAX_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 8;
// Größe der IN-Listen an Datenbank und LanceDB
const QUERY_BATCH = 500;
// Zweite Form des Ausschlusses: Blöcke „id NOT IN (…)“ dieser Größe per AND
// (ohne Obergrenze für die Zahl der Blöcke)
const EXCLUSION_BLOCK = 1000;
// Vektor-IDs (uuidv4) für die Filterbedingung; eine andere ID kommt nie in
// die Anfrage, dann gilt fail-closed (keine Treffer)
const VECTOR_ID_RX = /^[A-Za-z0-9_.:-]{1,100}$/;
// KB-3: höchstens so viele Einträge je Liste der Status-Seite
const STATUS_LIST_MAX = 500;
// Dokumentdatei nicht lesbar (fehlt, kein JSON): nicht verfügbar, also kein
// eingelerntes Kursdokument; nicht über die Stunde hinaus gemerkt, seine
// Abschnitte werden über den Kopfblock geprüft
const UNREADABLE = Symbol("unreadable");

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
  if (data.version !== CONTRACT_VERSION) return "version ist nicht 2";
  if (
    typeof data.workspace !== "string" ||
    !WORKSPACE_SLUG_RX.test(data.workspace)
  )
    return "workspace fehlt oder ist kein Slug";
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
  // einzelne ungültige Einträge überspringt readCourseInventory (J)
  if (!data.offered.some((number) => courseKey(number) !== null))
    return "offered enthält keine gültige Kursnummer";
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

// KB-4: Laufmeldung run mit erlaubten Werten, sonst null (verworfen)
function readRun(data) {
  const { run } = data;
  if (!isPlainObject(run) || typeof run.at !== "string") return null;
  const atMs = Date.parse(run.at);
  if (
    !Number.isFinite(atMs) ||
    !RUN_RESULTS.includes(run.result) ||
    !RUN_CAUSES.includes(run.cause)
  )
    return null;
  return {
    at: new Date(atMs).toISOString(),
    atMs,
    result: run.result,
    cause: run.cause,
  };
}

// KB-4: Titel als Map Vergleichsform -> Titel, nur für Kursnummern in
// offered; ungültige Einträge werden übersprungen
function readTitles(data, offered) {
  const titles = new Map();
  if (!isPlainObject(data.titles)) return titles;
  for (const [number, title] of Object.entries(data.titles)) {
    const key = courseKey(number);
    if (
      key !== null &&
      offered.has(key) &&
      typeof title === "string" &&
      title.trim().length > 0 &&
      title.length <= TITLE_MAX_LEN &&
      !CONTROL_RX.test(title)
    )
      titles.set(key, title);
  }
  return titles;
}

// Alter des Werts nach Vertrag: höchstens 24 h, höchstens 1 h in der Zukunft
function ageProblem(createdMs, now) {
  const age = now - createdMs;
  if (age > INVENTORY_MAX_AGE_MS) return "created älter als 24 h";
  if (age < -INVENTORY_FUTURE_MS) return "created liegt in der Zukunft";
  return null;
}

/**
 * Wendet der Chat diese Kursliste gerade an (Zahl, Ausblenden)? Nur, wenn
 * created höchstens 24 h alt ist (run.at zählt nicht). Eine Stelle für
 * Chatpfad (loadCourseInventory) und Status-Seite (listApplied, Fixliste r4
 * Nr. 2), damit die Seite nie etwas anderes zeigt, als der Chat tut.
 * @param {{createdMs: number}} inventory - Laufzeitform aus readCourseInventory
 * @param {number} now
 * @returns {boolean}
 */
function courseListApplies(inventory, now) {
  return ageProblem(inventory.createdMs, now) === null;
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
  // KB-4: eine Laufmeldung behält created, maßgeblich ist der jüngere
  // Zeitpunkt (created oder run.at)
  const reason =
    problem ||
    ageProblem(
      Math.max(Date.parse(data.created), readRun(data)?.atMs ?? -Infinity),
      now
    );
  if (reason) throw new Error(`${COURSE_INVENTORY_LABEL}: ${reason}`);
  return update;
}

/**
 * Laufzeitform eines gespeicherten Werts (ohne Altersprüfung, die macht
 * loadCourseInventory je Aufruf). Leer -> {inventory: null} ohne problem.
 * Ungültige Einträge in offered werden übersprungen (skipped).
 * @param {*} raw
 * @returns {{inventory: {raw: string, workspace: string, createdMs: number, stand: string, offered: Set<string>, numbers: Map<string, string>, titles: Map<string, string>, estimatedEnd: boolean, run: {at: string, atMs: number, result: string, cause: string|null}|null}|null, problem?: string, skipped?: number}}
 */
function readCourseInventory(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { inventory: null };
  const { data, problem } = readContract(raw);
  if (problem) return { inventory: null, problem };
  const createdMs = Date.parse(data.created);
  const keys = data.offered.map(courseKey);
  const offered = new Set(keys.filter((key) => key !== null));
  // KB-3: Kursnummer in der Schreibweise des Kursprogramms (Status-Seite)
  const numbers = new Map();
  keys.forEach((key, i) => {
    if (key !== null && !numbers.has(key))
      numbers.set(key, data.offered[i].normalize("NFC").trim());
  });
  return {
    inventory: {
      raw,
      workspace: data.workspace,
      createdMs,
      stand: new Date(createdMs).toISOString(),
      offered,
      numbers,
      titles: readTitles(data, offered),
      estimatedEnd: data.estimatedEnd === true,
      run: readRun(data),
    },
    skipped: keys.length - keys.filter((key) => key !== null).length,
  };
}

// Zuletzt gelesener Wert und seine Laufzeitform: neu geparst wird nur, wenn
// sich der gespeicherte Wert ändert (die Pipeline schreibt aus einem anderen
// Prozess, deshalb wird der Wert je Anfrage gelesen, eine Zeile per Label).
let cached = { raw: null, inventory: null };

/** Der gespeicherte Wert; wirft bei einem Lesefehler der Datenbank. */
async function readStoredInventory() {
  const row = await prisma.system_settings.findFirst({
    where: { label: COURSE_INVENTORY_LABEL },
    select: { value: true },
  });
  return row?.value ?? null;
}

/**
 * KB-4: gültiger Wert des Containers ohne Altersprüfung (Laufzeitform von
 * readCourseInventory mit titles, estimatedEnd und run), sonst null. Nur
 * intern für die Status-Seite (KB-3): Titel und Laufmeldung kommen nie in
 * /config, Prompt oder Suche. Wirft bei einem Lesefehler der Datenbank
 * (Fixliste r2 Nr. 6: die Status-Seite zeigt dann einen Fehler, nicht
 * „nicht eingerichtet“).
 * @returns {Promise<object|null>}
 */
async function courseInventoryRecord() {
  const raw = await readStoredInventory();
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw !== cached.raw) {
    const { inventory, problem, skipped } = readCourseInventory(raw);
    // verworfenen Wert und übersprungene Einträge melden, dank Cache einmal
    // je Wert
    if (problem)
      console.error(`[courseInventory] Kursliste verworfen: ${problem}`);
    if (skipped)
      console.error(
        `[courseInventory] Kursliste: ${skipped} ungültige Kursnummern übersprungen`
      );
    cached = { raw, inventory };
  }
  return cached.inventory;
}

/**
 * Kursbestand des Containers, den der Chat anwendet (gültig und
 * courseListApplies), sonst null. Wirft bei einem Lesefehler der Datenbank;
 * die Chatpfade fangen ihn an einer Stelle ab (workspaceInventory).
 * @param {{now?: number}} [options]
 * @returns {Promise<{raw: string, createdMs: number, stand: string, offered: Set<string>}|null>}
 */
async function loadCourseInventory({ now = Date.now() } = {}) {
  const inventory = await courseInventoryRecord();
  return inventory && courseListApplies(inventory, now) ? inventory : null;
}

// ---------------------------------------------------------------------------
// Index je Workspace (B, veraltete Dokumente, Vorfilter)
// ---------------------------------------------------------------------------

// Dokumentdatei als Objekt oder null (außerhalb der Dokumente, zu groß);
// wirft bei fehlender oder kaputter Datei
async function readDocumentFile(docpath) {
  const { documentsPath, isWithin, normalizePath } = require("../files");
  const path = require("path");
  const full = path.resolve(documentsPath, normalizePath(docpath));
  if (!isWithin(path.resolve(documentsPath), full)) return null;
  const stat = await fs.promises.stat(full);
  if (!stat.isFile() || stat.size > DOC_FILE_MAX_BYTES) return null;
  const doc = JSON.parse(await fs.promises.readFile(full, "utf8"));
  return isPlainObject(doc) ? doc : null;
}

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
      const doc = await readDocumentFile(docpath);
      return typeof doc?.pageContent === "string" ? doc.pageContent : null;
    },
    // KB-3: das Dokument ({pageContent, start_date, …}) oder null
    readDocument: async (docpath) => await readDocumentFile(docpath),
    // Alle Zeilen der Tabelle als [{id, title, published}], einmal je Aufbau
    // (AK-K9: vorhandene Abschnitte, KR-1: verwaiste, I: Uploads der
    // gespeicherten Quellen); null = nicht prüfbar (anderer Vektorspeicher)
    // -> es zählt document_vectors
    tableRows: async (slug) => {
      const { getVectorDbClass } = require("../helpers");
      const VectorDb = getVectorDbClass();
      if (typeof VectorDb?.tableRows !== "function") return null;
      return await VectorDb.tableRows(slug);
    },
    // KR-1: Text der Abschnitte zu den IDs, als [{id, text}]; null = nicht
    // prüfbar
    rowTexts: async (slug, ids) => {
      const { getVectorDbClass } = require("../helpers");
      const VectorDb = getVectorDbClass();
      if (typeof VectorDb?.rowTexts !== "function") return null;
      return await VectorDb.rowTexts(slug, ids);
    },
  };
}

let deps = defaultDeps();
// slug -> {raw, builtAt, promise}
const indexCache = new Map();
// slug -> Map(docpath -> Kursnummer|null|UNREADABLE): Dokumentdateien
// ändern sich nicht (ein neuer Upload bekommt einen neuen docpath), deshalb
// über die Stunde hinaus gemerkt (UNREADABLE nicht); Einträge entfallener
// Dokumente werden beim Neuaufbau entfernt.
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
    if (previous.has(docpath) && previous.get(docpath) !== UNREADABLE) {
      memo.set(docpath, previous.get(docpath));
      return;
    }
    let key = null;
    try {
      key = courseKeyOfText(await deps.readDocumentText(docpath));
    } catch {
      key = UNREADABLE;
    }
    memo.set(docpath, key);
  });
  docKeyMemo.set(slug, memo);
  return memo;
}

const notIn = (ids) => `id NOT IN (${ids.map((id) => `'${id}'`).join(",")})`;

/**
 * Bedingungen für den Ausschluss, ohne Obergrenze: [eine Liste, Blöcke per
 * AND]. Leer, wenn nichts auszuschließen ist; null, wenn eine ID nicht in
 * die Anfrage darf (dann fail-closed).
 * @param {Set<string>} ids
 * @returns {string[]|null}
 */
function exclusionClauses(ids) {
  const list = [...ids].sort();
  if (list.length === 0) return [];
  if (!list.every((id) => typeof id === "string" && VECTOR_ID_RX.test(id)))
    return null;
  const blocks = [];
  for (let i = 0; i < list.length; i += EXCLUSION_BLOCK)
    blocks.push(`(${notIn(list.slice(i, i + EXCLUSION_BLOCK))})`);
  return [notIn(list), blocks.join(" AND ")];
}

// Veraltet nach dem eigenen Kopfblock (Kursnummer außerhalb von A)
function textIsStale(index, text) {
  const key = courseKeyOfText(text);
  return key !== null && !index.offered.has(key);
}

// Upload, zu dem ein Abschnitt gehört: title und published teilen alle
// Abschnitte eines Uploads (die Zeilen tragen keine Dokumentspalte)
function uploadGroup(row) {
  return typeof row?.title === "string" && typeof row?.published === "string"
    ? `${row.title}\u0000${row.published}`
    : null;
}

/**
 * KR-1: Abschnitte, die kein lesbares Dokument des Workspace erklärt, über
 * ihren Kopfblock prüfen: verwaiste Zeilen (gruppiert über ihren Upload) und
 * Abschnitte von Dokumenten mit unlesbarer Datei (gruppiert über docId).
 * Ergebnis: die auszuschließenden IDs. Fehler gehen an buildIndex (S4).
 */
async function headBlockExclusions(slug, offered, { orphans, unreadable }) {
  const out = new Set();
  const ids = [
    ...orphans.map((row) => row.id),
    ...unreadable.flatMap(({ vectorIds }) => vectorIds),
  ];
  if (ids.length === 0) return out;
  const texts = (await deps.rowTexts(slug, ids)) || [];
  const textById = new Map(texts.map((row) => [row.id, row.text]));
  const stale = (id) => textIsStale({ offered }, textById.get(id));
  const staleGroups = new Set();
  for (const row of orphans)
    if (stale(row.id)) {
      out.add(row.id);
      const group = uploadGroup(row);
      if (group !== null) staleGroups.add(group);
    }
  for (const row of orphans)
    if (staleGroups.has(uploadGroup(row))) out.add(row.id);
  for (const { vectorIds } of unreadable)
    if (vectorIds.some(stale)) for (const id of vectorIds) out.add(id);
  return out;
}

/**
 * Index des Workspace der Kursliste bauen (r5: nur dieser Workspace, auch
 * ohne einen einzigen angebotenen Kurs, dann ist count 0).
 * @param {string} slug
 * @param {object} inventory - Laufzeitform aus readCourseInventory
 * @returns {Promise<object|null>} null: Workspace unbekannt
 */
async function buildIndex(slug, inventory) {
  const workspaceId = await deps.findWorkspaceId(slug);
  if (!workspaceId) return null;
  const documents = (await deps.listDocuments(workspaceId)) || [];
  const keys = await documentKeys(slug, documents);

  const withKeys = documents.map((doc) => ({
    ...doc,
    key: keys.get(doc.docpath) ?? null,
  }));
  const courseDocs = withKeys.filter((doc) => typeof doc.key === "string");

  const offered = inventory.offered;
  const base = { slug, inventory, offered, complete: true };

  // Abschnitte aller Dokumente: welche Zeilen der Tabelle der Workspace kennt
  const vectorsByDoc = new Map();
  for (const { docId, vectorId } of await deps.listVectors(
    documents.map((doc) => doc.docId)
  )) {
    if (!vectorsByDoc.has(docId)) vectorsByDoc.set(docId, []);
    vectorsByDoc.get(docId).push(vectorId);
  }

  // Zeilen der Tabelle einmal lesen (G): AK-K9 welche Abschnitte gibt es
  // wirklich im Vektorspeicher, KR-1 verwaiste Abschnitte. Fehler: Index
  // gilt, wird aber nur 2 min gemerkt (S4, r3-S3 a)
  let rows = null;
  try {
    rows = await deps.tableRows(slug);
  } catch (error) {
    console.error(
      `[courseInventory] Suchdaten nicht prüfbar: ${error.message}`
    );
    base.complete = false;
  }
  const present = rows ? new Set(rows.map((row) => row.id)) : null;
  const embedded = (doc) => {
    const ids = vectorsByDoc.get(doc.docId) || [];
    if (ids.length === 0) return false;
    return present === null ? true : ids.some((id) => present.has(id));
  };
  const known = new Set(courseDocs.filter(embedded).map((doc) => doc.key));
  let count = 0;
  for (const key of known) if (offered.has(key)) count++;

  const staleDocs = courseDocs.filter((doc) => !offered.has(doc.key));
  // hidden wie count (r3-S4): verschiedene Kursnummern der eingelernten
  // veralteten Dokumente; ausgeschlossen werden alle veralteten
  // KB-3: je Kursnummer das erste Dokument (Liste der Status-Seite)
  const hiddenDocs = new Map();
  for (const doc of staleDocs.filter(embedded))
    if (!hiddenDocs.has(doc.key)) hiddenDocs.set(doc.key, doc.docpath);
  const hidden = hiddenDocs.size;
  const excludedIds = new Set(
    staleDocs.flatMap((doc) => vectorsByDoc.get(doc.docId) || [])
  );
  const knownIds = new Set();
  for (const ids of vectorsByDoc.values())
    for (const id of ids) knownIds.add(id);
  let headBlockIds = new Set();
  try {
    headBlockIds = await headBlockExclusions(slug, offered, {
      orphans: (rows || []).filter((row) => !knownIds.has(row.id)),
      unreadable: withKeys
        .filter((doc) => doc.key === UNREADABLE)
        .map((doc) => ({ vectorIds: vectorsByDoc.get(doc.docId) || [] }))
        .filter(({ vectorIds }) => vectorIds.length > 0),
    });
  } catch (error) {
    console.error(
      `[courseInventory] Abschnitte ohne lesbares Dokument nicht prüfbar: ${error.message}`
    );
    base.complete = false;
  }
  for (const id of headBlockIds) excludedIds.add(id);

  // I (S6): Uploads der Tabelle, deren Abschnitte alle ausgeschlossen sind
  // (eindeutig veraltet), für gespeicherte Quellen ohne Kopfblock
  const uploadStale = new Map();
  for (const row of rows || []) {
    const group = uploadGroup(row);
    if (group === null) continue;
    uploadStale.set(
      group,
      (uploadStale.get(group) ?? true) && excludedIds.has(row.id)
    );
  }
  const staleUploads = new Set(
    [...uploadStale].filter(([, stale]) => stale).map(([group]) => group)
  );
  return {
    ...base,
    counts: { count, offered: offered.size, hidden },
    // KB-3: eingelernte Kursnummern (fehlend = offered ohne diese) und die
    // ausgeblendeten mit Dokument, nur für die Status-Seite
    knownKeys: known,
    hiddenDocs,
    staleDocCount: staleDocs.length,
    headBlockCount: headBlockIds.size,
    excludedIds,
    staleUploads,
    clauses: exclusionClauses(excludedIds),
    // F: zuletzt angenommene Form der Bedingung, zuerst versucht
    form: { accepted: 0 },
  };
}

/**
 * Index eines Workspace (Namespace = slug) zum gültigen Kursbestand, gemerkt
 * höchstens 1 h je Workspace und Wert (AK-K4); null ohne gültigen Wert, ohne
 * Workspace oder für einen anderen Workspace als den der Kursliste (r5:
 * dann wird nichts weiter gelesen). Ein unvollständiger Index und ein
 * gescheiterter Aufbau werden nur 2 min gemerkt (S4, r3-S3 a, D-r6-1),
 * damit der Chatpfad nicht je Anfrage neu baut. anyAge (KB-3, Status-Seite):
 * auch ein Wert, den der Chat nicht mehr anwendet, derselbe Index je Wert.
 * Wirft bei einem Fehler (Datenbank, Aufbau des Index): Die Status-Seite
 * meldet ihn (Fixliste r2 Nr. 6), die Chatpfade nutzen workspaceInventory.
 * @param {string} slug
 * @param {{now?: number, anyAge?: boolean}} [options]
 * @returns {Promise<object|null>}
 */
async function workspaceIndex(slug, { now = Date.now(), anyAge = false } = {}) {
  if (typeof slug !== "string" || slug.length === 0) return null;
  // KB-3: die Status-Seite bewertet auch einen Wert über 24 h (Alter)
  const inventory = anyAge
    ? await courseInventoryRecord()
    : await loadCourseInventory({ now });
  if (!inventory || inventory.workspace !== slug) return null;
  const entry = indexCache.get(slug);
  if (
    entry &&
    entry.raw === inventory.raw &&
    now - entry.builtAt >= 0 &&
    now - entry.builtAt < entry.maxAge
  )
    return await entry.promise;
  const fresh = {
    raw: inventory.raw,
    builtAt: now,
    maxAge: INDEX_MAX_AGE_MS,
    promise: buildIndex(slug, inventory),
  };
  indexCache.set(slug, fresh);
  try {
    const index = await fresh.promise;
    if (!index?.complete) fresh.maxAge = INCOMPLETE_INDEX_MAX_AGE_MS;
    return index;
  } catch (error) {
    fresh.maxAge = INCOMPLETE_INDEX_MAX_AGE_MS;
    throw error;
  }
}

/**
 * workspaceIndex für die Chatpfade: bei einem Fehler (Datenbank, Aufbau des
 * Index) eine Logzeile und null, dann bleibt alles wie ohne Kursliste
 * (NAK-K1). Wirft nie.
 * @param {string} slug
 * @param {{now?: number}} [options]
 * @returns {Promise<object|null>}
 */
async function workspaceInventory(slug, options) {
  try {
    return await workspaceIndex(slug, options);
  } catch (error) {
    console.error(`[courseInventory] Index nicht gebaut: ${error.message}`);
    return null;
  }
}

// Ist ein Abschnitt (Treffer oder gespeicherte Quelle) veraltet? Über seine
// Vektor-ID (Dokument des Workspace mit Kursnummer außerhalb von A) oder über
// seinen eigenen Kopfblock (auch ein Abschnitt, dessen Dokument der
// Workspace nicht mehr kennt). Ohne Kopfblock über title und published
// seinem Upload zugeordnet (I, S6): nur ein eindeutig veralteter Upload
// blendet aus, ohne bekanntes Dokument bleibt der Abschnitt.
function rowIsStale(index, row) {
  if (!row || typeof row !== "object") return false;
  if (typeof row.id === "string" && index.excludedIds.has(row.id)) return true;
  const key = courseKeyOfText(row.text);
  if (key !== null) return !index.offered.has(key);
  return index.staleUploads.has(uploadGroup(row));
}

/**
 * Ausschluss für eine Suche im Vektorspeicher (lance/index.js): clauses =
 * die Formen der Filterbedingung („id NOT IN (…)“ als eine Liste, dann als
 * Blöcke per AND), in jeder Anfrage, ohne Obergrenze. clauses leer heißt
 * fail-closed: keine Treffer (eine ID darf nicht in die Anfrage). form:
 * die zuletzt angenommene Form, gemeinsam für alle Suchen bis zum nächsten
 * Aufbau des Index (F). stats zählt je Suche die Anfragen ohne Treffer,
 * weil LanceDB jede Form abgelehnt hat. null: nichts auszublenden (kein
 * gültiger Wert, nicht der Workspace der Kursliste, kein veralteter
 * Abschnitt). Wirft nie.
 * @param {string} namespace
 * @returns {Promise<{clauses: string[], form: {accepted: number}, excludedIds: number, staleDocs: number, headBlockIds: number, stats: {failClosed: number}}|null>}
 */
async function courseSearchExclusion(namespace) {
  const index = await workspaceInventory(namespace);
  if (!index || index.excludedIds.size === 0) return null;
  return {
    clauses: index.clauses || [],
    form: index.form,
    excludedIds: index.excludedIds.size,
    staleDocs: index.staleDocCount,
    headBlockIds: index.headBlockCount,
    stats: { failClosed: 0 },
  };
}

/**
 * Prüfer für die Chatpfade (angeheftete Dokumente, Rückgriff über
 * fillSourceWindow, Kurskarten). null ohne gültigen Kursbestand für diesen
 * Workspace: dann bleibt alles wie heute (NAK-K1). Wirft nie.
 * @param {{slug?: string}|null} workspace
 * @returns {Promise<object|null>}
 */
async function courseInventoryGuard(workspace) {
  const index = await workspaceInventory(workspace?.slug);
  if (!index) return null;
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
 * Zahlen des Kursbestands, nur intern (Betreiber-Info; öffentlich liefert
 * /config davon nur count, die Vorschau im Design Center ebenso): {count,
 * offered, hidden, stand}; hidden = verschiedene Kursnummern der eingelernten
 * veralteten Kursdokumente, die die Suche ausblendet (D-K5, gezählt wie
 * count). null ohne gültigen Wert oder in einem anderen Workspace als dem
 * der Kursliste. Wirft nie.
 * @param {{slug?: string}|null} workspace
 * @returns {Promise<{count: number, offered: number, hidden: number, stand: string}|null>}
 */
async function courseInventoryStatus(workspace) {
  const index = await workspaceInventory(workspace?.slug);
  if (!index) return null;
  return { ...index.counts, stand: index.inventory.stand };
}

// KB-3: Einträge der ausgeblendeten Kurse je Index; die Dokumente werden
// einmal je Index gelesen (höchstens STATUS_LIST_MAX)
const hiddenEntries = new WeakMap();

async function readHiddenEntries(index) {
  const docs = [...index.hiddenDocs].slice(0, STATUS_LIST_MAX);
  return await mapWithLimit(docs, READ_CONCURRENCY, async ([key, docpath]) => {
    let summary = null;
    try {
      summary = courseDocumentSummary(await deps.readDocument(docpath));
    } catch {
      // Datei fehlt oder ist kaputt: nur die Kursnummer
    }
    const knr = summary?.knr;
    return {
      knr: courseKey(knr) === key ? knr : key,
      title: summary?.title ?? null,
      start: summary?.start ?? null,
      duration: summary?.duration ?? null,
    };
  });
}

/**
 * KB-3: Kursbestand eines Workspace für die Status-Seite, auch über 24 h
 * (anyAge): der Wert (Laufzeitform mit titles, run, estimatedEnd), ob der
 * Chat ihn gerade anwendet (listApplied, courseListApplies), die Zahlen und
 * die Listen, je höchstens 500 Einträge. missing: angebotene,
 * nicht eingelernte Kurse mit Titel aus der Kursliste (ohne Titel null);
 * hidden: eingelernte Kurse außerhalb der Kursliste mit Titel, Beginn und
 * Dauer aus ihrem Kursdokument. null ohne gültigen Wert oder in einem
 * anderen Workspace als dem der Kursliste (nicht eingerichtet). lists
 * false: ohne Listen (Ampel, Menüpunkt). Nur lesend. Wirft bei einem Lesefehler
 * (Datenbank, Aufbau des Index), damit er nicht als „nicht eingerichtet“
 * erscheint (Fixliste r2 Nr. 6).
 * @param {{slug?: string}|null} workspace
 * @param {{now?: number, lists?: boolean}} [options]
 * @returns {Promise<{inventory: object, listApplied: boolean, counts: {count: number, offered: number, hidden: number}, missing?: Array<{knr: string, title: string|null}>, hidden?: Array<{knr: string, title: string|null, start: string|null, duration: string|null}>}|null>}
 */
async function courseInventoryDetails(
  workspace,
  { now = Date.now(), lists = true } = {}
) {
  const index = await workspaceIndex(workspace?.slug, { now, anyAge: true });
  if (!index) return null;
  const { inventory } = index;
  const listApplied = courseListApplies(inventory, now);
  if (!lists) return { inventory, listApplied, counts: index.counts };
  const missing = [];
  for (const key of index.offered) {
    if (missing.length >= STATUS_LIST_MAX) break;
    if (index.knownKeys.has(key)) continue;
    missing.push({
      knr: inventory.numbers.get(key) ?? key,
      title: inventory.titles.get(key) ?? null,
    });
  }
  if (!hiddenEntries.has(index))
    hiddenEntries.set(index, readHiddenEntries(index));
  return {
    inventory,
    listApplied,
    counts: index.counts,
    missing,
    hidden: await hiddenEntries.get(index),
  };
}

/**
 * Feld courseCount für GET /embed/:id/config nach Vertrag: nur mit Anzeige
 * an, gültigem, höchstens 24 h altem Wert (loadCourseInventory) und
 * count ≥ 1, sonst null (das Feld fehlt ganz). Öffentlich nur {count, word}
 * (Fixliste r4 Nr. 2): offered, hidden und stand sind Betreiber-Info und
 * bleiben intern (courseInventoryStatus).
 * @param {{slug?: string}|null} workspace
 * @param {{mode: "on"|"off", word: string}} options
 * @returns {Promise<{count: number, word: string}|null>}
 */
async function courseCountField(workspace, { mode, word }) {
  if (mode !== "on") return null;
  const status = await courseInventoryStatus(workspace);
  if (!status || status.count < 1) return null;
  return { count: status.count, word };
}

module.exports = {
  COURSE_INVENTORY_LABEL,
  validateCourseInventorySetting,
  loadCourseInventory,
  courseInventoryRecord,
  courseSearchExclusion,
  courseInventoryGuard,
  courseInventoryStatus,
  courseCountField,
  courseInventoryDetails,
  STATUS_LIST_MAX,
  // nur für Tests
  __test__: {
    INVENTORY_MAX_BYTES,
    INVENTORY_MAX_AGE_MS,
    INDEX_MAX_AGE_MS,
    INCOMPLETE_INDEX_MAX_AGE_MS,
    EXCLUSION_BLOCK,
    TITLE_MAX_LEN,
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
