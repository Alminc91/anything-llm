/* eslint-env jest, node */
// Design Center: Standardtexte des Widgets (embedDefaults.js) und die
// Prompt-Abschnitte des Karten-Modus. Die Standardtexte müssen wörtlich den
// Widget-Werten (PANEL_TEXTS im Embed-Repo) entsprechen — Vergleich gegen
// eine Kopie (fixtures/embedPanelTexts.json, mit Stand-Kommentar).
const {
  EMBED_DEFAULT_TEXTS,
  DEFAULT_SUGGESTIONS,
  embedDefaultsLanguage,
  embedDefaultTexts,
  defaultSuggestions,
  COURSE_CARDS_PROMPT_NOTE,
  COURSE_CARDS_LONG_PROMPT_NOTE,
  COURSE_CARDS_SECTION_HEADING,
  COURSE_CARDS_ANSWER_STYLES,
  COURSE_CARDS_LAYOUTS,
  courseCardsPromptNote,
  promptHasCourseCardsSection,
  removeCourseCardsSections,
} = require("../../../utils/chats/embedDefaults");
const {
  DISCLAIMER_PROMPT_NOTE,
  FOLLOW_UPS_PROMPT_NOTE,
} = require("../../../utils/chats/embedCourseSources");
const { normalizePrivacyText } = require("../../../utils/chats/embedStandards");
const PANEL_TEXTS = require("./fixtures/embedPanelTexts.json");

describe("Standardtexte = Widget-PANEL_TEXTS", () => {
  test.each(["de", "en"])("%s wörtlich wie im Widget", (lang) => {
    const widget = PANEL_TEXTS[lang];
    expect(embedDefaultTexts(lang)).toEqual({
      name: widget.assistantName,
      assistantSubtitle: widget.assistantSubtitle,
      greeting: widget.greetingBubble,
      sendMessageText: widget.inputPlaceholder,
      privacyTitle: widget.privacyTitle,
      privacyText: widget.privacyPoints.map((p) => `• ${p}`).join("\n"),
      disclaimerText: widget.aiDisclaimer,
      // Datenschutz-Fußzeile (Nutzer 23.10.2026): Link neben dem KI-Hinweis,
      // Punkt „Hinweis zur KI“ und Button im Datenschutz-Fenster
      privacyLinkText: widget.privacyLinkText,
      privacyAiTitle: widget.privacyAiTitle,
      privacyAiText: widget.privacyAiText,
      privacyCloseText: widget.privacyCloseText,
      inlineInputPlaceholder: widget.inlineBarPlaceholder,
      inlineSendText: widget.inlineSendText,
      // S1 (Fixliste 7.22-rc10): Startvorschläge hat das Widget nicht, der
      // Server liefert sie (DEFAULT_SUGGESTIONS, auch live über /config)
      defaultMessages: [...DEFAULT_SUGGESTIONS[lang]],
    });
  });

  // S1 (Fixliste 7.22-rc10): Standard-Startvorschläge je Sprache, wörtlich
  // wie die Vorbelegung des Design Centers. Bewusste Änderung E42
  // (Nutzerentscheidung 22.10.2026, 7.22-rc23): der Standard ist in jeder
  // Sprache leer; bis 7.22-rc22 standen hier zwei Beispiele je Sprache.
  test("S1, Bewusste Änderung E42: Standard-Startvorschläge de/en leer, Kopie, eingefroren", () => {
    expect(defaultSuggestions("de")).toEqual([]);
    expect(defaultSuggestions("en")).toEqual([]);
    for (const lang of [undefined, "fr", "", "en-GB"])
      expect(defaultSuggestions(lang)).toEqual(
        defaultSuggestions(lang === "en-GB" ? "en" : "de")
      );
    expect(embedDefaultTexts("en").defaultMessages).toEqual(
      defaultSuggestions("en")
    );
    for (const lang of Object.keys(DEFAULT_SUGGESTIONS))
      for (const text of DEFAULT_SUGGESTIONS[lang])
        expect(text).not.toMatch(/[\u2013\u2014]/);
    // Kopie: der Aufrufer kann die Standards nicht verändern
    const list = defaultSuggestions("de");
    list.push("x");
    expect(defaultSuggestions("de")).toHaveLength(0);
    expect(() => DEFAULT_SUGGESTIONS.de.push("x")).toThrow();
    expect(() => DEFAULT_SUGGESTIONS.en.push("x")).toThrow();
  });

  // E42 (Nutzerentscheidung 22.10.2026, 7.22-rc23): Kunden ohne gespeicherte
  // Startvorschläge bekommen keine Standard-Startvorschläge mehr, in allen
  // Sprachen; die früheren Beispiele kommen auf keinem Weg mehr vor.
  test("E42: kein Standard-Startvorschlag in irgendeiner Sprache, auch nicht in den Standardtexten des Design Centers", () => {
    const OLD = [
      "Ich suche einen Deutschkurs.",
      "Gibt es Excel-Kurse am Abend?",
      "I am looking for a German course.",
      "Are there Excel courses in the evening?",
    ];
    expect(Object.keys(DEFAULT_SUGGESTIONS).sort()).toEqual(["de", "en"]);
    for (const lang of Object.keys(DEFAULT_SUGGESTIONS)) {
      expect(DEFAULT_SUGGESTIONS[lang]).toEqual([]);
      expect(Object.isFrozen(DEFAULT_SUGGESTIONS[lang])).toBe(true);
    }
    expect(Object.isFrozen(DEFAULT_SUGGESTIONS)).toBe(true);
    for (const lang of [
      "de",
      "en",
      "DE",
      "en-GB",
      "en_US",
      "fr",
      "tr",
      "uk",
      "ar",
      "",
      undefined,
      null,
      7,
      "<x>",
    ]) {
      expect([lang, defaultSuggestions(lang)]).toEqual([lang, []]);
      expect([lang, embedDefaultTexts(lang).defaultMessages]).toEqual([
        lang,
        [],
      ]);
      // die übrigen Standardtexte bleiben
      expect(embedDefaultTexts(lang).name).toBeTruthy();
    }
    const all = JSON.stringify([
      DEFAULT_SUGGESTIONS,
      embedDefaultTexts("de"),
      embedDefaultTexts("en"),
    ]);
    for (const text of OLD) expect(all).not.toContain(text);
  });

  test("D2: eingeklappte Inline-Leiste mit den Demo-Texten, je Sprache", () => {
    expect(embedDefaultTexts("de")).toMatchObject({
      inlineInputPlaceholder: "Stellen Sie hier Ihre Frage …",
      inlineSendText: "Chatten",
    });
    expect(embedDefaultTexts("en")).toMatchObject({
      inlineInputPlaceholder: "Ask your question here …",
      inlineSendText: "Chat",
    });
  });

  // Nutzerentscheidung 23.10.2026 (7.22.2): Der Standard-Platzhalter des
  // Chat-Eingabefelds ist derselbe Text wie in der eingeklappten Leiste, mit
  // Leerzeichen und typografischen Auslassungspunkten (U+2026). Bis
  // 7.22.2-rc4 „Ihre Frage eingeben“ / „Enter your question“.
  test("23.10.2026: Standard-Platzhalter des Chats gleich dem der eingeklappten Leiste, je Sprache", () => {
    expect(embedDefaultTexts("de").sendMessageText).toBe(
      "Stellen Sie hier Ihre Frage \u2026"
    );
    expect(embedDefaultTexts("en").sendMessageText).toBe(
      "Ask your question here \u2026"
    );
    for (const lang of [...Object.keys(EMBED_DEFAULT_TEXTS), "fr", undefined]) {
      const t = embedDefaultTexts(lang);
      expect(t.sendMessageText).toBe(t.inlineInputPlaceholder);
      expect(t.sendMessageText).not.toMatch(/\.\.\.|eingeben|Enter your/);
    }
  });

  test("Auftrag B: deutsche Texte wörtlich (Design Center vereinfacht, 15.10.2026)", () => {
    const de = embedDefaultTexts("de");
    expect(de.greeting).toBe(
      "Hallo! Ich bin Ihr KI-Berater. Wie kann ich Ihnen helfen?"
    );
    expect(de.name).toBe("KI-Berater");
    expect(de.assistantSubtitle).toBe(
      "Online-Berater mit künstlicher Intelligenz"
    );
    // Platzhalter seit der Nutzerentscheidung vom 23.10.2026 wie die Leiste
    expect(de.sendMessageText).toBe("Stellen Sie hier Ihre Frage …");
    expect(de.privacyTitle).toBe("Datenschutz");
    expect(de.privacyText.split("\n")).toEqual([
      "• Ihre Anfragen bleiben auf Servern in Deutschland und werden nicht an Dritte weitergegeben.",
      "• Mitarbeiter der Einrichtung können Gespräche zur Qualitätssicherung einsehen.",
      "• Bitte teilen Sie nur Angaben, die für Ihre Anfrage nötig sind.",
    ]);
    // R1 (Fixliste 7.22-rc8): „Unsere KI“ statt „KI“; bewusst gekürzt am
    // 23.10.2026 (Datenschutz-Fußzeile): die Bitte, Antworten zu prüfen,
    // steht als eigener Punkt im Datenschutz-Fenster
    expect(de.disclaimerText).toBe("Unsere KI kann Fehler machen");
    expect(embedDefaultTexts("en").disclaimerText).toBe(
      "Our AI can make mistakes"
    );
    // entfallen: Knopf der Datenschutz-Karte, eigener Text der Begrüßungsblase
    expect(de).not.toHaveProperty("privacyButtonText");
    expect(de).not.toHaveProperty("greetingBubbleText");
  });

  test("keine Gedankenstriche (– oder —) in sichtbaren Standardtexten", () => {
    for (const lang of Object.keys(EMBED_DEFAULT_TEXTS))
      for (const text of Object.values(embedDefaultTexts(lang)).flat())
        expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  // E30 (Fixliste 7.22-rc19, Nutzerentscheidung): Standardtexte ohne
  // Gendersprache; „Mitarbeiter“ statt „Mitarbeitende“. Englisch unverändert,
  // gespeicherte Texte der Kunden bleiben, wie sie sind.
  test("E30: Datenschutz-Standard „Mitarbeiter der Einrichtung …“, keine Gendersprache", () => {
    expect(EMBED_DEFAULT_TEXTS.de.privacyPoints[1]).toBe(
      "Mitarbeiter der Einrichtung können Gespräche zur Qualitätssicherung einsehen."
    );
    expect(PANEL_TEXTS.de.privacyPoints).toEqual(
      EMBED_DEFAULT_TEXTS.de.privacyPoints
    );
    expect(EMBED_DEFAULT_TEXTS.en.privacyPoints[1]).toBe(
      "Staff of the institution may view conversations for quality assurance."
    );
    for (const lang of Object.keys(EMBED_DEFAULT_TEXTS))
      for (const text of [
        ...Object.values(embedDefaultTexts(lang)).flat(),
        ...PANEL_TEXTS[lang].privacyPoints,
      ])
        expect(text).not.toMatch(/Mitarbeitende|\w[*:_]innen\b|\wInnen\b/);
  });

  test("Standardtexte passen in die Grenzen von Server und Widget", () => {
    for (const lang of Object.keys(EMBED_DEFAULT_TEXTS)) {
      const t = embedDefaultTexts(lang);
      expect(t.greeting.length).toBeLessThanOrEqual(300);
      expect(t.assistantSubtitle.length).toBeLessThanOrEqual(60);
      expect(t.sendMessageText.length).toBeLessThanOrEqual(120);
      expect(t.privacyTitle.length).toBeLessThanOrEqual(120);
      expect(t.disclaimerText.length).toBeLessThanOrEqual(160);
      // freier Datenschutz-Text: unverändert gültig (normalizePrivacyText)
      expect(normalizePrivacyText(t.privacyText)).toBe(t.privacyText);
    }
  });

  // Bewusste Änderung E42 (7.22-rc23): die Startvorschläge sind leer, die
  // Kopie bleibt leer (bis 7.22-rc22 Länge 2)
  test("Rückgabe ist eine Kopie (Aufrufer kann nichts verändern), Bewusste Änderung E42", () => {
    const a = embedDefaultTexts("de");
    a.privacyTitle = "x";
    a.defaultMessages.push("x");
    expect(embedDefaultTexts("de").privacyTitle).toBe("Datenschutz");
    expect(embedDefaultTexts("de").defaultMessages).toEqual([]);
  });
});

// Datenschutz als Link in der Fußzeile (issues/datenschutz-fusszeile.md,
// Nutzer 23.10.2026, Vertrag Punkte 1 bis 4): kurzer KI-Hinweis, Linktext in
// derselben Zeile, Punkt „Hinweis zur KI“ und Button „Schließen“ im
// Datenschutz-Fenster; de und en wortgleich mit PANEL_TEXTS im Widget.
describe("Datenschutz-Fußzeile: Texte des Vertrags", () => {
  const CONTRACT = {
    de: {
      disclaimerText: "Unsere KI kann Fehler machen",
      privacyLinkText: "Datenschutz",
      privacyAiTitle: "Hinweis zur KI",
      privacyAiText:
        "Unser KI-Berater ist auf richtige Auskünfte aus unserem Kursangebot optimiert. Wie jede KI kann er sich dennoch einmal irren. Wichtige Angaben wie Termine und Preise finden Sie zur Sicherheit immer auch auf der Kursseite.",
      privacyCloseText: "Schließen",
      privacyTitle: "Datenschutz",
    },
    en: {
      disclaimerText: "Our AI can make mistakes",
      privacyLinkText: "Privacy",
      privacyAiTitle: "About the AI",
      privacyAiText:
        "Our AI advisor is optimised for accurate information about our courses. Like any AI, it can still make the occasional mistake. For safety, you can always find important details such as dates and prices on the course page.",
      privacyCloseText: "Close",
      privacyTitle: "Privacy",
    },
  };

  test.each(["de", "en"])("%s: Wortlaut wörtlich", (lang) => {
    const t = embedDefaultTexts(lang);
    for (const [key, value] of Object.entries(CONTRACT[lang]))
      expect([key, t[key]]).toEqual([key, value]);
    // Rohtexte unter denselben Namen (Kopie von PANEL_TEXTS)
    for (const key of [
      "disclaimerText",
      "privacyLinkText",
      "privacyAiTitle",
      "privacyAiText",
      "privacyCloseText",
    ])
      expect(EMBED_DEFAULT_TEXTS[lang][key]).toBe(CONTRACT[lang][key]);
  });

  test("Fixture = Vertrag (aiDisclaimer und die neuen Schlüssel des Widgets)", () => {
    for (const lang of ["de", "en"]) {
      expect(PANEL_TEXTS[lang].aiDisclaimer).toBe(
        CONTRACT[lang].disclaimerText
      );
      for (const key of [
        "privacyLinkText",
        "privacyAiTitle",
        "privacyAiText",
        "privacyCloseText",
      ])
        expect(PANEL_TEXTS[lang][key]).toBe(CONTRACT[lang][key]);
    }
  });

  test("Fußzeile ohne alten Zusatz, ohne Satzpunkt am Ende, keine Gedankenstriche oder Gendersprache", () => {
    for (const lang of ["de", "en"]) {
      const t = embedDefaultTexts(lang);
      expect(t.disclaimerText).not.toMatch(/prüfen|double-check|\.$/);
      expect(`${t.disclaimerText} · ${t.privacyLinkText}`).toBe(
        lang === "de"
          ? "Unsere KI kann Fehler machen · Datenschutz"
          : "Our AI can make mistakes · Privacy"
      );
      for (const key of Object.keys(CONTRACT[lang]))
        expect(t[key]).not.toMatch(
          /[\u2013\u2014]|Mitarbeitende|\w[*:_]innen\b|\wInnen\b/
        );
    }
  });
});

// R1 (Fixliste 7.22-rc8): Gegenprobe gegen das Embed-Repo selbst (nicht nur
// gegen die Fixture-Kopie). KUFER_EMBED_DIR zeigt auf den Worktree des
// Widgets; ohne die Variable wird übersprungen. Ändert das Widget einen
// dieser Texte (seit der Datenschutz-Fußzeile, 7.23, auch Linktext, Punkt
// „Hinweis zur KI“ und Button im Fenster), scheitert dieser Test, bis
// embedDefaults.js und die Fixture nachgezogen sind.
const embedDir = process.env.KUFER_EMBED_DIR;
const describeWidget = embedDir ? describe : describe.skip;
describeWidget(
  "Standardtexte wortgleich mit PANEL_TEXTS im Embed-Repo (KUFER_EMBED_DIR)",
  () => {
    const fs = require("fs");
    const path = require("path");
    let source = "";
    beforeAll(() => {
      source = fs.readFileSync(
        path.join(embedDir, "src/utils/layout.js"),
        "utf8"
      );
    });
    // PANEL_TEXTS = { de: {…}, en: {…} }: je Sprache die String-Felder
    const block = (lang) => {
      const start = source.indexOf(
        `${lang}: {`,
        source.indexOf("PANEL_TEXTS = {")
      );
      expect(start).toBeGreaterThan(0);
      let depth = 0;
      for (let i = source.indexOf("{", start); i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0)
          return source.slice(start, i + 1);
      }
      throw new Error(`PANEL_TEXTS.${lang} ohne Ende`);
    };
    const field = (text, name) => {
      const m = new RegExp(`${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
      expect(m).not.toBeNull();
      return JSON.parse(`"${m[1]}"`);
    };

    // privacyPoints: [ "…", "…" ] als Liste der Texte
    const points = (text) => {
      const m = /privacyPoints:\s*\[([^\]]*)\]/.exec(text);
      expect(m).not.toBeNull();
      return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((p) =>
        JSON.parse(`"${p[1]}"`)
      );
    };

    test.each(["de", "en"])(
      "%s: KI-Hinweis, Name, Untertitel, Begrüßung, Platzhalter, Überschrift, Datenschutz-Link und -Fenster, Datenschutz-Punkte",
      (lang) => {
        const widget = block(lang);
        const ours = EMBED_DEFAULT_TEXTS[lang];
        expect(field(widget, "aiDisclaimer")).toBe(ours.disclaimerText);
        expect(field(widget, "assistantName")).toBe(ours.assistantName);
        expect(field(widget, "assistantSubtitle")).toBe(ours.assistantSubtitle);
        expect(field(widget, "greetingBubble")).toBe(ours.greeting);
        expect(field(widget, "inputPlaceholder")).toBe(ours.inputPlaceholder);
        expect(field(widget, "privacyTitle")).toBe(ours.privacyTitle);
        // Datenschutz-Fußzeile (23.10.2026): Linktext, Punkt „Hinweis zur
        // KI“ und Button im Fenster unter denselben Namen
        for (const key of [
          "privacyLinkText",
          "privacyAiTitle",
          "privacyAiText",
          "privacyCloseText",
        ]) {
          expect([key, field(widget, key)]).toEqual([key, ours[key]]);
          expect([key, PANEL_TEXTS[lang][key]]).toEqual([key, ours[key]]);
        }
        // Datenschutz-Punkte (E30, Fixliste 7.22-rc19): wortgleich im Widget
        expect(points(widget)).toEqual(ours.privacyPoints);
        // Fixture-Kopie ebenfalls auf dem Stand des Widgets
        expect(PANEL_TEXTS[lang].aiDisclaimer).toBe(
          field(widget, "aiDisclaimer")
        );
      }
    );
  }
);

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

  test.each(["short", "long"])(
    "teaser-rule-15-20: %s — Regel genau einmal, Beispiel-Teaser ≤ 20 Wörter",
    (style) => {
      for (const footer of [false, true]) {
        const note = courseCardsPromptNote({ style, footer });
        expect(note.split("15–20 words — never more than 20")).toHaveLength(2);
        expect(note).not.toContain("never fewer than 15");
        const examples = note
          .split("\n")
          .map((line) => /^\[\[TEASER \d+: (.*)\]\]$/.exec(line))
          .filter(Boolean)
          .map((m) => m[1]);
        expect(examples).toHaveLength(2);
        for (const teaser of examples) {
          const words = teaser.trim().split(/\s+/).length;
          expect(words).toBeGreaterThanOrEqual(15);
          expect(words).toBeLessThanOrEqual(20);
        }
      }
    }
  );

  test("courseCardsPromptNote: long -> Liste, classic -> nichts, sonst kurz", () => {
    expect(COURSE_CARDS_ANSWER_STYLES).toEqual(["short", "long", "classic"]);
    // Kartenlayout: nur Darstellung (Widget), Standard "grid"
    expect(COURSE_CARDS_LAYOUTS).toEqual(["grid", "rows"]);
    expect(courseCardsPromptNote({ style: "long" })).toBe(
      COURSE_CARDS_LONG_PROMPT_NOTE
    );
    expect(courseCardsPromptNote({ style: "classic" })).toBe("");
    expect(courseCardsPromptNote({ style: "classic", footer: true })).toBe("");
    expect(courseCardsPromptNote()).toBe(COURSE_CARDS_PROMPT_NOTE);
    for (const style of ["short", undefined, "", "LONG", null])
      expect(courseCardsPromptNote({ style })).toBe(COURSE_CARDS_PROMPT_NOTE);
  });

  test.each(["short", "long"])(
    "%s: Beispiel mit KI-Hinweis-Zeile, bei footer ohne",
    (style) => {
      const KI =
        "*Ich bin eine KI und kann Fehler machen. Bitte überprüfen Sie meine Antworten.*";
      const plain = courseCardsPromptNote({ style });
      const footer = courseCardsPromptNote({ style, footer: true });
      expect(plain).toContain(`\n\n${KI}\n▪ Everything else`);
      expect(footer).not.toContain(KI);
      // sonst identisch: nur Leerzeile + KI-Zeile fehlen
      expect(footer).toBe(plain.replace(`\n\n${KI}`, ""));
      expect(footer.endsWith("stays unchanged.")).toBe(true);
      // footer nur bei true (kein Wahrheitswert-Durchrutschen)
      expect(courseCardsPromptNote({ style, footer: "footer" })).toBe(plain);
    }
  );

  test("promptHasCourseCardsSection erkennt beide Überschriften (Groß-/Kleinschreibung, Leerraum egal)", () => {
    expect(promptHasCourseCardsSection(`A\n${COURSE_CARDS_PROMPT_NOTE}`)).toBe(
      true
    );
    expect(
      promptHasCourseCardsSection(`A${COURSE_CARDS_LONG_PROMPT_NOTE}`)
    ).toBe(true);
    expect(promptHasCourseCardsSection("x\n  ###course   CARDS Mode\n")).toBe(
      true
    );
    expect(
      promptHasCourseCardsSection("### Course Information Blueprint")
    ).toBe(false);
    // nur am Zeilenanfang (Erwähnung im Fließtext zählt nicht)
    expect(promptHasCourseCardsSection("see ### Course Cards Mode below")).toBe(
      false
    );
    expect(promptHasCourseCardsSection(null)).toBe(false);
  });

  test("removeCourseCardsSections: bis ▪▪▪ bzw. nächste ###-Überschrift, sonst unverändert", () => {
    const base = "### A\na\n\n▪▪▪\n\n### B\nb";
    expect(removeCourseCardsSections(base)).toBe(base);
    expect(
      removeCourseCardsSections(
        "### A\na\n\n### Course Cards Mode — Search\nr1\n[[KARTEN: -]]\n\n▪▪▪\n\n### B\nb"
      )
    ).toBe("### A\na\n\n▪▪▪\n\n### B\nb");
    expect(
      removeCourseCardsSections(
        "### A\n### Course Cards Mode\nr\n### B\nb\n### course cards mode (alt)\nr2"
      )
    ).toBe("### A\n### B\nb");
    expect(removeCourseCardsSections(null)).toBe(null);
  });
});
