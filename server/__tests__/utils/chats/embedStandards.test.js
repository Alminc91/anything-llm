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
  embedDisplayMode,
  courseCardsValue,
  courseCardsPositionValue,
  welcomeBubblesValue,
  effectiveGreeting,
  effectivePlaceholder,
  inlineBarPlaceholder,
  normalizePrivacyText,
  privacyTitleValue,
  privacyNoticeValue,
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
// wählbar. Fehlend oder ungültig -> Standard (Karten zuerst), damit
// bestehende Widgets ohne neue Schlüssel bleiben, wie sie sind.
describe("Kurskarten an/aus und Reihenfolge (KIE-567)", () => {
  test("erlaubte Werte wörtlich wie im Vertrag", () => {
    expect(COURSE_CARDS_VALUES).toEqual(["auto", "off"]);
    expect(COURSE_CARDS_POSITIONS).toEqual(["above", "below"]);
    expect(Object.isFrozen(COURSE_CARDS_VALUES)).toBe(true);
    expect(Object.isFrozen(COURSE_CARDS_POSITIONS)).toBe(true);
  });

  test.each([
    ["auto", "auto"],
    ["off", "off"],
    [" OFF ", "off"],
    ["Auto", "auto"],
    [undefined, "auto"],
    [null, "auto"],
    ["", "auto"],
    ["aus", "auto"],
    ["none", "auto"],
    [false, "auto"],
    [0, "auto"],
    [["off"], "auto"],
  ])("courseCardsValue(%p) -> %p", (input, expected) => {
    expect(courseCardsValue(input)).toBe(expected);
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

  test("applyEmbedStandards: ohne bzw. mit ungültigen Werten Karten zuerst (wie vorher)", () => {
    for (const vc of [
      {},
      { courseCards: "kaputt", courseCardsPosition: 5 },
      { courseCards: "", courseCardsPosition: "" },
    ]) {
      const out = applyEmbedStandards({}, vc);
      expect(out.courseCards).toBe("auto");
      expect(out.courseCardsPosition).toBe("above");
    }
  });

  test("Ausgelieferte Werte schlagen Werte aus mapped (Server gewinnt)", () => {
    const out = applyEmbedStandards(
      { courseCards: "off", courseCardsPosition: "below" },
      {}
    );
    expect(out.courseCards).toBe("auto");
    expect(out.courseCardsPosition).toBe("above");
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

// KIE-565 Nachtrag (Nutzer 15.10.2026): Datenschutz-Hinweis abschaltbar
describe("Datenschutz-Hinweis an/aus (privacyNotice)", () => {
  test("nicht mehr unter den festen Standards", () => {
    expect("privacyNotice" in EMBED_FIXED_STANDARDS).toBe(false);
  });

  test.each([
    ["none", "none"],
    [" None ", "none"],
    ["bubble", "bubble"],
    ["modal", "bubble"],
    [undefined, "bubble"],
    [null, "bubble"],
    ["", "bubble"],
    ["aus", "bubble"],
    [false, "bubble"],
  ])("privacyNoticeValue(%p) -> %p", (input, expected) => {
    expect(privacyNoticeValue(input)).toBe(expected);
  });

  test("applyEmbedStandards: none bleibt none, Altwert modal wird bubble, fehlend bubble", () => {
    expect(
      applyEmbedStandards({}, { privacyNotice: "none" }).privacyNotice
    ).toBe("none");
    expect(
      applyEmbedStandards({}, { privacyNotice: "modal" }).privacyNotice
    ).toBe("bubble");
    expect(applyEmbedStandards({}, {}).privacyNotice).toBe("bubble");
    // ein durchgereichter Wert aus mapped kann den gespeicherten nicht schlagen
    expect(
      applyEmbedStandards({ privacyNotice: "none" }, {}).privacyNotice
    ).toBe("bubble");
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
    expect(out).not.toHaveProperty("greetingBubbleText");
  });

  test("C01: setzt nur abgeleitete und feste Werte, was ans Widget geht bestimmt die Erlaubtliste des Endpunkts", () => {
    const out = applyEmbedStandards({ buttonColor: "#123456" }, {});
    expect(out).toEqual({
      buttonColor: "#123456",
      ...EMBED_FIXED_STANDARDS,
      ...INLINE_FIXED_STANDARDS,
      privacyNotice: "bubble",
      courseCards: "auto",
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
});
