/* eslint-env jest, node */
// Design Center vereinfacht (15.10.2026): feste Standards des Embed-Widgets
// (utils/chats/embedStandards.js), reine Funktionen. Die Auslieferung über
// GET /embed/:id/config prüft endpoints/embedConfigEndpoint.test.js, den
// Prompt pro Embed embedStreamCardsMarker/embedStreamFollowUps.test.js.
const {
  BUBBLE_COURSE_CARDS,
  EMBED_FIXED_STANDARDS,
  INLINE_FIXED_STANDARDS,
  embedDisplayMode,
  courseCardsForDisplayMode,
  effectiveGreeting,
  effectivePlaceholder,
  inlineBarPlaceholder,
  greetingBubbleText,
  normalizePrivacyText,
  privacyTitleValue,
  applyEmbedStandards,
} = require("../../../utils/chats/embedStandards");
const { embedDefaultTexts } = require("../../../utils/chats/embedDefaults");

describe("Darstellung und Kurskarten", () => {
  test.each([
    ["inline", "inline"],
    [" Inline ", "inline"],
    ["bubble", "bubble"],
    [undefined, "bubble"],
    [null, "bubble"],
    ["", "bubble"],
    ["inline-box", "bubble"],
    [true, "bubble"],
  ])("embedDisplayMode(%p) -> %p", (input, expected) => {
    expect(embedDisplayMode(input)).toBe(expected);
  });

  test("D1: Karten in beiden Darstellungen an, auch ohne gespeicherte Darstellung (Browser-Abnahme rc2)", () => {
    expect(BUBBLE_COURSE_CARDS).toBe("auto");
    for (const mode of ["inline", "bubble", undefined, null, "", "kaputt"])
      expect(courseCardsForDisplayMode(mode)).toBe("auto");
  });

  test("Karten wie Demo-Variante 4: zuerst die Karten, dann der kurze Text, Zeilenlayout", () => {
    expect(EMBED_FIXED_STANDARDS).toMatchObject({
      courseCardsPosition: "above",
      courseCardsAnswerStyle: "short",
      courseCardsLayout: "rows",
    });
  });

  test("Inline wie die Demo-Seite (app.js loadWidgetScript)", () => {
    expect(INLINE_FIXED_STANDARDS).toEqual({
      inlineInput: true,
      inlineOpenOn: "focus",
      inlineEffect: "morph",
      inlineLayout: "overlay",
      inlineStartState: "collapsed",
      inlineHeight: "520px",
      inheritFont: true,
    });
  });

  test("Standards unveränderlich", () => {
    expect(Object.isFrozen(EMBED_FIXED_STANDARDS)).toBe(true);
    expect(Object.isFrozen(INLINE_FIXED_STANDARDS)).toBe(true);
  });
});

describe("Begrüßung und Platzhalter", () => {
  test("greetingBubbleText vor greeting, getrimmt; frühere Vorbelegungen = kein Text", () => {
    expect(
      effectiveGreeting({ greeting: " A ", greetingBubbleText: " B " })
    ).toBe("B");
    expect(effectiveGreeting({ greeting: "A", greetingBubbleText: "" })).toBe(
      "A"
    );
    expect(
      effectiveGreeting({
        greeting:
          "Hallo und herzlich willkommen! Ich helfe Ihnen gerne weiter und beantworte Ihre Fragen mit intelligenten, KI-gestützten Antworten.",
      })
    ).toBe(null);
    expect(effectiveGreeting({})).toBe(null);
    expect(effectiveGreeting(undefined)).toBe(null);
    expect(effectiveGreeting({ greeting: ["A"] })).toBe(null);
  });

  test("der neue Standardtext ist ein eigener Text (wird nicht als Vorbelegung verworfen)", () => {
    const { greeting, sendMessageText } = embedDefaultTexts("de");
    expect(effectiveGreeting({ greeting })).toBe(greeting);
    expect(effectivePlaceholder({ sendMessageText })).toBe(sendMessageText);
  });

  test("Platzhalter: frühere Vorbelegung und leer -> null", () => {
    expect(effectivePlaceholder({ sendMessageText: " Frage? " })).toBe(
      "Frage?"
    );
    expect(
      effectivePlaceholder({ sendMessageText: "Wie kann ich Ihnen helfen?" })
    ).toBe(null);
    expect(effectivePlaceholder({ sendMessageText: "" })).toBe(null);
  });

  test("D2: Platzhalter des Chat-Eingabefelds gilt nicht für die Inline-Leiste", () => {
    expect(inlineBarPlaceholder({ sendMessageText: "Ihre Frage an uns" })).toBe(
      null
    );
    expect(inlineBarPlaceholder({})).toBe(null);
  });

  test("F04: früher eigens gespeicherter Leistentext bleibt wirksam (getrimmt, höchstens 120 Zeichen)", () => {
    expect(
      inlineBarPlaceholder({ inlineInputPlaceholder: " Was suchen Sie? " })
    ).toBe("Was suchen Sie?");
    expect(inlineBarPlaceholder({ inlineInputPlaceholder: "  " })).toBe(null);
    expect(inlineBarPlaceholder({ inlineInputPlaceholder: 5 })).toBe(null);
    expect(
      inlineBarPlaceholder({ inlineInputPlaceholder: "x".repeat(120) })
    ).toHaveLength(120);
    expect(
      inlineBarPlaceholder({ inlineInputPlaceholder: "x".repeat(121) })
    ).toBe(null);
  });

  test("F07: Text der Begrüßungsblase höchstens 300 Zeichen, lange Begrüßung auf ein Wortende gekürzt", () => {
    expect(greetingBubbleText("Hallo!")).toBe("Hallo!");
    const exact = "y".repeat(300);
    expect(greetingBubbleText(exact)).toBe(exact);
    const words = Array(80).fill("Wort").join(" ");
    const short = greetingBubbleText(words);
    expect(short.length).toBeLessThanOrEqual(300);
    expect(short).toMatch(/ Wort…$/);
    expect(words.startsWith(short.slice(0, -1))).toBe(true);
    // ein langes Wort: hart gekürzt, nie über 300
    expect(greetingBubbleText("x".repeat(400))).toBe(`${"x".repeat(299)}…`);
    // Satzzeichen vor dem „…“ fallen weg, kein halbes Emoji am Ende
    const comma = `${"a".repeat(250)}, ${"b".repeat(60)}`;
    expect(greetingBubbleText(comma)).toBe(`${"a".repeat(250)}…`);
    const emoji = `${"c".repeat(298)}😀${"d".repeat(10)}`;
    expect(greetingBubbleText(emoji)).toBe(`${"c".repeat(298)}…`);
  });
});

describe("Datenschutz-Text", () => {
  test("Standardtext (freies Format) bleibt unverändert", () => {
    for (const lang of ["de", "en"]) {
      const { privacyText } = embedDefaultTexts(lang);
      expect(normalizePrivacyText(privacyText)).toBe(privacyText);
    }
  });

  test("Altformat mit mehreren Teilen (Zeilen bzw. „|“) kommt als „• “-Zeilen, ein einzelner Satz bleibt Absatz", () => {
    const { privacyText } = embedDefaultTexts("de");
    const legacy = privacyText.replace(/^• /gm, "");
    expect(legacy).not.toMatch(/•/);
    expect(normalizePrivacyText(legacy)).toBe(privacyText);
    expect(normalizePrivacyText(" a | b \n\n c ")).toBe("• a\n• b\n• c");
    expect(normalizePrivacyText("Ein einzelner Satz.")).toBe(
      "Ein einzelner Satz."
    );
  });

  test("F08: zweimal normalisiert bleibt gleich, ein Teil mit „-“ behält Zeichen und Bedeutung", () => {
    const once = normalizePrivacyText("Kosten | -10 % Rabatt");
    expect(once).toBe("• Kosten\n• -10 % Rabatt");
    expect(normalizePrivacyText(once)).toBe(once);
    for (const v of [
      "a\nb",
      "Fragen: datenschutz@vhs.de | Tel. 0591 123",
      "• a\nAbsatz",
      "Ein Satz",
    ]) {
      const first = normalizePrivacyText(v);
      expect(normalizePrivacyText(first)).toBe(first);
    }
  });

  test("freies Format: Zeichen bleiben stehen, „|“ trennt nicht, leere Zeilen fallen weg", () => {
    expect(
      normalizePrivacyText("Absatz eins\n\n-Punkt\n– Strich\nAbsatz | zwei")
    ).toBe("Absatz eins\n-Punkt\n– Strich\nAbsatz | zwei");
    // nur Zeichen ohne Text: gültig wie im Widget (es zeigt dann nichts davon)
    expect(normalizePrivacyText("-\n•")).toBe("-\n•");
  });

  test("Grenzen wie im Widget: 12 Zeilen mit je 500 Zeichen, 1000 Zeichen gesamt", () => {
    const twelve = ["• a", ...Array(11).fill("b")].join("\n");
    expect(normalizePrivacyText(twelve)).toBe(twelve);
    expect(normalizePrivacyText(`${twelve}\nc`)).toBe(null);
    expect(normalizePrivacyText(`• ${"x".repeat(498)}`)).toHaveLength(500);
    expect(normalizePrivacyText(`• ${"x".repeat(499)}`)).toBe(null);
    expect(normalizePrivacyText("1|2|3|4|5|6")).toBe(
      "• 1\n• 2\n• 3\n• 4\n• 5\n• 6"
    );
  });

  test("ungültig -> null (weglassen, nicht kürzen)", () => {
    for (const v of [null, 5, "", "   ", "x".repeat(1001)])
      expect(normalizePrivacyText(v)).toBe(null);
  });

  test("privacyTitleValue: leer bleibt leer (keine Überschrift), früherer Standard mit Doppelpunkt = Standard", () => {
    expect(privacyTitleValue("")).toBe("");
    expect(privacyTitleValue("Datenschutz:")).toBe(undefined);
    expect(privacyTitleValue(" Privacy: ")).toBe(undefined);
    expect(privacyTitleValue(" Datenschutz ")).toBe("Datenschutz");
    expect(privacyTitleValue(undefined)).toBe(undefined);
    expect(privacyTitleValue("t".repeat(121))).toBe(undefined);
  });
});

describe("applyEmbedStandards", () => {
  test("verändert die Eingabe nicht", () => {
    const mapped = { theme: "dark" };
    const vc = { greeting: "Hallo" };
    const out = applyEmbedStandards(mapped, vc);
    expect(mapped).toEqual({ theme: "dark" });
    expect(vc).toEqual({ greeting: "Hallo" });
    expect(out.theme).toBe("dark");
    expect(out.greeting).toBe("Hallo");
    expect(out.greetingBubbleText).toBe("Hallo");
  });

  test("C01: setzt nur abgeleitete und feste Werte, was ans Widget geht bestimmt die Erlaubtliste des Endpunkts", () => {
    const out = applyEmbedStandards({ buttonColor: "#123456" }, {});
    expect(out).toEqual({
      buttonColor: "#123456",
      ...EMBED_FIXED_STANDARDS,
      ...INLINE_FIXED_STANDARDS,
      courseCards: "auto",
    });
  });

  test("F07: lange Begrüßung kommt gekürzt auch als greetingBubbleText (sonst gewänne das Script-Attribut)", () => {
    const long = Array(80).fill("Wort").join(" ");
    const out = applyEmbedStandards({}, { greeting: long });
    expect(out.greeting).toBe(long);
    expect(out.greetingBubbleText).toBe(greetingBubbleText(long));
    expect(out.greetingBubbleText.length).toBeLessThanOrEqual(300);
  });

  test("kein Gedankenstrich in festen Werten", () => {
    const out = applyEmbedStandards({}, { displayMode: "inline" });
    expect(JSON.stringify(out)).not.toMatch(/[–—]/);
  });
});
