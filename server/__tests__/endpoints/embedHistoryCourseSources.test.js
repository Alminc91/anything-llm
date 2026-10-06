/* eslint-env jest, node */
// Öffentlicher Endpunkt GET /embed/:embedId/:sessionId (Widget-Historie):
// Kontext-Schnipsel (sources) dürfen Endnutzer nie erreichen; courseSources
// (nur Kurs-Metadaten für die Kurskarten) kommen bei den Antworten an.
// Echte EmbedChats.filterSources + convertToChatHistory, nur prisma gemockt.

jest.mock("../../utils/prisma", () => ({
  embed_chats: { findMany: jest.fn() },
}));
jest.mock("../../utils/http", () => ({
  reqBody: jest.fn(),
  multiUserMode: jest.fn(),
  safeJsonParse: (v, fallback = null) => {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  },
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../utils/chats/embed", () => ({
  streamChatWithForEmbed: jest.fn(),
}));
jest.mock("../../utils/middleware/embedMiddleware", () => ({
  validEmbedConfig: jest.fn(),
  canRespond: jest.fn(),
  setConnectionMeta: jest.fn(),
}));
jest.mock("../../models/embedConfig", () => ({
  EmbedConfig: { getVisualConfig: jest.fn() },
}));
jest.mock("../../utils/files/embedLogo", () => ({
  fetchEmbedLogo: jest.fn(),
  determineEmbedLogoFilepath: jest.fn(),
}));
jest.mock("../../utils/TextToSpeech", () => ({
  getTTSProvider: jest.fn(),
  isTTSConfigured: jest.fn(),
}));
jest.mock("../../utils/SpeechToText", () => ({
  getSTTProvider: jest.fn(),
  isSTTConfigured: jest.fn(),
}));

const prisma = require("../../utils/prisma");
const { embeddedEndpoints } = require("../../endpoints/embed");

function collectRoutes(register) {
  const routes = {};
  const app = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (path, ...handlers) => {
          routes[`${String(method).toUpperCase()} ${path}`] =
            handlers[handlers.length - 1];
        },
    }
  );
  register(app);
  return routes;
}

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined,
    locals: { embedConfig: { id: 7, uuid: "embed-uuid" } },
    status: jest.fn(function (code) {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn(function (body) {
      res.body = body;
      return res;
    }),
    sendStatus: jest.fn(function (code) {
      res.statusCode = code;
      return { end: jest.fn() };
    }),
  };
  return res;
}

const COURSE = {
  url: "https://aw.donau.kufer.de/kurssuche/kurs/yoga-aufbaukurs/262-3103",
  title: "Yoga (Aufbaukurs)",
  start_date: "2026-09-14",
  end_date: "2026-12-28",
  start_minutes: 1080,
  weekdays: ",mon,",
  price: 60,
  bookable: true,
  format: "onsite",
};

const ROWS = [
  {
    id: 1,
    prompt: "Gibt es Yogakurse am Abend?",
    response: JSON.stringify({
      text: "Ja, zum Beispiel [Yoga (Aufbaukurs)](https://aw.donau.kufer.de/kurssuche/kurs/yoga-aufbaukurs/262-3103).",
      type: "chat",
      sources: [
        {
          text: "Titel: Yoga (Aufbaukurs)\nKursbeschreibung: Hatha-Yoga ist …",
          chunkSource: "aw-donau-kufer-de-kurssuche-kurs-yoga.txt",
          ...COURSE,
        },
      ],
      // Altbestand-Simulation: ein Fremdfeld darf nicht durchrutschen
      courseSources: [{ ...COURSE, text: "darf nie raus" }],
      metrics: {},
    }),
    createdAt: new Date("2026-10-05T10:00:00Z"),
    session_id: "sess-1",
    conversation_id: "conv-1",
    include: true,
    feedbackScore: null,
  },
  {
    id: 2,
    prompt: "Wie melde ich mich an?",
    response: JSON.stringify({
      text: "Über die Kursseite oder telefonisch.",
      type: "chat",
      sources: [{ text: "Anmeldung: … interner Kontext …", title: "kontakt" }],
      metrics: {},
    }),
    createdAt: new Date("2026-10-05T10:01:00Z"),
    session_id: "sess-1",
    conversation_id: "conv-1",
    include: true,
    feedbackScore: null,
  },
];

describe("GET /embed/:embedId/:sessionId — Historie für das Widget", () => {
  const routes = collectRoutes(embeddedEndpoints);
  const handler = routes["GET /embed/:embedId/:sessionId"];

  beforeEach(() => {
    prisma.embed_chats.findMany.mockReset();
    prisma.embed_chats.findMany.mockResolvedValue(ROWS);
  });

  test("sources werden entfernt, courseSources kommen an der Antwort an", async () => {
    const res = mockResponse();
    await handler(
      {
        params: { embedId: "embed-uuid", sessionId: "sess-1" },
        query: { conversationId: "conv-1" },
      },
      res
    );

    expect(res.statusCode).toBe(200);
    const { history } = res.body;
    expect(history).toHaveLength(4);

    // Kein Kontext-Schnipsel irgendwo in der Antwort an das Widget
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/Kursbeschreibung|interner Kontext|darf nie raus/);
    for (const msg of history.filter((m) => m.role === "assistant"))
      expect(msg.sources).toEqual([]);

    const [, firstReply, , secondReply] = history;
    expect(firstReply.role).toBe("assistant");
    expect(firstReply.courseSources).toEqual([COURSE]);
    expect(firstReply.content).toMatch(/^Ja, zum Beispiel/);
    // Antwort ohne courseSources: Feld fehlt ganz
    expect(secondReply).not.toHaveProperty("courseSources");
  });

  test("Historie ohne Kurskarten-Daten bleibt wie bisher", async () => {
    prisma.embed_chats.findMany.mockResolvedValue([ROWS[1]]);
    const res = mockResponse();
    await handler(
      { params: { embedId: "embed-uuid", sessionId: "sess-1" }, query: {} },
      res
    );
    expect(res.body.history).toHaveLength(2);
    expect(res.body.history[1]).toMatchObject({
      role: "assistant",
      content: "Über die Kursseite oder telefonisch.",
      sources: [],
    });
    expect(res.body.history[1]).not.toHaveProperty("courseSources");
  });

  test("Altdaten mit Primitiven in courseSources: 200 statt 500, gültige Einträge bleiben", async () => {
    prisma.embed_chats.findMany.mockResolvedValue([
      {
        ...ROWS[0],
        response: JSON.stringify({
          text: "Antwort",
          type: "chat",
          sources: [],
          courseSources: ["x", 1, true, null, COURSE],
        }),
      },
    ]);
    const res = mockResponse();
    await handler(
      { params: { embedId: "embed-uuid", sessionId: "sess-1" }, query: {} },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.history[1].courseSources).toEqual([COURSE]);
  });
  test("Kurskarten v2: courseCardsAnnounced kommt mit, auf die Liste begrenzt", async () => {
    const row = (id, extra) => ({
      ...ROWS[0],
      id,
      response: JSON.stringify({
        text: "Antwort",
        type: "chat",
        sources: [],
        courseSources: [COURSE],
        metrics: {},
        ...extra,
      }),
    });
    prisma.embed_chats.findMany.mockResolvedValue([
      row(11, { courseCardsAnnounced: 1 }),
      row(12, { courseCardsAnnounced: 5 }), // mehr als Einträge -> begrenzt
      row(13, { courseCardsAnnounced: "2" }), // kein Integer -> weg
      row(14, { courseCardsAnnounced: 1, courseSources: [] }), // ohne Karten -> weg
    ]);
    const res = mockResponse();
    await handler(
      {
        params: { embedId: "embed-uuid", sessionId: "sess-1" },
        query: { conversationId: "conv-1" },
      },
      res
    );
    const replies = res.body.history.filter((m) => m.role === "assistant");
    expect(replies.map((m) => m.courseCardsAnnounced)).toEqual([
      1,
      1,
      undefined,
      undefined,
    ]);
    expect(replies[3]).not.toHaveProperty("courseSources");
  });

  test("Kurskarten v2: Marker-Nummern (courseCardsMarker) nie an das Widget", async () => {
    prisma.embed_chats.findMany.mockResolvedValue([
      {
        ...ROWS[0],
        response: JSON.stringify({
          text: "Antwort",
          type: "chat",
          sources: [],
          courseSources: [COURSE],
          courseCardsAnnounced: 1,
          courseCardsMarker: [0],
        }),
      },
    ]);
    const res = mockResponse();
    await handler(
      { params: { embedId: "embed-uuid", sessionId: "sess-1" }, query: {} },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.history[1].content).toBe("Antwort");
    expect(JSON.stringify(res.body)).not.toMatch(/KARTEN|courseCardsMarker/);
    const { EmbedChats } = require("../../models/embedChats");
    const [filtered] = EmbedChats.filterSources([
      {
        id: 1,
        response: JSON.stringify({ text: "x", courseCardsMarker: [0] }),
      },
    ]);
    expect(JSON.parse(filtered.response)).toEqual({ text: "x" });
  });

  test("Kurskarten v3: courseTeasers kommen mit (nur Karten-URLs, Typ/Länge geprüft), Teaserzeilen (LLM) nie", async () => {
    const V3 = { ...COURSE, sessions: "16 Abende", venue: "Realschule" };
    prisma.embed_chats.findMany.mockResolvedValue([
      {
        ...ROWS[0],
        response: JSON.stringify({
          text: "Antwort",
          type: "chat",
          sources: [],
          courseSources: [V3],
          courseCardsAnnounced: 1,
          courseCardsMarker: [0],
          courseTeaserLines: [{ index: 0, text: "Sanft starten." }],
          // gespeichert werden nur bereinigte Teaser (Bereinigung genau
          // einmal beim Erzeugen); /history prüft nur noch Typ und Länge
          courseTeasers: {
            [COURSE.url]: " Sanft starten am Abend. ",
            "https://fremd.example/kurs/1": "darf nie raus",
          },
        }),
      },
      { ...ROWS[1], id: 3 },
    ]);
    const res = mockResponse();
    await handler(
      { params: { embedId: "embed-uuid", sessionId: "sess-1" }, query: {} },
      res
    );
    expect(res.statusCode).toBe(200);
    const [, reply, , plain] = res.body.history;
    expect(reply.courseSources).toEqual([V3]);
    expect(reply.courseTeasers).toEqual({
      [COURSE.url]: "Sanft starten am Abend.",
    });
    expect(plain).not.toHaveProperty("courseTeasers");
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/courseTeaserLines|TEASER|darf nie raus/);
  });
  test("Folgefragen: followUps bereinigt an der Antwort, Zeile nie im Text", async () => {
    prisma.embed_chats.findMany.mockResolvedValue([
      {
        ...ROWS[1],
        response: JSON.stringify({
          text: "Über die Kursseite oder telefonisch.",
          type: "chat",
          sources: [],
          followUps: [
            "Gibt es B1-Kurse?",
            " **Auch online?** ",
            42,
            "x".repeat(61),
            "Abends?",
            "Viertens?",
          ],
        }),
      },
      {
        ...ROWS[1],
        id: 4,
        response: JSON.stringify({
          text: "Ohne Vorschläge.",
          type: "chat",
          sources: [],
          followUps: "kein Array",
        }),
      },
    ]);
    const res = mockResponse();
    await handler(
      { params: { embedId: "embed-uuid", sessionId: "sess-1" }, query: {} },
      res
    );
    expect(res.statusCode).toBe(200);
    const [, reply, , plain] = res.body.history;
    expect(reply.followUps).toEqual([
      "Gibt es B1-Kurse?",
      "Auch online?",
      "Abends?",
    ]);
    expect(reply.content).toBe("Über die Kursseite oder telefonisch.");
    expect(plain).not.toHaveProperty("followUps");
    expect(JSON.stringify(res.body)).not.toMatch(/FRAGEN|xxxxx|Viertens/);
  });
});
