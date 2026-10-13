/* eslint-env jest, node */
// KIE-538 — POST /embed/:embedId/analytics/export: Export der Konversationen
// einer Auswahl als CSV oder JSON.
//
// Geprüft wird gegen die echte Route mit ihrer ganzen Middleware-Kette
// (support/routeHarness.js: Anmeldung, Rollenprüfung, Bindung an den
// Workspace) und gegen eine echte SQLite-Datei aus den Migrationen
// (helpers/sqliteTestDatabase.js) - Gruppierung, Nummerierung und Filter
// laufen wie im Betrieb, die Liste (analytics/conversations) dient als
// Vergleich.
//
// Die CSV wird mit einem eigenen, vom geprüften Code unabhängigen Leser nach
// RFC 4180 zurückgelesen (parseCsv unten).
//
// Die Zeitzone des Prozesses wird nicht gesetzt; alle Zeitpunkte sind
// Berliner Wanduhrzeiten (berlinInstant). Die Erwartungen gelten für TZ=UTC,
// TZ=Europe/Berlin und TZ=America/New_York (extras/scripts/testTimezones.mjs).
jest.mock(
  "../../utils/prisma",
  () => require("../helpers/sqliteTestDatabase").testPrisma
);
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
// Kein Abruf der Modell-Liste aus dem Netz beim Laden der Provider.
jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: () => null },
}));
// Nur für den Passwortschutz des Einbenutzerbetriebs nötig (hier ohne).
jest.mock("../../utils/EncryptionManager", () => ({
  EncryptionManager: class {
    decrypt() {
      return null;
    }
  },
}));
jest.mock("../../utils/files/multer", () => ({
  handleEmbedLogoUpload: jest.fn((_request, _response, next) => next()),
}));
jest.mock("../../utils/files/embedLogo", () => ({
  deleteOldEmbedLogo: jest.fn(),
}));

// Setzt JWT_SECRET, bevor utils/http geladen wird.
const { collectRoutes, invoke } = require("./support/routeHarness");
// Adressen und Rümpfe, wie der Browser sie sendet - dieselben, gegen die das
// Frontend geprüft ist.
const {
  ROUTES,
  conversationsBody,
  exportBody,
} = require("./support/embedAnalyticsRequests");
const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
  createEmbed,
  berlinInstant,
  eventsOf,
  tableChecksum,
} = require("../helpers/sqliteTestDatabase");
const { makeJWT } = require("../../utils/http");
const { MessageLedger } = require("../../models/messageLedger");
const { EmbedChats } = require("../../models/embedChats");
const { embedManagementEndpoints } = require("../../endpoints/embedManagement");
const {
  conversationExport,
  csvCell,
  defuseCell,
  exportFileName,
  fileNameSlug,
  formatBerlinDateTime,
  formatBerlinIso,
  primed,
  writeChunks,
} = require("../../utils/helpers/chat/embedConversationExport");

const routes = collectRoutes(embedManagementEndpoints);
const EXPORT = routes[`${ROUTES.export.method} ${ROUTES.export.path}`];
const CONVERSATIONS =
  routes[`${ROUTES.conversations.method} ${ROUTES.conversations.path}`];

const HEADERS = [
  "Konversation",
  "Konversations-ID",
  "Nachricht",
  "Zeitpunkt",
  "Frage",
  "Antwort",
  "Bewertung",
  "Grund der negativen Bewertung",
  "Kommentar zur negativen Bewertung",
];

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

let db;
let errorSpy;
let logSpy;
let userCounter = 0;
let admin;

beforeEach(async () => {
  MessageLedger._resetCache();
  delete process.env.DISABLE_VIEW_CHAT_HISTORY;
  db = await createTestDatabase();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  await setMultiUserMode(true);
  admin = await createUser("admin");
});
afterEach(async () => {
  delete process.env.DISABLE_VIEW_CHAT_HISTORY;
  jest.restoreAllMocks();
  errorSpy.mockRestore();
  logSpy.mockRestore();
  await db.close();
});
afterAll(() => {
  MessageLedger._resetCache();
  removeTestDatabases();
});

// ---------------------------------------------------------------------------
// Bestand
// ---------------------------------------------------------------------------

async function setMultiUserMode(enabled) {
  await db.client.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: String(enabled) },
    create: { label: "multi_user_mode", value: String(enabled) },
  });
}

/**
 * Legt einen Nutzer an und liefert sein Sitzungs-Token (echtes JWT).
 * @param {"admin"|"manager"|"default"} role
 * @param {number[]} [workspaceIds] - Mitgliedschaften
 */
async function createUser(role, workspaceIds = []) {
  const user = await db.client.users.create({
    data: { username: `${role}-${++userCounter}`, password: "x", role },
  });
  for (const workspaceId of workspaceIds)
    await db.client.workspace_users.create({
      data: { user_id: user.id, workspace_id: workspaceId },
    });
  return {
    id: user.id,
    role,
    token: makeJWT({ id: user.id, username: user.username }),
  };
}

// Was eine gespeicherte Antwort außer dem Text enthält - nichts davon darf in
// den Export.
const SOURCE_TEXT = "QUELLENTEXT-aus-dem-Kursprogramm";
const CONNECTION = { ip: "203.0.113.77", host: "https://kunde.example.org" };

/**
 * Eine Widget-Nachricht, wie der Chat sie speichert: Antwort als JSON mit
 * Text und Quellen, Verbindungsdaten der Sitzung.
 */
async function addChat(
  embed,
  { at, prompt = "Frage", answer = "Antwort", conversation, session, ...data }
) {
  return await db.client.embed_chats.create({
    data: {
      embed_id: embed.id,
      prompt,
      response: JSON.stringify({
        text: answer,
        type: "chat",
        sources: [{ title: "kursprogramm.pdf", text: SOURCE_TEXT }],
      }),
      session_id: session ?? `sitzung-${conversation}`,
      conversation_id: conversation ?? null,
      connection_information: JSON.stringify(CONNECTION),
      createdAt: at,
      ...data,
    },
  });
}

/** Zeitraum der Ansicht, wie ein Browser in Berlin ihn sendet: ganze Tage. */
function period(fromDay, toDay) {
  const next = new Date(`${toDay}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    startDate: berlinInstant(fromDay, 0, 0).toISOString(),
    endDate: new Date(
      berlinInstant(next.toISOString().slice(0, 10), 0, 0).getTime() - 1
    ).toISOString(),
  };
}
const SEPTEMBER = period("2026-09-01", "2026-09-30");
const OCTOBER = period("2026-10-01", "2026-10-31");

function exportFile(embed, format, request = {}, user = admin, prepare) {
  return invoke(EXPORT, {
    params: { embedId: String(embed?.id ?? embed) },
    body: exportBody(format, request),
    token: user?.token ?? null,
    prepare,
  });
}

/** Die Liste über alle Seiten, wie die Ansicht sie beim Blättern lädt. */
async function listAll(embed, request = {}, user = admin) {
  const limit = 5;
  const all = [];
  for (let offset = 0; ; offset += limit) {
    const result = await invoke(CONVERSATIONS, {
      params: { embedId: String(embed.id) },
      body: conversationsBody({ ...request, offset, limit }),
      token: user?.token ?? null,
    });
    expect(result.statusCode).toBe(200);
    all.push(...result.body.conversations);
    if (!result.body.hasMore) {
      expect(all).toHaveLength(result.body.totalCount);
      return all;
    }
  }
}

// ---------------------------------------------------------------------------
// Unabhängiger Leser nach RFC 4180 (mit Semikolon als Trenner)
// ---------------------------------------------------------------------------

/**
 * Liest eine CSV streng nach RFC 4180: Zeilen enden mit CRLF (auch die
 * letzte), eine Zelle steht ganz oder gar nicht in Anführungszeichen, darin
 * ist "" ein Anführungszeichen; Trenner und Zeilenumbrüche gelten in
 * Anführungszeichen als Inhalt. Alles andere ist ein Fehler.
 * @param {string} text - ohne BOM
 * @returns {string[][]}
 */
function parseCsv(text, delimiter = ";") {
  const rows = [];
  let row = [];
  let i = 0;
  while (i < text.length) {
    let cell = "";
    if (text[i] === '"') {
      i += 1;
      for (;;) {
        if (i >= text.length)
          throw new Error("Anführungszeichen nicht geschlossen");
        if (text[i] !== '"') {
          cell += text[i];
          i += 1;
        } else if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          i += 1;
          break;
        }
      }
      if (text[i] !== delimiter && text.slice(i, i + 2) !== "\r\n")
        throw new Error(`Zeichen nach schließendem Anführungszeichen (${i})`);
    } else {
      while (
        i < text.length &&
        text[i] !== delimiter &&
        text[i] !== "\r" &&
        text[i] !== "\n"
      ) {
        if (text[i] === '"')
          throw new Error(`Anführungszeichen in einer Zelle ohne (${i})`);
        cell += text[i];
        i += 1;
      }
    }
    row.push(cell);
    if (text[i] === delimiter) {
      i += 1;
      // Ein Trenner am Zeilenende beginnt eine letzte, leere Zelle.
      if (text.slice(i, i + 2) === "\r\n") {
        row.push("");
        rows.push(row);
        row = [];
        i += 2;
      } else if (i >= text.length) {
        throw new Error("Datei endet ohne CRLF");
      }
    } else if (text.slice(i, i + 2) === "\r\n") {
      rows.push(row);
      row = [];
      i += 2;
    } else {
      throw new Error(`Zeile endet nicht mit CRLF (${i})`);
    }
  }
  if (row.length > 0) throw new Error("Datei endet ohne CRLF");
  return rows;
}

/** Zeilen der Exportdatei als Objekte (Spaltenname → Zelle), ohne Kopfzeile. */
function table(result) {
  expect(result.statusCode).toBe(200);
  expect(typeof result.body).toBe("string");
  expect(result.body.charCodeAt(0)).toBe(0xfeff);
  const [header, ...rows] = parseCsv(result.body.slice(1));
  expect(header).toEqual(HEADERS);
  for (const row of rows) expect(row).toHaveLength(HEADERS.length);
  return rows.map((row) =>
    Object.fromEntries(HEADERS.map((name, i) => [name, row[i]]))
  );
}

/** Berliner Zeit "TT.MM.JJJJ HH:MM:SS", unabhängig vom geprüften Code. */
function berlinText(instant) {
  return new Date(instant)
    .toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
    .replace(",", "");
}

/**
 * Ist das eine Zelle, die eine Tabellenkalkulation als Formel lesen könnte?
 * Unabhängig vom geprüften Code formuliert: beginnt mit Tabulator oder
 * Wagenrücklauf, oder das erste Zeichen nach führendem Leerraum ist eines der
 * Formelzeichen.
 */
const BLANK = [" ", "\t", "\n", "\r", "\u00A0", "\u200B", "\uFEFF", "\u3000"];
const TRIGGERS = ["=", "+", "-", "@", "\uFF1D", "\uFF0B", "\uFF0D", "\uFF20"];
function looksLikeFormula(text) {
  if (text.startsWith("\t") || text.startsWith("\r")) return true;
  let i = 0;
  while (i < text.length && BLANK.includes(text[i])) i += 1;
  return TRIGGERS.includes(text[i]);
}

/** Kleiner, reproduzierbarer Zufallsgenerator (mulberry32). */
function random(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// AK-1 — Export entspricht der Auswahl
// ============================================================================
describe("entspricht_auswahl (AK-1)", () => {
  let workspace, widgetA, widgetB;
  // Erwartung, unabhängig vom Server geführt: Konversation → ihre Nachrichten
  let seeded;

  /** n Nachrichten einer Konversation, die erste zur Berliner Wanduhrzeit. */
  async function converse(embed, name, day, hour, minute, n) {
    const start = berlinInstant(day, hour, minute).getTime();
    const messages = [];
    for (let i = 0; i < n; i++) {
      const at = new Date(start + i * 90_000);
      const prompt = `${name}: Frage ${i + 1}`;
      const answer = `${name}: Antwort ${i + 1}`;
      await addChat(embed, { at, prompt, answer, conversation: name });
      messages.push({ at, prompt, answer });
    }
    seeded.set(name, { startedAt: start, messages });
  }

  beforeEach(async () => {
    seeded = new Map();
    workspace = await createWorkspace(db.client, { name: "VHS Musterstadt" });
    widgetA = await createEmbed(db.client, workspace);
    widgetB = await createEmbed(db.client, workspace);
    // Widget A: 12 Konversationen im September, 5 im Oktober
    for (let i = 1; i <= 12; i++) {
      const day = `2026-09-${String(2 * i).padStart(2, "0")}`;
      await converse(
        widgetA,
        `sep-${String(i).padStart(2, "0")}`,
        day,
        8 + i,
        15,
        1 + (i % 4)
      );
    }
    for (let i = 1; i <= 5; i++)
      await converse(widgetA, `okt-${i}`, `2026-10-0${i}`, 10, 0, 2);
    // Widget B im selben Workspace: darf nie in der Datei von A stehen
    await addChat(widgetB, {
      at: berlinInstant("2026-09-10", 12, 0),
      prompt: "Widget B: Frage",
      answer: "Widget B: Antwort",
      conversation: "b-1",
    });
  });

  /** Was die Datei enthalten muss: Konversationen nach Beginn absteigend nummeriert. */
  function expectedRows(names) {
    const ordered = [...names].sort(
      (a, b) => seeded.get(b).startedAt - seeded.get(a).startedAt
    );
    return ordered.flatMap((name, index) =>
      seeded.get(name).messages.map((message, i) => ({
        Konversation: String(index + 1),
        "Konversations-ID": name,
        Nachricht: String(i + 1),
        Zeitpunkt: berlinText(message.at),
        Frage: message.prompt,
        Antwort: message.answer,
        Bewertung: "",
        "Grund der negativen Bewertung": "",
        "Kommentar zur negativen Bewertung": "",
      }))
    );
  }
  const september = () =>
    [...seeded.keys()].filter((name) => name.startsWith("sep-"));

  test("entspricht_auswahl: Widget A, Zeitraum September, Filter „Alle“ - die CSV enthält genau die Nachrichten der 12 September-Konversationen, sortiert nach Konversation und Zeitpunkt", async () => {
    const result = await exportFile(widgetA, "csv", SEPTEMBER);
    const rows = table(result);

    expect(rows).toEqual(expectedRows(september()));
    expect(new Set(rows.map((row) => row["Konversations-ID"])).size).toBe(12);
    // 12 Konversationen mit 1 + (i % 4) Nachrichten
    expect(rows).toHaveLength(30);
    expect(result.body).not.toMatch(/okt-|Widget B/);

    // Sortierung: Konversation aufsteigend, darin Nachricht aufsteigend
    const order = rows.map((row) => [
      Number(row.Konversation),
      Number(row.Nachricht),
    ]);
    expect(order).toEqual(
      [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    );
  });

  test("entspricht_auswahl: dieselben Konversationen, dieselben Nummern und dieselbe Zahl an Nachrichten wie die Liste über alle Seiten", async () => {
    const listed = await listAll(widgetA, SEPTEMBER);
    const rows = table(await exportFile(widgetA, "csv", SEPTEMBER));

    expect(listed).toHaveLength(12);
    const fromList = listed
      .map((c) => [c.conversation_number, c.conversation_id, c.message_count])
      .sort((a, b) => a[0] - b[0]);
    const counts = new Map();
    for (const row of rows) {
      const key = `${row.Konversation}|${row["Konversations-ID"]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const fromExport = [...counts].map(([key, count]) => {
      const [number, id] = key.split("|");
      return [Number(number), id, count];
    });
    expect(fromExport).toEqual(fromList);
  });

  test("entspricht_auswahl: Oktober und „Gesamt“ liefern ihre eigene Menge", async () => {
    const october = table(await exportFile(widgetA, "csv", OCTOBER));
    expect(october).toEqual(
      expectedRows([...seeded.keys()].filter((name) => name.startsWith("okt-")))
    );

    const all = table(await exportFile(widgetA, "csv"));
    expect(all).toEqual(expectedRows([...seeded.keys()]));
    expect(all).toHaveLength(40);
  });

  test("entspricht_auswahl: Abschnitts-Filter aus dem Diagramm (KIE-536) - exportiert wird, was die Liste für den Abschnitt zeigt", async () => {
    // KW 37: Montag 07.09. bis Sonntag 13.09. → sep-04 (08.09.), sep-05 (10.09.), sep-06 (12.09.)
    const bucket = { start: "2026-09-07", end: "2026-09-13" };
    const listed = await listAll(widgetA, { ...SEPTEMBER, bucket });
    const rows = table(
      await exportFile(widgetA, "csv", { ...SEPTEMBER, bucket })
    );

    const ids = (values) => [...new Set(values)].sort();
    expect(ids(rows.map((row) => row["Konversations-ID"]))).toEqual([
      "sep-04",
      "sep-05",
      "sep-06",
    ]);
    expect(ids(rows.map((row) => row["Konversations-ID"]))).toEqual(
      ids(listed.map((c) => c.conversation_id))
    );
    // Die Nummer ist die der Liste - dort mit Abschnitt über alle
    // Konversationen des Widgets vergeben, nicht nur über die drei.
    expect(
      Object.fromEntries(
        rows.map((row) => [row["Konversations-ID"], Number(row.Konversation)])
      )
    ).toEqual(
      Object.fromEntries(
        listed.map((c) => [c.conversation_id, c.conversation_number])
      )
    );
    // Eine vor dem Abschnitt begonnene Konversation, die im Abschnitt
    // weitergeht, gehört nicht dazu (wie in der Liste).
    await addChat(widgetA, {
      at: berlinInstant("2026-09-09", 9, 0),
      conversation: "sep-01",
    });
    const again = table(
      await exportFile(widgetA, "csv", { ...SEPTEMBER, bucket })
    );
    expect(ids(again.map((row) => row["Konversations-ID"]))).toEqual([
      "sep-04",
      "sep-05",
      "sep-06",
    ]);
  });

  test("entspricht_auswahl: für jede Auswahl dieselbe Menge an Konversations-IDs wie die Liste (Zeitraum × Filter × Abschnitt)", async () => {
    // Bewertungen verteilt: 👎 in sep-03 und okt-2, 👍 in sep-07 und sep-03
    const rate = async (conversation, feedbackScore) => {
      const chat = await db.client.embed_chats.findFirst({
        where: { conversation_id: conversation },
        orderBy: { id: "desc" },
      });
      await db.client.embed_chats.update({
        where: { id: chat.id },
        data: { feedbackScore },
      });
    };
    await rate("sep-03", false);
    await rate("okt-2", false);
    await rate("sep-07", true);
    const firstOfSep03 = await db.client.embed_chats.findFirst({
      where: { conversation_id: "sep-03" },
      orderBy: { id: "asc" },
    });
    await db.client.embed_chats.update({
      where: { id: firstOfSep03.id },
      data: { feedbackScore: true },
    });

    const periods = [
      SEPTEMBER,
      OCTOBER,
      {},
      period("2026-09-06", "2026-10-02"),
    ];
    const buckets = [
      null,
      { start: "2026-09-01", end: "2026-09-30" },
      { start: "2026-09-06", end: "2026-09-06" },
      { start: "2026-10-01", end: "2026-10-03" },
    ];
    let compared = 0;
    for (const range of periods)
      for (const feedbackFilter of ["all", "negative", "positive"])
        for (const bucket of buckets) {
          const request = { ...range, feedbackFilter, bucket };
          const listed = await listAll(widgetA, request);
          const rows = table(await exportFile(widgetA, "csv", request));
          const json = JSON.parse(
            (await exportFile(widgetA, "json", request)).body
          );

          const fromList = listed.map((c) => c.conversation_id).sort();
          expect([
            JSON.stringify(request),
            [...new Set(rows.map((row) => row["Konversations-ID"]))].sort(),
          ]).toEqual([JSON.stringify(request), fromList]);
          expect(json.map((c) => c.conversationId).sort()).toEqual(fromList);
          expect(rows).toHaveLength(
            listed.reduce((sum, c) => sum + c.message_count, 0)
          );
          compared += 1;
        }
    expect(compared).toBe(48);
  });

  test("entspricht_auswahl: Was die Liste nicht zeigt, steht nicht im Export - vom Besucher geleerte Konversationen und Nachrichten außerhalb des Zeitraums", async () => {
    // Vom Besucher geleert (markHistoryInvalid): ganz und teilweise
    await addChat(widgetA, {
      at: berlinInstant("2026-09-15", 9, 0),
      prompt: "GELEERT ganz",
      conversation: "geleert",
      include: false,
    });
    await addChat(widgetA, {
      at: berlinInstant("2026-09-16", 9, 0),
      prompt: "GELEERT teilweise",
      conversation: "teils",
      include: false,
    });
    await addChat(widgetA, {
      at: berlinInstant("2026-09-16", 9, 5),
      prompt: "nach dem Leeren",
      conversation: "teils",
    });
    // Über die Monatsgrenze: 30.09. 23:58 und 01.10. 00:03 Berliner Zeit
    await addChat(widgetA, {
      at: berlinInstant("2026-09-30", 23, 58),
      prompt: "vor Mitternacht",
      conversation: "grenze",
    });
    await addChat(widgetA, {
      at: berlinInstant("2026-10-01", 0, 3),
      prompt: "nach Mitternacht",
      conversation: "grenze",
    });

    const listed = await listAll(widgetA, SEPTEMBER);
    const rows = table(await exportFile(widgetA, "csv", SEPTEMBER));
    const byId = (id) => rows.filter((row) => row["Konversations-ID"] === id);

    expect(listed.map((c) => c.conversation_id)).not.toContain("geleert");
    expect(byId("geleert")).toEqual([]);
    expect(byId("teils").map((row) => row.Frage)).toEqual(["nach dem Leeren"]);
    expect(byId("grenze").map((row) => row.Frage)).toEqual(["vor Mitternacht"]);
    expect(rows.map((row) => row.Frage).join("\n")).not.toMatch(/GELEERT/);
    // Zeilen je Konversation = message_count der Liste
    for (const conversation of listed)
      expect([
        conversation.conversation_id,
        byId(conversation.conversation_id).length,
      ]).toEqual([conversation.conversation_id, conversation.message_count]);

    // Die Nachricht nach Mitternacht steht im Oktober-Export.
    const october = table(await exportFile(widgetA, "csv", OCTOBER));
    expect(
      october
        .filter((row) => row["Konversations-ID"] === "grenze")
        .map((row) => row.Frage)
    ).toEqual(["nach Mitternacht"]);
  });

  test("entspricht_auswahl: Alt-Zeilen ohne conversation_id bilden je Browser-Sitzung eine Konversation - wie in der Liste, nur ohne die Sitzungs-Kennung als ID", async () => {
    for (const minute of [0, 2, 4])
      await addChat(widgetA, {
        at: berlinInstant("2026-09-20", 14, minute),
        prompt: `Alt ${minute}`,
        session: "alt-sitzung-1",
      });
    // Dieselbe Sitzung hat später eine Konversation mit eigener Kennung.
    await addChat(widgetA, {
      at: berlinInstant("2026-09-21", 9, 0),
      prompt: "Neu in alter Sitzung",
      conversation: "neu-in-alt",
      session: "alt-sitzung-1",
    });

    const listed = await listAll(widgetA, SEPTEMBER);
    const legacy = listed.find((c) => c.conversation_id === "alt-sitzung-1");
    expect(legacy.message_count).toBe(3);

    const rows = table(await exportFile(widgetA, "csv", SEPTEMBER));
    const legacyRows = rows.filter(
      (row) => Number(row.Konversation) === legacy.conversation_number
    );
    expect(legacyRows.map((row) => row.Frage)).toEqual([
      "Alt 0",
      "Alt 2",
      "Alt 4",
    ]);
    expect(legacyRows.map((row) => row["Konversations-ID"])).toEqual([
      "",
      "",
      "",
    ]);
    expect(
      rows
        .filter((row) => row["Konversations-ID"] === "neu-in-alt")
        .map((row) => row.Frage)
    ).toEqual(["Neu in alter Sitzung"]);
    // 12 + Alt-Konversation + „neu-in-alt"
    expect(new Set(rows.map((row) => row.Konversation)).size).toBe(14);
    expect(listed).toHaveLength(14);
  });

  test("entspricht_auswahl: ein leerer Zeitraum ergibt eine Datei nur mit Kopfzeile bzw. eine leere Liste", async () => {
    const empty = period("2025-01-01", "2025-01-31");
    const csv = await exportFile(widgetA, "csv", empty);
    expect(table(csv)).toEqual([]);
    expect(csv.body).toBe(
      `\uFEFF${HEADERS.map((h) => `"${h}"`).join(";")}\r\n`
    );

    const json = await exportFile(widgetA, "json", empty);
    expect(json.statusCode).toBe(200);
    expect(JSON.parse(json.body)).toEqual([]);

    // Widget ganz ohne Nachrichten
    const fresh = await createEmbed(db.client, workspace);
    expect(table(await exportFile(fresh, "csv"))).toEqual([]);
  });

  test("entspricht_auswahl: Dateiname aus Widget und Zeitraum (AK-10), Antwort als Anhang", async () => {
    const csv = await exportFile(widgetA, "csv", SEPTEMBER);
    expect(csv.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(csv.headers["Content-Disposition"]).toBe(
      `attachment; filename="konversationen_vhs-musterstadt-${widgetA.id}_2026-09-01_2026-09-30.csv"`
    );

    const json = await exportFile(widgetA, "json", {
      ...SEPTEMBER,
      bucket: { start: "2026-09-07", end: "2026-09-13" },
    });
    expect(json.headers["Content-Type"]).toBe(
      "application/json; charset=utf-8"
    );
    expect(json.headers["Content-Disposition"]).toBe(
      `attachment; filename="konversationen_vhs-musterstadt-${widgetA.id}_2026-09-07_2026-09-13.json"`
    );

    const all = await exportFile(widgetA, "csv");
    expect(all.headers["Content-Disposition"]).toBe(
      `attachment; filename="konversationen_vhs-musterstadt-${widgetA.id}_gesamt.csv"`
    );
  });
});

// ============================================================================
// AK-2 — Bewertungsfilter wirkt im Export
// ============================================================================
describe("filter (AK-2)", () => {
  let embed;

  beforeEach(async () => {
    const workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
    const day = "2026-09-10";
    // a: drei Nachrichten, die zweite 👎
    await addChat(embed, {
      at: berlinInstant(day, 9, 0),
      prompt: "a1",
      conversation: "a",
    });
    await addChat(embed, {
      at: berlinInstant(day, 9, 1),
      prompt: "a2",
      conversation: "a",
      feedbackScore: false,
      feedbackReason: "Zu ungenau",
      feedbackText: "Das Datum fehlt.",
    });
    await addChat(embed, {
      at: berlinInstant(day, 9, 2),
      prompt: "a3",
      conversation: "a",
    });
    // b: zwei Nachrichten, eine 👍
    await addChat(embed, {
      at: berlinInstant(day, 10, 0),
      prompt: "b1",
      conversation: "b",
      feedbackScore: true,
    });
    await addChat(embed, {
      at: berlinInstant(day, 10, 1),
      prompt: "b2",
      conversation: "b",
    });
    // c: ohne Bewertung
    await addChat(embed, {
      at: berlinInstant(day, 11, 0),
      prompt: "c1",
      conversation: "c",
    });
    // d: 👍 und 👎
    await addChat(embed, {
      at: berlinInstant(day, 12, 0),
      prompt: "d1",
      conversation: "d",
      feedbackScore: true,
    });
    await addChat(embed, {
      at: berlinInstant(day, 12, 1),
      prompt: "d2",
      conversation: "d",
      feedbackScore: false,
    });
    // e: 👎 im Oktober - außerhalb des Zeitraums
    await addChat(embed, {
      at: berlinInstant("2026-10-02", 9, 0),
      prompt: "e1",
      conversation: "e",
      feedbackScore: false,
    });
  });

  const prompts = (rows) => rows.map((row) => row.Frage);

  test("filter: „Mit negativer Bewertung“ - nur Konversationen mit mindestens einer negativ bewerteten Antwort, jeweils vollständig", async () => {
    const rows = table(
      await exportFile(embed, "csv", {
        ...SEPTEMBER,
        feedbackFilter: "negative",
      })
    );
    // d (12:00) ist jünger als a (09:00); beide vollständig, auch die
    // unbewerteten und positiv bewerteten Nachrichten.
    expect(prompts(rows)).toEqual(["d1", "d2", "a1", "a2", "a3"]);
    expect(rows.map((row) => row.Bewertung)).toEqual([
      "positiv",
      "negativ",
      "",
      "negativ",
      "",
    ]);
  });

  test("filter: „Mit positiver Bewertung“ und „Alle“", async () => {
    expect(
      prompts(
        table(
          await exportFile(embed, "csv", {
            ...SEPTEMBER,
            feedbackFilter: "positive",
          })
        )
      )
    ).toEqual(["d1", "d2", "b1", "b2"]);
    expect(prompts(table(await exportFile(embed, "csv", SEPTEMBER)))).toEqual([
      "d1",
      "d2",
      "c1",
      "b1",
      "b2",
      "a1",
      "a2",
      "a3",
    ]);
  });

  test("filter: Die laufende Nummer ist die der ungefilterten Liste", async () => {
    const all = await listAll(embed, SEPTEMBER);
    const number = Object.fromEntries(
      all.map((c) => [c.conversation_id, c.conversation_number])
    );
    expect(number).toEqual({ d: 1, c: 2, b: 3, a: 4 });

    const rows = table(
      await exportFile(embed, "csv", {
        ...SEPTEMBER,
        feedbackFilter: "negative",
      })
    );
    expect([
      ...new Set(
        rows.map((row) => `${row["Konversations-ID"]}=${row.Konversation}`)
      ),
    ]).toEqual(["d=1", "a=4"]);
  });

  test("filter: derselbe Legacy-Schalter und dieselbe Normalisierung wie die Liste (onlyNegative, unbekannter Wert → „Alle“)", async () => {
    const send = async (body) => {
      const result = await invoke(EXPORT, {
        params: { embedId: String(embed.id) },
        body: { format: "csv", ...SEPTEMBER, ...body },
        token: admin.token,
      });
      return [...new Set(table(result).map((row) => row["Konversations-ID"]))];
    };
    expect(await send({ onlyNegative: true })).toEqual(["d", "a"]);
    expect(
      await send({ feedbackFilter: "positive", onlyNegative: true })
    ).toEqual(["d", "b"]);
    expect(await send({ feedbackFilter: "1=1) OR (1=1" })).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
    expect(await send({ feedbackFilter: "" })).toEqual(["d", "c", "b", "a"]);
  });
});

// ============================================================================
// AK-3 — CSV öffnet in Excel korrekt
// ============================================================================
describe("csv_format (AK-3)", () => {
  let embed;
  beforeEach(async () => {
    const workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
  });

  const TRICKY = {
    prompt: 'Größe "L"; oder „XL“? Müßiggänger & Ärzte – 5 €',
    answer:
      'Erste Zeile\nZweite Zeile; mit Semikolon\r\nDritte "Zeile"\n\n  eingerückt  ',
  };

  test("csv_format: UTF-8 mit BOM (EF BB BF), Semikolon als Trenner, CRLF als Zeilenende", async () => {
    await addChat(embed, {
      at: berlinInstant("2026-09-01", 8, 30),
      conversation: "k-1",
      ...TRICKY,
    });
    const result = await exportFile(embed, "csv");
    const bytes = Buffer.from(result.body, "utf8");

    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // genau ein BOM, am Anfang
    expect(result.body.indexOf("\uFEFF", 1)).toBe(-1);
    // Kopfzeile: neun Spalten, Semikolon
    const firstLine = result.body.slice(1, result.body.indexOf("\r\n"));
    expect(firstLine).toBe(HEADERS.map((name) => `"${name}"`).join(";"));
    expect(result.body.endsWith("\r\n")).toBe(true);
    // Umlaute als UTF-8: „ö“ = C3 B6, „€“ = E2 82 AC
    expect(bytes.includes(Buffer.from("Größe", "utf8"))).toBe(true);
    expect(bytes.includes(Buffer.from([0xe2, 0x82, 0xac]))).toBe(true);
    // jedes Stück der gestreamten Antwort ist eine ganze Zeile
    expect(result.chunks).toHaveLength(2);
    for (const chunk of result.chunks)
      expect(chunk.endsWith("\r\n")).toBe(true);
  });

  test("csv_format: Anführungszeichen verdoppelt, Semikolon und Zeilenumbrüche bleiben in einer Zelle, Werte stehen in den richtigen Spalten", async () => {
    await addChat(embed, {
      at: berlinInstant("2026-09-01", 8, 30),
      conversation: "k-1",
      ...TRICKY,
      feedbackScore: false,
      feedbackReason: 'Grund; mit "Zeichen"',
      feedbackText: "Kommentar\nzweizeilig",
    });
    const result = await exportFile(embed, "csv");

    // wörtlich: die Datenzeile, wie sie in der Datei steht
    const dataLine = result.body.slice(result.body.indexOf("\r\n") + 2);
    expect(dataLine).toBe(
      [
        "1",
        '"k-1"',
        "1",
        '"01.09.2026 08:30:00"',
        '"Größe ""L""; oder „XL“? Müßiggänger & Ärzte – 5 €"',
        '"Erste Zeile\nZweite Zeile; mit Semikolon\r\nDritte ""Zeile""\n\n  eingerückt  "',
        '"negativ"',
        '"Grund; mit ""Zeichen"""',
        '"Kommentar\nzweizeilig"',
      ].join(";") + "\r\n"
    );

    // zurückgelesen: eine Zeile, die Zellen unverändert
    expect(table(result)).toEqual([
      {
        Konversation: "1",
        "Konversations-ID": "k-1",
        Nachricht: "1",
        Zeitpunkt: "01.09.2026 08:30:00",
        Frage: TRICKY.prompt,
        Antwort: TRICKY.answer,
        Bewertung: "negativ",
        "Grund der negativen Bewertung": 'Grund; mit "Zeichen"',
        "Kommentar zur negativen Bewertung": "Kommentar\nzweizeilig",
      },
    ]);
  });

  test("csv_format: Rundlauf - 400 zufällige Texte kommen aus dem unabhängigen RFC-4180-Leser so zurück, wie sie gespeichert wurden (bis auf die Entschärfung)", async () => {
    const next = random(538);
    const alphabet = [
      ..."aZ09äÖß€",
      "😀",
      '"',
      '"',
      ";",
      ";",
      ",",
      "\n",
      "\r",
      "\r\n",
      "\t",
      " ",
      " ",
      "\u00A0",
      "\u200B",
      "'",
      "=",
      "+",
      "-",
      "@",
      "\uFF1D",
      "|",
      "\\",
    ];
    const text = () =>
      Array.from(
        { length: Math.floor(next() * 14) },
        () => alphabet[Math.floor(next() * alphabet.length)]
      ).join("");

    const start = berlinInstant("2026-09-05", 8, 0).getTime();
    const stored = Array.from({ length: 400 }, (_, i) => ({
      conversation: `k-${String(i).padStart(3, "0")}`,
      at: new Date(start + i * 60_000),
      prompt: text(),
      answer: text(),
      reason: text(),
      comment: text(),
    }));
    await db.client.embed_chats.createMany({
      data: stored.map((entry) => ({
        embed_id: embed.id,
        prompt: entry.prompt,
        response: JSON.stringify({ text: entry.answer, sources: [] }),
        session_id: `sitzung-${entry.conversation}`,
        conversation_id: entry.conversation,
        createdAt: entry.at,
        feedbackScore: false,
        feedbackReason: entry.reason,
        feedbackText: entry.comment,
      })),
    });

    const rows = table(await exportFile(embed, "csv"));
    expect(rows).toHaveLength(400);
    const byId = new Map(rows.map((row) => [row["Konversations-ID"], row]));
    const cell = (value) => (looksLikeFormula(value) ? `'${value}` : value);
    let defused = 0;
    for (const entry of stored) {
      const row = byId.get(entry.conversation);
      expect([entry.conversation, row.Frage]).toEqual([
        entry.conversation,
        cell(entry.prompt),
      ]);
      expect(row.Antwort).toBe(cell(entry.answer));
      expect(row["Grund der negativen Bewertung"]).toBe(cell(entry.reason));
      expect(row["Kommentar zur negativen Bewertung"]).toBe(
        cell(entry.comment)
      );
      expect(row.Zeitpunkt).toBe(berlinText(entry.at));
      for (const value of [
        entry.prompt,
        entry.answer,
        entry.reason,
        entry.comment,
      ])
        if (looksLikeFormula(value)) defused += 1;
    }
    // Der Zufall hat beide Fälle reichlich getroffen.
    expect(defused).toBeGreaterThan(100);
    expect(defused).toBeLessThan(1500);
  });

  test("csv_format: der Leser dieser Datei weist kaputte CSV zurück (Gegenprobe)", () => {
    expect(parseCsv('"a";b\r\n"c""d";\r\n')).toEqual([
      ["a", "b"],
      ['c"d', ""],
    ]);
    expect(parseCsv('"x\r\ny;z";1\r\n')).toEqual([["x\r\ny;z", "1"]]);
    for (const broken of [
      "a;b",
      "a;b\n",
      'a"b;c\r\n',
      '"a"b;c\r\n',
      '"offen;c\r\n',
      "a\rb\r\n",
    ])
      expect(() => parseCsv(broken)).toThrow();
  });

  test("csv_format: csvCell - Zahlen ohne, Text immer in Anführungszeichen, leer bleibt leer", () => {
    expect(csvCell(12)).toBe("12");
    expect(csvCell("12")).toBe('"12"');
    expect(csvCell("")).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(NaN)).toBe("");
    expect(csvCell(' a "b" ')).toBe('" a ""b"" "');
  });
});

// ============================================================================
// AK-4 — Spalten und Zeitpunkte
// ============================================================================
describe("spalten (AK-4)", () => {
  test("spalten: drei Nachrichten, eine negativ bewertet mit Grund und Kommentar - jede Zeile hat die neun Spalten, der Zeitpunkt ist Berliner Zeit TT.MM.JJJJ HH:MM:SS", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    // 06:30:05 UTC = 08:30:05 Berliner Sommerzeit
    await addChat(embed, {
      at: new Date("2026-09-01T06:30:05.000Z"),
      prompt: "Wann beginnt der Kurs?",
      answer: "Am Montag um 18 Uhr.",
      conversation: "konv-1",
      feedbackScore: true,
    });
    await addChat(embed, {
      at: new Date("2026-09-01T06:31:40.250Z"),
      prompt: "Und was kostet er?",
      answer: "Das weiß ich leider nicht.",
      conversation: "konv-1",
      feedbackScore: false,
      feedbackReason: "Zu ungenau",
      feedbackText: "Der Preis steht doch auf der Seite.",
    });
    await addChat(embed, {
      at: new Date("2026-09-01T06:33:00.000Z"),
      prompt: "Danke",
      answer: "Gern.",
      conversation: "konv-1",
    });

    const result = await exportFile(embed, "csv");
    const [header, ...rows] = parseCsv(result.body.slice(1));

    expect(header).toEqual(HEADERS);
    expect(header).toHaveLength(9);
    expect(rows).toEqual([
      [
        "1",
        "konv-1",
        "1",
        "01.09.2026 08:30:05",
        "Wann beginnt der Kurs?",
        "Am Montag um 18 Uhr.",
        "positiv",
        "",
        "",
      ],
      [
        "1",
        "konv-1",
        "2",
        "01.09.2026 08:31:40",
        "Und was kostet er?",
        "Das weiß ich leider nicht.",
        "negativ",
        "Zu ungenau",
        "Der Preis steht doch auf der Seite.",
      ],
      ["1", "konv-1", "3", "01.09.2026 08:33:00", "Danke", "Gern.", "", "", ""],
    ]);
    for (const row of rows) {
      expect(row).toHaveLength(9);
      expect(row[3]).toMatch(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/);
    }
  });

  test("spalten: Berliner Zeit über Tages-, Jahres- und Zeitumstellungsgrenzen - unabhängig von der Zeitzone des Servers", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const cases = [
      // UTC → Berlin
      ["2026-09-30T22:30:00.000Z", "01.10.2026 00:30:00"], // Sommerzeit, Folgetag
      ["2026-12-01T07:00:00.000Z", "01.12.2026 08:00:00"], // Winterzeit
      ["2026-12-31T23:59:59.000Z", "01.01.2027 00:59:59"], // Jahreswechsel
      ["2026-03-29T00:59:59.000Z", "29.03.2026 01:59:59"], // vor der Umstellung
      ["2026-03-29T01:00:00.000Z", "29.03.2026 03:00:00"], // 02:00 gibt es nicht
      ["2026-10-25T00:30:00.000Z", "25.10.2026 02:30:00"], // 02:30 zum ersten Mal
      ["2026-10-25T01:30:00.000Z", "25.10.2026 02:30:00"], // 02:30 zum zweiten Mal
      ["2026-07-04T22:00:00.000Z", "05.07.2026 00:00:00"], // Mitternacht ist 00, nicht 24
    ];
    for (const [i, [instant]] of cases.entries())
      await addChat(embed, {
        at: new Date(instant),
        prompt: `Fall ${i}`,
        conversation: `fall-${i}`,
      });

    const rows = table(await exportFile(embed, "csv"));
    const shown = Object.fromEntries(
      rows.map((row) => [row.Frage, row.Zeitpunkt])
    );
    for (const [i, [instant, expected]] of cases.entries()) {
      expect([instant, shown[`Fall ${i}`]]).toEqual([instant, expected]);
      expect(formatBerlinDateTime(new Date(instant))).toBe(expected);
      expect(berlinText(instant)).toBe(expected);
    }
    // JSON: dieselbe Wanduhrzeit mit Versatz - die doppelte Stunde ist eindeutig
    expect(formatBerlinIso(new Date("2026-10-25T00:30:00.000Z"))).toBe(
      "2026-10-25T02:30:00+02:00"
    );
    expect(formatBerlinIso(new Date("2026-10-25T01:30:00.000Z"))).toBe(
      "2026-10-25T02:30:00+01:00"
    );
    expect(formatBerlinDateTime(new Date(NaN))).toBe("");
    expect(formatBerlinIso(new Date(NaN))).toBeNull();
  });

  test("spalten: Grund und Kommentar erscheinen nur bei einer negativen Bewertung; eine Antwort ohne lesbaren Text bleibt leer", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const at = berlinInstant("2026-09-02", 9, 0).getTime();
    const base = { embed_id: embed.id, session_id: "s", conversation_id: "k" };
    await db.client.embed_chats.createMany({
      data: [
        // Reste eines Kommentars an einer positiven bzw. unbewerteten Zeile
        {
          ...base,
          prompt: "p1",
          response: JSON.stringify({ text: "a1" }),
          createdAt: new Date(at),
          feedbackScore: true,
          feedbackReason: "REST",
          feedbackText: "REST",
        },
        {
          ...base,
          prompt: "p2",
          response: JSON.stringify({ text: "a2" }),
          createdAt: new Date(at + 1000),
          feedbackScore: null,
          feedbackReason: "REST",
          feedbackText: "REST",
        },
        // kein JSON, JSON ohne text, text ist kein Text
        {
          ...base,
          prompt: "p3",
          response: "kein JSON {",
          createdAt: new Date(at + 2000),
        },
        {
          ...base,
          prompt: "p4",
          response: JSON.stringify({ sources: [{ text: SOURCE_TEXT }] }),
          createdAt: new Date(at + 3000),
        },
        {
          ...base,
          prompt: "p5",
          response: JSON.stringify({ text: { nested: SOURCE_TEXT } }),
          createdAt: new Date(at + 4000),
        },
        {
          ...base,
          prompt: "p6",
          response: JSON.stringify({ text: 42 }),
          createdAt: new Date(at + 5000),
        },
        {
          ...base,
          prompt: "p7",
          response: "[]",
          createdAt: new Date(at + 6000),
        },
      ],
    });

    const result = await exportFile(embed, "csv");
    const rows = table(result);
    expect(rows.map((row) => [row.Frage, row.Antwort, row.Bewertung])).toEqual([
      ["p1", "a1", "positiv"],
      ["p2", "a2", ""],
      ["p3", "", ""],
      ["p4", "", ""],
      ["p5", "", ""],
      ["p6", "", ""],
      ["p7", "", ""],
    ]);
    expect(result.body).not.toMatch(/REST|QUELLENTEXT|kein JSON/);
    const json = JSON.parse((await exportFile(embed, "json")).body);
    expect(json[0].messages.map((m) => m.response)).toEqual([
      "a1",
      "a2",
      "",
      "",
      "",
      "",
      "",
    ]);
  });
});

// ============================================================================
// AK-5 — JSON-Export
// ============================================================================
describe("json (AK-5)", () => {
  test("json: eine Liste von Konversationen mit ihren Nachrichten und denselben Feldern wie die CSV", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await addChat(embed, {
      at: new Date("2026-09-01T06:30:05.000Z"),
      prompt: 'Frage mit "Anführung"; und\nUmbruch',
      answer: "=Antwort wie eine Formel",
      conversation: "konv-1",
    });
    await addChat(embed, {
      at: new Date("2026-09-01T06:31:00.000Z"),
      prompt: "Zweite Frage",
      answer: "Zweite Antwort",
      conversation: "konv-1",
      feedbackScore: false,
      feedbackReason: "Zu ungenau",
      feedbackText: "Bitte genauer.",
    });
    await addChat(embed, {
      at: new Date("2026-09-02T10:00:00.000Z"),
      prompt: "Neue Konversation",
      answer: "Ja.",
      conversation: "konv-2",
      feedbackScore: true,
    });
    await addChat(embed, {
      at: new Date("2026-08-30T10:00:00.000Z"),
      prompt: "Alt-Zeile",
      answer: "Alt-Antwort",
      session: "alt-sitzung",
    });

    const result = await exportFile(embed, "json");
    expect(result.statusCode).toBe(200);
    expect(result.headers["Content-Type"]).toBe(
      "application/json; charset=utf-8"
    );
    // kein BOM: JSON.parse würde daran scheitern
    expect(result.body.startsWith("[")).toBe(true);

    expect(JSON.parse(result.body)).toEqual([
      {
        conversation: 1,
        conversationId: "konv-2",
        messages: [
          {
            message: 1,
            timestamp: "2026-09-02T12:00:00+02:00",
            prompt: "Neue Konversation",
            response: "Ja.",
            rating: "positive",
            ratingReason: null,
            ratingComment: null,
          },
        ],
      },
      {
        conversation: 2,
        conversationId: "konv-1",
        messages: [
          {
            message: 1,
            timestamp: "2026-09-01T08:30:05+02:00",
            prompt: 'Frage mit "Anführung"; und\nUmbruch',
            // JSON wird nicht von einer Tabellenkalkulation ausgewertet:
            // keine Entschärfung
            response: "=Antwort wie eine Formel",
            rating: null,
            ratingReason: null,
            ratingComment: null,
          },
          {
            message: 2,
            timestamp: "2026-09-01T08:31:00+02:00",
            prompt: "Zweite Frage",
            response: "Zweite Antwort",
            rating: "negative",
            ratingReason: "Zu ungenau",
            ratingComment: "Bitte genauer.",
          },
        ],
      },
      {
        conversation: 3,
        conversationId: null,
        messages: [
          {
            message: 1,
            timestamp: "2026-08-30T12:00:00+02:00",
            prompt: "Alt-Zeile",
            response: "Alt-Antwort",
            rating: null,
            ratingReason: null,
            ratingComment: null,
          },
        ],
      },
    ]);
  });

  test("json: Zeilentrenner U+2028 und U+2029 sowie Zeilenumbrüche in Frage, Antwort, Grund, Kommentar und Kennung kommen unverändert zurück - das Einrücken der Datei verändert keinen Wert", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const text = (name) =>
      `${name}1\u2028${name}2\u2029${name}3\n${name}4\r\n${name}5\u2028\u2028  ${name}6\u2029`;
    await addChat(embed, {
      at: berlinInstant("2026-09-01", 8, 30),
      prompt: text("Frage"),
      answer: text("Antwort"),
      conversation: "konv\u2028mit\u2029Trenner",
      session: "s-1",
      feedbackScore: false,
      feedbackReason: text("Grund"),
      feedbackText: text("Kommentar"),
    });
    await addChat(embed, {
      at: berlinInstant("2026-09-02", 8, 30),
      prompt: "\u2028am Anfang und am Ende\u2029",
      answer: "\u2029",
      conversation: "konv-2",
    });

    const result = await exportFile(embed, "json");
    expect(JSON.parse(result.body)).toEqual([
      {
        conversation: 1,
        conversationId: "konv-2",
        messages: [
          {
            message: 1,
            timestamp: "2026-09-02T08:30:00+02:00",
            prompt: "\u2028am Anfang und am Ende\u2029",
            response: "\u2029",
            rating: null,
            ratingReason: null,
            ratingComment: null,
          },
        ],
      },
      {
        conversation: 2,
        conversationId: "konv\u2028mit\u2029Trenner",
        messages: [
          {
            message: 1,
            timestamp: "2026-09-01T08:30:00+02:00",
            prompt: text("Frage"),
            response: text("Antwort"),
            rating: "negative",
            ratingReason: text("Grund"),
            ratingComment: text("Kommentar"),
          },
        ],
      },
    ]);
    // Die Datei bleibt eingerückt: je Konversation zwei Leerzeichen tiefer.
    expect(result.body.startsWith('[\n  {\n    "conversation": 1,\n')).toBe(
      true
    );
    expect(result.body).toContain('\n  },\n  {\n    "conversation": 2,\n');
    expect(result.body.endsWith("\n  }\n]\n")).toBe(true);

    // Die CSV derselben Auswahl enthält dieselben Texte.
    const rows = table(await exportFile(embed, "csv"));
    expect(
      rows.map((row) => [
        row["Konversations-ID"],
        row.Frage,
        row.Antwort,
        row["Grund der negativen Bewertung"],
        row["Kommentar zur negativen Bewertung"],
      ])
    ).toEqual([
      ["konv-2", "\u2028am Anfang und am Ende\u2029", "\u2029", "", ""],
      [
        "konv\u2028mit\u2029Trenner",
        text("Frage"),
        text("Antwort"),
        text("Grund"),
        text("Kommentar"),
      ],
    ]);
  });

  test("json: dieselbe Auswahl ergibt in CSV und JSON dieselben Konversationen, Nachrichten und Werte", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const start = berlinInstant("2026-09-03", 8, 0).getTime();
    for (let i = 0; i < 23; i++)
      await addChat(embed, {
        at: new Date(start + i * 7 * 60_000),
        prompt: `Frage ${i}`,
        answer: `Antwort ${i}`,
        conversation: `k-${i % 6}`,
        feedbackScore: i % 5 === 0 ? false : i % 7 === 0 ? true : null,
        feedbackReason: i % 5 === 0 ? `Grund ${i}` : null,
        feedbackText: i % 10 === 0 ? `Kommentar ${i}` : null,
      });

    const request = { ...SEPTEMBER, feedbackFilter: "negative" };
    const rows = table(await exportFile(embed, "csv", request));
    const json = JSON.parse((await exportFile(embed, "json", request)).body);

    const rating = { positive: "positiv", negative: "negativ" };
    const flattened = json.flatMap((conversation) =>
      conversation.messages.map((message) => ({
        Konversation: String(conversation.conversation),
        "Konversations-ID": conversation.conversationId,
        Nachricht: String(message.message),
        Zeitpunkt: berlinText(message.timestamp),
        Frage: message.prompt,
        Antwort: message.response,
        Bewertung: message.rating ? rating[message.rating] : "",
        "Grund der negativen Bewertung": message.ratingReason ?? "",
        "Kommentar zur negativen Bewertung": message.ratingComment ?? "",
      }))
    );
    expect(flattened.length).toBeGreaterThan(10);
    expect(flattened).toEqual(rows);
    // Felder je Konversation und je Nachricht
    for (const conversation of json) {
      expect(Object.keys(conversation)).toEqual([
        "conversation",
        "conversationId",
        "messages",
      ]);
      for (const message of conversation.messages)
        expect(Object.keys(message)).toEqual([
          "message",
          "timestamp",
          "prompt",
          "response",
          "rating",
          "ratingReason",
          "ratingComment",
        ]);
    }
  });
});

// ============================================================================
// AK-9 — Protokollierung
// ============================================================================
describe("protokoll (AK-9)", () => {
  let workspace, embed;
  beforeEach(async () => {
    workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
    for (let i = 0; i < 7; i++)
      await addChat(embed, {
        at: berlinInstant("2026-09-10", 9, i),
        prompt: `GEHEIME FRAGE ${i}`,
        answer: `GEHEIME ANTWORT ${i}`,
        conversation: `k-${i % 3}`,
        feedbackScore: i === 0 ? false : null,
      });
  });

  test("protokoll: Ein Export steht in event_logs - Nutzer, Widget, Format, Zeitraum und Zeilenzahl", async () => {
    const kunde = await createUser("default", [workspace.id]);
    const result = await exportFile(embed, "csv", SEPTEMBER, kunde);
    expect(table(result)).toHaveLength(7);

    const events = await eventsOf(db.client, "embed_conversations_exported");
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe(kunde.id);
    expect(events[0].occurredAt).toBeInstanceOf(Date);
    expect(events[0].metadata).toEqual({
      embedId: embed.id,
      format: "csv",
      fromDay: "2026-09-01",
      toDay: "2026-09-30",
      startDate: SEPTEMBER.startDate,
      endDate: SEPTEMBER.endDate,
      feedbackFilter: "all",
      startedFromDay: null,
      startedToDay: null,
      conversationCount: 3,
      rowCount: 7,
      completed: true,
    });
  });

  test("protokoll: Format, Filter und Abschnitt des Exports; „Gesamt“ ohne Zeitraum", async () => {
    await exportFile(embed, "json", {
      ...SEPTEMBER,
      feedbackFilter: "negative",
      bucket: { start: "2026-09-07", end: "2026-09-13" },
    });
    await exportFile(embed, "csv");

    const events = await eventsOf(db.client, "embed_conversations_exported");
    expect(events.map((event) => event.userId)).toEqual([admin.id, admin.id]);
    expect(events[0].metadata).toEqual(
      expect.objectContaining({
        embedId: embed.id,
        format: "json",
        fromDay: "2026-09-07",
        toDay: "2026-09-13",
        feedbackFilter: "negative",
        startedFromDay: "2026-09-07",
        startedToDay: "2026-09-13",
        conversationCount: 1,
        rowCount: 3,
        completed: true,
      })
    );
    expect(events[1].metadata).toEqual(
      expect.objectContaining({
        format: "csv",
        fromDay: null,
        toDay: null,
        startDate: null,
        endDate: null,
        conversationCount: 3,
        rowCount: 7,
      })
    );
  });

  test("protokoll: keine Inhalte, keine Sitzungs- und keine Verbindungsdaten im Protokoll", async () => {
    await exportFile(embed, "csv", SEPTEMBER);
    await exportFile(embed, "json", SEPTEMBER);
    const logs = await db.client.event_logs.findMany();
    const text = JSON.stringify(logs);
    expect(logs).toHaveLength(2);
    expect(text).not.toMatch(/GEHEIM|sitzung-|k-0|203\.0\.113|example\.org/);
    for (const log of logs)
      expect(Object.keys(JSON.parse(log.metadata)).sort()).toEqual(
        [
          "completed",
          "conversationCount",
          "embedId",
          "endDate",
          "feedbackFilter",
          "format",
          "fromDay",
          "rowCount",
          "startDate",
          "startedFromDay",
          "startedToDay",
          "toDay",
        ].sort()
      );
  });

  test("protokoll: ohne Mehrbenutzermodus ohne Nutzer; abgelehnte Anfragen hinterlassen keinen Eintrag", async () => {
    const fremd = await createUser("default", []);
    expect((await exportFile(embed, "csv", SEPTEMBER, fremd)).statusCode).toBe(
      403
    );
    expect((await exportFile(embed, "xlsx", SEPTEMBER)).statusCode).toBe(400);
    expect((await exportFile(embed, "csv", SEPTEMBER, null)).statusCode).toBe(
      401
    );
    expect(await eventsOf(db.client, "embed_conversations_exported")).toEqual(
      []
    );

    await setMultiUserMode(false);
    expect((await exportFile(embed, "csv", SEPTEMBER, null)).statusCode).toBe(
      200
    );
    const events = await eventsOf(db.client, "embed_conversations_exported");
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBeNull();
    expect(events[0].metadata.rowCount).toBe(7);
  });

  test("protokoll: Der Export liest nur - embed_chats und das Zählerbuch sind danach Byte für Byte dieselben", async () => {
    const before = {
      chats: await tableChecksum(db.client, "embed_chats"),
      ledger: await tableChecksum(db.client, "message_ledger"),
    };
    await exportFile(embed, "csv", SEPTEMBER);
    await exportFile(embed, "json");
    expect({
      chats: await tableChecksum(db.client, "embed_chats"),
      ledger: await tableChecksum(db.client, "message_ledger"),
    }).toEqual(before);
  });
});

// ============================================================================
// AK-11 — Große Exporte
// ============================================================================
describe("gross (AK-11)", () => {
  const CONVERSATIONS_TOTAL = 4000;
  const PER_CONVERSATION = 5;
  let embed;

  /** 20.000 Nachrichten in 4.000 Konversationen, über den September verteilt. */
  async function seedLarge() {
    const workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
    const start = berlinInstant("2026-09-01", 0, 0).getTime();
    const data = [];
    for (let c = 0; c < CONVERSATIONS_TOTAL; c++)
      for (let m = 0; m < PER_CONVERSATION; m++)
        data.push({
          embed_id: embed.id,
          prompt: `Frage ${c}/${m}`,
          response: JSON.stringify({
            text: `Antwort ${c}/${m}`,
            sources: [{ text: SOURCE_TEXT }],
          }),
          session_id: `sitzung-${c}`,
          conversation_id: `konv-${c}`,
          // je Konversation 10 Minuten, Nachrichten im Abstand von 1 Minute
          createdAt: new Date(start + c * 600_000 + m * 60_000),
        });
    for (let i = 0; i < data.length; i += 2000)
      await db.client.embed_chats.createMany({ data: data.slice(i, i + 2000) });
    expect(await db.client.embed_chats.count()).toBe(20000);
  }

  test("gross: 20.000 Nachrichten kommen vollständig an - zeilenweise geschrieben, die Datenbank in Paketen gelesen", async () => {
    await seedLarge();
    const pages = jest.spyOn(EmbedChats, "_exportConversationPage");
    const batches = jest.spyOn(EmbedChats, "_exportMessages");

    const result = await exportFile(embed, "csv", SEPTEMBER);
    const rows = table(result);

    // vollständig, jede Nachricht genau einmal, in Reihenfolge
    expect(rows).toHaveLength(20000);
    expect(new Set(rows.map((row) => row.Frage)).size).toBe(20000);
    for (let c = 0; c < CONVERSATIONS_TOTAL; c++) {
      // jüngste Konversation zuerst: Nummer 1 ist konv-3999
      const own = rows.slice(c * PER_CONVERSATION, (c + 1) * PER_CONVERSATION);
      const name = CONVERSATIONS_TOTAL - 1 - c;
      expect(
        own.map(
          (row) =>
            `${row.Konversation}|${row["Konversations-ID"]}|${row.Nachricht}|${row.Frage}`
        )
      ).toEqual(
        Array.from(
          { length: PER_CONVERSATION },
          (_, m) => `${c + 1}|konv-${name}|${m + 1}|Frage ${name}/${m}`
        )
      );
    }

    // zeilenweise: Kopfzeile + je Nachricht ein Stück, nie die ganze Datei
    expect(result.chunks).toHaveLength(20001);
    expect(
      Math.max(...result.chunks.map((chunk) => chunk.length))
    ).toBeLessThan(200);

    // in Paketen: 8 volle Seiten Konversationen und eine leere zum Schluss
    expect(EmbedChats.EXPORT_CONVERSATION_PAGE).toBe(500);
    expect(pages).toHaveBeenCalledTimes(9);
    const pageSizes = await Promise.all(
      pages.mock.results.map(async (call) => (await call.value).length)
    );
    expect(pageSizes).toEqual([500, 500, 500, 500, 500, 500, 500, 500, 0]);
    // Schlüssel-Paginierung: jede Seite beginnt hinter der letzten Konversation der vorigen
    expect(pages.mock.calls[0][0].after).toBeNull();
    for (const [args] of pages.mock.calls.slice(1))
      expect(args.after).toEqual({
        startedAt: expect.any(Number),
        firstChatId: expect.any(Number),
      });
    // Nachrichten: je Abfrage höchstens ein Paket
    expect(batches).toHaveBeenCalledTimes(40);
    for (const call of batches.mock.results) {
      const byGroup = await call.value;
      let messages = 0;
      for (const list of byGroup.values()) messages += list.length;
      expect(messages).toBeLessThanOrEqual(EmbedChats.EXPORT_MESSAGE_BATCH);
      expect(byGroup.size).toBeLessThanOrEqual(
        EmbedChats.EXPORT_BATCH_CONVERSATIONS
      );
    }

    const [event] = await eventsOf(db.client, "embed_conversations_exported");
    expect(event.metadata).toEqual(
      expect.objectContaining({
        conversationCount: 4000,
        rowCount: 20000,
        completed: true,
      })
    );
    // Quellen-Texte haben die Datenbank nicht verlassen.
    expect(result.body).not.toContain(SOURCE_TEXT);
  });

  test("gross: Lesen und Schreiben wechseln sich ab - geschrieben wird, bevor die nächsten Pakete gelesen sind", async () => {
    await seedLarge();
    const trace = [];
    const originalPage = EmbedChats._exportConversationPage;
    const originalBatch = EmbedChats._exportMessages;
    jest
      .spyOn(EmbedChats, "_exportConversationPage")
      .mockImplementation(async (args) => {
        trace.push("seite");
        return await originalPage(args);
      });
    jest
      .spyOn(EmbedChats, "_exportMessages")
      .mockImplementation(async (args) => {
        trace.push("paket");
        return await originalBatch(args);
      });

    const exported = conversationExport(
      "csv",
      EmbedChats.conversationsForExport(embed.id, {
        startDate: new Date(SEPTEMBER.startDate),
        endDate: new Date(SEPTEMBER.endDate),
      })
    );
    let written = 0;
    let longestRun = 0;
    let run = 0;
    for await (const chunk of exported.chunks) {
      expect(chunk.endsWith("\r\n")).toBe(true);
      if (trace[trace.length - 1] !== "zeile") run = 0;
      trace.push("zeile");
      written += 1;
      run += 1;
      longestRun = Math.max(longestRun, run);
    }
    expect(written).toBe(20001);
    expect(exported.stats).toEqual({ conversations: 4000, rows: 20000 });

    // Zwischen zwei Lesezugriffen entstehen höchstens die Zeilen eines Pakets …
    expect(longestRun).toBeLessThanOrEqual(EmbedChats.EXPORT_MESSAGE_BATCH + 1);
    // … und nach dem ersten Paket sind erst dessen Zeilen geschrieben, bevor
    // das zweite gelesen wird.
    const secondBatch = trace.indexOf("paket", trace.indexOf("paket") + 1);
    expect(
      trace.slice(0, secondBatch).filter((step) => step === "zeile")
    ).toHaveLength(1 + EmbedChats.EXPORT_MESSAGE_BATCH);
    expect(trace.filter((step) => step === "paket")).toHaveLength(40);
    expect(trace.filter((step) => step === "seite")).toHaveLength(9);
  });

  test("gross: JSON mit 20.000 Nachrichten ist gültig und vollständig, je Konversation ein Stück", async () => {
    await seedLarge();
    const result = await exportFile(embed, "json", SEPTEMBER);
    const json = JSON.parse(result.body);

    expect(json).toHaveLength(4000);
    expect(json.map((c) => c.conversation)).toEqual(
      Array.from({ length: 4000 }, (_, i) => i + 1)
    );
    expect(json.every((c) => c.messages.length === PER_CONVERSATION)).toBe(
      true
    );
    expect(json[0].conversationId).toBe("konv-3999");
    expect(json[3999].messages[4].prompt).toBe("Frage 0/4");
    // "[" + je Konversation ein Stück + "]"
    expect(result.chunks).toHaveLength(4002);
  });

  test("gross: Nachrichten, die während des Exports entstehen, verschieben weder Nummern noch Seiten", async () => {
    await seedLarge();
    const originalPage = EmbedChats._exportConversationPage;
    let pagesRead = 0;
    jest
      .spyOn(EmbedChats, "_exportConversationPage")
      .mockImplementation(async (args) => {
        // Nach der ersten Seite: eine neue Konversation (jünger als alle) und
        // eine weitere Nachricht in einer noch nicht gelesenen.
        if (pagesRead++ === 1) {
          await addChat(embed, {
            at: berlinInstant("2026-09-30", 23, 0),
            prompt: "NEU während des Exports",
            conversation: "neu",
          });
          await addChat(embed, {
            at: berlinInstant("2026-09-01", 0, 9),
            prompt: "NACHTRAG während des Exports",
            conversation: "konv-0",
            session: "sitzung-0",
          });
        }
        return await originalPage(args);
      });

    const rows = table(await exportFile(embed, "csv", SEPTEMBER));
    expect(rows).toHaveLength(20000);
    expect(rows.map((row) => row.Frage).join("\n")).not.toMatch(/während/);
    // Nummern lückenlos 1 … 4000, keine Konversation doppelt
    const numbers = [...new Set(rows.map((row) => Number(row.Konversation)))];
    expect(numbers).toEqual(Array.from({ length: 4000 }, (_, i) => i + 1));
    expect(new Set(rows.map((row) => row["Konversations-ID"])).size).toBe(4000);
  });

  test("gross: eine einzelne Konversation, größer als ein Paket, kommt vollständig und in Reihenfolge an", async () => {
    const workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
    const start = berlinInstant("2026-09-01", 8, 0).getTime();
    const count = EmbedChats.EXPORT_MESSAGE_BATCH * 2 + 50;
    await db.client.embed_chats.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        embed_id: embed.id,
        prompt: `Frage ${i}`,
        response: JSON.stringify({ text: "Antwort" }),
        session_id: "s",
        conversation_id: "lang",
        createdAt: new Date(start + i * 1000),
      })),
    });
    await addChat(embed, {
      at: new Date(start - 60_000),
      prompt: "davor",
      conversation: "kurz",
    });

    const rows = table(await exportFile(embed, "csv"));
    expect(rows).toHaveLength(count + 1);
    expect(rows.slice(0, count).map((row) => row.Nachricht)).toEqual(
      Array.from({ length: count }, (_, i) => String(i + 1))
    );
    expect(rows[count].Frage).toBe("davor");
  });

  test("gross: Ein Fehler vor der ersten Zeile ergibt 500 ohne Datei; ein Fehler mitten im Export bricht die Verbindung ab, statt eine abgeschnittene Datei als vollständig zu liefern", async () => {
    await seedLarge();

    const failing = jest
      .spyOn(EmbedChats, "_exportConversationPage")
      .mockRejectedValueOnce(new Error("database is locked"));
    const early = await exportFile(embed, "csv", SEPTEMBER);
    expect(early.statusCode).toBe(500);
    expect(early.headers).toEqual({});
    expect(early.chunks).toEqual([]);
    expect(early.destroyed).toBeNull();
    expect(await eventsOf(db.client, "embed_conversations_exported")).toEqual(
      []
    );
    failing.mockRestore();

    const originalBatch = EmbedChats._exportMessages;
    let calls = 0;
    jest
      .spyOn(EmbedChats, "_exportMessages")
      .mockImplementation(async (args) => {
        if (++calls === 3) throw new Error("database is locked");
        return await originalBatch(args);
      });
    const late = await exportFile(embed, "csv", SEPTEMBER);
    expect(late.destroyed).toBeInstanceOf(Error);
    expect(late.destroyed.message).toBe("database is locked");
    // Die Antwort wurde nicht regulär beendet.
    expect(late.body).toBeUndefined();
    // Kopfzeile + zwei Pakete sind bereits draußen - und protokolliert.
    expect(late.chunks).toHaveLength(1 + 2 * EmbedChats.EXPORT_MESSAGE_BATCH);
    const [event] = await eventsOf(db.client, "embed_conversations_exported");
    expect(event.metadata).toEqual(
      expect.objectContaining({ rowCount: 1000, completed: false })
    );
  });

  test("gross: Beendet der Empfänger die Verbindung mitten im Export, wird nicht weiter gelesen - das Protokoll nennt completed: false und die bis dahin geschriebenen Zeilen", async () => {
    await seedLarge();
    const pages = jest.spyOn(EmbedChats, "_exportConversationPage");
    const batches = jest.spyOn(EmbedChats, "_exportMessages");
    // Kopfzeile + 700 Zeilen: mitten im zweiten Paket
    const WRITTEN = 700;

    const result = await exportFile(
      embed,
      "csv",
      SEPTEMBER,
      admin,
      (response, outcome) => {
        const write = response.write;
        // Der Empfänger nimmt jedes Stück an (kein Warten auf „drain") und
        // ist nach dem 701. weg.
        response.destroyed = false;
        response.write = (chunk) => {
          write(chunk);
          if (outcome.chunks.length === 1 + WRITTEN) response.destroyed = true;
          return true;
        };
      }
    );

    expect(result.statusCode).toBe(200);
    expect(result.chunks).toHaveLength(1 + WRITTEN);
    // Die Antwort hat der Empfänger beendet, nicht der Server (kein Fehler).
    expect(result.destroyed).toBeNull();
    // Gelesen sind eine Seite Konversationen und zwei Pakete Nachrichten -
    // nicht die 40 der ganzen Auswahl.
    expect(pages).toHaveBeenCalledTimes(1);
    expect(batches).toHaveBeenCalledTimes(2);

    const events = await eventsOf(db.client, "embed_conversations_exported");
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual(
      expect.objectContaining({
        embedId: embed.id,
        format: "csv",
        conversationCount: WRITTEN / PER_CONVERSATION,
        rowCount: WRITTEN,
        completed: false,
      })
    );
  });

  test("gross: writeChunks erzeugt nach dem Ende der Verbindung kein weiteres Stück und schreibt keines mehr - auch wenn der Empfänger bis dahin jedes angenommen hat", async () => {
    /** Zählt, was erzeugt wurde, und merkt sich, ob die Folge geschlossen ist. */
    function counted(n, onProduce = () => {}) {
      const state = { produced: 0, closed: false };
      state.chunks = (async function* () {
        try {
          for (let i = 0; i < n; i++) {
            state.produced += 1;
            onProduce(state.produced);
            yield `${i}\r\n`;
          }
        } finally {
          state.closed = true;
        }
      })();
      return state;
    }
    function receiver(onWrite = () => {}) {
      const response = { destroyed: false, writableEnded: false, taken: [] };
      response.write = (chunk) => {
        response.taken.push(chunk);
        onWrite(response);
        return true;
      };
      return response;
    }

    // 1. Der Empfänger ist nach dem vierten Stück weg: Rückgabe false, das
    // fünfte Stück entsteht gar nicht erst, die Folge wird geschlossen.
    const gone = receiver((response) => {
      if (response.taken.length === 4) response.destroyed = true;
    });
    const first = counted(1000);
    expect(await writeChunks(gone, first.chunks)).toBe(false);
    expect(gone.taken).toEqual(["0\r\n", "1\r\n", "2\r\n", "3\r\n"]);
    expect(first.produced).toBe(4);
    expect(first.closed).toBe(true);

    // 2. Die Verbindung endet, während das nächste Stück entsteht (die
    // Datenbank wird gelesen): Es wird nicht mehr geschrieben.
    const during = receiver();
    const second = counted(1000, (produced) => {
      if (produced === 3) during.destroyed = true;
    });
    expect(await writeChunks(during, second.chunks)).toBe(false);
    expect(during.taken).toEqual(["0\r\n", "1\r\n"]);
    expect(second.produced).toBe(3);
    expect(second.closed).toBe(true);

    // 3. Die Antwort ist schon beendet: nichts wird erzeugt, nichts geschrieben.
    for (const state of [{ destroyed: true }, { writableEnded: true }]) {
      const ended = Object.assign(receiver(), state);
      const third = counted(10);
      expect(await writeChunks(ended, third.chunks)).toBe(false);
      expect(ended.taken).toEqual([]);
      expect(third.produced).toBe(0);
    }

    // 4. Weg nach dem letzten Stück: nicht als vollständig gemeldet.
    const last = receiver((response) => {
      if (response.taken.length === 5) response.destroyed = true;
    });
    expect(await writeChunks(last, counted(5).chunks)).toBe(false);
    expect(last.taken).toHaveLength(5);

    // Gegenprobe: Ein Empfänger, der bleibt, bekommt alles.
    const stays = receiver();
    const all = counted(5);
    expect(await writeChunks(stays, all.chunks)).toBe(true);
    expect(stays.taken).toHaveLength(5);
    expect(all.closed).toBe(true);
  });

  test("gross: primed gibt die Quelle frei, wenn der Abnehmer vorzeitig aufhört - die Abfrage hinter dem Export bleibt nicht offen", async () => {
    function source() {
      const state = { produced: 0, closed: false };
      state.rows = (async function* () {
        try {
          for (let i = 0; i < 100; i++) {
            state.produced += 1;
            yield i;
          }
        } finally {
          state.closed = true;
        }
      })();
      return state;
    }

    // vollständig gelesen
    const whole = source();
    const values = [];
    for await (const value of await primed(whole.rows)) values.push(value);
    expect(values).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(whole.closed).toBe(true);

    // vorzeitig beendet: Das erste Element ist bereits gelesen (primed), die
    // Quelle wird trotzdem geschlossen.
    const partial = source();
    const sequence = await primed(partial.rows);
    expect(partial.produced).toBe(1);
    for await (const value of sequence) if (value === 2) break;
    expect(partial.produced).toBe(3);
    expect(partial.closed).toBe(true);

    // über writeChunks, wie im Endpunkt
    const viaWrite = source();
    const receiver = { destroyed: false, taken: [] };
    receiver.write = (chunk) => {
      receiver.taken.push(chunk);
      if (receiver.taken.length === 3) receiver.destroyed = true;
      return true;
    };
    expect(await writeChunks(receiver, await primed(viaWrite.rows))).toBe(
      false
    );
    expect(receiver.taken).toEqual([0, 1, 2]);
    expect(viaWrite.closed).toBe(true);
  });

  test("gross: an einer echten http.ServerResponse mit langsamem Empfänger - alle Zeilen kommen in Reihenfolge an, die Antwort endet regulär; nach einem Fehler mittendrin fehlt das Ende", async () => {
    const http = require("http");
    const { Duplex } = require("stream");

    /**
     * Eine Antwort von Node selbst, an einem Empfänger ohne Netz: Er nimmt
     * je Schreibvorgang erst nach einer Millisekunde ab und puffert wenig -
     * write() meldet deshalb „voll", und es muss gewartet werden.
     */
    function connection() {
      const received = [];
      const socket = new Duplex({
        highWaterMark: 64,
        read() {},
        write(chunk, _encoding, callback) {
          received.push(Buffer.from(chunk));
          setTimeout(callback, 1);
        },
      });
      socket.on("error", () => {});
      const response = new http.ServerResponse({
        method: "POST",
        httpVersionMajor: 1,
        httpVersionMinor: 1,
      });
      response.on("error", () => {});
      response.assignSocket(socket);
      // Wie der HTTP-Server (socketOnDrain): Fließt der Socket ab, erfährt es
      // die Antwort.
      socket.on("drain", () => response.emit("drain"));
      return {
        response,
        raw: () => Buffer.concat(received).toString("utf8"),
      };
    }
    const settled = () => new Promise((resolve) => setTimeout(resolve, 50));
    const rowsIn = (raw) => raw.match(/Zeile \d+;/g) ?? [];

    // 1. vollständiger Export
    async function* rows(n) {
      for (let i = 0; i < n; i++) yield `Zeile ${i};"äöü"\r\n`;
    }
    const complete = connection();
    let waited = 0;
    complete.response.on("drain", () => (waited += 1));
    complete.response.setHeader("Content-Type", "text/csv; charset=utf-8");
    expect(await writeChunks(complete.response, rows(300))).toBe(true);
    complete.response.end();
    await settled();

    expect(waited).toBeGreaterThan(10);
    expect(complete.raw()).toMatch(/transfer-encoding: chunked/i);
    expect(rowsIn(complete.raw())).toEqual(
      Array.from({ length: 300 }, (_, i) => `Zeile ${i};`)
    );
    // reguläres Ende der Antwort: der abschließende leere Chunk
    expect(complete.raw().endsWith("\r\n0\r\n\r\n")).toBe(true);

    // 2. Fehler mitten im Export: Die Verbindung wird abgebrochen (wie im
    // Endpunkt) - der Empfänger sieht kein reguläres Ende.
    async function* failing() {
      for (let i = 0; i < 50; i++) yield `Zeile ${i};\r\n`;
      throw new Error("database is locked");
    }
    const broken = connection();
    await expect(writeChunks(broken.response, failing())).rejects.toThrow(
      "database is locked"
    );
    broken.response.destroy(new Error("database is locked"));
    await settled();

    expect(broken.response.destroyed).toBe(true);
    expect(broken.raw().endsWith("0\r\n\r\n")).toBe(false);
    expect(rowsIn(broken.raw()).length).toBeLessThanOrEqual(50);
  });

  test("gross: writeChunks wartet, wenn der Empfänger nicht nachkommt, und hört auf, wenn er die Verbindung beendet", async () => {
    const { EventEmitter } = require("events");
    async function* numbers(n) {
      for (let i = 0; i < n; i++) yield `${i}\r\n`;
    }

    // Empfänger nimmt jedes zweite Stück erst nach „drain" ab.
    const slow = new EventEmitter();
    const received = [];
    let waiting = 0;
    slow.write = (chunk) => {
      received.push(chunk);
      if (received.length % 2 === 1) return true;
      waiting += 1;
      setImmediate(() => slow.emit("drain"));
      return false;
    };
    expect(await writeChunks(slow, numbers(10))).toBe(true);
    expect(received).toHaveLength(10);
    expect(waiting).toBe(5);
    expect(slow.listenerCount("drain")).toBe(0);
    expect(slow.listenerCount("close")).toBe(0);

    // Empfänger beendet die Verbindung, während auf ihn gewartet wird.
    const gone = new EventEmitter();
    const sent = [];
    let produced = 0;
    async function* counted() {
      for (let i = 0; i < 1000; i++) {
        produced += 1;
        yield `${i}\r\n`;
      }
    }
    gone.write = (chunk) => {
      sent.push(chunk);
      if (sent.length < 3) return true;
      setImmediate(() => {
        gone.destroyed = true;
        gone.emit("close");
      });
      return false;
    };
    expect(await writeChunks(gone, counted())).toBe(false);
    expect(sent).toHaveLength(3);
    // Es wird nicht weiter gelesen.
    expect(produced).toBe(3);
    expect(gone.listenerCount("drain")).toBe(0);
  });
});

// ============================================================================
// NAK-1 — Kein Export fremder Widgets
// ============================================================================
describe("fremdes_widget (NAK-1)", () => {
  let workspaceA, workspaceB, widgetA, widgetB, kunde;

  beforeEach(async () => {
    workspaceA = await createWorkspace(db.client);
    workspaceB = await createWorkspace(db.client);
    widgetA = await createEmbed(db.client, workspaceA);
    widgetB = await createEmbed(db.client, workspaceB);
    await addChat(widgetA, {
      at: berlinInstant("2026-09-10", 9, 0),
      prompt: "Frage in A",
      conversation: "a-1",
    });
    await addChat(widgetB, {
      at: berlinInstant("2026-09-10", 9, 0),
      prompt: "FREMDE Frage in B",
      conversation: "b-1",
    });
    kunde = await createUser("default", [workspaceA.id]);
  });

  const expectNoData = (result, statusCode) => {
    expect(result.statusCode).toBe(statusCode);
    expect(result.chunks).toEqual([]);
    expect(result.headers).toEqual({});
    expect(JSON.stringify(result.body ?? "")).not.toMatch(/FREMDE|Frage in/);
  };

  test("fremdes_widget: default aus Workspace A erhält für ein Widget aus Workspace B 403 und keine Daten - CSV wie JSON, nichts wird gelesen, nichts protokolliert", async () => {
    const read = jest.spyOn(EmbedChats, "conversationsForExport");
    for (const format of ["csv", "json"]) {
      const result = await exportFile(widgetB, format, SEPTEMBER, kunde);
      expectNoData(result, 403);
      expect(result.body).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("fremdes_widget: dieselbe Ablehnung wie die Konversationsliste - auch für ein unbekanntes Widget und ohne jede Mitgliedschaft", async () => {
    const list = await invoke(CONVERSATIONS, {
      params: { embedId: String(widgetB.id) },
      body: conversationsBody(SEPTEMBER),
      token: kunde.token,
    });
    expect(list.statusCode).toBe(403);

    for (const embedId of ["9999", "abc", "-1", "0", `${widgetB.id} OR 1=1`])
      expectNoData(await exportFile(embedId, "csv", SEPTEMBER, kunde), 403);

    const ohneWorkspace = await createUser("default", []);
    for (const widget of [widgetA, widgetB])
      expectNoData(
        await exportFile(widget, "csv", SEPTEMBER, ohneWorkspace),
        403
      );
  });

  test("fremdes_widget: Die Rechteprüfung kommt vor der Eingabeprüfung (403 statt 400)", async () => {
    expectNoData(await exportFile(widgetB, "xlsx", SEPTEMBER, kunde), 403);
    expectNoData(
      await exportFile(widgetB, "csv", { startDate: "kein Datum" }, kunde),
      403
    );
  });

  test("fremdes_widget: das eigene Widget liefert nur dessen Konversationen", async () => {
    const rows = table(await exportFile(widgetA, "csv", SEPTEMBER, kunde));
    expect(rows.map((row) => row.Frage)).toEqual(["Frage in A"]);
  });

  test("fremdes_widget: Nach dem Umhängen entscheidet der heutige Workspace des Widgets", async () => {
    await db.client.embed_configs.update({
      where: { id: widgetB.id },
      data: { workspace_id: workspaceA.id },
    });
    expect(
      (await exportFile(widgetB, "csv", SEPTEMBER, kunde)).statusCode
    ).toBe(200);
    await db.client.embed_configs.update({
      where: { id: widgetA.id },
      data: { workspace_id: workspaceB.id },
    });
    expectNoData(await exportFile(widgetA, "csv", SEPTEMBER, kunde), 403);
  });

  test("fremdes_widget: admin und manager exportieren jedes Widget; ein unbekanntes Widget ergibt 404", async () => {
    for (const role of ["admin", "manager"]) {
      const user = await createUser(role);
      const rows = table(await exportFile(widgetB, "csv", SEPTEMBER, user));
      expect(rows.map((row) => row.Frage)).toEqual(["FREMDE Frage in B"]);
      for (const embedId of ["9999", "abc", "0"])
        expectNoData(await exportFile(embedId, "csv", SEPTEMBER, user), 404);
    }
  });

  test("fremdes_widget: ohne Anmeldung 401, gesperrter Nutzer 401", async () => {
    expectNoData(await exportFile(widgetA, "csv", SEPTEMBER, null), 401);
    expectNoData(
      await exportFile(widgetA, "csv", SEPTEMBER, {
        token: "kein.gültiges.token",
      }),
      401
    );
    await db.client.users.update({
      where: { id: kunde.id },
      data: { suspended: 1 },
    });
    expectNoData(await exportFile(widgetA, "csv", SEPTEMBER, kunde), 401);
  });

  test("fremdes_widget: Chat-Verlauf abgeschaltet (DISABLE_VIEW_CHAT_HISTORY) - dieselbe Ablehnung wie die Konversationsliste, für jede Rolle", async () => {
    process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    for (const user of [admin, await createUser("manager"), kunde]) {
      const list = await invoke(CONVERSATIONS, {
        params: { embedId: String(widgetA.id) },
        body: conversationsBody(SEPTEMBER),
        token: user.token,
      });
      const result = await exportFile(widgetA, "csv", SEPTEMBER, user);
      expect(list.statusCode).toBe(422);
      expect(result.statusCode).toBe(422);
      expect(result.body).toBe(list.body);
      expect(result.chunks).toEqual([]);
    }
    expect(await db.client.event_logs.count()).toBe(0);
  });

  test("fremdes_widget: ohne Mehrbenutzermodus wird nicht geprüft (kein Nutzerobjekt)", async () => {
    await setMultiUserMode(false);
    const rows = table(await exportFile(widgetB, "csv", SEPTEMBER, null));
    expect(rows.map((row) => row.Frage)).toEqual(["FREMDE Frage in B"]);
  });

  test("fremdes_widget: ungültige Eingaben - 400 ohne Datei und ohne Abfrage", async () => {
    const read = jest.spyOn(EmbedChats, "conversationsForExport");
    const send = (body) =>
      invoke(EXPORT, {
        params: { embedId: String(widgetA.id) },
        body,
        token: admin.token,
      });
    for (const body of [
      {},
      { format: "xlsx" },
      { format: "jsonl" },
      { format: "CSV" },
      { format: ["csv"] },
      { format: "__proto__" },
      { format: "constructor" },
      { format: "csv", startDate: "kein Datum" },
      { format: "csv", endDate: "2026-13-45" },
      { format: "csv", startedFromDay: "2026-09-01" },
      {
        format: "csv",
        startedFromDay: "2026-09-10",
        startedToDay: "2026-09-01",
      },
      {
        format: "json",
        startedFromDay: "01.09.2026",
        startedToDay: "02.09.2026",
      },
    ]) {
      const result = await send(body);
      expect([JSON.stringify(body), result.statusCode]).toEqual([
        JSON.stringify(body),
        400,
      ]);
      expect(result.body).toEqual({
        success: false,
        error: expect.any(String),
      });
      expect(result.chunks).toEqual([]);
      expect(result.headers).toEqual({});
    }
    expect(read).not.toHaveBeenCalled();
    expect(await db.client.event_logs.count()).toBe(0);
  });
});

// ============================================================================
// NAK-3 — Keine Formelausführung
// ============================================================================
describe("formel_entschaerft (NAK-3)", () => {
  let embed;
  beforeEach(async () => {
    const workspace = await createWorkspace(db.client);
    embed = await createEmbed(db.client, workspace);
  });

  const HYPERLINK = '=HYPERLINK("http://example.org";"Klick")';

  test("formel_entschaerft: Eine Frage =HYPERLINK(…) steht als Text in der Zelle - mit vorangestelltem Hochkomma", async () => {
    await addChat(embed, {
      at: berlinInstant("2026-09-01", 8, 0),
      prompt: HYPERLINK,
      answer: "Antwort",
      conversation: "k-1",
    });
    const result = await exportFile(embed, "csv");

    expect(table(result)[0].Frage).toBe(`'${HYPERLINK}`);
    // wörtlich in der Datei: Die Zelle beginnt nicht mit „=“.
    expect(result.body).toContain(
      `;"'=HYPERLINK(""http://example.org"";""Klick"")";`
    );
    expect(result.body).not.toMatch(/(^|;|\r\n)"?=/);
  });

  test("formel_entschaerft: = + - @, Tabulator und Wagenrücklauf am Zellanfang - in jeder Textspalte, auch in der Konversations-ID", async () => {
    const starts = ["=", "+", "-", "@", "\t", "\r"];
    for (const [i, start] of starts.entries()) {
      const payload = `${start}1+cmd|' /C calc'!A0`;
      await addChat(embed, {
        at: berlinInstant("2026-09-01", 8, i),
        prompt: payload,
        answer: payload,
        // Die Kennung kommt vom Widget im Browser - also von außen.
        conversation: `${payload}#${i}`,
        session: `s-${i}`,
        feedbackScore: false,
        feedbackReason: payload,
        feedbackText: payload,
      });
    }
    const rows = table(await exportFile(embed, "csv"));
    expect(rows).toHaveLength(6);
    const textColumns = [
      "Konversations-ID",
      "Frage",
      "Antwort",
      "Grund der negativen Bewertung",
      "Kommentar zur negativen Bewertung",
    ];
    for (const row of rows)
      for (const column of textColumns) {
        expect([column, row[column][0]]).toEqual([column, "'"]);
        expect(starts).toContain(row[column][1]);
      }
    // Jede Zelle der Datei, ohne Ausnahme: keine sieht aus wie eine Formel.
    for (const row of rows)
      for (const value of Object.values(row))
        expect([value, looksLikeFormula(value)]).toEqual([value, false]);
  });

  test("formel_entschaerft: auch nach führendem Leerraum - Leerzeichen, geschütztes Leerzeichen, Zeilenumbruch, unsichtbare Zeichen", async () => {
    // Manche Programme und Importwege schneiden Leerraum am Zellanfang ab;
    // danach stünde das Formelzeichen vorn.
    const blanks = [
      " ",
      "   ",
      "\u00A0",
      "\n",
      " \t ",
      "\u200B",
      "\uFEFF",
      "\u3000",
      "\u2060",
      "\u00AD",
    ];
    for (const [i, blank] of blanks.entries())
      await addChat(embed, {
        at: berlinInstant("2026-09-01", 9, i),
        prompt: `${blank}=SUMME(A1:A9)`,
        answer: `${blank}@SUM(1)`,
        conversation: `k-${i}`,
      });
    const rows = table(await exportFile(embed, "csv"));
    expect(rows).toHaveLength(blanks.length);
    for (const row of rows) {
      expect(row.Frage.startsWith("'")).toBe(true);
      expect(row.Frage.endsWith("=SUMME(A1:A9)")).toBe(true);
      expect(row.Antwort.startsWith("'")).toBe(true);
    }
  });

  test("formel_entschaerft: defuseCell - was entschärft wird und was unverändert bleibt", () => {
    for (const dangerous of [
      "=1+1",
      "+1",
      "-1",
      "@SUM(1)",
      "\tTab",
      "\rCR",
      "\r\n=1",
      " =1",
      "\n-1",
      "\uFF1D1",
      "\uFF0B1",
      "\uFF0D1",
      "\uFF20x",
      "- Punkt 1",
      "+49 591 1234",
      "-",
    ]) {
      expect([dangerous, defuseCell(dangerous)]).toEqual([
        dangerous,
        `'${dangerous}`,
      ]);
      expect(looksLikeFormula(dangerous)).toBe(true);
    }
    for (const harmless of [
      "",
      "Hallo",
      "1+1=2",
      "a=b",
      "E-Mail: a@b.de",
      " Leerzeichen vorn",
      "\nZeilenumbruch vorn",
      "'=schon entschärft",
      "„=“ in Anführungszeichen",
      "5 - 3",
      "100 %",
    ]) {
      expect(defuseCell(harmless)).toBe(harmless);
      expect(looksLikeFormula(harmless)).toBe(false);
    }
    // Entschärft wird genau einmal.
    expect(csvCell("=1")).toBe(`"'=1"`);
  });
});

// ============================================================================
// NAK-4 — Keine Verbindungsdaten im Export
// ============================================================================
describe("keine_verbindungsdaten (NAK-4)", () => {
  test("keine_verbindungsdaten: Die Datei enthält keine IP-Adresse, keinen Host, keine session_id und keine Quellen-Texte - CSV wie JSON", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const secrets = {
      ip: "198.51.100.23",
      host: "https://www.vhs-geheim.example",
      username: "besucher-name-geheim",
      session: "SITZUNG-3f9c2a-geheim",
      legacySession: "ALTSITZUNG-77aa-geheim",
      sameSession: "GLEICH-51bb-geheim",
      source: "QUELLE: interner Text aus dem Dokument",
      sourceUrl: "file://intern/kursplanung.docx",
    };
    const response = (text) =>
      JSON.stringify({
        text,
        type: "chat",
        sources: [
          {
            id: "doc-1",
            title: "kursplanung.docx",
            url: secrets.sourceUrl,
            text: secrets.source,
            chunkSource: secrets.sourceUrl,
          },
        ],
        courseSources: [{ title: "Kurs", url: secrets.sourceUrl }],
        courseTeaserLines: [secrets.source],
        metrics: { ip: secrets.ip },
      });
    const connection = JSON.stringify({
      ip: secrets.ip,
      host: secrets.host,
      username: secrets.username,
    });
    const at = berlinInstant("2026-09-10", 9, 0).getTime();
    await db.client.embed_chats.createMany({
      data: [
        // Konversation mit eigener Kennung
        {
          embed_id: embed.id,
          prompt: "Frage 1",
          response: response("Antwort 1"),
          session_id: secrets.session,
          conversation_id: "konv-offen",
          connection_information: connection,
          createdAt: new Date(at),
        },
        {
          embed_id: embed.id,
          prompt: "Frage 2",
          response: response("Antwort 2"),
          session_id: secrets.session,
          conversation_id: "konv-offen",
          connection_information: connection,
          createdAt: new Date(at + 60_000),
          feedbackScore: false,
          feedbackReason: "Zu ungenau",
          feedbackText: "Kommentar",
        },
        // Alt-Zeile: Die Liste zeigt hier die session_id als ID
        {
          embed_id: embed.id,
          prompt: "Alt-Frage",
          response: response("Alt-Antwort"),
          session_id: secrets.legacySession,
          conversation_id: null,
          connection_information: connection,
          createdAt: new Date(at + 120_000),
        },
        // conversation_id gleich der session_id
        {
          embed_id: embed.id,
          prompt: "Gleich-Frage",
          response: response("Gleich-Antwort"),
          session_id: secrets.sameSession,
          conversation_id: secrets.sameSession,
          connection_information: connection,
          createdAt: new Date(at + 180_000),
        },
      ],
    });

    // Die Liste nennt die session_id (als ID der Alt-Konversation) - der Export nicht.
    const listed = await listAll(embed);
    expect(listed.map((c) => c.conversation_id)).toContain(
      secrets.legacySession
    );

    for (const format of ["csv", "json"]) {
      const result = await exportFile(embed, format);
      expect(result.statusCode).toBe(200);
      for (const [name, secret] of Object.entries(secrets))
        expect([format, name, result.body.includes(secret)]).toEqual([
          format,
          name,
          false,
        ]);
      expect(result.body).not.toMatch(
        /session|connection|sources|courseSources|chunkSource|kursplanung|198\.51\.100|\bip\b|\bhost\b/i
      );
      // Auch die Kopfzeilen der Antwort nennen nichts davon.
      expect(JSON.stringify(result.headers)).not.toMatch(/geheim|198\.51/);
      // vollständig: alle vier Nachrichten
      for (const text of [
        "Antwort 1",
        "Antwort 2",
        "Alt-Antwort",
        "Gleich-Antwort",
      ])
        expect(result.body).toContain(text);
    }

    const rows = table(await exportFile(embed, "csv"));
    expect(rows.map((row) => [row.Frage, row["Konversations-ID"]])).toEqual([
      ["Gleich-Frage", ""],
      ["Alt-Frage", ""],
      ["Frage 1", "konv-offen"],
      ["Frage 2", "konv-offen"],
    ]);
    const json = JSON.parse((await exportFile(embed, "json")).body);
    expect(json.map((c) => c.conversationId)).toEqual([
      null,
      null,
      "konv-offen",
    ]);
    expect(Object.keys(json[2].messages[0]).sort()).toEqual(
      [
        "message",
        "prompt",
        "rating",
        "ratingComment",
        "ratingReason",
        "response",
        "timestamp",
      ].sort()
    );
  });

  test("keine_verbindungsdaten: Die Abfrage des Exports liest weder connection_information noch die Quellen aus der Datenbank", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await addChat(embed, {
      at: berlinInstant("2026-09-10", 9, 0),
      conversation: "k-1",
    });
    const batches = jest.spyOn(EmbedChats, "_exportMessages");
    await exportFile(embed, "csv");

    const byGroup = await batches.mock.results[0].value;
    const [messages] = [...byGroup.values()];
    expect(Object.keys(messages[0]).sort()).toEqual(
      [
        "answer",
        "createdAt",
        "feedbackReason",
        "feedbackScore",
        "feedbackText",
        "prompt",
      ].sort()
    );
    expect(JSON.stringify(messages)).not.toMatch(
      /QUELLENTEXT|203\.0\.113|sitzung/
    );
    expect(messages[0].createdAt).toBeInstanceOf(Date);
  });

  test("keine_verbindungsdaten: Dieselbe conversation_id in zwei Browser-Sitzungen bleibt - wie in der Liste - zwei Konversationen", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    await addChat(embed, {
      at: berlinInstant("2026-09-10", 9, 0),
      prompt: "eins",
      conversation: "geteilt",
      session: "sitzung-eins",
    });
    await addChat(embed, {
      at: berlinInstant("2026-09-10", 10, 0),
      prompt: "zwei",
      conversation: "geteilt",
      session: "sitzung-zwei",
    });
    await addChat(embed, {
      at: berlinInstant("2026-09-10", 10, 5),
      prompt: "zwei b",
      conversation: "geteilt",
      session: "sitzung-zwei",
    });

    const listed = await listAll(embed);
    expect(listed.map((c) => [c.conversation_number, c.message_count])).toEqual(
      [
        [1, 2],
        [2, 1],
      ]
    );
    const rows = table(await exportFile(embed, "csv"));
    expect(
      rows.map((row) => [row.Konversation, row.Nachricht, row.Frage])
    ).toEqual([
      ["1", "1", "zwei"],
      ["1", "2", "zwei b"],
      ["2", "1", "eins"],
    ]);
  });
});

// ============================================================================
// Dateiname (AK-10)
// ============================================================================
describe("Dateiname (AK-10)", () => {
  test("exportFileName: konversationen_<widget>_<von>_<bis>.<endung>, nur dateinamenssichere Zeichen", () => {
    expect(
      exportFileName({
        embedId: 3,
        workspaceName: "VHS Musterstadt",
        fromDay: "2026-09-01",
        toDay: "2026-09-30",
        extension: "csv",
      })
    ).toBe("konversationen_vhs-musterstadt-3_2026-09-01_2026-09-30.csv");
    expect(
      exportFileName({
        embedId: 12,
        workspaceName: "Volkshochschule Köln/Süd – Außenstelle „Nord“ (Test)",
        extension: "json",
      })
    ).toBe(
      "konversationen_volkshochschule-koeln-sued-aussenstelle-nord-test-12_gesamt.json"
    );
    expect(
      exportFileName({
        embedId: 1,
        workspaceName: null,
        fromDay: "2026-09-01",
        extension: "csv",
      })
    ).toBe("konversationen_widget-1_ab-2026-09-01.csv");
    expect(
      exportFileName({
        embedId: 1,
        workspaceName: "///",
        toDay: "2026-09-30",
        extension: "csv",
      })
    ).toBe("konversationen_widget-1_bis-2026-09-30.csv");

    // Was auch immer als Name kommt: nichts, was einen Header oder Pfad bricht.
    for (const name of [
      'a"; filename="x.exe',
      "..\\..\\etc/passwd",
      "zeile\r\nSet-Cookie: x=1",
      "名前",
      "Ünïcödé Ñame",
      "x".repeat(500),
    ]) {
      const file = exportFileName({
        embedId: 7,
        workspaceName: name,
        extension: "csv",
      });
      expect(file).toMatch(/^konversationen_[a-z0-9-]+_gesamt\.csv$/);
      expect(file.length).toBeLessThan(100);
    }
    expect(fileNameSlug("Ünïcödé Ñame")).toBe("uenicoede-name");
    expect(fileNameSlug("  --  ")).toBe("");
  });
});
