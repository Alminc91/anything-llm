/* eslint-env jest, node */
// Design Center vereinfacht (15.10.2026): feste Standards des Embed-Widgets
// (utils/chats/embedStandards.js), reine Funktionen. Die Auslieferung über
// GET /embed/:id/config prüft endpoints/embedConfigEndpoint.test.js, den
// Prompt pro Embed embedStreamCardsMarker/embedStreamFollowUps.test.js.
const {
  BUBBLE_COURSE_CARDS,
  EMBED_FIXED_STANDARDS,
  INLINE_FIXED_STANDARDS,
  EMBED_IGNORED_KEYS,
  embedDisplayMode,
  courseCardsForDisplayMode,
  effectiveGreeting,
  effectivePlaceholder,
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

  test("Inline Karten an; Chatblase aus, bis die Browser-Abnahme sie freigibt", () => {
    expect(BUBBLE_COURSE_CARDS).toBe("off");
    expect(courseCardsForDisplayMode("inline")).toBe("auto");
    expect(courseCardsForDisplayMode("bubble")).toBe("off");
    expect(courseCardsForDisplayMode(undefined)).toBe("off");
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
    expect(Object.isFrozen(EMBED_IGNORED_KEYS)).toBe(true);
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
});

describe("Datenschutz-Text", () => {
  test("Standardtext (freies Format) bleibt unverändert", () => {
    for (const lang of ["de", "en"]) {
      const { privacyText } = embedDefaultTexts(lang);
      expect(normalizePrivacyText(privacyText)).toBe(privacyText);
    }
  });

  test("Altformat bleibt Altformat (Zeilen bzw. „|“), das Widget zeigt mehrere Zeilen als Punkte", () => {
    const { privacyText } = embedDefaultTexts("de");
    const legacy = privacyText.replace(/^• /gm, "");
    expect(legacy).not.toMatch(/•/);
    expect(normalizePrivacyText(legacy)).toBe(legacy);
    expect(normalizePrivacyText(" a | b \n\n c ")).toBe("a\nb\nc");
    expect(normalizePrivacyText("Ein einzelner Satz.")).toBe(
      "Ein einzelner Satz."
    );
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
    expect(normalizePrivacyText("1|2|3|4|5|6")).toBe("1\n2\n3\n4\n5\n6");
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
    const mapped = { windowWidth: "420px", theme: "dark" };
    const vc = { greeting: "Hallo" };
    const out = applyEmbedStandards(mapped, vc);
    expect(mapped).toEqual({ windowWidth: "420px", theme: "dark" });
    expect(vc).toEqual({ greeting: "Hallo" });
    expect(out).not.toHaveProperty("windowWidth");
    expect(out.theme).toBe("dark");
    expect(out.greeting).toBe("Hallo");
  });

  test("entfallene Schlüssel fehlen immer, auch wenn sie im Eingang stehen", () => {
    const mapped = Object.fromEntries(EMBED_IGNORED_KEYS.map((k) => [k, "x"]));
    const out = applyEmbedStandards(mapped, {});
    for (const key of EMBED_IGNORED_KEYS) expect(out).not.toHaveProperty(key);
  });

  test("kein Gedankenstrich in festen Werten", () => {
    const out = applyEmbedStandards({}, { displayMode: "inline" });
    expect(JSON.stringify(out)).not.toMatch(/[–—]/);
  });
});
