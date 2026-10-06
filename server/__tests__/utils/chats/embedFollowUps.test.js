/* eslint-env jest, node */
// Folgefragen: Endzeile "[[FRAGEN: Frage eins? | Frage zwei?]]" — Erkennen
// am Antwortende (parseFollowUps), Stream-Filter (CardsMarkerFilter)
// entscheidet wie die ganze Antwort, gespeicherte Vorschläge (storedFollowUps)
// und Wiederherstellung im LLM-Verlauf (restoreCardsMarkers).

const {
  parseFollowUps,
  parseCardsReply,
  storedFollowUps,
  restoreCardsMarkers,
  __test__: {
    CardsMarkerFilter,
    FOLLOW_UPS_LINE_MAX,
    FOLLOW_UP_MAX_LEN,
    parseFollowUpItems,
    followUpsLine,
  },
} = require("../../../utils/chats/embedCardsMarker");

const BODY = "Ja, es gibt passende Englischkurse für Sie.";
const LINE = "[[FRAGEN: Gibt es B1-Kurse? | Auch online?]]";

describe("parseFollowUps (vollständige Antwort)", () => {
  test("AK-1: Endzeile erkannt, Text ohne Zeile und ohne Leerraum davor", () => {
    const r = parseFollowUps(`${BODY}\n${LINE}`, { final: true });
    expect(r.state).toBe("followUps");
    expect(r.followUps).toEqual(["Gibt es B1-Kurse?", "Auch online?"]);
    expect(r.text).toBe(BODY);
    // Leerraum davor/danach, Einrückung, Kleinschreibung des Tags
    const r2 = parseFollowUps(`${BODY}\n\n  [[fragen:a? |b?]]  \n\n`, {
      final: true,
    });
    expect(r2.followUps).toEqual(["a?", "b?"]);
    expect(r2.text).toBe(BODY);
  });

  test("drei Einträge erlaubt, Dubletten einmal, Markdown/HTML bereinigt", () => {
    const r = parseFollowUps(
      `${BODY}\n[[FRAGEN: **Gibt es B1?** | <b>Auch online?</b> | gibt es b1? | [Abends?](https://x.de)]]`,
      { final: true }
    );
    expect(r.followUps).toEqual(["Gibt es B1?", "Auch online?", "Abends?"]);
  });

  test("'-' bzw. leer: Protokoll ohne Vorschläge — Zeile entfernt", () => {
    for (const line of ["[[FRAGEN: -]]", "[[FRAGEN:]]", "[[FRAGEN:  ]]"]) {
      const r = parseFollowUps(`${BODY}\n${line}`, { final: true });
      expect(r.state).toBe("followUps");
      expect(r.followUps).toEqual([]);
      expect(r.text).toBe(BODY);
    }
  });

  test("nur die Zeile (ganze Antwort) wird erkannt", () => {
    const r = parseFollowUps(LINE, { final: true });
    expect(r.followUps).toHaveLength(2);
    expect(r.text).toBe("");
  });

  test("NAK-1: kaputt/zu lang/nicht am Ende -> Text unverändert, nichts gesammelt", () => {
    const long = "x".repeat(FOLLOW_UP_MAX_LEN + 1);
    const cases = [
      `${BODY}\n[[FRAGEN: a? | ${long}]]`, // Eintrag > 60
      `${BODY}\n[[FRAGEN: a? | b? | c? | d?]]`, // 4 Einträge
      `${BODY}\n[[FRAGEN: ${"Frage ".repeat(60)}]]`, // Zeile > 300
      `${BODY}\n[[FRAGEN: a? | b?`, // ohne "]]"
      `${BODY}\n[[FRAGEN: a? | b?]] und noch Text`, // Text hinter "]]"
      `${BODY}\n${LINE}\nNoch ein Satz.`, // nicht am Ende
      `${BODY} ${LINE}`, // kein Zeilenanfang
      `${BODY}\n[[FRAGEN: | | ]]`, // nur leere Einträge
      `${BODY}\n[[FRAGE: a? | b?]]`, // falsches Tag
    ];
    for (const text of cases) {
      const r = parseFollowUps(text, { final: true });
      expect(r.state).toBe("none");
      expect(r.text).toBe(text);
      expect(r.followUps).toBeUndefined();
    }
  });

  test("Grenze: Zeile mit genau 300 Zeichen gilt, 301 nicht", () => {
    // Einträge à ≤ 60 Zeichen: "| " + 58 x "a" + "?" ... auffüllen
    const build = (len) => {
      const head = "[[FRAGEN: ";
      const items = [];
      let rest = len - head.length - 2;
      // drei Einträge, Trenner " | " (3 Zeichen), Leerraum rechts füllt
      for (let i = 0; i < 3; i++) items.push("q".repeat(59) + "?");
      const core = items.join(" | ");
      rest -= core.length;
      return `${head}${core}${" ".repeat(rest)}]]`;
    };
    const ok = build(FOLLOW_UPS_LINE_MAX);
    expect(ok).toHaveLength(300);
    expect(parseFollowUps(`${BODY}\n${ok}`, { final: true }).state).toBe(
      "followUps"
    );
    const tooLong = build(FOLLOW_UPS_LINE_MAX + 1);
    expect(tooLong).toHaveLength(301);
    expect(parseFollowUps(`${BODY}\n${tooLong}`, { final: true }).state).toBe(
      "none"
    );
  });

  test("parseFollowUpItems: Grenzen", () => {
    expect(parseFollowUpItems("a | b | c")).toEqual(["a", "b", "c"]);
    expect(parseFollowUpItems("a | b | c | d")).toBeNull();
    expect(parseFollowUpItems("x".repeat(60))).toEqual(["x".repeat(60)]);
    expect(parseFollowUpItems("x".repeat(61))).toBeNull();
    expect(parseFollowUpItems(" - ")).toEqual([]);
  });
});

describe("parseCardsReply mit Folgefragen", () => {
  test("Marker + Teaser + Text + Endzeile", () => {
    const reply = [
      "[[KARTEN: 0]]",
      "[[TEASER 0: Kurz und knapp.]]",
      BODY,
      LINE,
    ].join("\n");
    const r = parseCardsReply(reply);
    expect(r.marker.indices).toEqual([0]);
    expect(r.teasers).toEqual([{ index: 0, text: "Kurz und knapp." }]);
    expect(r.followUps).toEqual(["Gibt es B1-Kurse?", "Auch online?"]);
    expect(r.text).toBe(BODY);
  });

  test("ohne Marker: Endzeile trotzdem entfernt", () => {
    const r = parseCardsReply(`${BODY}\n${LINE}`);
    expect(r.marker.state).toBe("none");
    expect(r.text).toBe(BODY);
    expect(r.followUps).toHaveLength(2);
  });

  test("ohne Endzeile: followUps leer, Text unverändert", () => {
    const r = parseCardsReply(`${BODY}\n`);
    expect(r.followUps).toEqual([]);
    expect(r.text).toBe(`${BODY}\n`);
  });
});

// Stream-Filter: Token für Token (verschiedene Größen) muss dasselbe
// ergeben wie parseCardsReply über die ganze Antwort.
describe("CardsMarkerFilter: Stream entscheidet wie die ganze Antwort", () => {
  const REPLIES = [
    `${BODY}\n${LINE}`,
    `${BODY}\n\n${LINE}\n\n`,
    `${BODY}`,
    `${BODY}   \n\n`,
    `[[KARTEN: 1, 2]]\n[[TEASER 1: Erster.]]\n[[TEASER 2: Zweiter.]]\n${BODY}\n${LINE}`,
    `[[KARTEN: -]]\n${BODY}\n${LINE}`,
    `[[KARTEN: -]]\n${LINE}`,
    LINE,
    `${BODY}\n${LINE}\nNoch ein Satz.`,
    `${BODY}\n[[FRAGEN: a? | b?]] und noch Text`,
    `${BODY}\n[[FRAGEN: a? | ${"x".repeat(61)}]]`,
    `${BODY}\n[[FRAGEN: ${"Frage ".repeat(60)}]]`,
    `${BODY}\n[[FRAGEN: a? | b?`,
    `${BODY} [[FRAGEN: a? | b?]]`,
    `${BODY}\n[[FRAGEN: a [x]] b? | c?]]`,
    `Liste:\n- [[Link]]\n- zwei\n[[FRAGEN: Mehr? | Online?]]`,
    `${BODY}\n[[ nicht das Tag]]\n`,
    `\n\n  ${BODY}\n[[fragen: klein? | auch?]]`,
  ];

  function streamThrough(reply, size) {
    const filter = new CardsMarkerFilter();
    const tokens = reply.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) || [];
    let text = "";
    let followUps;
    for (const t of tokens) {
      const out = filter.push(t);
      expect(out.followUps).toBeUndefined();
      text += out.text;
    }
    const last = filter.push("", { final: true });
    text += last.text;
    followUps = last.followUps ?? [];
    return { text, followUps };
  }

  test.each(REPLIES.map((r, i) => [i, r]))(
    "Antwort %i: Text und Folgefragen gleich",
    (_i, reply) => {
      const whole = parseCardsReply(reply);
      for (const size of [1, 2, 3, 5, 8, 13, 400]) {
        const streamed = streamThrough(reply, size);
        expect(streamed.text).toBe(whole.text);
        expect(streamed.followUps).toEqual(whole.followUps);
      }
    }
  );

  test("hält nur das Ende zurück: Text vor der Endzeile geht sofort raus", () => {
    const filter = new CardsMarkerFilter();
    expect(filter.push(`${BODY} Mehr`).text).toBe(`${BODY} Mehr`);
    // Leerraum am Ende wird gehalten, bis sichtbarer Text folgt
    expect(filter.push(" \n").text).toBe("");
    expect(filter.push("[[FRA").text).toBe("");
    expect(filter.push("GEN: a? | b?]]").text).toBe("");
    const end = filter.push("", { final: true });
    expect(end.text).toBe("");
    expect(end.followUps).toEqual(["a?", "b?"]);
  });

  test("Zeile mitten im Text: sobald weiterer Text folgt, geht sie als Text raus", () => {
    const filter = new CardsMarkerFilter();
    let text = filter.push(`${BODY}\n${LINE}\n`).text;
    expect(text).toBe(BODY);
    text += filter.push("Weiter.").text;
    expect(text).toBe(`${BODY}\n${LINE}\nWeiter.`);
  });
});

describe("gespeicherte Folgefragen", () => {
  test("storedFollowUps: nur Strings, bereinigt, ≤ 60 Zeichen, max. 3, ohne Dubletten", () => {
    expect(
      storedFollowUps([
        " **Gibt es B1?** ",
        42,
        null,
        "x".repeat(61),
        "gibt es b1?",
        "<i>Online?</i>",
        "Abends?",
        "Viertens?",
      ])
    ).toEqual(["Gibt es B1?", "Online?", "Abends?"]);
    expect(storedFollowUps("a")).toEqual([]);
    expect(storedFollowUps(undefined)).toEqual([]);
  });

  test("followUpsLine", () => {
    expect(followUpsLine(["a?", "b?"])).toBe("[[FRAGEN: a? | b?]]");
    expect(followUpsLine([])).toBe("");
  });

  test("restoreCardsMarkers: Endzeile wieder am Ende (mit und ohne Marker), Datensatz unverändert", () => {
    const rows = [
      {
        id: 1,
        response: JSON.stringify({
          text: BODY,
          followUps: ["Gibt es B1-Kurse?", "Auch online?"],
        }),
      },
      {
        id: 2,
        response: JSON.stringify({
          text: BODY,
          courseCardsMarker: [0],
          courseTeaserLines: [{ index: 0, text: "Kurz." }],
          followUps: ["Mehr?"],
        }),
      },
      { id: 3, response: JSON.stringify({ text: BODY }) },
    ];
    const before = JSON.stringify(rows);
    const out = restoreCardsMarkers(rows);
    expect(JSON.parse(out[0].response).text).toBe(`${BODY}\n${LINE}`);
    expect(JSON.parse(out[1].response).text).toBe(
      `[[KARTEN: 0]]\n[[TEASER 0: Kurz.]]\n${BODY}\n[[FRAGEN: Mehr?]]`
    );
    expect(out[2]).toBe(rows[2]);
    expect(JSON.stringify(rows)).toBe(before);
    // Rundweg: die wiederhergestellte Antwort parst wieder zu Text + Vorschlägen
    const again = parseCardsReply(JSON.parse(out[1].response).text);
    expect(again.text).toBe(BODY);
    expect(again.followUps).toEqual(["Mehr?"]);
  });
});
