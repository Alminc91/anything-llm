/* eslint-env jest, node */
// Design Center: Standardtexte des Widgets (embedDefaults.js) und die
// Prompt-Abschnitte des Karten-Modus. Die Standardtexte müssen wörtlich den
// Widget-Werten (PANEL_TEXTS im Embed-Repo) entsprechen — Vergleich gegen
// eine Kopie (fixtures/embedPanelTexts.json, mit Stand-Kommentar).
const {
  EMBED_DEFAULT_TEXTS,
  embedDefaultsLanguage,
  embedDefaultTexts,
  COURSE_CARDS_PROMPT_NOTE,
  COURSE_CARDS_LONG_PROMPT_NOTE,
  COURSE_CARDS_SECTION_HEADING,
  courseCardsPromptNote,
  promptHasCourseCardsSection,
} = require("../../../utils/chats/embedDefaults");
const {
  DISCLAIMER_PROMPT_NOTE,
  FOLLOW_UPS_PROMPT_NOTE,
} = require("../../../utils/chats/embedCourseSources");
const PANEL_TEXTS = require("./fixtures/embedPanelTexts.json");

describe("Standardtexte = Widget-PANEL_TEXTS", () => {
  test.each(["de", "en"])("%s wörtlich wie im Widget", (lang) => {
    const widget = PANEL_TEXTS[lang];
    expect(embedDefaultTexts(lang)).toEqual({
      greetingBubbleText: widget.greetingBubble,
      privacyTitle: widget.privacyTitle,
      privacyText: widget.privacyPoints.join("\n"),
      privacyButtonText: widget.privacyButton,
      disclaimerText: widget.aiDisclaimer,
    });
  });

  test("Hard Constraint 4: deutsche Texte wörtlich", () => {
    const de = embedDefaultTexts("de");
    expect(de.greetingBubbleText).toBe(
      "Hallo! Ich bin Ihr digitaler Berater und arbeite mit künstlicher Intelligenz (KI). Beschreiben Sie, was Sie suchen, und ich finde passende Angebote."
    );
    expect(de.privacyText.split("\n")).toEqual([
      "Ihre Anfragen bleiben auf Servern in Deutschland und werden nicht an Dritte weitergegeben.",
      "Mitarbeitende der Einrichtung können Gespräche zur Qualitätssicherung einsehen.",
      "Bitte teilen Sie nur Angaben, die für Ihre Anfrage nötig sind.",
    ]);
    expect(de.privacyButtonText).toBe("Start");
    expect(de.disclaimerText).toBe(
      "Ich bin eine KI und kann Fehler machen. Bitte überprüfen Sie meine Antworten."
    );
  });

  test("Standardtexte passen in die Server-Grenzen (mapLayoutConfig)", () => {
    for (const lang of Object.keys(EMBED_DEFAULT_TEXTS)) {
      const t = embedDefaultTexts(lang);
      expect(t.greetingBubbleText.length).toBeLessThanOrEqual(300);
      expect(t.privacyTitle.length).toBeLessThanOrEqual(120);
      expect(t.privacyButtonText.length).toBeLessThanOrEqual(40);
      expect(t.disclaimerText.length).toBeLessThanOrEqual(160);
      expect(t.privacyText.length).toBeLessThanOrEqual(1000);
      const points = t.privacyText.split("\n");
      expect(points.length).toBeLessThanOrEqual(5);
      for (const p of points) expect(p.length).toBeLessThanOrEqual(160);
    }
  });

  test("Rückgabe ist eine Kopie (Aufrufer kann nichts verändern)", () => {
    const a = embedDefaultTexts("de");
    a.privacyTitle = "x";
    expect(embedDefaultTexts("de").privacyTitle).toBe("Datenschutz:");
  });
});

describe("embedDefaultsLanguage wie panelLanguage() im Widget", () => {
  test.each([
    ["de", "de"],
    ["en", "en"],
    ["EN", "en"],
    ["en-GB", "en"],
    ["en_US", "en"],
    ["fr", "de"],
    ["", "de"],
    [undefined, "de"],
    [["en"], "de"],
    ["english", "de"],
    ["en-<script>", "de"],
  ])("%p -> %p", (input, expected) => {
    expect(embedDefaultsLanguage(input)).toBe(expected);
  });
});

describe("Prompt-Abschnitte des Karten-Modus", () => {
  test.each([
    [
      "kurz (Suche)",
      COURSE_CARDS_PROMPT_NOTE,
      "### Course Cards Mode — Search",
    ],
    [
      "ausführlich (Liste)",
      COURSE_CARDS_LONG_PROMPT_NOTE,
      "### Course Cards Mode (",
    ],
  ])("%s: Überschrift, Marker, Teaser, Sprachweiche", (_name, note, head) => {
    expect(note.startsWith(`\n\n${head}`)).toBe(true);
    expect(note.startsWith(`\n\n${COURSE_CARDS_SECTION_HEADING}`)).toBe(true);
    expect(note).toContain("[[KARTEN: n, n]]");
    expect(note).toContain("[[KARTEN: -]]");
    expect(note).toContain("[[TEASER n: …]]");
    expect(note).toContain("**Language check FIRST");
    expect(note).toContain(
      "Card numbers and teasers below apply ONLY to answers in German."
    );
    expect(note.endsWith("stays unchanged.")).toBe(true);
  });

  test("keine Folgefragen-Dopplung: [[FRAGEN]] und Rückfrage-Regel nur in FOLLOW_UPS_PROMPT_NOTE", () => {
    for (const note of [
      COURSE_CARDS_PROMPT_NOTE,
      COURSE_CARDS_LONG_PROMPT_NOTE,
    ]) {
      expect(note).not.toMatch(/FRAGEN/);
      expect(note).not.toMatch(/No follow-up question/i);
      // Footer-Regel bleibt (verträgt sich mit dem Footer Override)
      expect(note).toContain("if a Footer Override is active, write no footer");
    }
    expect(FOLLOW_UPS_PROMPT_NOTE).toContain("[[FRAGEN:");
    expect(FOLLOW_UPS_PROMPT_NOTE).toContain(
      "Do NOT ask a question in the answer text"
    );
    // die bestehenden Notes haben keine Karten-/Teaser-Regel
    for (const note of [DISCLAIMER_PROMPT_NOTE, FOLLOW_UPS_PROMPT_NOTE])
      expect(note).not.toMatch(/KARTEN|TEASER|Course Cards/);
  });

  test("kurz: keine Links im Text; ausführlich: Liste mit Links", () => {
    expect(COURSE_CARDS_PROMPT_NOTE).toContain("do NOT write any links");
    expect(COURSE_CARDS_LONG_PROMPT_NOTE).toContain(
      "Every listed course MUST be linked with its exact URL"
    );
  });

  test("courseCardsPromptNote: long -> Liste, alles andere -> kurz", () => {
    expect(courseCardsPromptNote("long")).toBe(COURSE_CARDS_LONG_PROMPT_NOTE);
    for (const v of ["short", undefined, "", "LONG", null])
      expect(courseCardsPromptNote(v)).toBe(COURSE_CARDS_PROMPT_NOTE);
  });

  test("promptHasCourseCardsSection erkennt beide Überschriften", () => {
    expect(promptHasCourseCardsSection(`A\n${COURSE_CARDS_PROMPT_NOTE}`)).toBe(
      true
    );
    expect(
      promptHasCourseCardsSection(`A${COURSE_CARDS_LONG_PROMPT_NOTE}`)
    ).toBe(true);
    expect(
      promptHasCourseCardsSection("### Course Information Blueprint")
    ).toBe(false);
    expect(promptHasCourseCardsSection(null)).toBe(false);
  });
});
