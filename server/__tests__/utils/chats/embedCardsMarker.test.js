/* eslint-env jest, node */
// Kurskarten v2: Karten-Marker "[[KARTEN: n, n]]" in der ersten Antwortzeile
// — Parsing, Pufferung im Token-Strom, Entfernen aus dem Text.

jest.mock("../../../utils/helpers/chat/responses", () => ({
  writeResponseChunk: jest.fn((response, data) =>
    response.write(`data: ${JSON.stringify(data)}\n\n`)
  ),
}));

const {
  CARDS_MARKER_BUFFER_MAX,
  parseCardsMarker,
  parseMarkerIndices,
  stripCardsMarker,
  CardsMarkerFilter,
  createCardsMarkerResponse,
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
