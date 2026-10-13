/* eslint-env jest, node */
// Konversationen: Suche, Reihenfolge und Öffnen per Link (Konversationen-
// Ansicht mit Seitenpanel).
//
// Geprüft wird gegen die echten Routen mit ihrer ganzen Middleware-Kette
// (support/routeHarness.js: Anmeldung, Rollenprüfung, Bindung an den
// Workspace) und gegen eine echte SQLite-Datei aus den Migrationen
// (helpers/sqliteTestDatabase.js) - die Suche ist SQL (GLOB, json_extract),
// eine Attrappe könnte sie nicht prüfen.
//
//   POST /embed/:embedId/analytics/conversations  mit q   (AK-3, AK-10–12, NAK-2–4, NAK-8)
//   POST /embed/:embedId/analytics/export         mit q   (AK-12)
//   GET  /embed/:embedId/conversation/:chatId              (AK-7, NAK-1, NAK-8)
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
jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: () => null },
}));
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
} = require("../helpers/sqliteTestDatabase");
const { makeJWT } = require("../../utils/http");
const { MessageLedger } = require("../../models/messageLedger");
const { embedManagementEndpoints } = require("../../endpoints/embedManagement");
const {
  parseSearch,
  searchForms,
  searchGlobPattern,
  searchProbe,
  loggableError,
  SEARCH_MAX_LENGTH,
} = require("../../utils/helpers/chat/conversationSearch");
const { EmbedChats } = require("../../models/embedChats");

const routes = collectRoutes(embedManagementEndpoints);
const route = ({ method, path }) => routes[`${method} ${path}`];
const CONVERSATIONS = route(ROUTES.conversations);
const EXPORT = route(ROUTES.export);
const DETAILS = route(ROUTES.details);

// Der erste Test jeder Datei erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

let db;
let userCounter = 0;
let admin;

beforeEach(async () => {
  MessageLedger._resetCache();
  delete process.env.DISABLE_VIEW_CHAT_HISTORY;
  db = await createTestDatabase();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  await db.client.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
  admin = await createUser("admin");
});
afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});
afterAll(() => {
  MessageLedger._resetCache();
  removeTestDatabases();
});

// ---------------------------------------------------------------------------
// Bestand
// ---------------------------------------------------------------------------

/**
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

// Was eine gespeicherte Antwort außer dem Text enthält: Quellen und Metadaten.
const SOURCE_WORD = "Quellenwortnurhier";
const META_WORD = "Metawortnurhier";

/**
 * Eine Widget-Nachricht, wie der Chat sie speichert: Antwort als JSON mit
 * Text, Quellen und Metadaten. `rawResponse` speichert die Antwort wörtlich
 * (Alt-Zeilen ohne JSON).
 */
async function addChat(
  embed,
  {
    at,
    prompt = "Frage",
    answer = "Antwort",
    rawResponse,
    conversation,
    session,
    ...data
  }
) {
  return await db.client.embed_chats.create({
    data: {
      embed_id: embed.id,
      prompt,
      response:
        rawResponse ??
        JSON.stringify({
          text: answer,
          type: "chat",
          sources: [{ title: "kursprogramm.pdf", text: SOURCE_WORD }],
          metrics: { note: META_WORD },
        }),
      session_id: session ?? `sitzung-${conversation}`,
      conversation_id: conversation === undefined ? null : conversation,
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
const OCTOBER = period("2026-10-01", "2026-10-31");

/** Eine Seite der Liste (Antwort der echten Route). */
function listPage(embed, request = {}, user = admin) {
  return invoke(CONVERSATIONS, {
    params: { embedId: String(embed?.id ?? embed) },
    body: conversationsBody({ ...OCTOBER, limit: 100, ...request }),
    token: user?.token ?? null,
  });
}

/** Kennungen der Konversationen einer Suche, in der Reihenfolge der Liste. */
async function found(embed, search, request = {}) {
  const result = await listPage(embed, { search, ...request });
  expect(result.statusCode).toBe(200);
  expect(result.body.success).toBe(true);
  expect(result.body.totalCount).toBe(result.body.conversations.length);
  return result.body.conversations.map((c) => c.conversation_id);
}

function details(embed, chatId, user = admin) {
  return invoke(DETAILS, {
    params: {
      embedId: String(embed?.id ?? embed),
      chatId: String(chatId),
    },
    token: user?.token ?? null,
  });
}

function exportFile(embed, format, request = {}, user = admin) {
  return invoke(EXPORT, {
    params: { embedId: String(embed?.id ?? embed) },
    body: exportBody(format, request),
    token: user?.token ?? null,
  });
}

// ---------------------------------------------------------------------------
// Suchmuster (Hilfsfunktionen)
// ---------------------------------------------------------------------------

describe("suchmuster", () => {
  test("parseSearch: getrimmt, leer = keine Suche, kein Text oder zu lang = Fehler", () => {
    expect(parseSearch(undefined)).toEqual({ search: null, error: null });
    expect(parseSearch(null)).toEqual({ search: null, error: null });
    expect(parseSearch("   ")).toEqual({ search: null, error: null });
    expect(parseSearch("  Spanisch ")).toEqual({
      search: "Spanisch",
      error: null,
    });
    // NFD (u + Trema) wird zu NFC (ü)
    expect(parseSearch("u\u0308bung").search).toBe("übung");
    for (const value of [3, true, ["a"], { q: "a" }])
      expect(parseSearch(value).error).toMatch(/string/);
    expect(parseSearch("x".repeat(SEARCH_MAX_LENGTH)).error).toBeNull();
    expect(parseSearch("x".repeat(SEARCH_MAX_LENGTH + 1)).error).toMatch(
      /longer/
    );
  });

  test("searchGlobPattern: Buchstaben als Klasse ihrer Schreibweisen, Platzhalter wörtlich", () => {
    expect(searchGlobPattern("übung")).toBe("*[üÜ][bB][uU][nN][gG]*");
    expect(searchGlobPattern("größe")).toBe("*[gG][rR][öÖ][ßẞ][eE]*");
    expect(searchGlobPattern("a*b?c[d]")).toBe("*[aA][*][bB][?][cC][[][dD]]*");
    expect(searchGlobPattern("100 %_x")).toBe("*100 %_[xX]*");
    expect(searchGlobPattern("^-]")).toBe("*^-]*");
  });

  test("parseSearch: Rohlänge, Steuerzeichen und allein stehende Ersatzhälften → Fehler (Fixliste 1–3)", () => {
    // Rohwert zu lang: abgelehnt, bevor er normalisiert oder zerlegt wird
    const huge = " ".repeat(5_000_000) + "x";
    const normalize = jest.spyOn(String.prototype, "normalize");
    expect(parseSearch(huge).error).toMatch(/longer/);
    expect(normalize).not.toHaveBeenCalled();
    normalize.mockRestore();
    expect(
      parseSearch(" ".repeat(SEARCH_MAX_LENGTH * 4 - 1) + "x").search
    ).toBe("x");
    // NUL und andere Steuerzeichen
    for (const value of [
      "\u0000",
      "\u0000zzz",
      "ab\u0000xy",
      "a\tb",
      "x\u007f",
    ])
      expect([value, parseSearch(value).error]).toEqual([
        value,
        expect.stringMatching(/control/),
      ]);
    // nur Leerraum (auch Tabulator/Umbruch) bleibt „keine Suche"
    expect(parseSearch("\n\t ")).toEqual({ search: null, error: null });
    // Ersatzhälften allein: kein gültiges Unicode; ein Paar ist ein Zeichen
    for (const value of ["\ud800", "a\udc00b", "\ud83d"])
      expect(parseSearch(value).error).toMatch(/well-formed/);
    expect(parseSearch("Kurs 😀")).toEqual({ search: "Kurs 😀", error: null });
  });

  test("searchForms: NFC und – falls verschieden – NFD", () => {
    expect(searchForms("Übung")).toEqual(["Übung", "U\u0308bung"]);
    expect(searchForms("kurs")).toEqual(["kurs"]);
    expect(searchForms("größe")).toEqual(["größe", "gro\u0308ße"]);
  });

  test("searchProbe: billige Vorprüfung, wählerisch auch bei Umlauten und Kyrillisch (Fixliste 6)", () => {
    // ohne Buchstaben außerhalb von ASCII: ein LIKE, schon genau
    expect(searchProbe("kurs")).toEqual({
      op: "like",
      values: ["%kurs%"],
      exact: true,
    });
    expect(searchProbe("10 %_\\")).toEqual({
      op: "like",
      values: ["%10 \\%\\_\\\\%"],
      exact: true,
    });
    // längster Abschnitt ohne Umlaut (ab drei Buchstaben)
    expect(searchProbe("Übung")).toEqual({
      op: "like",
      values: ["%bung%"],
      exact: false,
    });
    // kurzer Begriff: Schreibweisen ausgeschrieben; ASCII-Buchstaben → LIKE
    expect(searchProbe("für")).toEqual({
      op: "like",
      values: ["%für%", "%fÜr%"],
      exact: false,
    });
    expect(searchProbe("äa").values).toEqual(["%äa%", "%Äa%"]);
    // ohne ASCII-Buchstaben: instr, höchstens vier Schreibweisen
    expect(searchProbe("курс")).toEqual({
      op: "instr",
      values: ["ку", "кУ", "Ку", "КУ"],
      exact: false,
    });
    expect(searchProbe("äöü").values).toEqual(["äö", "äÖ", "Äö", "ÄÖ"]);
    // ß hat zwei Schreibweisen (ß, ẞ)
    expect(searchProbe("ßü").values).toHaveLength(4);
    // Kein Zeichen „_" für einen Umlaut: Die Vorprüfung ließe sonst fast
    // jede Zeile durch.
    for (const term of ["üb", "äa", "äöü", "курс", "für"])
      expect(searchProbe(term).values.join("")).not.toMatch(/_/);
  });

  test("loggableError: Name und Codes, nie der Meldungstext (Fixliste 3)", () => {
    const error = Object.assign(
      new Error("Raw query failed … LIKE '%geheim%' …"),
      { code: "P2010", meta: { code: "1" } }
    );
    expect(loggableError(error)).toEqual({
      name: "Error",
      code: "P2010",
      dbCode: "1",
    });
    expect(JSON.stringify(loggableError(error))).not.toMatch(/geheim/);
    expect(loggableError(undefined)).toEqual({
      name: null,
      code: null,
      dbCode: null,
    });
  });
});

// ---------------------------------------------------------------------------
// AK-10: Suche über Frage, Antworttext, Grund und Kommentar
// ---------------------------------------------------------------------------

describe("suche (AK-10)", () => {
  let embed;
  beforeEach(async () => {
    embed = await createEmbed(db.client, await createWorkspace(db.client));
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Welche Sprachkurse gibt es?",
      answer: "Wir bieten **Spanisch** und Englisch an.",
      conversation: "antwort",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-06", 9, 0),
      prompt: "Ich suche einen spanischkurs am Abend",
      conversation: "frage",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-07", 9, 0),
      prompt: "Gibt es Yoga?",
      feedbackScore: false,
      feedbackReason: "Nicht SPANISCH genug",
      conversation: "grund",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-08", 9, 0),
      prompt: "Gibt es Pilates?",
      feedbackScore: false,
      feedbackText: "Ich wollte eigentlich Spanischunterricht",
      conversation: "kommentar",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-09", 9, 0),
      prompt: "Wann beginnt Französisch?",
      answer: "Am Montag.",
      conversation: "kein-treffer",
    });
    // zweite Zeile einer Konversation trifft - die ganze Konversation zählt
    await addChat(embed, {
      at: berlinInstant("2026-10-10", 9, 0),
      prompt: "Gibt es Kochkurse?",
      conversation: "zweite-zeile",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-10", 9, 5),
      prompt: "Und spanische Küche?",
      conversation: "zweite-zeile",
    });
  });

  test("„spanisch“ findet genau die Konversationen mit Treffer in Frage, Antworttext, Grund oder Kommentar", async () => {
    expect((await found(embed, "spanisch")).sort()).toEqual(
      ["antwort", "frage", "grund", "kommentar", "zweite-zeile"].sort()
    );
    // Die Treffer-Konversation kommt vollständig: beide Zeilen gezählt
    const result = await listPage(embed, { search: "spanische" });
    expect(result.body.conversations).toEqual([
      expect.objectContaining({
        conversation_id: "zweite-zeile",
        message_count: 2,
        preview: "Gibt es Kochkurse?",
      }),
    ]);
  });

  test("ohne Treffer: leere Liste, Zähler 0, Status 200", async () => {
    const result = await listPage(embed, { search: "Klingonisch" });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      success: true,
      conversations: [],
      hasMore: false,
      totalCount: 0,
    });
  });

  test("leerer oder nur aus Leerraum bestehender Begriff = keine Suche", async () => {
    const all = await found(embed, null);
    expect(all).toHaveLength(6);
    for (const q of ["", "   ", "\n\t"]) {
      const result = await invoke(CONVERSATIONS, {
        params: { embedId: String(embed.id) },
        body: { ...conversationsBody({ ...OCTOBER, limit: 100 }), q },
        token: admin.token,
      });
      expect(result.body.conversations.map((c) => c.conversation_id)).toEqual(
        all
      );
    }
  });

  test("ungültiger Begriff: 400 ohne Daten (kein Text, länger als 200 Zeichen)", async () => {
    for (const q of [42, ["spanisch"], { $gt: "" }, "x".repeat(201)]) {
      const result = await invoke(CONVERSATIONS, {
        params: { embedId: String(embed.id) },
        body: { ...conversationsBody(OCTOBER), q },
        token: admin.token,
      });
      expect(result.statusCode).toBe(400);
      expect(result.body.success).toBe(false);
      expect(JSON.stringify(result.body)).not.toMatch(/Sprach|Yoga/);
    }
  });

  test("Blättern: Seiten der Suche ergeben zusammen die ganze Treffermenge, ohne Doppelte", async () => {
    const pages = [];
    for (let offset = 0; ; offset += 2) {
      const result = await listPage(embed, {
        search: "spanisch",
        offset,
        limit: 2,
      });
      expect(result.body.totalCount).toBe(5);
      pages.push(...result.body.conversations.map((c) => c.conversation_id));
      if (!result.body.hasMore) break;
    }
    expect(pages).toEqual(await found(embed, "spanisch"));
  });
});

// ---------------------------------------------------------------------------
// AK-11: Groß/klein egal, auch bei Umlauten
// ---------------------------------------------------------------------------

describe("umlaute (AK-11)", () => {
  let embed;
  beforeEach(async () => {
    embed = await createEmbed(db.client, await createWorkspace(db.client));
    const texts = {
      uebung: "Gibt es eine Übung für den Rücken?",
      grosse: "Welche GRÖßE haben die Räume?",
      gross_ss: "Welche GRÖSSE haben die Räume?",
      aerger: "ÄRGER mit der Anmeldung",
      ascii: "Kurs fuer Anfaenger",
    };
    let minute = 0;
    for (const [conversation, prompt] of Object.entries(texts))
      await addChat(embed, {
        at: berlinInstant("2026-10-05", 10, minute++),
        prompt,
        conversation,
      });
  });

  test("„übung“ findet „Übung“, „ÜBUNG“ ebenso", async () => {
    expect(await found(embed, "übung")).toEqual(["uebung"]);
    expect(await found(embed, "ÜBUNG")).toEqual(["uebung"]);
    expect(await found(embed, "Rücken")).toEqual(["uebung"]);
  });

  test("„größe“ findet „GRÖßE“ – und umgekehrt", async () => {
    expect(await found(embed, "größe")).toEqual(["grosse"]);
    expect(await found(embed, "GRÖßE")).toEqual(["grosse"]);
    expect(await found(embed, "GRÖẞE")).toEqual(["grosse"]);
  });

  test("dokumentiertes Verhalten: ß und SS gelten nicht als gleich, ü nicht als ue", async () => {
    expect(await found(embed, "größe")).not.toContain("gross_ss");
    expect(await found(embed, "GRÖSSE")).toEqual(["gross_ss"]);
    expect(await found(embed, "Anfänger")).toEqual([]);
    expect(await found(embed, "ärger")).toEqual(["aerger"]);
  });

  test("ein zerlegtes „ü“ (u + Trema, NFD) im Begriff findet das gespeicherte „ü“", async () => {
    expect(await found(embed, "u\u0308bung")).toEqual(["uebung"]);
  });
});

// ---------------------------------------------------------------------------
// NAK-3: Platzhalter und Sonderzeichen gelten wörtlich
// ---------------------------------------------------------------------------

describe("sonderzeichen (NAK-3)", () => {
  const TEXTS = {
    prozent: "Gibt es 10 % Rabatt?",
    unterstrich: "Datei kurs_liste.pdf",
    stern: "Bewertung: 5*",
    frage: "Wirklich?",
    klammer: "Kurs [A1] voll",
    apostroph: "Peter's Kurs",
    rueckstrich: "Pfad C:\\Kurse",
    anfuehrung: 'Der Kurs "Yoga"',
    ohne: "Gibt es Zumba",
  };
  let embed;
  beforeEach(async () => {
    embed = await createEmbed(db.client, await createWorkspace(db.client));
    let minute = 0;
    for (const [conversation, prompt] of Object.entries(TEXTS))
      await addChat(embed, {
        at: berlinInstant("2026-10-05", 11, minute++),
        prompt,
        // dieselben Zeichen auch im Antworttext (JSON maskiert " und \)
        answer: `Antwort zu: ${prompt}`,
        conversation,
      });
  });

  test.each([
    ["%", ["prozent"]],
    ["_", ["unterstrich"]],
    ["*", ["stern"]],
    ["?", ["prozent", "frage"]],
    ["[", ["klammer"]],
    ["[A1]", ["klammer"]],
    ["'", ["apostroph"]],
    ["\\", ["rueckstrich"]],
    ['"', ["anfuehrung"]],
    ['"Yoga"', ["anfuehrung"]],
    ["C:\\Kurse", ["rueckstrich"]],
    ["%_", []],
    ["*?", []],
  ])(
    "„%s“ trifft nur wörtlich – Status 200, kein Treffer auf alles",
    async (search, expected) => {
      const result = await listPage(embed, { search });
      expect(result.statusCode).toBe(200);
      expect(result.body.success).toBe(true);
      expect(
        result.body.conversations.map((c) => c.conversation_id).sort()
      ).toEqual([...expected].sort());
      expect(result.body.totalCount).toBe(expected.length);
    }
  );

  test("SQL im Begriff ist nur Text", async () => {
    for (const search of [
      "' OR 1=1 --",
      "%' OR '1'='1",
      '"); DROP TABLE embed_chats; --',
    ]) {
      const result = await listPage(embed, { search });
      expect(result.statusCode).toBe(200);
      expect(result.body.conversations).toEqual([]);
    }
    expect(await db.client.embed_chats.count()).toBe(Object.keys(TEXTS).length);
  });

  test("Treffer nur im Antworttext, mit Zeichen, die JSON maskiert", async () => {
    await addChat(embed, {
      at: berlinInstant("2026-10-06", 11, 0),
      prompt: "Wo?",
      answer: 'Raum "Süd"\\Nord',
      conversation: "json-maskiert",
    });
    expect(await found(embed, '"süd"\\nord')).toEqual(["json-maskiert"]);
  });
});

// ---------------------------------------------------------------------------
// NAK-4: Keine Treffer aus Quellen oder Metadaten
// ---------------------------------------------------------------------------

describe("unsichtbar (NAK-4)", () => {
  test("ein Wort nur in Quellen oder Metadaten einer JSON-Antwort trifft nicht; im Text schon; eine Antwort ohne JSON zählt wörtlich", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Gibt es Kurse?",
      conversation: "nur-quellen",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 1),
      prompt: "Und sonst?",
      answer: `Im Text steht ${SOURCE_WORD}.`,
      conversation: "im-text",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 2),
      prompt: "Alt",
      rawResponse: `Alte Antwort ohne JSON mit ${META_WORD}`,
      conversation: "alt-ohne-json",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 3),
      prompt: "Kaputt",
      rawResponse: `{"text": "abgebrochen ${META_WORD}`,
      conversation: "kaputtes-json",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 4),
      prompt: "Ohne Text",
      rawResponse: JSON.stringify({ sources: [{ text: META_WORD }] }),
      conversation: "json-ohne-text",
    });

    expect(await found(embed, SOURCE_WORD)).toEqual(["im-text"]);
    expect(await found(embed, "kursprogramm.pdf")).toEqual([]);
    expect((await found(embed, META_WORD)).sort()).toEqual(
      ["alt-ohne-json", "kaputtes-json"].sort()
    );
    expect(await found(embed, "sources")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NAK-2 / NAK-1: Rechte wie ohne Suche, auch beim Öffnen per Link
// ---------------------------------------------------------------------------

describe("rechte (NAK-1, NAK-2)", () => {
  let workspaceA, workspaceB, widgetA, widgetB, kunde, chatB;
  beforeEach(async () => {
    workspaceA = await createWorkspace(db.client);
    workspaceB = await createWorkspace(db.client);
    widgetA = await createEmbed(db.client, workspaceA);
    widgetB = await createEmbed(db.client, workspaceB);
    await addChat(widgetA, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Frage in A zu Spanisch",
      conversation: "a-1",
    });
    chatB = await addChat(widgetB, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "FREMDE Frage in B zu Spanisch",
      conversation: "b-1",
    });
    kunde = await createUser("default", [workspaceA.id]);
  });

  test("NAK-2: q mit fremdem Widget – 403 wie ohne q, keine Zählung, kein Treffer", async () => {
    const withoutSearch = await listPage(widgetB, {}, kunde);
    const withSearch = await listPage(widgetB, { search: "spanisch" }, kunde);
    for (const result of [withoutSearch, withSearch]) {
      expect(result.statusCode).toBe(403);
      expect(result.body).toBeUndefined();
    }
    // auch ein unbekanntes Widget und ein Nutzer ohne Workspace
    const ohneWorkspace = await createUser("default", []);
    for (const [embed, user] of [
      ["9999", kunde],
      [widgetA, ohneWorkspace],
      [widgetB, ohneWorkspace],
    ]) {
      const result = await listPage(embed, { search: "Frage" }, user);
      expect(result.statusCode).toBe(403);
      expect(JSON.stringify(result.body ?? "")).not.toMatch(/Frage/);
    }
    // eigenes Widget: nur die eigene Konversation
    expect(
      (
        await listPage(widgetA, { search: "spanisch" }, kunde)
      ).body.conversations.map((c) => c.conversation_id)
    ).toEqual(["a-1"]);
  });

  test("NAK-2: Export mit q für ein fremdes Widget – 403, keine Datei", async () => {
    const result = await exportFile(
      widgetB,
      "csv",
      { ...OCTOBER, search: "spanisch" },
      kunde
    );
    expect(result.statusCode).toBe(403);
    expect(result.chunks).toEqual([]);
  });

  test("NAK-1: Öffnen per Link – ohne Recht auf das Widget 403 ohne Nachricht; über das eigene Widget ist die fremde Zeile keine Konversation", async () => {
    const foreign = await details(widgetB, chatB.id, kunde);
    expect(foreign.statusCode).toBe(403);
    expect(JSON.stringify(foreign.body ?? "")).not.toMatch(/FREMDE/);

    const ohneWorkspace = await createUser("default", []);
    expect((await details(widgetB, chatB.id, ohneWorkspace)).statusCode).toBe(
      403
    );

    // Die Zeile aus B über das Widget A angefragt: keine Nachricht.
    const viaOwn = await details(widgetA, chatB.id, kunde);
    expect(viaOwn.statusCode).toBe(200);
    expect(viaOwn.body).toEqual({ success: true, messages: [] });

    // ohne Anmeldung
    expect((await details(widgetB, chatB.id, null)).statusCode).toBe(401);
  });

  test("AK-7: Öffnen per Link – Mitglied, manager und admin sehen die Konversation, auch außerhalb des Zeitraums der Liste", async () => {
    const old = await addChat(widgetA, {
      at: berlinInstant("2025-01-15", 9, 0),
      prompt: "Alte Frage aus dem Januar 2025",
      conversation: "a-alt",
    });
    // nicht in der Liste des Standard-Zeitraums
    expect(
      (await listPage(widgetA, {}, kunde)).body.conversations.map(
        (c) => c.conversation_id
      )
    ).not.toContain("a-alt");

    const manager = await createUser("manager");
    for (const user of [kunde, manager, admin]) {
      const result = await details(widgetA, old.id, user);
      expect(result.statusCode).toBe(200);
      expect(result.body.messages.map((m) => m.prompt)).toEqual([
        "Alte Frage aus dem Januar 2025",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// AK-12: Suche zusammen mit Filtern, Zeitraum und Export
// ---------------------------------------------------------------------------

describe("kombiniert (AK-12)", () => {
  let embed, workspace;
  beforeEach(async () => {
    workspace = await createWorkspace(db.client, { name: "VHS Musterstadt" });
    embed = await createEmbed(db.client, workspace);
    const rows = [
      // [Kennung, Tag, Frage, negativ bewertet]
      ["kurs-neg", "2026-10-05", "Welcher Kurs passt?", true],
      ["kurs-ohne", "2026-10-06", "Gibt es einen Kurs?", false],
      ["anderes-neg", "2026-10-07", "Wo parke ich?", true],
      ["kurs-neg-september", "2026-09-20", "Kurs im September?", true],
    ];
    for (const [conversation, day, prompt, negative] of rows)
      await addChat(embed, {
        at: berlinInstant(day, 9, 0),
        prompt,
        feedbackScore: negative ? false : null,
        conversation,
      });
  });

  test("Liste und Export enthalten genau die Schnittmenge aus Suche, Bewertungsfilter und Zeitraum; der Dateiname bleibt", async () => {
    const request = { ...OCTOBER, feedbackFilter: "negative", search: "kurs" };
    expect(await found(embed, "kurs", { feedbackFilter: "negative" })).toEqual([
      "kurs-neg",
    ]);

    const json = await exportFile(embed, "json", request);
    expect(json.statusCode).toBe(200);
    const file = JSON.parse(json.body);
    expect(file.map((c) => c.conversationId)).toEqual(["kurs-neg"]);
    expect(json.headers["Content-Disposition"]).toBe(
      'attachment; filename="konversationen_vhs-musterstadt-' +
        `${embed.id}_2026-10-01_2026-10-31.json"`
    );

    const withoutSearch = await exportFile(embed, "json", {
      ...OCTOBER,
      feedbackFilter: "negative",
    });
    expect(
      JSON.parse(withoutSearch.body)
        .map((c) => c.conversationId)
        .sort()
    ).toEqual(["anderes-neg", "kurs-neg"]);
    // Dateiname mit und ohne Suche gleich
    expect(withoutSearch.headers["Content-Disposition"]).toBe(
      json.headers["Content-Disposition"]
    );
  });

  test("Export: Format und Nummer unverändert – die Spalte „Konversation“ trägt die Nummer der ungefilterten Liste", async () => {
    const all = await listPage(embed, {});
    const numberOf = Object.fromEntries(
      all.body.conversations.map((c) => [
        c.conversation_id,
        c.conversation_number,
      ])
    );
    const csv = await exportFile(embed, "csv", { ...OCTOBER, search: "kurs" });
    expect(csv.statusCode).toBe(200);
    // Die Zellen dieses Bestands enthalten weder Semikolon noch Umbruch.
    const cells = (line) =>
      line.split(";").map((cell) => cell.replace(/^"|"$/g, ""));
    const lines = csv.body.slice(1).split("\r\n").filter(Boolean);
    expect(cells(lines[0])).toEqual([
      "Konversation",
      "Konversations-ID",
      "Nachricht",
      "Zeitpunkt",
      "Frage",
      "Antwort",
      "Bewertung",
      "Grund der negativen Bewertung",
      "Kommentar zur negativen Bewertung",
    ]);
    expect(lines.slice(1).map((line) => cells(line).slice(0, 2))).toEqual([
      [String(numberOf["kurs-ohne"]), "kurs-ohne"],
      [String(numberOf["kurs-neg"]), "kurs-neg"],
    ]);
  });

  test("Export mit ungültigem q: 400 ohne Datei", async () => {
    const result = await invoke(EXPORT, {
      params: { embedId: String(embed.id) },
      body: { ...exportBody("csv", OCTOBER), q: 7 },
      token: admin.token,
    });
    expect(result.statusCode).toBe(400);
    expect(result.chunks).toEqual([]);
  });

  test("Abschnitts-Filter (Diagramm) und Suche zusammen", async () => {
    expect(
      await found(embed, "kurs", {
        bucket: { start: "2026-10-06", end: "2026-10-06" },
      })
    ).toEqual(["kurs-ohne"]);
  });
});

// ---------------------------------------------------------------------------
// AK-3: Reihenfolge nach letzter Nachricht
// ---------------------------------------------------------------------------

describe("reihenfolge (AK-3)", () => {
  test("eine weitergeführte alte Konversation steht ganz oben; mit Suche ebenso", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    await addChat(embed, {
      at: berlinInstant("2026-10-02", 9, 0),
      prompt: "Alte Frage zum Kurs",
      conversation: "alt",
    });
    for (let day = 3; day <= 12; day++)
      await addChat(embed, {
        at: berlinInstant(`2026-10-${String(day).padStart(2, "0")}`, 9, 0),
        prompt: `Kurs am ${day}.`,
        conversation: `k-${day}`,
      });
    expect((await found(embed, null)).at(-1)).toBe("alt");

    // Der Besucher schreibt in der alten Konversation weiter.
    await addChat(embed, {
      at: berlinInstant("2026-10-13", 7, 47),
      prompt: "Noch eine Frage",
      conversation: "alt",
    });
    const list = await listPage(embed, {});
    expect(list.body.conversations[0]).toEqual(
      expect.objectContaining({
        conversation_id: "alt",
        message_count: 2,
        started_at: berlinInstant("2026-10-02", 9, 0).getTime(),
        last_message_at: berlinInstant("2026-10-13", 7, 47).getTime(),
      })
    );
    expect((await found(embed, "kurs"))[0]).toBe("alt");
  });

  test("gleiche letzte Nachricht: feste Reihenfolge (jüngere Zeile zuerst) – Blättern ohne Doppelte", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    const at = berlinInstant("2026-10-05", 9, 0);
    for (let i = 0; i < 7; i++)
      await addChat(embed, {
        at,
        prompt: `Gleichzeitig ${i}`,
        conversation: `g-${i}`,
      });
    const seen = [];
    for (let offset = 0; offset < 7; offset += 3) {
      const page = await listPage(embed, { offset, limit: 3 });
      seen.push(...page.body.conversations.map((c) => c.conversation_id));
    }
    expect(seen).toEqual(["g-6", "g-5", "g-4", "g-3", "g-2", "g-1", "g-0"]);
  });
});

// ---------------------------------------------------------------------------
// NAK-8: Alt-Chats ohne conversation_id
// ---------------------------------------------------------------------------

describe("alt_chats (NAK-8)", () => {
  test("Alt-Zeilen ohne conversation_id: gefunden, nicht mit der neuen Konversation derselben Sitzung vermischt, per Link geöffnet genau ihre Zeilen", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    const firstOld = await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Alte Frage zum Töpfern",
      conversation: null,
      session: "sitzung-x",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 1),
      prompt: "Alte zweite Frage",
      conversation: null,
      session: "sitzung-x",
    });
    const newer = await addChat(embed, {
      at: berlinInstant("2026-10-06", 9, 0),
      prompt: "Neue Frage zum Töpfern",
      conversation: "neu-1",
      session: "sitzung-x",
    });
    // andere Sitzung, ebenfalls ohne conversation_id
    await addChat(embed, {
      at: berlinInstant("2026-10-07", 9, 0),
      prompt: "Fremde alte Frage zum Töpfern",
      conversation: null,
      session: "sitzung-y",
    });

    const list = await listPage(embed, { search: "töpfern" });
    expect(
      list.body.conversations.map((c) => [c.conversation_id, c.message_count])
    ).toEqual([
      ["sitzung-y", 1],
      ["neu-1", 1],
      ["sitzung-x", 2],
    ]);
    // Suche nur in der zweiten Alt-Zeile trifft die Alt-Konversation
    expect(await found(embed, "zweite Frage")).toEqual(["sitzung-x"]);

    // Öffnen per Link (first_chat_id bzw. irgendeine Zeile): nur die Alt-Zeilen
    const legacy = list.body.conversations.find(
      (c) => c.conversation_id === "sitzung-x"
    );
    expect(legacy.first_chat_id).toBe(firstOld.id);
    const opened = await details(embed, legacy.first_chat_id);
    expect(opened.body.messages.map((m) => m.prompt)).toEqual([
      "Alte Frage zum Töpfern",
      "Alte zweite Frage",
    ]);
    const openedNew = await details(embed, newer.id);
    expect(openedNew.body.messages.map((m) => m.prompt)).toEqual([
      "Neue Frage zum Töpfern",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AK-1: Angaben je Zeile; Liste und Zähler aus einer Abfrage
// ---------------------------------------------------------------------------

describe("zeile (AK-1)", () => {
  test("first_negative_reason: der erste Grund einer negativen Bewertung im Zeitraum; ohne Grund null", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    await addChat(embed, {
      at: berlinInstant("2026-09-30", 9, 0),
      prompt: "Vor dem Zeitraum",
      feedbackScore: false,
      feedbackReason: "Grund aus September",
      conversation: "mit-grund",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Erste Frage",
      feedbackScore: false,
      feedbackReason: "Unvollständig",
      conversation: "mit-grund",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 1),
      prompt: "Zweite Frage",
      feedbackScore: false,
      feedbackReason: "Falsch",
      conversation: "mit-grund",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 10, 0),
      prompt: "Ohne Grund",
      feedbackScore: false,
      feedbackText: "nur Kommentar",
      conversation: "ohne-grund",
    });
    // dieselbe Kennung in einer anderen Sitzung: eigene Konversation
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 11, 0),
      prompt: "Andere Sitzung",
      feedbackScore: false,
      feedbackReason: "Grund der anderen Sitzung",
      conversation: "mit-grund",
      session: "andere-sitzung",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 12, 0),
      prompt: "Positiv",
      feedbackScore: true,
      conversation: "positiv",
    });

    const result = await listPage(embed, {});
    expect(
      result.body.conversations.map((c) => [
        c.conversation_id,
        c.session_id,
        c.first_negative_reason,
      ])
    ).toEqual([
      ["positiv", "sitzung-positiv", null],
      ["mit-grund", "andere-sitzung", "Grund der anderen Sitzung"],
      ["ohne-grund", "sitzung-ohne-grund", null],
      ["mit-grund", "sitzung-mit-grund", "Unvollständig"],
    ]);
  });

  test("totalCount aus derselben Abfrage wie die Seite; hinter dem Ende geblättert stimmt er weiterhin", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    for (let i = 0; i < 5; i++)
      await addChat(embed, {
        at: berlinInstant("2026-10-05", 9, i),
        prompt: `Kurs ${i}`,
        conversation: `k-${i}`,
      });
    const page = await listPage(embed, { search: "kurs", offset: 2, limit: 2 });
    expect(page.body).toMatchObject({ totalCount: 5, hasMore: true });
    expect(page.body.conversations).toHaveLength(2);
    const behind = await listPage(embed, {
      search: "kurs",
      offset: 10,
      limit: 2,
    });
    expect(behind.body).toEqual({
      success: true,
      conversations: [],
      hasMore: false,
      totalCount: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// Fixliste nach den Reviews (13.10.2026) – Server
// ---------------------------------------------------------------------------

describe("eingaben (Fixliste 1–4)", () => {
  let embed;
  beforeEach(async () => {
    embed = await createEmbed(db.client, await createWorkspace(db.client));
    for (let i = 0; i < 5; i++)
      await addChat(embed, {
        at: berlinInstant("2026-10-05", 9, i),
        prompt: `Hallo Kurs ${i}`,
        conversation: `k-${i}`,
      });
  });

  const rawList = (body) =>
    invoke(CONVERSATIONS, {
      params: { embedId: String(embed.id) },
      body: { ...conversationsBody({ ...OCTOBER }), ...body },
      token: admin.token,
    });

  test("NUL und Steuerzeichen im Begriff: 400 – kein Treffer auf alles (NAK-3)", async () => {
    for (const q of ["\u0000", "\u0000zzz", "ab\u0000xy", "x\u0001", "a\tb"]) {
      const result = await rawList({ q });
      expect([q, result.statusCode]).toEqual([q, 400]);
      expect(result.body).toEqual({
        success: false,
        error: expect.any(String),
      });
      const exported = await invoke(EXPORT, {
        params: { embedId: String(embed.id) },
        body: { ...exportBody("csv", OCTOBER), q },
        token: admin.token,
      });
      expect([q, exported.statusCode]).toEqual([q, 400]);
      expect(exported.chunks).toEqual([]);
    }
  });

  test("allein stehende Ersatzhälfte: 400; riesiges q: 400, bevor es verarbeitet wird", async () => {
    expect((await rawList({ q: "\ud800" })).statusCode).toBe(400);
    expect((await rawList({ q: "Kurs\udfff" })).statusCode).toBe(400);
    const normalize = jest.spyOn(String.prototype, "normalize");
    const huge = await rawList({ q: "x".repeat(2_000_000) });
    expect(huge.statusCode).toBe(400);
    expect(normalize).not.toHaveBeenCalled();
  });

  test("limit und offset: ganze Zahlen, limit 1–100, offset ab 0 – sonst 400; ohne Angabe 0 und 20; hasMore stimmt", async () => {
    for (const body of [
      { limit: -1 },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: "5" },
      { limit: "1; DROP TABLE embed_chats" },
      { limit: [1] },
      { limit: 1e12 },
      { offset: -5 },
      { offset: "1" },
      { offset: 2.5 },
      { offset: { $gt: 0 } },
    ]) {
      const result = await rawList(body);
      expect([body, result.statusCode]).toEqual([body, 400]);
      expect(result.body).toEqual({
        success: false,
        error: expect.any(String),
      });
    }
    // ohne Angabe: Vorgaben
    const defaults = await invoke(CONVERSATIONS, {
      params: { embedId: String(embed.id) },
      body: { startDate: OCTOBER.startDate, endDate: OCTOBER.endDate },
      token: admin.token,
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.body).toMatchObject({ totalCount: 5, hasMore: false });
    expect(defaults.body.conversations).toHaveLength(5);
    // Grenzen und hasMore
    for (const [offset, limit, length, hasMore] of [
      [0, 1, 1, true],
      [0, 100, 5, false],
      [3, 2, 2, false],
      [2, 2, 2, true],
      [5, 2, 0, false],
    ]) {
      const result = await rawList({ offset, limit, q: "kurs" });
      expect(result.statusCode).toBe(200);
      expect([offset, limit, result.body.conversations.length]).toEqual([
        offset,
        limit,
        length,
      ]);
      expect(result.body.hasMore).toBe(hasMore);
      expect(result.body.totalCount).toBe(5);
    }
    expect(await db.client.embed_chats.count()).toBe(5);
  });

  test("Datenbankfehler (Fixliste 2, R2): 500 { success: false } statt einer leeren Liste – das Protokoll nennt weder Begriff noch Suchmuster", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const original = db.client.$queryRaw;
    jest.spyOn(EmbedChats, "_conversationList").mockImplementation(() => {
      throw Object.assign(
        new Error("Raw query failed: … LIKE '%geheimname%' ESCAPE …"),
        { code: "P2010" }
      );
    });
    const result = await rawList({ q: "geheimname" });
    expect(result.statusCode).toBe(500);
    expect(result.body).toEqual({ success: false, error: expect.any(String) });
    expect(JSON.stringify(result.body)).not.toMatch(/geheimname|P2010/);
    expect(db.client.$queryRaw).toBe(original);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toMatch(/P2010/);
    expect(logged).not.toMatch(/geheimname/);
  });

  test("Datenbankfehler in der Zählung hinter der letzten Seite (Fixliste 2, R2): 500 – keine 0, die wie „keine Konversationen“ aussähe", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const count = jest
      .spyOn(EmbedChats, "countConversations")
      .mockRejectedValue(Object.assign(new Error("boom"), { code: "P2010" }));
    // Seite hinter dem Ende: leer, die Zahl kommt aus countConversations
    const result = await rawList({ offset: 50, limit: 20 });
    expect(count).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(500);
    expect(result.body).toEqual({ success: false, error: expect.any(String) });
    // Modell: beide melden den Fehler, statt ihn zu schlucken
    count.mockRestore();
    jest.spyOn(db.client, "$queryRaw").mockRejectedValue(new Error("kaputt"));
    await expect(EmbedChats.countConversations(embed.id)).rejects.toThrow(
      "kaputt"
    );
    await expect(
      EmbedChats.conversationPage(embed.id, { search: "kurs" })
    ).rejects.toThrow("kaputt");
  });

  test("Globale Liste /embed/chats/conversations (Fixliste 2, R10): dieselbe Prüfung von limit und offset – sonst 400; ohne Angabe 0 und 20", async () => {
    const GLOBAL = routes["POST /embed/chats/conversations"];
    const global = (body) => invoke(GLOBAL, { body, token: admin.token });
    for (const body of [
      { limit: -1 },
      { limit: 0 },
      { limit: 101 },
      { limit: "5" },
      { offset: "5" },
      { offset: -1 },
      { offset: 1.5 },
    ]) {
      const result = await global(body);
      expect([body, result.statusCode]).toEqual([body, 400]);
      expect(result.body).toEqual({
        success: false,
        error: expect.any(String),
      });
    }
    const defaults = await global({});
    expect(defaults.statusCode).toBe(200);
    expect(defaults.body).toMatchObject({ totalCount: 5, hasMore: false });
    expect(defaults.body.conversations).toHaveLength(5);
    const paged = await global({ offset: 1, limit: 2 });
    expect(paged.body.conversations).toHaveLength(2);
    // eine Zahl, keine Zeichenkette ("1" + 2 = "12")
    expect(paged.body.hasMore).toBe(true);
  });
});

describe("panel (Fixliste 5)", () => {
  test("Der Gesprächsverlauf zeigt keine vom Besucher geleerten Zeilen (include = 0); Löschen und Lösch-Vorschau meinen weiter alle", async () => {
    const workspace = await createWorkspace(db.client);
    const embed = await createEmbed(db.client, workspace);
    const visible = await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "sichtbare Frage",
      conversation: "k",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 1),
      prompt: "GELEERT geheim",
      conversation: "k",
      include: false,
    });
    const cleared = await addChat(embed, {
      at: berlinInstant("2026-10-05", 10, 0),
      prompt: "ganz GELEERT",
      conversation: "z",
      include: false,
    });

    const opened = await details(embed, visible.id);
    expect(opened.body.messages.map((m) => m.prompt)).toEqual([
      "sichtbare Frage",
    ]);
    // über die geleerte Zeile angefragt: dieselbe Konversation, ohne sie
    const viaCleared = await details(embed, visible.id + 1);
    expect(viaCleared.body.messages.map((m) => m.prompt)).toEqual([
      "sichtbare Frage",
    ]);
    // ganz geleert: nichts zu zeigen
    const empty = await details(embed, cleared.id);
    expect(empty.body).toEqual({ success: true, messages: [] });
    expect(JSON.stringify(empty.body)).not.toMatch(/GELEERT/);
    // Liste und Suche wie bisher ohne die geleerten Zeilen
    expect(await found(embed, "geheim")).toEqual([]);
    expect(
      (await listPage(embed, {})).body.conversations.map((c) => [
        c.conversation_id,
        c.message_count,
      ])
    ).toEqual([["k", 1]]);
    // Lösch-Vorschau (KIE-538) zählt alle Zeilen der Konversation
    expect(
      await EmbedChats.conversationDeletionPreview(embed.id, visible.id)
    ).toMatchObject({ messageCount: 2 });
  });
});

describe("leistung (Fixliste 6–8)", () => {
  test("Säulenklick + Suche: Der Begriff wird nur in den Konversationen des Abschnitts gesucht (EXISTS nach den Filtern), nicht in der ganzen Historie", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    await addChat(embed, {
      at: berlinInstant("2026-10-06", 9, 0),
      prompt: "Gibt es Yoga?",
      conversation: "im-abschnitt",
    });
    // Treffer erst in einer späteren Zeile derselben Konversation
    await addChat(embed, {
      at: berlinInstant("2026-10-20", 9, 0),
      prompt: "Und Spanisch?",
      conversation: "im-abschnitt",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-02", 9, 0),
      prompt: "Spanisch am Abend",
      conversation: "davor",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-06", 10, 0),
      prompt: "Kein Treffer hier",
      conversation: "im-abschnitt-ohne",
    });
    const bucket = { start: "2026-10-06", end: "2026-10-06" };
    expect(await found(embed, "spanisch", { bucket })).toEqual([
      "im-abschnitt",
    ]);
    expect((await found(embed, "spanisch")).sort()).toEqual([
      "davor",
      "im-abschnitt",
    ]);
    // Bewertungsfilter: ebenso erst filtern, dann suchen
    await addChat(embed, {
      at: berlinInstant("2026-10-07", 9, 0),
      prompt: "Spanisch negativ",
      feedbackScore: false,
      conversation: "negativ",
    });
    expect(
      await found(embed, "spanisch", { feedbackFilter: "negative" })
    ).toEqual(["negativ"]);

    // Form der Abfrage: Gruppen ohne Suche, die Suche als EXISTS danach
    const { Prisma } = require("@prisma/client");
    const between = {
      start: berlinInstant("2026-10-06", 0, 0),
      endExclusive: berlinInstant("2026-10-07", 0, 0),
    };
    const { source, where } = EmbedChats._conversationSelection({
      embedId: embed.id,
      startedBetween: between,
      search: "spanisch",
    });
    const text = Prisma.sql`${source} ${where}`.sql;
    expect(text).not.toMatch(/row_search_hit/);
    expect(text).toMatch(/started_at >= \? AND started_at < \? AND EXISTS/);
    const plain = EmbedChats._conversationSelection({
      embedId: embed.id,
      search: "spanisch",
    });
    expect(Prisma.sql`${plain.source} ${plain.where}`.sql).toMatch(
      /MAX\(row_search_hit\)[\s\S]*WHERE search_hit = 1$/
    );
  });

  test("Export mit Suche: die Treffer-Konversationen werden EINMAL bestimmt, nicht je Seite – Inhalte seitenweise (Fixliste 2, R11); Inhalt wie die Liste", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    const PAGE = EmbedChats.EXPORT_CONVERSATION_PAGE;
    // 2 · PAGE + 3 Konversationen, jede zweite mit Treffer: PAGE + 2 Treffer
    const total = 2 * PAGE + 3;
    await db.client.embed_chats.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        embed_id: embed.id,
        prompt: i % 2 === 0 ? `Frage ${i} zum Kurs` : `Frage ${i}`,
        response: JSON.stringify({ text: "Antwort", type: "chat" }),
        session_id: `s-${i}`,
        conversation_id: `k-${i}`,
        createdAt: new Date(berlinInstant("2026-10-05", 9, 0).getTime() + i),
      })),
    });
    const hits = jest.spyOn(EmbedChats, "_exportHits");
    const hitPages = jest.spyOn(EmbedChats, "_exportHitPage");
    const pages = jest.spyOn(EmbedChats, "_exportConversationPage");
    const result = await exportFile(embed, "json", {
      ...OCTOBER,
      search: "kurs",
    });
    expect(result.statusCode).toBe(200);
    const exported = JSON.parse(result.body).map((c) => c.conversationId);
    // die Suche einmal, danach nur Seiten über den Primärschlüssel
    expect(hits).toHaveBeenCalledTimes(1);
    expect(hits.mock.calls[0][0]).toMatchObject({ search: "kurs" });
    const found = await hits.mock.results[0].value;
    // Kennung und Sitzung aus der Treffermenge selbst (Fixliste 3, C2)
    expect(Object.keys(found).sort()).toEqual([
      "conversationIds",
      "messageCounts",
      "numbers",
      "sessionIds",
    ]);
    expect(found.conversationIds).toHaveLength(PAGE + 2);
    expect(hitPages).toHaveBeenCalledTimes(2);
    expect(hitPages.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [0, PAGE],
      [PAGE, 2 * PAGE],
    ]);
    expect(pages).not.toHaveBeenCalled();
    // Inhalt und Reihenfolge wie die Liste (jüngster Beginn zuerst)
    const expected = Array.from({ length: total }, (_, i) => i)
      .filter((i) => i % 2 === 0)
      .reverse()
      .map((i) => `k-${i}`);
    expect(exported).toEqual(expected);
    const numbers = JSON.parse(result.body).map((c) => c.conversation);
    expect(numbers[0]).toBe(1);
    expect(numbers[1]).toBe(3);
    // ohne Suche weiter seitenweise über den Schlüssel
    hits.mockClear();
    pages.mockClear();
    await exportFile(embed, "json", OCTOBER);
    expect(hits).not.toHaveBeenCalled();
    expect(pages).toHaveBeenCalledTimes(3);
    expect(pages.mock.calls[0][0].limit).toBe(PAGE);
  });
});

describe("protokoll (Fixliste 9)", () => {
  test("Der Export vermerkt, ob gesucht wurde – den Begriff nicht", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Frage von max.mustermann@example.org",
      conversation: "k",
    });
    await exportFile(embed, "csv", {
      ...OCTOBER,
      search: "max.mustermann@example.org",
    });
    await exportFile(embed, "csv", OCTOBER);
    const events = await eventsOf(db.client, "embed_conversations_exported");
    expect(events.map((event) => event.metadata.searched)).toEqual([
      true,
      false,
    ]);
    expect(events[0].metadata.conversationCount).toBe(1);
    const raw = await db.client.event_logs.findMany();
    expect(JSON.stringify(raw)).not.toMatch(/mustermann/);
  });
});

describe("globale sicht (Fixliste 10)", () => {
  test("first_negative_reason: gleiche Kennung und Sitzung in zwei Widgets – jeder Grund bleibt bei seinem Widget", async () => {
    const workspace = await createWorkspace(db.client);
    const widgetA = await createEmbed(db.client, workspace);
    const widgetB = await createEmbed(db.client, workspace);
    await addChat(widgetA, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Frage in A",
      feedbackScore: false,
      feedbackReason: "Grund aus A",
      conversation: "gleich",
      session: "gleiche-sitzung",
    });
    await addChat(widgetB, {
      at: berlinInstant("2026-10-05", 10, 0),
      prompt: "Frage in B",
      feedbackScore: false,
      feedbackReason: "Grund aus B",
      conversation: "gleich",
      session: "gleiche-sitzung",
    });
    const conversations = await EmbedChats.getConversations(null, 0, 20);
    expect(
      conversations.map((c) => [c.embed_id, c.first_negative_reason])
    ).toEqual([
      [widgetB.id, "Grund aus B"],
      [widgetA.id, "Grund aus A"],
    ]);
  });
});

describe("sichtbarer text (Fixliste 11, 24)", () => {
  test("NFD: zerlegte Umlaute im gespeicherten Text werden mit NFC gefunden – in Frage, Antwort, Grund und Kommentar", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    const nfd = (text) => text.normalize("NFD");
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: nfd("Gibt es eine Übung?"),
      conversation: "frage",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 1),
      prompt: "Wo?",
      answer: nfd('Im GRÖßEREN Raum, mit "Übung" am Abend'),
      conversation: "antwort",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 2),
      prompt: "Ok",
      feedbackScore: false,
      feedbackReason: nfd("Unvollständig"),
      feedbackText: nfd("Übung fehlt"),
      conversation: "bewertung",
    });
    expect((await found(embed, "übung")).sort()).toEqual([
      "antwort",
      "bewertung",
      "frage",
    ]);
    expect(await found(embed, "größeren")).toEqual(["antwort"]);
    expect(await found(embed, "unvollständig")).toEqual(["bewertung"]);
    // NFD im Begriff findet NFD wie NFC
    expect((await found(embed, nfd("ÜBUNG"))).sort()).toEqual([
      "antwort",
      "bewertung",
      "frage",
    ]);
  });

  test("Antwort mit maskierten Zeichen: Treffer über den Text, nicht über die Maskierung im JSON", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Kurse?",
      answer: "Kurs\nYoga am Abend",
      conversation: "umbruch",
    });
    // „\nYoga" steht im JSON als \n – das „n" davor gehört nicht zum Text
    expect(await found(embed, "nyoga")).toEqual([]);
    expect(await found(embed, "Yoga am")).toEqual(["umbruch"]);
    expect(await found(embed, "kurs")).toEqual(["umbruch"]);
  });

  test("dokumentiert (Entscheidung Punkt 11): Ein Begriff nur in einer Link-Adresse der Antwort trifft – die Ansicht weist dann darauf hin (Frontend)", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Wo melde ich mich an?",
      answer: "Hier: [Anmeldung](https://vhs-lingen.example/anmeldung)",
      conversation: "link",
    });
    expect(await found(embed, "vhs-lingen")).toEqual(["link"]);
    expect(await found(embed, "Anmeldung")).toEqual(["link"]);
  });
});

// ---------------------------------------------------------------------------
// Fixliste 2: Fehler melden statt verschlucken, Vorprüfung bei mehrzeiligen
// Antworten, Export mit Suche seitenweise
// ---------------------------------------------------------------------------

describe("fehler im verlauf (Fixliste 2, R1)", () => {
  test("Datenbankfehler beim Öffnen: 500 { success: false } – nicht „nicht gefunden“ und kein leerer Verlauf", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    const chat = await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Frage",
      conversation: "k",
    });
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const findMany = jest
      .spyOn(db.client.embed_chats, "findMany")
      .mockRejectedValue(
        Object.assign(new Error("SQLITE_BUSY"), { code: "P1008" })
      );
    const result = await details(embed, chat.id);
    expect(result.statusCode).toBe(500);
    expect(result.body).toEqual({ success: false, error: expect.any(String) });
    expect(JSON.stringify(errors.mock.calls)).toMatch(/P1008/);
    await expect(
      EmbedChats.getConversationDetails(chat.id, embed.id)
    ).rejects.toThrow("SQLITE_BUSY");
    // wieder erreichbar: dieselbe Konversation lädt
    findMany.mockRestore();
    const again = await details(embed, chat.id);
    expect(again.statusCode).toBe(200);
    expect(again.body.messages.map((m) => m.prompt)).toEqual(["Frage"]);
    // unbekannte Zeile bleibt „nicht gefunden“ (leer, 200 – wie bisher)
    expect((await details(embed, chat.id + 99)).body).toEqual({
      success: true,
      messages: [],
    });
  });
});

describe("mehrzeilige antworten (Fixliste 2, R6)", () => {
  // So speichert das Widget Antworten: Markdown mit Absätzen, Listen,
  // Kurslinks und Anführungszeichen – im JSON als \n und \".
  const ANSWER = [
    "Gern! Wir haben folgende **Kurse am Abend**:",
    "",
    '- [Spanisch A1](https://vhs.example/kurs/123?ort="Süd")',
    '- Yoga "sanft" im Raum 2',
    "",
    "Unterlagen liegen unter C:\\Kurse\\neu bereit.",
  ].join("\n");
  let embed;
  beforeEach(async () => {
    embed = await createEmbed(db.client, await createWorkspace(db.client));
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Was gibt es abends?",
      answer: ANSWER,
      conversation: "markdown",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 10, 0),
      prompt: "Und sonst?",
      answer: "Nichts\nWeiteres",
      conversation: "andere",
    });
  });

  test.each([
    ["Kurse am Abend", ["markdown"]],
    ['Yoga "sanft"', ["markdown"]],
    ['sanft" im', ["markdown"]],
    ["SPANISCH a1", ["markdown"]],
    ["C:\\Kurse\\neu", ["markdown"]],
    ["\\neu", ["markdown"]],
    ["Nichts", ["andere"]],
    ["Weiteres", ["andere"]],
    // das „n“ der Maskierung \n gehört nicht zum Text
    ["nWeiteres", []],
    ["n- Yoga", []],
    // Quelle und Metadaten treffen weiter nicht
    [SOURCE_WORD, []],
  ])("„%s“", async (search, expected) => {
    expect((await found(embed, search)).sort()).toEqual(expected);
  });

  test("Der Antwortanfang mit \\n wird direkt geprüft (aufgelöst) – nur mit weiteren Maskierungen wird der Text der Zeile aus dem JSON gelesen", async () => {
    const { sql } = EmbedChats._searchMatchSql("kurs");
    // Reihenfolge: ohne Rückstrich direkt, mit aufgelöstem \n direkt, sonst JSON
    const plain = sql.indexOf("instr(answer_head, '\\') = 0");
    const decoded = sql.indexOf(
      "instr(replace(answer_head, '\\n', char(10)), '\\') = 0"
    );
    const json = sql.lastIndexOf("json_extract(response, '$.text')");
    expect(plain).toBeGreaterThan(0);
    expect(decoded).toBeGreaterThan(plain);
    expect(json).toBeGreaterThan(decoded);
    // Zitat (\") und Rückstrich (\\) gehen über das JSON – und treffen
    expect(await found(embed, 'Kurs "Yoga"')).toEqual([]);
    await addChat(embed, {
      at: berlinInstant("2026-10-06", 9, 0),
      prompt: "Zitat?",
      answer: 'Zeile eins\nDer Kurs "Yoga" am Abend\nPfad C:\\neu',
      conversation: "zitat",
    });
    expect(await found(embed, 'Kurs "Yoga"')).toEqual(["zitat"]);
    expect(await found(embed, "C:\\neu")).toEqual(["zitat"]);
    expect(await found(embed, "eins")).toEqual(["zitat"]);
    expect(await found(embed, "nDer")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixliste 3 (Kontroll-Review 2): Zeilennummern außerhalb INT4, globale
// Liste, Antwortanfang auf \", Export mit Suche
// ---------------------------------------------------------------------------

describe("zeilennummer außerhalb INT4 (Fixliste 3, C3)", () => {
  test("Verlauf, Lösch-Vorschau und Löschen: eine Zahl > 2^31−1 bezeichnet keine Konversation – „nicht gefunden“, keine 500", async () => {
    const embed = await createEmbed(
      db.client,
      await createWorkspace(db.client)
    );
    const chat = await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Frage",
      conversation: "k",
    });
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    for (const chatId of [
      "2147483648",
      "99999999999",
      "9007199254740993",
      "999999999999999999999",
    ]) {
      const opened = await details(embed, chatId);
      expect([chatId, opened.statusCode, opened.body]).toEqual([
        chatId,
        200,
        { success: true, messages: [] },
      ]);
      const request = (route) =>
        invoke(routes[`${route.method} ${route.path}`], {
          params: { embedId: String(embed.id) },
          body: { chatId: Number(chatId) },
          token: admin.token,
        });
      // Vorschau wie bei jeder unbekannten Zeile: nichts zu löschen
      const preview = await request(ROUTES.deletionPreview);
      expect([chatId, preview.statusCode, preview.body]).toEqual([
        chatId,
        200,
        expect.objectContaining({ success: true, messageCount: 0 }),
      ]);
      const deleted = await request(ROUTES.deleteConversation);
      expect([chatId, deleted.statusCode]).toEqual([chatId, 404]);
    }
    // ein Widget > INT4 (admin darf jedes Widget ansehen): ebenso leer
    expect((await details("2147483648", chat.id)).body).toEqual({
      success: true,
      messages: [],
    });
    expect(
      await EmbedChats._conversationScope(embed.id, 2147483647)
    ).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    // die echte Zeile weiter erreichbar
    expect((await details(embed, chat.id)).body.messages).toHaveLength(1);
  });
});

describe("globale liste (Fixliste 3, C7/C8)", () => {
  const GLOBAL = () => routes["POST /embed/chats/conversations"];
  const global = (body, user = admin) =>
    invoke(GLOBAL(), { body, token: user.token });
  let workspaceA, widgetA, widgetB;
  beforeEach(async () => {
    workspaceA = await createWorkspace(db.client);
    widgetA = await createEmbed(db.client, workspaceA);
    widgetB = await createEmbed(db.client, await createWorkspace(db.client));
    for (let i = 0; i < 2; i++)
      await addChat(widgetA, {
        at: berlinInstant("2026-10-05", 9, i),
        prompt: `Frage A${i}`,
        conversation: `a-${i}`,
      });
    for (let i = 0; i < 3; i++)
      await addChat(widgetB, {
        at: berlinInstant("2026-10-05", 10, i),
        prompt: `FREMD B${i}`,
        conversation: `b-${i}`,
      });
  });

  test("Default-User: Seite UND Zählung nur über die Widgets seiner Workspaces – hasMore stimmt, nichts Fremdes", async () => {
    const kunde = await createUser("default", [workspaceA.id]);
    const all = await global({}, kunde);
    expect(all.statusCode).toBe(200);
    expect(all.body).toMatchObject({ totalCount: 2, hasMore: false });
    expect(all.body.conversations.map((c) => c.conversation_id)).toEqual([
      "a-1",
      "a-0",
    ]);
    expect(JSON.stringify(all.body)).not.toMatch(/FREMD/);
    // Blättern: die Seite ist voll (nicht nachträglich ausgedünnt)
    const first = await global({ limit: 1 }, kunde);
    expect(first.body).toMatchObject({ totalCount: 2, hasMore: true });
    expect(first.body.conversations.map((c) => c.conversation_id)).toEqual([
      "a-1",
    ]);
    const second = await global({ offset: 1, limit: 1 }, kunde);
    expect(second.body).toMatchObject({ totalCount: 2, hasMore: false });
    expect(second.body.conversations.map((c) => c.conversation_id)).toEqual([
      "a-0",
    ]);
    // ohne Workspace: nichts, auch keine Zahl fremder Widgets
    const ohneWorkspace = await createUser("default", []);
    expect((await global({}, ohneWorkspace)).body).toEqual({
      success: true,
      conversations: [],
      hasMore: false,
      totalCount: 0,
    });
    // admin und manager sehen alle Widgets
    for (const user of [admin, await createUser("manager")]) {
      const result = await global({}, user);
      expect(result.body.totalCount).toBe(5);
      expect(result.body.conversations).toHaveLength(5);
    }
  });

  test("Datenbankfehler: 500 { success: false } statt einer leeren Liste; ungültiger Zeitpunkt: 400", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest
      .spyOn(EmbedChats, "_conversationList")
      .mockRejectedValue(Object.assign(new Error("boom"), { code: "P2010" }));
    const failed = await global({});
    expect(failed.statusCode).toBe(500);
    expect(failed.body).toEqual({ success: false, error: expect.any(String) });
    jest.restoreAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    const invalid = await global({ startDate: "kein Datum" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toEqual({
      success: false,
      error: expect.any(String),
    });
  });
});

describe('antwortanfang endet auf \\" (Fixliste 3, C9)', () => {
  let embed;
  beforeEach(async () => {
    embed = await createEmbed(db.client, await createWorkspace(db.client));
    // Der Text endet auf Anführungszeichen und Komma: Im JSON steht \",
    // vor dem schließenden ", – die erste Folge "," beginnt schon beim
    // maskierten Anführungszeichen.
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Was gibt es?",
      answer: 'Wir empfehlen "Yoga am Abend",',
      conversation: "zitat-komma",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 10, 0),
      prompt: "Und mehrzeilig?",
      answer: 'Zeile eins\nDer Kurs "Spanisch",',
      conversation: "mehrzeilig",
    });
    // Ein Text, der wirklich auf einen Rückstrich endet
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 11, 0),
      prompt: "Pfad?",
      answer: "Liegt unter C:\\Kurse\\",
      conversation: "rueckstrich",
    });
    // gewöhnliches Textende: Die beiden Zeichen ", hinter dem Text im
    // Anfang treffen nicht
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 12, 0),
      prompt: "Sonst?",
      answer: "Nur Yoga",
      conversation: "normal",
    });
  });

  test('answer_head enthält immer den ganzen Text – mit den beiden Zeichen ", dahinter', async () => {
    const { Prisma } = require("@prisma/client");
    const rows = await db.client.$queryRaw`
      SELECT answer_head FROM ${EmbedChats._searchRowsSql(
        Prisma.sql`WHERE embed_id = ${embed.id}`
      )} ORDER BY id`;
    // Die erste Folge "," beginnt beim maskierten Anführungszeichen (\",")
    // bzw. am Textende – der Anfang reicht zwei Zeichen weiter.
    expect(rows.map((row) => row.answer_head)).toEqual([
      'Wir empfehlen \\"Yoga am Abend\\",',
      'Zeile eins\\nDer Kurs \\"Spanisch\\",',
      'Liegt unter C:\\\\Kurse\\\\",',
      'Nur Yoga",',
    ]);
  });

  test.each([
    ['Abend"', ["zitat-komma"]],
    ['abend",', ["zitat-komma"]],
    ['"Yoga am Abend",', ["zitat-komma"]],
    ['kurs "spanisch"', ["mehrzeilig"]],
    ['Spanisch",', ["mehrzeilig"]],
    ["eins", ["mehrzeilig"]],
    ["Kurse\\", ["rueckstrich"]],
    ["C:\\Kurse\\", ["rueckstrich"]],
    // die Maskierung gehört nicht zum Text
    ['Abend\\"', []],
    ["nDer", []],
    ["nur yoga", ["normal"]],
    ['nur yoga"', []],
    ['Nur Yoga",', []],
    ["Yoga,", []],
  ])("„%s“", async (search, expected) => {
    expect((await found(embed, search)).sort()).toEqual(expected);
  });
});

describe("export mit suche (Fixliste 3, C2/C10)", () => {
  const MAX_HITS = EmbedChats.EXPORT_SEARCH_MAX_HITS;
  let embed;
  beforeEach(async () => {
    embed = await createEmbed(db.client, await createWorkspace(db.client));
  });
  afterEach(() => {
    EmbedChats.EXPORT_SEARCH_MAX_HITS = MAX_HITS;
  });

  test("C2: Wird die erste Zeile einer Treffer-Konversation während des Exports gelöscht, bleibt die Konversation mit ihren übrigen Zeilen in der Datei", async () => {
    const first = await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 0),
      prompt: "Gibt es einen Kurs?",
      conversation: "k",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 9, 1),
      prompt: "Und abends ein Kurs?",
      conversation: "k",
    });
    await addChat(embed, {
      at: berlinInstant("2026-10-05", 10, 0),
      prompt: "Nur Kurs",
      conversation: "j",
    });
    const original = EmbedChats._exportHits;
    jest
      .spyOn(EmbedChats, "_exportHits")
      .mockImplementation(async (selection) => {
        const hits = await original.call(EmbedChats, selection);
        // Aufbewahrungsfrist: Die älteste Zeile verschwindet jetzt.
        await db.client.embed_chats.delete({ where: { id: first.id } });
        return hits;
      });
    const result = await exportFile(embed, "json", {
      ...OCTOBER,
      search: "kurs",
    });
    expect(result.statusCode).toBe(200);
    const exported = JSON.parse(result.body);
    expect(exported.map((c) => c.conversationId)).toEqual(["j", "k"]);
    expect(exported[1].messages.map((m) => m.prompt)).toEqual([
      "Und abends ein Kurs?",
    ]);
  });

  test("C10: harte Obergrenze der Treffermenge – darüber 413 mit der Zahl, ohne Datei; gelesen werden höchstens Grenze + 1 Zeilen", async () => {
    for (let i = 0; i < 3; i++)
      await addChat(embed, {
        at: berlinInstant("2026-10-05", 9, i),
        prompt: `Kurs ${i}`,
        conversation: `k-${i}`,
      });
    jest.spyOn(console, "error").mockImplementation(() => {});
    EmbedChats.EXPORT_SEARCH_MAX_HITS = 2;
    const queries = jest.spyOn(db.client, "$queryRaw");
    const tooMany = await exportFile(embed, "csv", {
      ...OCTOBER,
      search: "kurs",
    });
    expect(tooMany.statusCode).toBe(413);
    expect(tooMany.body).toEqual({
      success: false,
      reason: "too-many-hits",
      max: 2,
      error: expect.stringContaining("2"),
    });
    expect(tooMany.chunks).toEqual([]);
    const hitQuery = queries.mock.calls
      .map(([strings, ...values]) => ({ sql: strings.join("?"), values }))
      .find(({ sql }) => /conversation_number\s+FROM/.test(sql));
    expect(hitQuery.values.at(-1)).toBe(3);
    // keine Protokollzeile für einen Export, der nicht stattfand
    expect(await eventsOf(db.client, "embed_conversations_exported")).toEqual(
      []
    );
    // genau an der Grenze: Export wie gewohnt
    EmbedChats.EXPORT_SEARCH_MAX_HITS = 3;
    const fits = await exportFile(embed, "json", {
      ...OCTOBER,
      search: "kurs",
    });
    expect(fits.statusCode).toBe(200);
    expect(JSON.parse(fits.body)).toHaveLength(3);
    // ohne Suche gilt die Grenze nicht (seitenweise über den Schlüssel)
    EmbedChats.EXPORT_SEARCH_MAX_HITS = 1;
    const plain = await exportFile(embed, "json", OCTOBER);
    expect(JSON.parse(plain.body)).toHaveLength(3);
  });
});
