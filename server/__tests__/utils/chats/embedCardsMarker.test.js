/* eslint-env jest, node */
// Kurskarten v2: Karten-Marker "[[KARTEN: n, n]]" in der ersten Antwortzeile
// — Parsing, Pufferung im Token-Strom, Entfernen aus dem Text.

jest.mock("../../../utils/helpers/chat/responses", () => ({
  writeResponseChunk: jest.fn((response, data) =>
    response.write(`data: ${JSON.stringify(data)}\n\n`)
  ),
}));

const {
  parseCardsMarker,
  stripCardsMarker,
  createCardsMarkerResponse,
  restoreCardsMarkers,
  storedMarkerIndices,
  __test__: {
    CARDS_MARKER_BUFFER_MAX,
    parseMarkerIndices,
    cardsMarkerLine,
    CardsMarkerFilter,
  },
} = require("../../../utils/chats/embedCardsMarker");

describe("parseCardsMarker", () => {
  test.each([
    ["[[KARTEN: 0, 2, 3]]\nText", [0, 2, 3]],
    ["  \n[[KARTEN:1]] Text", [1]],
    ["[[karten: 3 ,1 , 3]]", [3, 1]],
    ["[[KARTEN: -]]\n\nKeine passenden Kurse.", []],
  ])("gültig: %p", (text, indices) => {
    const r = parseCardsMarker(text);
    expect(r).toMatchObject({ state: "marker", valid: true, indices });
  });

  test.each([
    ["[[KARTEN: eins, zwei]]\nText"],
    ["[[KARTEN: 1, 2,]]"],
    ["[[KARTEN: ]]"],
    ["[[KARTEN: 1-3]]"],
    ["[[KARTEN: 1234]]"],
  ])("kaputt (Inhalt): %p -> Marker, ohne Karten", (text) => {
    const r = parseCardsMarker(text);
    expect(r).toMatchObject({ state: "marker", valid: false, indices: null });
  });

  test("kaputt: Zeilenende vor ']]' -> Zeile wird entfernt", () => {
    const text = "[[KARTEN: 1, 2\nHier die Antwort.";
    const r = parseCardsMarker(text);
    expect(r).toMatchObject({ state: "marker", valid: false });
    expect(text.slice(r.end)).toBe("Hier die Antwort.");
  });

  test.each([
    ["Ja, es gibt Sportkurse."],
    ["[Aerobic](https://x.de/kurs/a/1) ist …"],
    ["**[[Hinweis]]**"],
    ["[[KARTE: 1]]"],
  ])("fehlend: %p -> sofort entschieden, kein Marker", (text) => {
    expect(parseCardsMarker(text).state).toBe("none");
  });

  test("Anfang des Tags -> noch offen (puffern)", () => {
    expect(parseCardsMarker("[").state).toBe("pending");
    expect(parseCardsMarker("  [[KAR").state).toBe("pending");
    expect(parseCardsMarker("[[KARTEN: 1, 2").state).toBe("pending");
    expect(parseCardsMarker("").state).toBe("pending");
    // Antwort zu Ende ohne vollständigen Marker -> kein Marker
    expect(parseCardsMarker("[[KAR", { final: true }).state).toBe("none");
  });

  test("zu lang: > 120 Zeichen ohne ']]'/Zeilenende -> kein Marker", () => {
    const text = `[[KARTEN: ${"1, ".repeat(60)}`;
    expect(text.length).toBeGreaterThan(CARDS_MARKER_BUFFER_MAX);
    expect(parseCardsMarker(text).state).toBe("none");
  });

  test("parseMarkerIndices: Dubletten raus, Reihenfolge bleibt", () => {
    expect(parseMarkerIndices(" 2, 0, 2 ")).toEqual([2, 0]);
    expect(parseMarkerIndices("-")).toEqual([]);
    expect(parseMarkerIndices("x")).toBeNull();
  });
});

describe("stripCardsMarker (gespeicherte Antwort / ohne Streaming)", () => {
  test.each([
    ["[[KARTEN: 0, 1]]\n\nHallo", "Hallo"],
    ["[[KARTEN: -]]\nHallo", "Hallo"],
    ["[[KARTEN: kaputt]] Hallo", "Hallo"],
    ["[[KARTEN: 1\nHallo", "Hallo"],
    ["Hallo [[KARTEN: 1]]", "Hallo [[KARTEN: 1]]"],
    ["Hallo", "Hallo"],
  ])("%p -> %p", (input, output) => {
    expect(stripCardsMarker(input)).toBe(output);
  });
});

describe("CardsMarkerFilter (Pufferung im Token-Strom)", () => {
  function run(tokens) {
    const filter = new CardsMarkerFilter();
    const sent = [];
    let marker = null;
    tokens.forEach((token, i) => {
      const r = filter.push(token, { final: i === tokens.length - 1 });
      if (r.marker) marker = r.marker;
      sent.push(r.text);
    });
    return { sent, text: sent.join(""), marker };
  }

  test("Marker über mehrere Tokens verteilt: nichts davon wird gesendet", () => {
    const { sent, text, marker } = run([
      "[[",
      "KAR",
      "TEN: 0",
      ", 3",
      "]]",
      "\n",
      "\n",
      "Ja",
      ", es gibt …",
      "",
    ]);
    expect(marker).toEqual({ indices: [0, 3], valid: true });
    expect(text).toBe("Ja, es gibt …");
    expect(sent.slice(0, 7).every((t) => t === "")).toBe(true);
    expect(sent.join("|")).not.toMatch(/KARTEN|\[\[/);
  });

  test("ohne Marker: Text unverändert, erstes Token sofort", () => {
    const { sent, text, marker } = run(["Ja", ", gern.", ""]);
    expect(marker).toBeNull();
    expect(sent[0]).toBe("Ja");
    expect(text).toBe("Ja, gern.");
  });

  test("Leerraum vorn wird gepuffert, dann unverändert gesendet", () => {
    const { text } = run(["\n", " Hallo", ""]);
    expect(text).toBe("\n Hallo");
  });

  test("kaputter Marker (Zeilenende) wird entfernt, keine Karten", () => {
    const { text, marker } = run(["[[KARTEN: a, b", "\nAntwort", ""]);
    expect(marker).toEqual({ indices: [], valid: false });
    expect(text).toBe("Antwort");
  });

  test("zu langer Anfang: nach 120 Zeichen wird alles unverändert gesendet", () => {
    const long = `[[KARTEN: ${"9 ".repeat(70)}`;
    const { text, marker } = run([
      long.slice(0, 60),
      long.slice(60),
      " Rest",
      "",
    ]);
    expect(marker).toBeNull();
    expect(text).toBe(`${long} Rest`);
  });

  test("Antwort endet, solange noch gepuffert wird -> Rest wird gesendet", () => {
    const { text } = run(["[[KAR"]);
    expect(text).toBe("[[KAR");
  });

  test("nur Marker, kein Text", () => {
    const { text, marker } = run(["[[KARTEN: 2]]", ""]);
    expect(marker.indices).toEqual([2]);
    expect(text).toBe("");
  });
});

describe("createCardsMarkerResponse (Response-Hülle)", () => {
  function fakeResponse() {
    const log = [];
    const listeners = {};
    return {
      log,
      locals: { connection: { host: "x" } },
      write: jest.fn((raw) => log.push(JSON.parse(raw.slice(6)))),
      on: jest.fn(function (ev, fn) {
        listeners[ev] = fn;
        return this;
      }),
      removeListener: jest.fn(),
      listeners,
    };
  }
  const chunk = (textResponse, close = false) =>
    `data: ${JSON.stringify({ uuid: "u1", type: "textResponseChunk", textResponse, close, error: false, sources: [] })}\n\n`;

  test("courseSources-Chunk kommt vor dem ersten Text-Token; Marker nie im Text", async () => {
    const res = fakeResponse();
    const { response, done } = createCardsMarkerResponse(res, {
      onMarker: async ({ indices }) => {
        await new Promise((r) => setTimeout(r, 5)); // asynchroner Nachschlag
        res.write(
          `data: ${JSON.stringify({ uuid: "u1", type: "courseSources", courseSources: indices.map((i) => ({ i })) })}\n\n`
        );
      },
    });
    for (const t of ["[[KARTEN:", " 1, 0]]", "\n", "Hier", " sind", " Kurse."])
      response.write(chunk(t));
    response.write(chunk("", true));
    await done();

    const types = res.log.map((c) => c.type);
    expect(types[0]).toBe("courseSources");
    expect(res.log[0].courseSources).toEqual([{ i: 1 }, { i: 0 }]);
    const texts = res.log.filter((c) => c.type === "textResponseChunk");
    expect(texts.map((c) => c.textResponse).join("")).toBe("Hier sind Kurse.");
    expect(JSON.stringify(res.log)).not.toMatch(/KARTEN/);
    expect(texts[texts.length - 1]).toMatchObject({ close: true });
  });

  test("Abbruch-Listener, locals und andere Chunks gehen an die echte Response", async () => {
    const res = fakeResponse();
    const { response, done } = createCardsMarkerResponse(res, {
      onMarker: jest.fn(),
    });
    const handler = () => {};
    response.on("close", handler);
    expect(res.on).toHaveBeenCalledWith("close", handler);
    expect(response.locals).toBe(res.locals);
    response.write(
      `data: ${JSON.stringify({ uuid: "u1", type: "abort", textResponse: null, close: true, error: "x" })}\n\n`
    );
    await done();
    expect(res.log).toEqual([
      {
        uuid: "u1",
        type: "abort",
        textResponse: null,
        close: true,
        error: "x",
      },
    ]);
  });

  test("ohne Marker: keine onMarker-Aufrufe, Text unverändert", async () => {
    const res = fakeResponse();
    const onMarker = jest.fn();
    const { response, done } = createCardsMarkerResponse(res, { onMarker });
    for (const t of ["Ja", ", gern."]) response.write(chunk(t));
    response.write(chunk("", true));
    await done();
    expect(onMarker).not.toHaveBeenCalled();
    expect(res.log.map((c) => c.textResponse).join("")).toBe("Ja, gern.");
  });
});

// Review-Befunde Kurskarten v2 (05.10.2026)
describe("Befund 6: gemeinsame Obergrenze für Stream-Filter und Stripping", () => {
  function streamText(text, size = 9) {
    const filter = new CardsMarkerFilter();
    const pieces = text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"));
    let marker = null;
    const sent = pieces.map((piece, i) => {
      const r = filter.push(piece, { final: false });
      if (r.marker) marker = r.marker;
      return r.text;
    });
    const end = filter.push("", { final: true });
    if (end.marker) marker = end.marker;
    sent.push(end.text);
    return { text: sent.join(""), marker };
  }

  test("160-Zeichen-Marker: Stream und strip lassen den Text beide unverändert", () => {
    const marker = `[[KARTEN: ${Array.from({ length: 50 }, (_, i) => i).join(", ")}]]`;
    expect(marker.length).toBeGreaterThan(CARDS_MARKER_BUFFER_MAX);
    expect(marker.length).toBeLessThanOrEqual(240);
    const reply = `${marker}\nHier sind die Kurse.`;
    expect(parseCardsMarker(reply, { final: true }).state).toBe("none");
    expect(stripCardsMarker(reply)).toBe(reply);
    const streamed = streamText(reply);
    expect(streamed.marker).toBeNull();
    expect(streamed.text).toBe(reply);
  });

  test("Marker knapp innerhalb der Grenze: beide entfernen ihn", () => {
    const list = Array.from({ length: 40 }, (_, i) => i).join(",");
    const marker = `[[KARTEN: ${list.slice(0, CARDS_MARKER_BUFFER_MAX - 12)}`;
    const closed = `${marker.replace(/,\d*$/, "")}]]`;
    expect(closed.length).toBeLessThanOrEqual(CARDS_MARKER_BUFFER_MAX);
    const reply = `${closed}\nText`;
    expect(stripCardsMarker(reply)).toBe("Text");
    const streamed = streamText(reply);
    expect(streamed.text).toBe("Text");
    expect(streamed.marker.valid).toBe(true);
  });

  test("kaputte Zeile länger als die Grenze bleibt in beiden Wegen stehen", () => {
    const reply = `[[KARTEN: ${"x".repeat(150)}\nText`;
    expect(stripCardsMarker(reply)).toBe(reply);
    expect(streamText(reply).text).toBe(reply);
  });
});

describe("Befund 4: Marker im LLM-Verlauf (restoreCardsMarkers)", () => {
  const { convertToPromptHistory } = jest.requireActual(
    "../../../utils/helpers/chat/responses"
  );
  const record = (id, response) => ({
    id,
    prompt: `Frage ${id}`,
    response: JSON.stringify(response),
  });

  test("stellt gespeicherte Nummern als erste Zeile voran, [] als '[[KARTEN: -]]', ohne Feld nichts", () => {
    const raw = [
      record(1, { text: "Kurse: …", courseCardsMarker: [0, 2], sources: [] }),
      record(2, { text: "Keine.", courseCardsMarker: [] }),
      record(3, { text: "Ohne Feld." }),
      record(4, { text: "Kaputt.", courseCardsMarker: ["1; drop", -1] }),
      record(5, { text: "Null.", courseCardsMarker: null }),
    ];
    const restored = restoreCardsMarkers(raw);
    expect(
      convertToPromptHistory(restored)
        .filter((m) => m.role === "assistant")
        .map((m) => m.content)
    ).toEqual([
      "[[KARTEN: 0, 2]]\nKurse: …",
      "[[KARTEN: -]]\nKeine.",
      "Ohne Feld.",
      "Kaputt.",
      "Null.",
    ]);
    // Originale bleiben unverändert (z. B. für /history)
    expect(JSON.parse(raw[0].response).text).toBe("Kurse: …");
    expect(restored[2]).toBe(raw[2]);
    expect(restored[4]).toBe(raw[4]);
    // auch der leere Marker wird wieder als (gültiger) Marker erkannt
    expect(
      parseCardsMarker(JSON.parse(restored[1].response).text, { final: true })
    ).toMatchObject({ state: "marker", indices: [], valid: true });
    // vorangestellter Marker wird wieder als Marker erkannt
    expect(
      parseCardsMarker(JSON.parse(restored[0].response).text, { final: true })
    ).toMatchObject({ state: "marker", indices: [0, 2], valid: true });
  });

  test("storedMarkerIndices / cardsMarkerLine prüfen die gespeicherte Liste", () => {
    expect(storedMarkerIndices([3, 1, 3])).toEqual([3, 1]);
    expect(storedMarkerIndices([])).toEqual([]);
    expect(storedMarkerIndices([1000])).toBeNull();
    expect(storedMarkerIndices([1.5])).toBeNull();
    expect(storedMarkerIndices("0,1")).toBeNull();
    expect(storedMarkerIndices(null)).toBeNull();
    expect(storedMarkerIndices(undefined)).toBeNull();
    expect(cardsMarkerLine([0, 4])).toBe("[[KARTEN: 0, 4]]");
    expect(cardsMarkerLine([])).toBe("[[KARTEN: -]]");
    expect(cardsMarkerLine(null)).toBe("");
    expect(cardsMarkerLine(undefined)).toBe("");
    expect(restoreCardsMarkers(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Kurskarten v3: Teaserzeilen "[[TEASER n: …]]" direkt nach dem Marker
// ---------------------------------------------------------------------------
describe("Kurskarten v3: parseTeaserLines / stripTeasers / parseCardsReply", () => {
  const {
    parseTeaserLines,
    stripTeasers,
    parseCardsReply,
    storedTeaserLines,
    __test__: { TEASER_LINE_MAX, TEASER_LINES_MAX, teaserLinesText },
  } = require("../../../utils/chats/embedCardsMarker");

  test("zwei Teaserzeilen, dann Text", () => {
    const text =
      "\n[[TEASER 0: Sanft starten am Abend.]]\n[[teaser 2:Zweiter Kurs.]]\n\nJa, zwei Kurse.";
    const r = parseTeaserLines(text);
    expect(r.state).toBe("done");
    expect(r.lines).toEqual([
      { index: 0, text: "Sanft starten am Abend." },
      { index: 2, text: "Zweiter Kurs." },
    ]);
    expect(text.slice(r.end)).toBe("Ja, zwei Kurse.");
  });

  test("offen: Anfang des Tags, Zeile ohne ']]', Leerraum am Ende", () => {
    expect(parseTeaserLines("").state).toBe("pending");
    expect(parseTeaserLines("[[TEA").state).toBe("pending");
    expect(parseTeaserLines("[[TEASER 0: halb").state).toBe("pending");
    expect(parseTeaserLines("[[TEASER 0: ganz]]\n").state).toBe("pending");
    expect(parseTeaserLines("[[TEASER 0: ganz]]\n").lines).toHaveLength(1);
  });

  test("kein Teaser: sofort entschieden", () => {
    for (const t of ["Ja", "[Aerobic](https://x.de)", "[[Hinweis]]", "**x**"])
      expect(parseTeaserLines(t)).toMatchObject({ state: "done", end: 0 });
  });

  test("NAK-1: kaputte Zeile (Zeilenende vor ']]') bleibt Text, auch alles danach", () => {
    const text = "[[TEASER 0: ohne Ende\n[[TEASER 1: gut]]\nText";
    const r = parseTeaserLines(text);
    expect(r).toMatchObject({ state: "done", lines: [], end: 0 });
  });

  test("NAK-1: überlange Zeile (> 240 ohne ']]') bleibt Text", () => {
    const text = `[[TEASER 0: ${"x".repeat(TEASER_LINE_MAX)}]]\nText`;
    const r = parseTeaserLines(text);
    expect(r).toMatchObject({ state: "done", lines: [], end: 0 });
    // ohne Zeilenende entscheidet die Grenze schon im Strom
    expect(parseTeaserLines(text.slice(0, TEASER_LINE_MAX)).state).toBe("done");
  });

  test("falsches Format bleibt Text", () => {
    for (const t of [
      "[[TEASER x: a]]\nT",
      "[[TEASER: a]]\nT",
      "[[TEASERS 1: a]]",
    ])
      expect(parseTeaserLines(t, { final: true })).toMatchObject({
        lines: [],
        end: 0,
      });
  });

  test("höchstens 5 Zeilen, die sechste bleibt Text", () => {
    const lines = Array.from(
      { length: 6 },
      (_, i) => `[[TEASER ${i}: Kurs ${i}.]]`
    );
    const text = `${lines.join("\n")}\nText`;
    const r = parseTeaserLines(text, { final: true });
    expect(r.lines).toHaveLength(TEASER_LINES_MAX);
    expect(text.slice(r.end)).toBe(`${lines[5]}\nText`);
  });

  test("final: Antwort endet mitten in einer Teaserzeile -> Rest bleibt Text", () => {
    const r = parseTeaserLines("[[TEASER 0: a]]\n[[TEASER 1: hal", {
      final: true,
    });
    expect(r.lines).toHaveLength(1);
    expect("[[TEASER 0: a]]\n[[TEASER 1: hal".slice(r.end)).toBe(
      "[[TEASER 1: hal"
    );
  });

  test("parseCardsReply: Marker + Teaser + Text; ohne Marker bleibt alles", () => {
    const reply =
      "[[KARTEN: 0, 2]]\n[[TEASER 0: A.]]\n[[TEASER 2: B.]]\nJa, zwei Kurse.";
    expect(parseCardsReply(reply)).toMatchObject({
      marker: { state: "marker", indices: [0, 2] },
      teasers: [
        { index: 0, text: "A." },
        { index: 2, text: "B." },
      ],
      text: "Ja, zwei Kurse.",
    });
    const noMarker = "[[TEASER 0: A.]]\nJa.";
    expect(parseCardsReply(noMarker)).toMatchObject({
      teasers: [],
      text: noMarker,
    });
    expect(stripTeasers("[[TEASER 0: A.]]\n\nJa.")).toBe("Ja.");
    expect(stripTeasers("Ja.")).toBe("Ja.");
  });

  test("storedTeaserLines / teaserLinesText prüfen die gespeicherte Liste", () => {
    expect(
      storedTeaserLines([
        { index: 0, text: "**A** <b>x</b>" },
        { index: 0, text: "doppelt" },
        { index: 1000, text: "zu groß" },
        { index: 1.5, text: "kein int" },
        { index: 2, text: "" },
        "x",
        null,
      ])
    ).toEqual([{ index: 0, text: "A x" }]);
    expect(storedTeaserLines("x")).toEqual([]);
    expect(teaserLinesText([{ index: 3, text: "Gut." }])).toEqual([
      "[[TEASER 3: Gut.]]",
    ]);
  });
});

describe("Kurskarten v3: CardsMarkerFilter mit Teaserzeilen (Token-Strom)", () => {
  function stream(text, size = 5) {
    const filter = new CardsMarkerFilter();
    const pieces = text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"));
    const events = [];
    pieces.forEach((piece, i) => {
      const r = filter.push(piece, { final: i === pieces.length - 1 });
      if (r.marker) events.push({ marker: r.marker, at: i });
      if (r.teasers) events.push({ teasers: r.teasers, at: i });
      if (r.text) events.push({ text: r.text, at: i });
    });
    return {
      events,
      pieces,
      text: events
        .filter((e) => e.text)
        .map((e) => e.text)
        .join(""),
    };
  }

  const REPLY =
    "[[KARTEN: 0, 2]]\n[[TEASER 0: Sanft starten nach Feierabend.]]\n[[TEASER 2: Kraft und Ruhe für Fortgeschrittene.]]\nJa, zwei Kurse passen.";

  test("AK-3/AK-4: Marker sofort, Teaser gesammelt sobald die letzte Zeile zu ist, dann Text", () => {
    const { events, pieces, text } = stream(REPLY);
    const markerAt = events.find((e) => e.marker).at;
    const teaser = events.find((e) => e.teasers);
    const firstText = events.find((e) => e.text);
    // Marker wird mit dem Token entschieden, das "]]" abschließt
    expect(pieces.slice(0, markerAt + 1).join("")).toMatch(/\]\]$|\]\]\n/);
    expect(pieces.slice(0, markerAt).join("")).not.toMatch(/TEASER/);
    expect(teaser.teasers.map((t) => t.index)).toEqual([0, 2]);
    // gemeldet mit dem Token, das die letzte Teaserzeile schließt — vor dem Text
    expect(pieces.slice(0, teaser.at + 1).join("")).toMatch(
      /Fortgeschrittene\.\]\]/
    );
    expect(pieces.slice(0, teaser.at).join("")).not.toMatch(
      /Fortgeschrittene\.\]\]/
    );
    // Token für Token: genau beim schließenden "]", noch vor dem Zeilenende
    const fine = stream(REPLY, 1);
    const at = fine.events.find((e) => e.teasers).at;
    expect(fine.pieces.slice(0, at + 1).join("")).toMatch(
      /Fortgeschrittene\.\]\]$/
    );
    expect(teaser.at).toBeLessThanOrEqual(firstText.at);
    expect(events.filter((e) => e.teasers)).toHaveLength(1);
    expect(text).toBe("Ja, zwei Kurse passen.");
  });

  test("weniger Teaser als Marker-Nummern: Meldung beim ersten Nicht-Teaser-Zeichen", () => {
    const { events, text } = stream(
      "[[KARTEN: 0, 2]]\n[[TEASER 0: Nur einer.]]\nText dahinter."
    );
    const teaser = events.find((e) => e.teasers);
    expect(teaser.teasers).toEqual([{ index: 0, text: "Nur einer." }]);
    expect(text).toBe("Text dahinter.");
  });

  test("NAK-3: Marker ohne Teaserzeilen wie v2 (keine Meldung, Text sofort)", () => {
    const { events, text } = stream("[[KARTEN: 1]]\n\nJa, gern.");
    expect(events.find((e) => e.teasers)).toBeUndefined();
    expect(text).toBe("Ja, gern.");
  });

  test("ohne Marker: Teaserzeilen bleiben Text (nur nach dem Marker gültig)", () => {
    const reply = "[[TEASER 0: a]]\nJa.";
    const { events, text } = stream(reply);
    expect(events.find((e) => e.teasers)).toBeUndefined();
    expect(text).toBe(reply);
  });

  test("NAK-1: kaputte Teaserzeile -> als Text durchgereicht (kein Verlust)", () => {
    const broken = `[[TEASER 0: ${"lang ".repeat(60)}`;
    const reply = `[[KARTEN: 0]]\n${broken}\nText`;
    const { events, text } = stream(reply);
    expect(events.find((e) => e.teasers)).toBeUndefined();
    expect(text).toBe(`${broken}\nText`);
    // gleiche Entscheidung wie für die gespeicherte Antwort
    expect(
      require("../../../utils/chats/embedCardsMarker").parseCardsReply(reply)
        .text
    ).toBe(text);
  });

  test("Stream und parseCardsReply entscheiden gleich (verschiedene Token-Größen)", () => {
    const {
      parseCardsReply,
    } = require("../../../utils/chats/embedCardsMarker");
    const replies = [
      REPLY,
      "[[KARTEN: -]]\n[[TEASER 1: fremd]]\nKeine Kurse.",
      "[[KARTEN: 0]]\n[[TEASER 0: a]] und gleich Text",
      "[[KARTEN: 0]]\n[[TEASER 0: a]]",
      "[[KARTEN: 0]]\n[[TEASER 0: a]]\n[[TEASER 0: b\nText",
    ];
    for (const reply of replies)
      for (const size of [1, 3, 7, 50]) {
        const { text } = stream(reply, size);
        expect(text).toBe(parseCardsReply(reply).text);
      }
  });

  test("createCardsMarkerResponse: courseSources -> courseTeasers -> Text, Teaser nie im Text", async () => {
    const log = [];
    const res = {
      locals: {},
      write: jest.fn((raw) => log.push(JSON.parse(raw.slice(6)))),
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const { response, done } = createCardsMarkerResponse(res, {
      onMarker: async () => {
        await new Promise((r) => setTimeout(r, 5));
        res.write(`data: ${JSON.stringify({ type: "courseSources" })}\n\n`);
      },
      onTeasers: (lines) =>
        res.write(
          `data: ${JSON.stringify({ type: "courseTeasers", lines })}\n\n`
        ),
    });
    for (const t of REPLY.match(/[\s\S]{1,6}/g))
      response.write(
        `data: ${JSON.stringify({ type: "textResponseChunk", textResponse: t, close: false })}\n\n`
      );
    response.write(
      `data: ${JSON.stringify({ type: "textResponseChunk", textResponse: "", close: true })}\n\n`
    );
    await done();
    const types = log.map((c) => c.type);
    expect(types.slice(0, 2)).toEqual(["courseSources", "courseTeasers"]);
    expect(types.slice(2).every((t) => t === "textResponseChunk")).toBe(true);
    expect(
      log
        .filter((c) => c.type === "textResponseChunk")
        .map((c) => c.textResponse)
        .join("")
    ).toBe("Ja, zwei Kurse passen.");
    expect(
      JSON.stringify(log.filter((c) => c.type === "textResponseChunk"))
    ).not.toMatch(/TEASER|KARTEN/);
  });
});

describe("AK-8: Marker und Teaserzeilen im LLM-Verlauf (restoreCardsMarkers)", () => {
  const { convertToPromptHistory } = jest.requireActual(
    "../../../utils/helpers/chat/responses"
  );
  test("Teaserzeilen folgen direkt auf den Marker, vor der Antwort", () => {
    const raw = [
      {
        id: 1,
        prompt: "Yoga am Abend?",
        response: JSON.stringify({
          text: "Ja, zwei Kurse passen.",
          courseCardsMarker: [0, 2],
          courseTeaserLines: [
            { index: 0, text: "Sanft starten." },
            { index: 2, text: "Für Fortgeschrittene." },
          ],
          courseTeasers: { "https://x.de/k/1": "Sanft starten." },
        }),
      },
      {
        id: 2,
        prompt: "ohne Marker",
        response: JSON.stringify({
          text: "Hallo.",
          courseTeaserLines: [{ index: 0, text: "nie ohne Marker" }],
        }),
      },
    ];
    const content = convertToPromptHistory(restoreCardsMarkers(raw))
      .filter((m) => m.role === "assistant")
      .map((m) => m.content);
    expect(content).toEqual([
      "[[KARTEN: 0, 2]]\n[[TEASER 0: Sanft starten.]]\n[[TEASER 2: Für Fortgeschrittene.]]\nJa, zwei Kurse passen.",
      "Hallo.",
    ]);
    // wiederhergestellter Verlauf wird wieder als Marker + Teaser erkannt
    const {
      parseCardsReply,
    } = require("../../../utils/chats/embedCardsMarker");
    expect(parseCardsReply(content[0])).toMatchObject({
      teasers: [{ index: 0 }, { index: 2 }],
      text: "Ja, zwei Kurse passen.",
    });
    expect(JSON.parse(raw[0].response).text).toBe("Ja, zwei Kurse passen.");
  });
});
