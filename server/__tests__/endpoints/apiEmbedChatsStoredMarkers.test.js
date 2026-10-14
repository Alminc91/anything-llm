/* eslint-env jest, node */
// B1 (Fixliste 9, L2 aus Runde 8): Die Entwickler-API liest gespeicherte
// Antworten über EmbedChats.where. Altdatensätze aus der Zeit vor FF1 tragen
// die Folgefragen-Zeile "[[FRAGEN: …]]" noch im Text; auch hier kommen sie
// über withoutProtocolMarkers ohne Marker an - wie bei allen anderen Lesern.
//
// Echte Routen samt validApiKey, echte Modelle; ersetzt ist nur die
// Datenbank (Prisma-Ersatz im Speicher, support/routeHarness.js).
jest.mock("../../utils/prisma", () =>
  require("./support/routeHarness").createFakePrisma()
);

const prisma = require("../../utils/prisma");
const { collectRoutes, invoke } = require("./support/routeHarness");
const { apiEmbedEndpoints } = require("../../endpoints/api/embed");

const BODY = "Ja, es gibt passende Englischkurse für Sie.";
const FOOTER = "*Ich bin eine KI und kann Fehler machen.*";
const OLD_TEXT = `${BODY}\n\n[[FRAGEN: Gibt es B1-Kurse? | Auch online?]]\n\n${FOOTER}`;
const CLEAN_TEXT = `${BODY}\n\n${FOOTER}`;
const API_KEY = "api-key-b1";

const routes = collectRoutes(apiEmbedEndpoints);
const textOf = (row) => JSON.parse(row.response).text;

beforeEach(() => {
  prisma.__reset();
  prisma.__seed("api_keys", { secret: API_KEY });
  const embed = prisma.__seed("embed_configs", { uuid: "embed-uuid" });
  const other = prisma.__seed("embed_configs", { uuid: "other-uuid" });
  prisma.__seed("embed_chats", {
    embed_id: embed.id,
    session_id: "s1",
    prompt: "Englisch?",
    response: JSON.stringify({ text: OLD_TEXT, sources: [{ title: "x" }] }),
  });
  prisma.__seed("embed_chats", {
    embed_id: embed.id,
    session_id: "s1",
    prompt: "Und B1?",
    response: JSON.stringify({ text: BODY, followUps: ["Mehr?"] }),
  });
  prisma.__seed("embed_chats", {
    embed_id: embed.id,
    session_id: "s2",
    prompt: "Kurse in [[Lingen]]?",
    response: JSON.stringify({ text: OLD_TEXT }),
  });
  prisma.__seed("embed_chats", {
    embed_id: other.id,
    session_id: "s1",
    prompt: "fremd",
    response: JSON.stringify({ text: OLD_TEXT }),
  });
});

describe("B1: Entwickler-API liefert gespeicherte Antworten ohne Protokoll-Marker", () => {
  test("EmbedChats.where bereinigt den Text, sonst alles unverändert", async () => {
    const { EmbedChats } = require("../../models/embedChats");
    const chats = await EmbedChats.where({ session_id: "s1" });
    expect(chats.map(textOf)).toEqual([CLEAN_TEXT, BODY, CLEAN_TEXT]);
    // Quellen und übrige Felder bleiben für die Rohdaten-Schnittstelle
    expect(JSON.parse(chats[0].response).sources).toEqual([{ title: "x" }]);
    expect(JSON.parse(chats[1].response).followUps).toEqual(["Mehr?"]);
    // Die gespeicherten Zeilen selbst bleiben unverändert
    expect(textOf(prisma.__rows("embed_chats")[0])).toBe(OLD_TEXT);
  });

  test("GET /v1/embed/:embedUuid/chats", async () => {
    const res = await invoke(routes["GET /v1/embed/:embedUuid/chats"], {
      params: { embedUuid: "embed-uuid" },
      token: API_KEY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.chats.map(textOf)).toEqual([CLEAN_TEXT, BODY, CLEAN_TEXT]);
    expect(JSON.stringify(res.body)).not.toContain("[[FRAGEN");
    // Der Nutzertext (prompt) wird nie angefasst
    expect(res.body.chats[2].prompt).toBe("Kurse in [[Lingen]]?");
  });

  test("GET /v1/embed/:embedUuid/chats/:sessionUuid", async () => {
    const res = await invoke(
      routes["GET /v1/embed/:embedUuid/chats/:sessionUuid"],
      { params: { embedUuid: "embed-uuid", sessionUuid: "s1" }, token: API_KEY }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.chats.map(textOf)).toEqual([CLEAN_TEXT, BODY]);
    expect(JSON.stringify(res.body)).not.toContain("[[FRAGEN");
  });

  test("ohne gültigen API-Key weiterhin 403", async () => {
    const res = await invoke(routes["GET /v1/embed/:embedUuid/chats"], {
      params: { embedUuid: "embed-uuid" },
      token: "falsch",
    });
    expect(res.statusCode).toBe(403);
  });
});
