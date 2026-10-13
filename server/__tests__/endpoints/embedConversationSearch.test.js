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
} = require("../helpers/sqliteTestDatabase");
const { makeJWT } = require("../../utils/http");
const { MessageLedger } = require("../../models/messageLedger");
const { embedManagementEndpoints } = require("../../endpoints/embedManagement");
const {
  parseSearch,
  searchGlobPattern,
  canPrefilterRawResponse,
  SEARCH_MAX_LENGTH,
} = require("../../utils/helpers/chat/conversationSearch");

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

  test("canPrefilterRawResponse: nur ohne Zeichen, die JSON maskiert", () => {
    expect(canPrefilterRawResponse("Spanisch ü%_*?[")).toBe(true);
    for (const search of ['"zitat"', "C:\\pfad", "a\tb"])
      expect(canPrefilterRawResponse(search)).toBe(false);
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
