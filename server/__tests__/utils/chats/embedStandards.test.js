/* eslint-env jest, node */
// Design Center vereinfacht (15.10.2026): feste Standards des Embed-Widgets
// (utils/chats/embedStandards.js), reine Funktionen. Die Auslieferung über
// GET /embed/:id/config prüft endpoints/embedConfigEndpoint.test.js, den
// Prompt pro Embed embedStreamCardsMarker/embedStreamFollowUps.test.js.
const {
  COURSE_CARDS_VALUES,
  COURSE_CARDS_POSITIONS,
  WELCOME_BUBBLES_VALUES,
  EMBED_FIXED_STANDARDS,
  INLINE_FIXED_STANDARDS,
  LEGACY_DEFAULT_GREETINGS,
  LEGACY_DEFAULT_PLACEHOLDERS,
  embedDisplayMode,
  storedCourseCards,
  defaultCourseCards,
  courseCardsValue,
  courseCardsPositionValue,
  welcomeBubblesValue,
  effectiveGreeting,
  effectivePlaceholder,
  inlineBarPlaceholder,
  normalizePrivacyText,
  privacyTitleValue,
  applyEmbedStandards,
} = require("../../../utils/chats/embedStandards");
const embedStandards = require("../../../utils/chats/embedStandards");
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

  test("Karten wie Demo-Variante 4: kurzer Text, Zeilenlayout fest; an/aus und Reihenfolge wählbar (KIE-567)", () => {
    expect(EMBED_FIXED_STANDARDS).toMatchObject({
      courseCardsAnswerStyle: "short",
      courseCardsLayout: "rows",
    });
    expect("courseCards" in EMBED_FIXED_STANDARDS).toBe(false);
    expect("courseCardsPosition" in EMBED_FIXED_STANDARDS).toBe(false);
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

// KIE-567 (Nutzer 15.10.2026): Antworten mit Kursen, im Design Center
// wählbar. Ohne gespeicherte Wahl hängt der Standard an der tatsächlichen
// Darstellung (R4, Fixliste 7.22-rc8): Chatfenster Nur Text mit Links, In
// der Seite Kurskarten; die Reihenfolge bleibt „Karten zuerst“.
describe("Kurskarten an/aus und Reihenfolge (KIE-567)", () => {
  test("erlaubte Werte wörtlich wie im Vertrag", () => {
    expect(COURSE_CARDS_VALUES).toEqual(["auto", "off"]);
    expect(COURSE_CARDS_POSITIONS).toEqual(["above", "below"]);
    expect(Object.isFrozen(COURSE_CARDS_VALUES)).toBe(true);
    expect(Object.isFrozen(COURSE_CARDS_POSITIONS)).toBe(true);
  });

  // R4: Standard je Darstellung (Vertrag Fork/Widget wörtlich)
  test("R4: Standard nach der tatsächlichen Darstellung, ungültig oder fehlend = Chatfenster = off", () => {
    expect(defaultCourseCards("inline")).toBe("auto");
    expect(defaultCourseCards(" Inline ")).toBe("auto");
    for (const displayMode of [
      "bubble",
      undefined,
      null,
      "",
      "seite",
      "INLINE-BOX",
      true,
      ["inline"],
    ])
      expect(defaultCourseCards(displayMode)).toBe("off");
  });

  test.each([
    ["auto", "auto"],
    ["off", "off"],
    [" OFF ", "off"],
    ["Auto", "auto"],
    [undefined, null],
    [null, null],
    ["", null],
    ["aus", null],
    ["none", null],
    [false, null],
    [0, null],
    [["off"], null],
  ])("storedCourseCards(%p) -> %p", (input, expected) => {
    expect(storedCourseCards(input)).toBe(expected);
  });

  // R4: gespeicherte Wahl gewinnt in beiden Darstellungen; ohne Wahl der
  // Standard der Darstellung (bewusst geändert: bisher immer "auto")
  test.each([
    ["auto", "bubble", "auto"],
    ["auto", "inline", "auto"],
    ["off", "inline", "off"],
    [" OFF ", "bubble", "off"],
    [undefined, "inline", "auto"],
    [undefined, "bubble", "off"],
    [undefined, undefined, "off"],
    ["kaputt", "inline", "auto"],
    ["kaputt", "bubble", "off"],
    ["", " INLINE ", "auto"],
    [["off"], "kaputt", "off"],
  ])("courseCardsValue(%p, %p) -> %p", (value, displayMode, expected) => {
    expect(courseCardsValue(value, displayMode)).toBe(expected);
  });

  test.each([
    ["above", "above"],
    ["below", "below"],
    [" Below ", "below"],
    [undefined, "above"],
    [null, "above"],
    ["", "above"],
    ["unten", "above"],
    ["left", "above"],
    [true, "above"],
  ])("courseCardsPositionValue(%p) -> %p", (input, expected) => {
    expect(courseCardsPositionValue(input)).toBe(expected);
  });

  test("applyEmbedStandards: gespeicherte Wahl kommt durch, in beiden Darstellungen", () => {
    for (const displayMode of [undefined, "bubble", "inline"]) {
      const out = applyEmbedStandards(
        {},
        { displayMode, courseCards: "off", courseCardsPosition: "below" }
      );
      expect(out.courseCards).toBe("off");
      expect(out.courseCardsPosition).toBe("below");
      // Antwortstil und Layout bleiben fest
      expect(out.courseCardsAnswerStyle).toBe("short");
      expect(out.courseCardsLayout).toBe("rows");
    }
  });

  // R4 (bewusst geändert): ohne gespeicherte Wahl geht courseCards NICHT
  // mit, das Widget entscheidet nach seiner tatsächlichen Darstellung; die
  // Reihenfolge bleibt Karten zuerst
  test("applyEmbedStandards: ohne bzw. mit ungültigen Werten kein courseCards, Reihenfolge Karten zuerst", () => {
    for (const vc of [
      {},
      { displayMode: "inline" },
      { displayMode: "bubble" },
      { courseCards: "kaputt", courseCardsPosition: 5 },
      { courseCards: "", courseCardsPosition: "" },
    ]) {
      const out = applyEmbedStandards({}, vc);
      expect(out).not.toHaveProperty("courseCards");
      expect(out.courseCardsPosition).toBe("above");
    }
  });

  test("Ausgelieferte Werte schlagen Werte aus mapped (Server gewinnt)", () => {
    const out = applyEmbedStandards(
      { courseCards: "off", courseCardsPosition: "below" },
      {}
    );
    // R4: nicht gespeichert -> auch ein Wert aus mapped geht nicht mit
    expect(out).not.toHaveProperty("courseCards");
    expect(out.courseCardsPosition).toBe("above");
    expect(
      applyEmbedStandards({ courseCards: "off" }, { courseCards: "auto" })
        .courseCards
    ).toBe("auto");
  });
});

// KIE-568 (Nutzer 15.10.2026): Willkommensblasen je Gerät. Fehlend oder
// ungültig -> "first" (beim ersten Besuch, wie bisher).
describe("Willkommensblasen je Gerät (KIE-568)", () => {
  test("erlaubte Werte wörtlich wie im Vertrag", () => {
    expect(WELCOME_BUBBLES_VALUES).toEqual(["off", "first", "every"]);
    expect(Object.isFrozen(WELCOME_BUBBLES_VALUES)).toBe(true);
  });

  test.each([
    ["off", "off"],
    ["first", "first"],
    ["every", "every"],
    [" EVERY ", "every"],
    ["Off", "off"],
    [undefined, "first"],
    [null, "first"],
    ["", "first"],
    ["always", "first"],
    ["aus", "first"],
    [false, "first"],
    [1, "first"],
  ])("welcomeBubblesValue(%p) -> %p", (input, expected) => {
    expect(welcomeBubblesValue(input)).toBe(expected);
  });

  test("applyEmbedStandards: beide Schlüssel immer mit gültigem Wert, Geräte unabhängig", () => {
    expect(applyEmbedStandards({}, {})).toMatchObject({
      welcomeBubblesDesktop: "first",
      welcomeBubblesMobile: "first",
    });
    expect(
      applyEmbedStandards(
        {},
        { welcomeBubblesDesktop: "off", welcomeBubblesMobile: "every" }
      )
    ).toMatchObject({
      welcomeBubblesDesktop: "off",
      welcomeBubblesMobile: "every",
    });
    expect(
      applyEmbedStandards(
        {},
        { welcomeBubblesDesktop: "every", welcomeBubblesMobile: "nie" }
      )
    ).toMatchObject({
      welcomeBubblesDesktop: "every",
      welcomeBubblesMobile: "first",
    });
  });

  test("Inline: Schlüssel gehen trotzdem mit (Rückfall auf die Chatblase ohne Platzhalter)", () => {
    expect(
      applyEmbedStandards(
        {},
        { displayMode: "inline", welcomeBubblesDesktop: "off" }
      ).welcomeBubblesDesktop
    ).toBe("off");
  });

  test("Server gewinnt gegen Werte aus mapped", () => {
    const out = applyEmbedStandards(
      { welcomeBubblesDesktop: "every", welcomeBubblesMobile: "off" },
      {}
    );
    expect(out.welcomeBubblesDesktop).toBe("first");
    expect(out.welcomeBubblesMobile).toBe("first");
  });
});

// Datenschutz als Link in der Fußzeile (issues/datenschutz-fusszeile.md,
// Nutzer 23.10.2026, AK-7/AK-10, Vertrag Punkt 6): Der Link „Datenschutz“
// steht immer unter der Eingabe, es gibt keine Auswahl mehr (kein Schalter,
// keine Blase beim Start, kein „Aus“). privacyNotice ist ein fester Standard
// "link"; gespeicherte Altwerte ("bubble", "none", "modal") wirken nicht.
// Bis 7.22.2 schaltete "none" den Hinweis ab (KIE-565 Nachtrag).
describe("Datenschutz-Hinweis immer als Link (privacyNotice)", () => {
  test('fester Standard "link", keine eigene Prüffunktion mehr', () => {
    expect(EMBED_FIXED_STANDARDS.privacyNotice).toBe("link");
    expect(embedStandards).not.toHaveProperty("privacyNoticeValue");
  });

  test.each([
    ["none"],
    [" None "],
    ["bubble"],
    ["BUBBLE"],
    ["modal"],
    ["link"],
    [undefined],
    [null],
    [""],
    ["aus"],
    [false],
    [0],
    [["none"]],
    [{ value: "none" }],
  ])("gespeichert %p -> link", (privacyNotice) => {
    const vc = privacyNotice === undefined ? {} : { privacyNotice };
    expect(applyEmbedStandards({}, vc).privacyNotice).toBe("link");
    expect(
      applyEmbedStandards({}, { ...vc, displayMode: "inline" }).privacyNotice
    ).toBe("link");
  });

  test("ein Wert aus mapped (Erlaubtliste) schlägt den festen Standard nicht", () => {
    for (const value of ["none", "bubble", "modal"])
      expect(
        applyEmbedStandards({ privacyNotice: value }, {}).privacyNotice
      ).toBe("link");
  });

  test("gespeicherte Texte des Hinweises bleiben, auch bei früher ausgeschaltetem Hinweis", () => {
    const out = applyEmbedStandards(
      {},
      {
        privacyNotice: "none",
        privacyTitle: " Hinweis ",
        privacyText: "• Eins",
      }
    );
    expect(out).toMatchObject({
      privacyNotice: "link",
      privacyTitle: "Hinweis",
      privacyText: "• Eins",
    });
  });
});

describe("Begrüßung und Platzhalter", () => {
  test("greetingBubbleText vor greeting, wenn er in der Blase stand, getrimmt; frühere Vorbelegungen = kein Text", () => {
    expect(
      effectiveGreeting({
        greeting: " A ",
        greetingBubbleText: " B ",
        greetingStyle: "bubble",
      })
    ).toBe("B");
    expect(effectiveGreeting({ greetingBubbleText: " B " })).toBe("B");
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

  test("F03 (Review 7.22-rc6): Blasentext nur, wenn er bisher sichtbar war oder keine Begrüßung gesetzt ist", () => {
    // früherer Standard „text“: der nie sichtbare Blasentext verdrängt die
    // sichtbare Begrüßung nicht
    for (const vc of [
      { greeting: "Sichtbar", greetingBubbleText: "Unsichtbar" },
      {
        greeting: "Sichtbar",
        greetingBubbleText: "Unsichtbar",
        greetingStyle: "text",
      },
      {
        greeting: "Sichtbar",
        greetingBubbleText: "Unsichtbar",
        privacyNotice: "modal",
      },
    ])
      expect(effectiveGreeting(vc)).toBe("Sichtbar");
    // Blase (Stil oder Datenschutz in der Blase, Schreibweise egal)
    for (const extra of [
      { greetingStyle: " Bubble " },
      { privacyNotice: "bubble" },
      { greetingStyle: "text", privacyNotice: "BUBBLE" },
    ])
      expect(
        effectiveGreeting({ greeting: "G", greetingBubbleText: "B", ...extra })
      ).toBe("B");
    // keine eigene Begrüßung (leer oder frühere Vorbelegung): Blasentext
    expect(
      effectiveGreeting({
        greeting: LEGACY_DEFAULT_GREETINGS[1],
        greetingBubbleText: "B",
        greetingStyle: "text",
      })
    ).toBe("B");
    expect(
      applyEmbedStandards(
        {},
        { greeting: "Sichtbar", greetingBubbleText: "Unsichtbar" }
      ).greeting
    ).toBe("Sichtbar");
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

  // Nutzerentscheidung 23.10.2026 (7.22.2): Der bisherige Standard
  // „Ihre Frage eingeben“ / „Enter your question“ gilt gespeichert als nicht
  // gesetzt; das Widget zeigt dann den neuen Standard (gleich der Leiste).
  test("23.10.2026: alter Standard gespeichert -> nicht gesetzt (neuer Standard), auch in der Leiste", () => {
    expect(LEGACY_DEFAULT_PLACEHOLDERS).toEqual([
      "Wie kann ich Ihnen helfen?",
      "Ihre Frage eingeben",
      "Enter your question",
    ]);
    expect(Object.isFrozen(LEGACY_DEFAULT_PLACEHOLDERS)).toBe(true);
    for (const sendMessageText of [
      "Ihre Frage eingeben",
      " Ihre Frage eingeben ",
      "Enter your question",
    ]) {
      expect(effectivePlaceholder({ sendMessageText })).toBe(null);
      expect(inlineBarPlaceholder({ sendMessageText })).toBe(null);
      const out = applyEmbedStandards({}, { sendMessageText });
      expect(out).not.toHaveProperty("sendMessageText");
      expect(out).not.toHaveProperty("inlineInputPlaceholder");
    }
    // ähnliche, aber eigene Texte bleiben
    expect(
      effectivePlaceholder({ sendMessageText: "Ihre Frage eingeben!" })
    ).toBe("Ihre Frage eingeben!");
  });

  // Nutzerentscheidung 23.10.2026 (ersetzt D2, 7.22-rc3): eingeklappt und
  // aufgeklappt derselbe Platzhalter
  test("23.10.2026: eigener Platzhalter gilt im Chat und in der eingeklappten Leiste", () => {
    const vc = { sendMessageText: " Ihre Frage an uns " };
    expect(effectivePlaceholder(vc)).toBe("Ihre Frage an uns");
    expect(inlineBarPlaceholder(vc)).toBe("Ihre Frage an uns");
    const out = applyEmbedStandards({}, vc);
    expect(out.sendMessageText).toBe("Ihre Frage an uns");
    expect(out.inlineInputPlaceholder).toBe("Ihre Frage an uns");
    // ohne eigenen Platzhalter: nichts, das Widget nimmt seinen Standard
    expect(inlineBarPlaceholder({})).toBe(null);
    expect(inlineBarPlaceholder({ sendMessageText: "  " })).toBe(null);
    expect(inlineBarPlaceholder({ sendMessageText: 7 })).toBe(null);
    expect(applyEmbedStandards({}, {})).not.toHaveProperty(
      "inlineInputPlaceholder"
    );
    // der neue Standard gespeichert ist ein eigener Text: Fenster und
    // Leiste zeigen ihn (gleich dem Standard des Widgets)
    const { sendMessageText } = embedDefaultTexts("de");
    expect(inlineBarPlaceholder({ sendMessageText })).toBe(sendMessageText);
  });

  test("23.10.2026: früher gespeicherter Leistentext gewinnt für die Leiste", () => {
    const vc = {
      sendMessageText: "Ihre Frage an uns",
      inlineInputPlaceholder: " Was suchen Sie? ",
    };
    expect(inlineBarPlaceholder(vc)).toBe("Was suchen Sie?");
    const out = applyEmbedStandards({}, vc);
    expect(out.sendMessageText).toBe("Ihre Frage an uns");
    expect(out.inlineInputPlaceholder).toBe("Was suchen Sie?");
    // ungültiger Leistentext: es gilt der eigene Platzhalter
    for (const inlineInputPlaceholder of ["  ", "x".repeat(121), 5])
      expect(inlineBarPlaceholder({ ...vc, inlineInputPlaceholder })).toBe(
        "Ihre Frage an uns"
      );
    // Leistentext neben altem Standard als Platzhalter
    expect(
      inlineBarPlaceholder({
        sendMessageText: "Ihre Frage eingeben",
        inlineInputPlaceholder: "Was suchen Sie?",
      })
    ).toBe("Was suchen Sie?");
  });

  test("23.10.2026: eigener Platzhalter über 120 Zeichen -> Leiste mit Standard, Chat mit dem Text", () => {
    const long = "p".repeat(121);
    expect(effectivePlaceholder({ sendMessageText: long })).toBe(long);
    expect(inlineBarPlaceholder({ sendMessageText: long })).toBe(null);
    const out = applyEmbedStandards({}, { sendMessageText: long });
    expect(out.sendMessageText).toBe(long);
    expect(out).not.toHaveProperty("inlineInputPlaceholder");
    // genau 120 Zeichen (nach dem Trimmen) passen noch
    const max = "p".repeat(120);
    expect(inlineBarPlaceholder({ sendMessageText: ` ${max} ` })).toBe(max);
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

  test("F05 (Review 7.22-rc6): 1000 Zeichen gelten auch nach dem Voranstellen von „• “", () => {
    // Altformat: 10 Zeilen, Rohtext 999 Zeichen, mit „• “ 1019 -> ungültig
    const lines = Array(10).fill("x".repeat(99));
    const raw = lines.join("\n");
    expect(raw).toHaveLength(999);
    expect(normalizePrivacyText(raw)).toBe(null);
    expect(applyEmbedStandards({}, { privacyText: raw })).not.toHaveProperty(
      "privacyText"
    );
    // genau 1000 nach der Umwandlung: gültig
    const fits = [...Array(9).fill("x".repeat(97)), "x".repeat(98)].join("\n");
    expect(normalizePrivacyText(fits)).toHaveLength(1000);
    // mit Zeichen (keine Umwandlung): 999 bleiben gültig
    const marked = ["• a", ...Array(9).fill("x".repeat(99))].join("\n");
    expect(marked.length).toBeLessThanOrEqual(1000);
    expect(normalizePrivacyText(marked)).toBe(marked);
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

  // F5 (C1, Fixliste rc1, 7.23): leer gilt wie nicht gesetzt, das Fenster
  // zeigt den Standard; bis 7.22.2 lieferte der Server "" (keine Überschrift
  // in der Blase)
  test("privacyTitleValue: leer = nicht gesetzt (Standard im Fenster), früherer Standard mit Doppelpunkt = Standard", () => {
    expect(privacyTitleValue("")).toBe(undefined);
    expect(privacyTitleValue("   ")).toBe(undefined);
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
    expect(out).not.toHaveProperty("greetingBubbleText");
  });

  test("C01: setzt nur abgeleitete und feste Werte, was ans Widget geht bestimmt die Erlaubtliste des Endpunkts", () => {
    const out = applyEmbedStandards({ buttonColor: "#123456" }, {});
    // R4: courseCards nur, wenn gespeichert
    expect(out).toEqual({
      buttonColor: "#123456",
      ...EMBED_FIXED_STANDARDS,
      ...INLINE_FIXED_STANDARDS,
      courseCardsPosition: "above",
      welcomeBubblesDesktop: "first",
      welcomeBubblesMobile: "first",
    });
  });

  test("F08 (Review 7.22-rc6): Begrüßung nur als greeting, ungekürzt; das Widget kürzt und lässt kein Script-Attribut gewinnen", () => {
    const long = Array(80).fill("Wort").join(" ");
    const out = applyEmbedStandards({}, { greeting: long });
    expect(out.greeting).toBe(long);
    expect(out).not.toHaveProperty("greetingBubbleText");
    const bubble = applyEmbedStandards(
      {},
      { greetingBubbleText: "Blase", greetingStyle: "bubble" }
    );
    expect(bubble.greeting).toBe("Blase");
    expect(bubble).not.toHaveProperty("greetingBubbleText");
  });

  test("kein Gedankenstrich in festen Werten", () => {
    const out = applyEmbedStandards({}, { displayMode: "inline" });
    expect(JSON.stringify(out)).not.toMatch(/[–—]/);
  });
});

// Review 7.22-rc6 F12 (AK-7): Migrationstabelle „alter Wert -> neues
// Verhalten“ für den Flotten-Rollout. Jeder feste oder wählbare Schlüssel
// steht darin, damit ein neuer fester Standard nicht ohne Eintrag bleibt.
describe("Migrationstabelle docs/design-center-2-migration.md", () => {
  test("nennt jeden festen und wählbaren Schlüssel", () => {
    const fs = require("fs");
    const path = require("path");
    const doc = fs.readFileSync(
      path.join(__dirname, "../../../../docs/design-center-2-migration.md"),
      "utf8"
    );
    for (const key of [
      ...Object.keys(EMBED_FIXED_STANDARDS),
      ...Object.keys(INLINE_FIXED_STANDARDS),
      "privacyNotice",
      "privacyText",
      "privacyTitle",
      "courseCards",
      "courseCardsPosition",
      "welcomeBubblesDesktop",
      "welcomeBubblesMobile",
      "userTextColor",
      "greetingBubbleText",
      "inlineTheme",
      "inlineSendText",
      "inlineCollapsedText",
      "disclaimerText",
      "windowWidth",
      "offsetX",
      "inlineMaxWidth",
      "data-bubble-persistence",
      "chatbotBubblesMessages",
    ])
      expect(doc).toContain(`\`${key}\``);
    expect(doc).not.toMatch(/\s[–—]\s/);
  });

  // Datenschutz-Fußzeile (Nutzer 23.10.2026, 7.23): Abschnitt
  // „Datenschutz-Hinweis“ beschreibt den festen Link, das Fenster und die
  // Altwerte ohne Wirkung; der Schalter steht nur noch als früherer Stand
  test("Datenschutz-Hinweis: Link immer, Fenster, Altwerte ohne Wirkung", () => {
    const fs = require("fs");
    const path = require("path");
    const doc = fs.readFileSync(
      path.join(__dirname, "../../../../docs/design-center-2-migration.md"),
      "utf8"
    );
    const start = doc.indexOf("## Datenschutz-Hinweis");
    expect(start).toBeGreaterThan(0);
    const section = doc
      .slice(start, doc.indexOf("\n## ", start + 1))
      .replace(/\s+/g, " ");
    for (const text of [
      "„Unsere KI kann Fehler machen · Datenschutz“",
      "„Our AI can make mistakes · Privacy“",
      '`privacyNotice: "link"`',
      "„Hinweis zur KI“",
      embedDefaultTexts("de").privacyAiText,
      "„Schließen“",
      "kein Schalter im Design Center, keine Blase beim Start, kein „Aus“",
      "Keine Migration",
    ])
      expect(section).toContain(text);
    const rows = section.split("| `privacyNotice` |");
    // drei Zeilen: bubble/modal/fehlt, none, Skript-Attribut
    expect(rows).toHaveLength(4);
    expect(rows[2]).toMatch(/^ `none` .*ab 7\.23 ohne Wirkung/);
    expect(section).not.toMatch(/[–—]/);
  });
});

// E43 (Nutzerentscheidung 22.10.2026, „Alte Vorlage als nicht gesetzt“,
// 7.22-rc24): Unsere früheren Datenschutz-Vorlagen in der gespeicherten
// Begrüßung (greeting, greetingBubbleText) gelten wie nicht gesetzt, damit
// der Hinweis nicht doppelt steht (Begrüßung und Datenschutz-Blase).
// Erlaubnisliste exakter Texte, verglichen nach Normalisierung von
// Leerraum; keine Stichwortsuche. Erhebung der Flotte:
// issues/rollout-722/datenschutz-vorlagen.md.
describe("E43: alte Datenschutz-Vorlagen in der Begrüßung", () => {
  const {
    LEGACY_PRIVACY_GREETINGS,
    isLegacyGreeting,
  } = require("../../../utils/chats/embedStandards");
  const fs = require("fs");
  const path = require("path");
  // Juni-Rollout (Kundendaten/Chatbot/prompt_rollout/rollout_greeting.py)
  const JUNE =
    "Dieser Chatbot nutzt künstliche Intelligenz (KI). Ihre Nachrichten werden nicht an Dritte weitergegeben, können aber zur Qualitätssicherung von uns eingesehen werden. Bitte geben Sie keine sensiblen personenbezogenen Daten ein.";
  // früherer Standard-Datenschutztext (vor E30) als ein Absatz (demo-inline)
  const PRE_E30 =
    "Ihre Anfragen bleiben auf Servern in Deutschland und werden nicht an Dritte weitergegeben. Mitarbeitende der Einrichtung können Gespräche zur Qualitätssicherung einsehen. Bitte teilen Sie nur Angaben, die für Ihre Anfrage nötig sind.";
  const OLD_BUBBLE =
    "Hallo! Ich bin Ihr digitaler Berater mit künstlicher Intelligenz (KI). Beschreiben Sie einfach, was Sie suchen.";
  const PRIVACY_TEXT_PRE_E30 = PRE_E30.replace(/\. /g, ".\n");

  // Leerraum-Varianten eines Textes: Umbrüche, Tabs, doppelte und
  // geschützte Leerzeichen, Rand
  const whitespaceVariants = (text) => [
    text.replace(/([.!?]) /g, "$1\n"),
    text.replace(/([.!?]) /g, "$1\r\n\r\n"),
    text.replace(/ /g, "  "),
    text.replace(/ (?=\S)/, "\t"),
    text.replace(/ /g, "\u00A0"),
    `\n  ${text.replace(/([.!?]) /g, "$1 \n ")}  \n`,
  ];

  test("Erlaubnisliste: genau die zwei erkannten Vorlagen, eingefroren", () => {
    expect(LEGACY_PRIVACY_GREETINGS).toEqual([JUNE, PRE_E30]);
    expect(Object.isFrozen(LEGACY_PRIVACY_GREETINGS)).toBe(true);
    for (const text of LEGACY_PRIVACY_GREETINGS) {
      expect(text).toBe(text.trim());
      expect(text).not.toMatch(/\s{2}|[\t\n\r\u00A0]/);
    }
  });

  test("jede Vorlage in greeting oder greetingBubbleText ergibt den Standard (null), mit und ohne Datenschutz-Blase", () => {
    for (const text of LEGACY_PRIVACY_GREETINGS)
      for (const extra of [
        {},
        { privacyNotice: "bubble" },
        { greetingStyle: "bubble" },
        { greetingStyle: "text" },
        { privacyNotice: "none" },
      ]) {
        expect(isLegacyGreeting(text)).toBe(true);
        expect(effectiveGreeting({ greeting: text, ...extra })).toBe(null);
        expect(effectiveGreeting({ greetingBubbleText: text, ...extra })).toBe(
          null
        );
        expect(
          effectiveGreeting({
            greeting: text,
            greetingBubbleText: OLD_BUBBLE,
            ...extra,
          })
        ).toBe(null);
        const out = applyEmbedStandards({}, { greeting: text, ...extra });
        expect(out).not.toHaveProperty("greeting");
        expect(out).not.toHaveProperty("greetingBubbleText");
        expect(out).toEqual(applyEmbedStandards({}, extra));
      }
  });

  test("Leerraum-Varianten der Vorlagen gelten ebenso als nicht gesetzt (auch die übrigen früheren Vorbelegungen)", () => {
    for (const text of [
      ...LEGACY_PRIVACY_GREETINGS,
      ...LEGACY_DEFAULT_GREETINGS,
    ])
      for (const variant of whitespaceVariants(text)) {
        expect(variant).not.toBe(text);
        expect(isLegacyGreeting(variant)).toBe(true);
        expect(effectiveGreeting({ greeting: variant })).toBe(null);
        expect(
          effectiveGreeting({
            greetingBubbleText: variant,
            privacyNotice: "bubble",
          })
        ).toBe(null);
      }
  });

  test("Demo-Fall: Datenschutztext als Begrüßung, alter Blasentext, früher Datenschutz-Blase an: Standard-Begrüßung, das Datenschutz-Fenster behält den gespeicherten Datenschutztext", () => {
    const stored = {
      displayMode: "inline",
      privacyNotice: "bubble",
      privacyText: PRIVACY_TEXT_PRE_E30,
      greeting: PRE_E30,
      greetingBubbleText: OLD_BUBBLE,
    };
    const out = applyEmbedStandards({}, stored);
    expect(out).not.toHaveProperty("greeting");
    expect(out).not.toHaveProperty("greetingBubbleText");
    // Datenschutz-Fußzeile (23.10.2026): gespeichert "bubble", geliefert
    // der feste Link
    expect(out.privacyNotice).toBe("link");
    expect(out.privacyText).toBe(
      PRE_E30.split(". ")
        .map((s, i, all) => `• ${s}${i < all.length - 1 ? "." : ""}`)
        .join("\n")
    );
    // gleich wie ohne gespeicherte Begrüßung
    const { greeting, greetingBubbleText, ...rest } = stored;
    expect(out).toEqual(applyEmbedStandards({}, rest));
  });

  test("eigene Texte bleiben: abgewandelte Vorlage, Vorlage mit eigenem Satz, Teil der Vorlage, Kundentext mit Datenschutzsatz, aktueller Standard", () => {
    const { greeting: standardDe, privacyText: privacyDe } =
      embedDefaultTexts("de");
    const { greeting: standardEn, privacyText: privacyEn } =
      embedDefaultTexts("en");
    const own = [
      // Kunde hat die Vorlage umgestellt und ergänzt
      "Dieser Chatbot nutzt künstliche Intelligenz (KI). Bitte geben Sie keine vertraulichen oder sensiblen personenbezogenen Daten ein. Ihre Nachrichten werden nicht an Dritte weitergegeben, können aber zur Qualitätssicherung anonymisiert von uns eingesehen werden.",
      `${JUNE} Willkommen bei der VHS!`,
      `Willkommen! ${JUNE}`,
      JUNE.replace("von uns", "von der VHS"),
      JUNE.slice(0, JUNE.indexOf(" Bitte")),
      JUNE.replace(/\.$/, ""),
      JUNE.replace("(KI)", "( KI )"),
      PRE_E30.replace("Mitarbeitende", "Mitarbeiter"),
      privacyDe.replace(/^• /gm, "").replace(/\n/g, " "),
      privacyEn.replace(/^• /gm, "").replace(/\n/g, " "),
      "Willkommen! Mit dem Absenden Ihrer Nachricht stimmen Sie unserer Datenschutzerklärung zu.",
      standardDe,
      standardEn,
    ];
    for (const text of own) {
      expect(isLegacyGreeting(text)).toBe(false);
      expect(effectiveGreeting({ greeting: text })).toBe(text);
      expect(
        effectiveGreeting({ greetingBubbleText: text, privacyNotice: "bubble" })
      ).toBe(text);
      expect(applyEmbedStandards({}, { greeting: text }).greeting).toBe(text);
    }
    // eigener Text gewinnt gegen eine Vorlage im anderen Feld; eigener
    // Leerraum innerhalb bleibt erhalten (nur der Rand wird getrimmt)
    expect(
      effectiveGreeting({
        greeting: " Eigene  Begrüßung\nZeile zwei ",
        greetingBubbleText: JUNE.replace(/\. /g, ".\n"),
        privacyNotice: "bubble",
      })
    ).toBe("Eigene  Begrüßung\nZeile zwei");
    expect(
      effectiveGreeting({
        greeting: PRE_E30.replace(/ /g, "  "),
        greetingBubbleText: "Eigene Blase",
        greetingStyle: "text",
      })
    ).toBe("Eigene Blase");
    for (const value of [undefined, null, 5, ["x"], {}, "", "   "])
      expect(isLegacyGreeting(value)).toBe(false);
  });

  test("Migrationsdoku: Abschnitt E43 mit beiden Vorlagen", () => {
    const doc = fs.readFileSync(
      path.join(__dirname, "../../../../docs/design-center-2-migration.md"),
      "utf8"
    );
    const start = doc.indexOf(
      "## Alte Datenschutz-Vorlagen in der Begrüßung (E43"
    );
    expect(start).toBeGreaterThan(0);
    const section = doc.slice(start, doc.indexOf("\n## ", start + 1));
    for (const text of LEGACY_PRIVACY_GREETINGS)
      expect(section).toContain(text);
    expect(section).not.toMatch(/[–—]/);
    // Prüfpunkt 13: Kundentexte mit eigenem Datenschutzinhalt nur melden
    expect(doc).toMatch(/^13\. /m);
    const point = doc.slice(doc.search(/^13\. /m), doc.search(/^14\. /m));
    expect(point).toMatch(/\(E43, 7\.22-rc24\)/);
    expect(point).toMatch(/`LEGACY_PRIVACY_GREETINGS`/);
    expect(point).toMatch(/Gespeicherte Texte der Kunden nicht ändern/);
    // Bewusste Änderung (Datenschutz-Fußzeile 7.23): kein Abschalten mehr
    expect(point).not.toMatch(/schaltet den Datenschutz-Hinweis ab/);
    // Prüfpunkt 14 (Datenschutz-Fußzeile, 7.23) ist der letzte (Prüfungen
    // in designCenterFixesRc17/Rc22 angehoben)
    const last = doc.slice(doc.search(/^14\. /m));
    expect(last).toMatch(/Datenschutz als Link in der Fußzeile \(7\.23/);
    expect(last).toMatch(/Nichts zu migrieren/);
    expect(last).toMatch(/`privacyUrl`/);
    expect(doc).not.toMatch(/^15\. /m);
  });
});
