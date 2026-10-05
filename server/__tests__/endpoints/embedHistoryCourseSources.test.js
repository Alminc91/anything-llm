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
});
