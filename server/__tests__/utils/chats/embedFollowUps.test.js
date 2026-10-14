/* eslint-env jest, node */
// Folgefragen: Zeile "[[FRAGEN: Frage eins? | Frage zwei?]]" — Erkennen
// überall im Text (FF1, parseFollowUps), Stream-Filter (CardsMarkerFilter)
// entscheidet wie die ganze Antwort, Sicherheitsnetz für Pillen (FF2,
// storedFollowUps) und Wiederherstellung im LLM-Verlauf (restoreCardsMarkers).

const {
  parseFollowUps,
  parseCardsReply,
  storedFollowUps,
  restoreCardsMarkers,
  cleanStoredResponse,
  __test__: {
    CardsMarkerFilter,
    FOLLOW_UPS_LINE_MAX,
    FOLLOW_UP_MAX_LEN,
    parseFollowUpItems,
    followUpKey,
    followUpsLine,
  },
  stripProtocolMarkers,
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
    for (const line of [
      "[[FRAGEN: -]]",
      "[[FRAGEN:]]",
      "[[FRAGEN:  ]]",
      "[[FRAGEN: | | ]]",
    ]) {
      const r = parseFollowUps(`${BODY}\n${line}`, { final: true });
      expect(r.state).toBe("followUps");
      expect(r.followUps).toEqual([]);
      expect(r.text).toBe(BODY);
    }
  });

  test("Befund 2: nur Satzzeichen/Striche/Aufzählungszeichen gelten als leer", () => {
    for (const line of [
      "[[FRAGEN: –]]",
      "[[FRAGEN: —]]",
      "[[FRAGEN: •]]",
      "[[FRAGEN: ·]]",
      "[[FRAGEN: *]]",
      "[[FRAGEN: .]]",
      "[[FRAGEN: … ]]",
      "[[FRAGEN: - | – | — | • | · | * | .]]",
    ]) {
      const r = parseFollowUps(`${BODY}\n${line}`, { final: true });
      expect(r.state).toBe("followUps");
      expect(r.followUps).toEqual([]);
      expect(r.text).toBe(BODY);
    }
    // gemischt: nur der echte Eintrag bleibt
    expect(
      parseFollowUps(`${BODY}\n[[FRAGEN: – | Auch online? | •]]`, {
        final: true,
      }).followUps
    ).toEqual(["Auch online?"]);
  });

  test("nur die Zeile (ganze Antwort) wird erkannt", () => {
    const r = parseFollowUps(LINE, { final: true });
    expect(r.followUps).toHaveLength(2);
    expect(r.text).toBe("");
  });

  test("Befund 1: erkennbare, inhaltlich kaputte Zeile wird trotzdem entfernt, gültige Einträge gesammelt", () => {
    const long = "x".repeat(FOLLOW_UP_MAX_LEN + 1);
    const cases = [
      // Eintrag > 60 Zeichen: verworfen, nicht gekürzt
      [`${BODY}\n[[FRAGEN: a? | ${long}]]`, ["a?"]],
      // 4+ Einträge: die ersten 3 gültigen
      [`${BODY}\n[[FRAGEN: a? | b? | c? | d?]]`, ["a?", "b?", "c?"]],
      [
        `${BODY}\n[[FRAGEN: ${long} | a? | | b? | c? | d?]]`,
        ["a?", "b?", "c?"],
      ],
      // alle Einträge ungültig -> [] (kein Chunk), Zeile trotzdem weg
      [`${BODY}\n[[FRAGEN: ${long} | ${long}y]]`, []],
      // Zeile fast am Fenster (≤ 300 Zeichen) mit nur zu langen Einträgen
      [`${BODY}\n[[FRAGEN: ${"Frage ".repeat(47)}]]`, []],
    ];
    for (const [text, followUps] of cases) {
      const r = parseFollowUps(text, { final: true });
      expect(r.state).toBe("followUps");
      expect(r.followUps).toEqual(followUps);
      expect(r.text).toBe(BODY);
    }
  });

  test('NAK-1: kein Marker (offen/zu lang/Zeilenende ohne "]]"/falsches Tag) -> Text unverändert, nichts gesammelt', () => {
    const cases = [
      `${BODY}\n[[FRAGEN: ${"Frage ".repeat(60)}]]`, // "]]" hinter 300 Zeichen
      `${BODY}\n[[FRAGEN: a? | b?`, // ohne "]]"
      `${BODY}\n[[FRAGEN: a? | b?\n`, // Zeilenende ohne "]]"
      `${BODY}\n[[FRAGEN: a? | b?\nWeiter.]]`, // "]]" erst in der nächsten Zeile
      `${BODY}\n[[FRAGE: a? | b?]]`, // falsches Tag
      `${BODY}\n[[ FRAGEN: a?]]`, // kein Tag (Leerzeichen)
    ];
    for (const text of cases) {
      const r = parseFollowUps(text, { final: true });
      expect(r.state).toBe("none");
      expect(r.text).toBe(text);
      expect(r.followUps).toBeUndefined();
    }
  });

  test('FF1/Befund 4: zwei Gruppen in einer Zeile oder in zwei Zeilen — erstes "]]" schließt, beide entfernt, Pillen aus der letzten', () => {
    for (const text of [
      `${BODY}\n[[FRAGEN: a? | b?]] [[FRAGEN: c?]]`,
      `${BODY}\n[[FRAGEN: a? | b?]]\n[[FRAGEN: c?]]`,
      `${BODY}\n[[FRAGEN: a? | b?]][[FRAGEN: c?]]\n`,
    ]) {
      const r = parseFollowUps(text, { final: true });
      expect(r.state).toBe("followUps");
      expect(r.followUps).toEqual(["c?"]);
      expect(r.text).toBe(BODY);
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

  test("parseFollowUpItems: Grenzen (= storedFollowUps über die Einträge)", () => {
    expect(parseFollowUpItems("a | b | c")).toEqual(["a", "b", "c"]);
    expect(parseFollowUpItems("a | b | c | d")).toEqual(["a", "b", "c"]);
    expect(parseFollowUpItems("x".repeat(60))).toEqual(["x".repeat(60)]);
    expect(parseFollowUpItems("x".repeat(61))).toEqual([]);
    expect(parseFollowUpItems(" - ")).toEqual([]);
    expect(parseFollowUpItems(" – ")).toEqual([]);
    expect(parseFollowUpItems("")).toEqual([]);
    expect(parseFollowUpItems(undefined)).toEqual([]);
    for (const raw of ["a? | **B?** | a?", "x | - | y", "– | • Was? |"])
      expect(parseFollowUpItems(raw)).toEqual(storedFollowUps(raw.split("|")));
  });
});

describe("Folgefragen-Richtung im Nicht-Stream-Pfad", () => {
  test("all-filtered-sync: nur Fragen an den Nutzer -> Zeile entfernt, followUps [] (parseFollowUps final und parseCardsReply über die ganze Antwort)", () => {
    const line =
      "[[FRAGEN: Suchen Sie einen Anfängerkurs? | Welche Sprache möchten Sie lernen? | Are you looking for beginner courses?]]";
    const whole = parseFollowUps(`${BODY}\n${line}`, { final: true });
    expect(whole.state).toBe("followUps");
    expect(whole.followUps).toEqual([]);
    expect(whole.text).toBe(BODY);
    const reply = parseCardsReply(`[[KARTEN: -]]\n${BODY}\n${line}`);
    expect(reply.followUps).toEqual([]);
    expect(reply.text).toBe(BODY);
    expect(reply.text).not.toMatch(/FRAGEN|Suchen Sie/);
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
    `${BODY}\n[[FRAGEN: a? | b? | c? | d?]]`,
    `${BODY}\n[[FRAGEN: | | ]]\n`,
    `${BODY}\n[[FRAGEN: –]]`,
    `${BODY}\n[[FRAGEN: — | • | Online?]]  \n`,
    `${BODY}\n[[FRAGEN: a? | b?]] [[FRAGEN: c?]]`,
    `${BODY}\n[[FRAGEN: a? | b?]]\n[[FRAGEN: c?]]`,
    `${BODY}\n[[FRAGEN: a]] foo\n`,
    `${BODY}\n[[FRAGEN: a? | b?\nWeiter.`,
    `${BODY}\n[[FRAGEN: ${"Frage ".repeat(47)}]]`,
    // FF1: Marker vor dem KI-Hinweis, mitten im Text, doppelt, inline
    `${BODY}\n\n${LINE}\n\n*KI-Hinweis: Ich bin eine KI und kann Fehler machen.*`,
    `${BODY}\n${LINE}\n\n---\n_KI-Hinweis_\n`,
    `Absatz eins.\n\n${LINE}\n\nAbsatz zwei.\n\n[[FRAGEN: Zweite? | Letzte?]]\n\nFuß.`,
    `${BODY} ${LINE} Weiter im Satz.`,
    `[[FRAGEN: Vorn? | Auch?]]\n\n${BODY}`,
    `  \n[[FRAGEN: Vorn?]]  [[KARTEN: 3]]\n${BODY}`,
    `${BODY}\n[[KARTEN: 2, 3]]\nNach Karten.\n${LINE}`,
    `[[KARTEN: 1]]\n[[TEASER 1: Kurz.]]\n${BODY}\n${LINE}\n[[KARTEN: 1]]\n*Hinweis*`,
    `${BODY}\n- Punkt\n  [[FRAGEN: Eingerückt?]]\n  - Unterpunkt`,
    `${BODY}\n[[FRAGEN: a?]]\n[[FRAGEN: -]]\nEnde.`,
    `${BODY} [[FRA nein]] und [[KARTE]] und [ [FRAGEN: a?]] [x]`,
    `${BODY}\n[[FRAGEN: offen ${"y".repeat(320)}\nRest.`,
    `${BODY}\n[[KARTEN: ${"9, ".repeat(50)}]]\nRest.`,
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

  test("FF1/Befund 7: Text hinter einem Marker geht sofort raus, der Marker nie", () => {
    // "]]" mit Text dahinter: Marker entfernt, Text sofort (Leerraum am
    // Ende bleibt gehalten)
    let filter = new CardsMarkerFilter();
    expect(filter.push(`${BODY}\n[[FRAGEN: a]] foo\n`).text).toBe(
      `${BODY}\nfoo`
    );
    filter = new CardsMarkerFilter();
    expect(filter.push(`${BODY}\n[[FRAGEN: a]] f`).text).toBe(`${BODY}\nf`);
    // Zeilenende ohne "]]": kein Marker, sofort Text
    filter = new CardsMarkerFilter();
    expect(filter.push(`${BODY}\n[[FRAGEN: a? | b?\n`).text).toBe(
      `${BODY}\n[[FRAGEN: a? | b?`
    );
    // ohne Zeilenende bleibt der offene Marker gehalten (könnte noch "]]" bekommen)
    filter = new CardsMarkerFilter();
    expect(filter.push(`${BODY}\n[[FRAGEN: a? | b?`).text).toBe(BODY);
    // ein geschlossener Marker mit Zeilenende: nichts davon geht raus
    filter = new CardsMarkerFilter();
    expect(filter.push(`${BODY}\n${LINE}\n`).text).toBe(BODY);
  });

  test("FF1: Marker vor dem KI-Hinweis — weiterer Text folgt, der Marker bleibt weg, Pillen beim Antwortende", () => {
    const filter = new CardsMarkerFilter();
    let text = filter.push(`${BODY}\n\n${LINE}\n\n`).text;
    expect(text).toBe(BODY);
    text += filter.push("*KI-Hinweis*").text;
    expect(text).toBe(`${BODY}\n\n*KI-Hinweis*`);
    const end = filter.push("", { final: true });
    expect(end.text).toBe("");
    expect(end.followUps).toEqual(["Gibt es B1-Kurse?", "Auch online?"]);
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

  test("Befund 2: storedFollowUps verwirft Einträge nur aus Satzzeichen/Strichen", () => {
    expect(
      storedFollowUps(["-", "–", "—", "•", "·", "*", ".", " … ", "Online?"])
    ).toEqual(["Online?"]);
  });

  test("Befund 6: kaputte Zeile landet nicht im gespeicherten Text, Verlauf bekommt nur die bereinigte Zeile", () => {
    const long = "x".repeat(FOLLOW_UP_MAX_LEN + 1);
    for (const line of [
      "[[FRAGEN: a? | b? | c? | d?]]",
      `[[FRAGEN: a? | ${long} | b? | c?]]`,
      `[[FRAGEN: ${long}]]`,
      "[[FRAGEN: –]]",
    ]) {
      const parsed = parseCardsReply(`${BODY}\n${line}`);
      expect(parsed.text).toBe(BODY);
      expect(parsed.text).not.toMatch(/FRAGEN/);
      const response = { text: parsed.text };
      if (parsed.followUps.length > 0) response.followUps = parsed.followUps;
      const [row] = restoreCardsMarkers([
        { id: 1, response: JSON.stringify(response) },
      ]);
      const restored = JSON.parse(row.response).text;
      const expected = parsed.followUps.length
        ? `${BODY}\n[[FRAGEN: ${parsed.followUps.join(" | ")}]]`
        : BODY;
      expect(restored).toBe(expected);
      expect(restored).not.toMatch(/d\?|x{61}|–/);
    }
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

// FF1 (Abnahme ENT-FOLGEFRAGEN, rc19): Die Zeile stand vor dem KI-Hinweis
// und war im Widget sichtbar, Pillen fehlten. Marker werden überall erkannt.
describe("FF1: Protokoll-Marker überall im Text", () => {
  const FOOTER = "*Ich bin eine KI und kann Fehler machen.*";
  const FU = ["Gibt es B1-Kurse?", "Auch online?"];

  // ganze Antwort (parseCardsReply) und Stream in allen Aufteilungen
  function streamed(reply, cuts) {
    const filter = new CardsMarkerFilter();
    let text = "";
    let from = 0;
    for (const cut of [...cuts, reply.length]) {
      const out = filter.push(reply.slice(from, cut));
      expect(out.followUps).toBeUndefined();
      text += out.text;
      from = cut;
    }
    const last = filter.push("", { final: true });
    return { text: text + last.text, followUps: last.followUps ?? [] };
  }

  function expectEverywhere(reply, text, followUps) {
    const whole = parseCardsReply(reply);
    expect(whole.text).toBe(text);
    expect(whole.followUps).toEqual(followUps);
    // jede Aufteilung in zwei Token
    for (let a = 0; a <= reply.length; a++)
      expect(streamed(reply, [a])).toEqual({ text, followUps });
  }

  test("Marker vor dem Footer (Fall der Abnahme): entfernt, Footer bleibt, Pillen da", () => {
    expectEverywhere(
      `${BODY}\n\n${LINE}\n\n${FOOTER}`,
      `${BODY}\n\n${FOOTER}`,
      FU
    );
    expectEverywhere(`${BODY}\n${LINE}\n${FOOTER}`, `${BODY}\n${FOOTER}`, FU);
    // Footer mit Trennlinie und Zeilenende am Schluss
    expectEverywhere(
      `${BODY}\n\n${LINE}\n\n---\n${FOOTER}\n`,
      `${BODY}\n\n---\n${FOOTER}\n`,
      FU
    );
  });

  test("Marker mitten im Text (eigene Zeile oder im Satz): entfernt, Text davor/danach normal", () => {
    expectEverywhere(
      `Absatz eins.\n\n${LINE}\n\nAbsatz zwei.`,
      "Absatz eins.\n\nAbsatz zwei.",
      FU
    );
    expectEverywhere(
      `Satz eins. ${LINE} Satz zwei.`,
      "Satz eins. Satz zwei.",
      FU
    );
    expectEverywhere(`${BODY} ${LINE}`, BODY, FU);
    expectEverywhere(`${LINE}\n\n${BODY}`, BODY, FU);
    // Einrückung der nächsten Zeile bleibt (Liste)
    expectEverywhere(
      "Liste:\n- eins\n\n[[FRAGEN: a?]]\n  - zwei",
      "Liste:\n- eins\n\n  - zwei",
      ["a?"]
    );
  });

  test("zwei Marker: beide entfernt, Pillen aus der LETZTEN Zeile (auch wenn sie leer ist)", () => {
    expectEverywhere(
      `Eins.\n[[FRAGEN: Erste? | Alte?]]\nZwei.\n\n[[FRAGEN: Neue? | Letzte?]]\n\n${FOOTER}`,
      `Eins.\nZwei.\n\n${FOOTER}`,
      ["Neue?", "Letzte?"]
    );
    expectEverywhere(`${BODY}\n${LINE}\n[[FRAGEN: -]]`, BODY, []);
    expectEverywhere(
      `${BODY}\n[[FRAGEN: -]]\n${FOOTER}\n${LINE}`,
      `${BODY}\n${FOOTER}`,
      FU
    );
  });

  test("späte [[KARTEN: …]]-Zeile wird analog entfernt (keine Karten, kein Text)", () => {
    expectEverywhere(
      `${BODY}\n[[KARTEN: 1, 2]]\n${FOOTER}`,
      `${BODY}\n${FOOTER}`,
      []
    );
    expectEverywhere(
      `[[KARTEN: 0]]\n${BODY}\n\n[[KARTEN: -]]\n\n${LINE}\n\n${FOOTER}`,
      `${BODY}\n\n${FOOTER}`,
      FU
    );
    const r = parseCardsReply(`[[KARTEN: 0]]\n${BODY}\n[[KARTEN: 5]]`);
    expect(r.marker.indices).toEqual([0]);
    expect(r.text).toBe(BODY);
  });

  test("Marker über Chunk-Grenzen: jede Aufteilung in drei Token ergibt dasselbe", () => {
    const reply = `Ja.\n\n[[FRAGEN: Gibt es B1? | Abends?]]\n\n${FOOTER}`;
    const text = `Ja.\n\n${FOOTER}`;
    for (let a = 0; a <= reply.length; a++)
      for (let b = a; b <= reply.length; b += 3)
        expect(streamed(reply, [a, b])).toEqual({
          text,
          followUps: ["Gibt es B1?", "Abends?"],
        });
  });

  test("unvollständiger Marker hängt nicht: Zeilenende oder Fenstergrenze geben ihn frei", () => {
    // Zeilenende ohne "]]" -> sofort Text
    let filter = new CardsMarkerFilter();
    expect(filter.push(`${BODY}\n[[FRAGEN: a? | b?`).text).toBe(BODY);
    expect(filter.push("\nWeiter").text).toBe("\n[[FRAGEN: a? | b?\nWeiter");
    // ohne Zeilenende: spätestens nach FOLLOW_UPS_LINE_MAX Zeichen frei
    filter = new CardsMarkerFilter();
    expect(filter.push(`${BODY}\n`).text).toBe(BODY);
    const open = `[[FRAGEN: ${"y".repeat(FOLLOW_UPS_LINE_MAX)}`;
    let out = "";
    let releasedAt = -1;
    for (let i = 0; i < open.length; i++) {
      out += filter.push(open[i]).text;
      if (releasedAt === -1 && out.length > 0) releasedAt = i;
    }
    expect(releasedAt).toBe(FOLLOW_UPS_LINE_MAX - 1);
    expect(out).toBe(`\n${open}`);
    // Tag-Anfang, der keiner wird -> sofort Text
    filter = new CardsMarkerFilter();
    expect(filter.push(`${BODY} [[FRA`).text).toBe(BODY);
    expect(filter.push("X").text).toBe(" [[FRAX");
    // Antwortende mit offenem Marker -> Text, keine Pillen
    filter = new CardsMarkerFilter();
    expect(filter.push(`${BODY}\n[[FRAGEN: a?`).text).toBe(BODY);
    const end = filter.push("", { final: true });
    expect(end.text).toBe("\n[[FRAGEN: a?");
    expect(end.followUps).toBeUndefined();
  });

  test("stripProtocolMarkers (Verlauf): Marker weg, sonst unverändert", () => {
    expect(stripProtocolMarkers(`${BODY}\n\n${LINE}\n\n${FOOTER}`)).toBe(
      `${BODY}\n\n${FOOTER}`
    );
    expect(stripProtocolMarkers(`${BODY}\n[[KARTEN: 1]]`)).toBe(BODY);
    expect(stripProtocolMarkers(`${BODY}  \n`)).toBe(`${BODY}  \n`);
    expect(stripProtocolMarkers("[[Link]] und [x]")).toBe("[[Link]] und [x]");
    expect(stripProtocolMarkers(null)).toBe(null);
  });
});

describe("FF2: Pillen-Sicherheitsnetz", () => {
  test("Dubletten normalisiert (Groß/klein, Leerraum, Satzzeichen, Unicode) -> die erste bleibt", () => {
    expect(
      parseFollowUpItems(
        "Gibt es B1-Kurse? | gibt es  b1 kurse ? | GIBT ES B1-KURSE | Gibt es B1‑Kurse? | Auch online?"
      )
    ).toEqual(["Gibt es B1-Kurse?", "Auch online?"]);
    expect(followUpKey(" Gibt es  Yoga am Abend ?! ")).toBe(
      "gibt es yoga am abend"
    );
    expect(followUpKey("ﬁt?")).toBe("fit");
  });

  test("Pille gleich der gerade gestellten Nutzerfrage (normalisiert) wird verworfen", () => {
    const userMessage = "gibt es yogakurse am abend";
    expect(
      parseFollowUpItems("Gibt es Yogakurse am Abend? | Gibt es Pilates?", {
        userMessage,
      })
    ).toEqual(["Gibt es Pilates?"]);
    // ganze Antwort und Stream gleich
    const reply = `${BODY}\n[[FRAGEN: Gibt es Yogakurse am Abend? | Auch samstags?]]\n*KI*`;
    const whole = parseCardsReply(reply, { userMessage });
    expect(whole.followUps).toEqual(["Auch samstags?"]);
    expect(whole.text).toBe(`${BODY}\n*KI*`);
    const filter = new CardsMarkerFilter({ userMessage });
    let text = "";
    for (const t of reply.match(/[\s\S]{1,4}/g)) text += filter.push(t).text;
    const end = filter.push("", { final: true });
    expect(text + end.text).toBe(whole.text);
    expect(end.followUps).toEqual(whole.followUps);
    // ähnliche, aber andere Frage bleibt; ohne Nutzerfrage bleibt alles
    expect(
      parseFollowUpItems("Gibt es Yogakurse am Morgen?", { userMessage })
    ).toEqual(["Gibt es Yogakurse am Morgen?"]);
    expect(parseFollowUpItems("Gibt es Yogakurse am Abend?")).toEqual([
      "Gibt es Yogakurse am Abend?",
    ]);
    expect(
      storedFollowUps(["Gibt es Yogakurse am Abend?", "Weiter?"], {
        userMessage: "Gibt es Yogakurse am Abend?",
      })
    ).toEqual(["Weiter?"]);
  });

  test("leere Pillen (nichts, Leerraum, nur Satzzeichen/Symbole) werden verworfen", () => {
    expect(
      parseFollowUpItems(" | ? | ?! | … | € | 👍 | ** | <b></b> | Echt?")
    ).toEqual(["Echt?"]);
  });

  test("zu lange Pillen: > 80 Zeichen immer verworfen; Grenze bleibt 60 (Prompt und Widget)", () => {
    const of = (n) => `${"a".repeat(n - 1)}?`;
    expect(FOLLOW_UP_MAX_LEN).toBe(60);
    expect(parseFollowUpItems(`${of(81)} | ${of(120)} | Kurz?`)).toEqual([
      "Kurz?",
    ]);
    expect(parseFollowUpItems(`${of(61)} | ${of(80)}`)).toEqual([]);
    expect(parseFollowUpItems(of(60))).toEqual([of(60)]);
  });

  test("Sie-Form-Filter bleibt — auch bei einem Marker mitten im Text", () => {
    const reply = `${BODY}\n[[FRAGEN: Suchen Sie einen Anfängerkurs? | Möchten Sie online lernen? | Gibt es Yoga am Abend?]]\n*KI*`;
    const r = parseCardsReply(reply);
    expect(r.followUps).toEqual(["Gibt es Yoga am Abend?"]);
    expect(r.text).toBe(`${BODY}\n*KI*`);
    expect(
      parseFollowUpItems("Welches Niveau haben Sie? | Would you like more?")
    ).toEqual([]);
  });
});

// L4 (Kontroll-Review rc20): Altdatensätze aus der Zeit vor FF1 – die Zeile
// stand vor dem KI-Hinweis, wurde nicht erkannt und blieb im gespeicherten
// Text; followUps fehlt. Jeder Leser des gespeicherten Texts bereinigt ihn.
describe("L4: Altdatensätze mit Marker beim Lesen", () => {
  const FOOTER = "*Ich bin eine KI und kann Fehler machen.*";
  const OLD_TEXT = `${BODY}\n\n${LINE}\n\n${FOOTER}`;
  const CLEAN_TEXT = `${BODY}\n\n${FOOTER}`;

  test("restoreCardsMarkers (LLM-Verlauf): Marker mitten im Text weg, nicht als Vorbild", () => {
    const rows = [
      // Altdatensatz ohne followUps/courseCardsMarker
      { id: 1, response: JSON.stringify({ text: OLD_TEXT }) },
      // Altdatensatz mit gespeicherten Pillen: Zeile nur einmal, am Ende
      {
        id: 2,
        response: JSON.stringify({ text: OLD_TEXT, followUps: ["Mehr?"] }),
      },
      // Altdatensatz mit Karten-Marker im Text und gespeichertem Marker
      {
        id: 3,
        response: JSON.stringify({
          text: `${BODY}\n[[KARTEN: 1]]`,
          courseCardsMarker: [1],
        }),
      },
    ];
    const before = JSON.stringify(rows);
    const out = restoreCardsMarkers(rows);
    expect(JSON.parse(out[0].response).text).toBe(CLEAN_TEXT);
    expect(JSON.parse(out[1].response).text).toBe(
      `${CLEAN_TEXT}\n[[FRAGEN: Mehr?]]`
    );
    expect(JSON.parse(out[2].response).text).toBe(`[[KARTEN: 1]]\n${BODY}`);
    // Datensätze unverändert, andere Felder bleiben
    expect(JSON.stringify(rows)).toBe(before);
    expect(JSON.parse(out[1].response).followUps).toEqual(["Mehr?"]);
  });

  test("cleanStoredResponse: Antwort-JSON und Klartext ohne Marker, sonst unverändert", () => {
    const old = JSON.stringify({
      text: OLD_TEXT,
      sources: [{ title: "a" }],
      followUps: ["Mehr?"],
    });
    const cleaned = JSON.parse(cleanStoredResponse(old));
    expect(cleaned).toEqual({
      text: CLEAN_TEXT,
      sources: [{ title: "a" }],
      followUps: ["Mehr?"],
    });
    // Klartext-Antwort (sehr alte Zeilen ohne JSON)
    expect(cleanStoredResponse(OLD_TEXT)).toBe(CLEAN_TEXT);
    // ohne Marker: dieselbe Zeichenkette (kein Umbau des JSON)
    const plain = JSON.stringify({ text: BODY, sources: [] });
    expect(cleanStoredResponse(plain)).toBe(plain);
    const link = JSON.stringify({ text: "Siehe [[Link]] und [x]" });
    expect(cleanStoredResponse(link)).toBe(link);
    // kein String / kein Objekt mit Text: unverändert
    expect(cleanStoredResponse(null)).toBe(null);
    expect(cleanStoredResponse(undefined)).toBe(undefined);
    const noText = JSON.stringify({ sources: [], note: "[[FRAGEN: a?]]" });
    expect(cleanStoredResponse(noText)).toBe(noText);
    const arr = JSON.stringify(["[[FRAGEN: a?]]"]);
    expect(cleanStoredResponse(arr)).toBe(arr);
  });
});
