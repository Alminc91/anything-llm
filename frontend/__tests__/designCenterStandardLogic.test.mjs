// Design Center vereinfacht (15./16.10.2026): Logik der Felder
// (EmbedAppearance/widgetKeys.js) als reine Funktionen. Der Datenschutz-Text
// und die früheren Vorbelegungen müssen genau wie im Server behandelt werden
// (server/utils/chats/embedStandards.js), sonst zeigte das Design Center
// etwas anderes als das Widget: Vergleich gegen den Server-Code.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const require = createRequire(import.meta.url);
const server = require("../../server/utils/chats/embedStandards.js");
const {
  embedDefaultTexts,
} = require("../../server/utils/chats/embedDefaults.js");
const DEFAULTS = embedDefaultTexts("de");

test("frühere Vorbelegungen wie im Server", () => {
  assert.deepEqual(keys.LEGACY_DEFAULT_GREETINGS, [
    ...server.LEGACY_DEFAULT_GREETINGS,
  ]);
  assert.deepEqual(keys.LEGACY_DEFAULT_PLACEHOLDERS, [
    ...server.LEGACY_DEFAULT_PLACEHOLDERS,
  ]);
  // F11: auch die früheren Datenschutz-Überschriften
  assert.deepEqual(keys.LEGACY_DEFAULT_PRIVACY_TITLES, [
    ...server.LEGACY_DEFAULT_PRIVACY_TITLES,
  ]);
  assert.equal(keys.PRIVACY_TEXT_MAX_LEN, server.PRIVACY_TEXT_MAX_LEN);
  assert.equal(keys.PRIVACY_LINES_MAX, server.PRIVACY_LINES_MAX);
  assert.equal(keys.PRIVACY_LINE_MAX_LEN, server.PRIVACY_LINE_MAX_LEN);
});

test("Datenschutz-Text: Normalform wie im Server (Altformat, freies Format, Grenzen)", () => {
  const cases = [
    DEFAULTS.privacyText,
    DEFAULTS.privacyText.replace(/^• /gm, ""),
    "a | b | c",
    " a\r\n\n | b \n",
    "1|2|3|4|5|6",
    `ok|${"x".repeat(161)}`,
    " | \n ",
    "Absatz eins\n\n-Punkt\n•   \nAbsatz | zwei",
    "Absatz\n– Strich",
    "Ein einzelner Satz.",
    "Wir nehmen Datenschutz ernst.\n- Server in Deutschland\n  •Keine Weitergabe\nFragen? Schreiben Sie uns.",
    ["• a", ...Array(9).fill("b".repeat(80))].join("\n"),
    ["• a", ...Array(10).fill("b")].join("\n"),
    `• ${"x".repeat(299)}`,
    `• a\n${"x".repeat(1000)}`,
    "-\n•",
    "",
    "   ",
    "|",
    42,
    null,
  ];
  for (const value of cases)
    assert.equal(
      keys.normalizePrivacyText(value),
      server.normalizePrivacyText(value),
      JSON.stringify(value)
    );
});

test("Datenschutz-Text: gespeichertes Altformat erscheint im Feld als „• “-Zeilen", () => {
  assert.equal(keys.privacyFieldText("a\nb"), "• a\n• b");
  assert.equal(keys.privacyFieldText("a | b"), "• a\n• b");
  assert.equal(keys.privacyFieldText("Absatz\n- Punkt"), "Absatz\n- Punkt");
  assert.deepEqual(keys.privacyBlocks("Absatz\n- Punkt"), [
    { type: "paragraph", text: "Absatz" },
    { type: "bullet", text: "Punkt" },
  ]);
  // Altformat in der Vorschau: alles Punkte
  assert.deepEqual(
    keys.privacyBlocks("a\nb").map((b) => b.type),
    ["bullet", "bullet"]
  );
});

test("Fehlermeldungen zum Datenschutz-Text ohne Gedankenstrich (Grenzen wie im Widget: 12 Zeilen, 500 Zeichen je Zeile, 1000 gesamt)", () => {
  for (const value of [
    ["• a", ...Array(12).fill("b")].join("\n"),
    Array(13).fill("p").join("|"),
    `• ${"x".repeat(499)}`,
    "x".repeat(1001),
  ]) {
    const error = keys.privacyTextError(value);
    assert.ok(error, JSON.stringify(value));
    assert.doesNotMatch(error, /[\u2013\u2014]/);
  }
  for (const value of [
    DEFAULTS.privacyText,
    "",
    "1|2|3|4|5|6",
    "y".repeat(161),
    ["• a", ...Array(11).fill("b")].join("\n"),
  ])
    assert.equal(keys.privacyTextError(value), null, JSON.stringify(value));
});

test("F05: 1000 Zeichen gelten auch nach dem Voranstellen von „• “ (wie der Server)", () => {
  const raw = Array(10).fill("x".repeat(99)).join("\n");
  assert.equal(raw.length, 999);
  assert.equal(
    keys.privacyTextError(raw),
    // C2 (Fixliste 7.22-rc13): Zahl mit Tausenderpunkt
    "Maximal 1.000 Zeichen insgesamt, mit den Zeichen „• “ am Zeilenanfang."
  );
  assert.equal(keys.normalizePrivacyText(raw), null);
  assert.equal(server.normalizePrivacyText(raw), null);
  // geänderter Text blockiert das Speichern
  const errors = keys.validateConfig({ privacyText: raw }, {}, "greeting");
  assert.ok(errors.privacyText);
  const fits = [...Array(9).fill("x".repeat(97)), "x".repeat(98)].join("\n");
  assert.equal(keys.privacyTextError(fits), null);
  assert.equal(
    keys.normalizePrivacyText(fits),
    server.normalizePrivacyText(fits)
  );
  assert.equal(keys.normalizePrivacyText(fits).length, 1000);
});

test("Datenschutz-Blöcke wie im Widget: Altformat mehrere Zeilen = Punkte, eine Zeile = Absatz, „–“ zählt als Zeichen", () => {
  assert.deepEqual(keys.privacyBlocks("Ein Satz."), [
    { type: "paragraph", text: "Ein Satz." },
  ]);
  assert.deepEqual(keys.privacyBlocks("a | b"), [
    { type: "bullet", text: "a" },
    { type: "bullet", text: "b" },
  ]);
  assert.deepEqual(keys.privacyBlocks("Absatz\n– Strich\n-\n• Punkt"), [
    { type: "paragraph", text: "Absatz" },
    { type: "bullet", text: "Strich" },
    { type: "bullet", text: "Punkt" },
  ]);
  assert.equal(keys.privacyFieldText("Ein Satz."), "Ein Satz.");
  // Standard im Altformat = Standard
  assert.ok(
    keys.sameAsDefault(
      "privacyText",
      DEFAULTS.privacyText.replace(/^• /gm, ""),
      DEFAULTS
    )
  );
  assert.ok(!keys.sameAsDefault("privacyText", "Ein Satz.", DEFAULTS));
});

test("Begrüßung: früherer Blasentext hat Vorrang (Schlüssel), Vorbelegungen zeigen den Standard", () => {
  assert.equal(keys.greetingKey({}), "greeting");
  assert.equal(
    keys.greetingKey({
      greetingBubbleText: "Eigene Blase",
      greeting: "x",
      greetingStyle: "bubble",
    }),
    "greetingBubbleText"
  );
  assert.equal(
    keys.greetingKey({ greetingBubbleText: "Eigene Blase" }),
    "greetingBubbleText"
  );
  // F03: bei Stil „text“ war der Blasentext nie sichtbar
  assert.equal(
    keys.greetingKey({ greetingBubbleText: "Eigene Blase", greeting: "x" }),
    "greeting"
  );
  assert.equal(
    keys.greetingKey({
      greetingBubbleText: server.LEGACY_DEFAULT_GREETINGS[1],
    }),
    "greeting"
  );
  assert.equal(
    keys.greetingFieldValue(
      { greeting: server.LEGACY_DEFAULT_GREETINGS[0] },
      "greeting",
      DEFAULTS
    ),
    DEFAULTS.greeting
  );
  assert.equal(
    keys.greetingFieldValue({ greeting: "Hallo!" }, "greeting", DEFAULTS),
    "Hallo!"
  );
  assert.equal(
    keys.greetingFieldValue({ greeting: "" }, "greeting", DEFAULTS),
    ""
  );
  assert.equal(
    keys.previewGreeting({ greeting: "" }, "greeting", DEFAULTS),
    DEFAULTS.greeting
  );
  // gleiche Regel wie der Server
  for (const vc of [
    { greetingBubbleText: "B", greeting: "G" },
    { greetingBubbleText: "B", greeting: "G", greetingStyle: "Bubble" },
    { greetingBubbleText: "B", greeting: "G", privacyNotice: "bubble" },
    { greetingBubbleText: "B", greeting: "G", privacyNotice: "modal" },
    {
      greetingBubbleText: "B",
      greeting: server.LEGACY_DEFAULT_GREETINGS[1],
      greetingStyle: "text",
    },
    { greetingBubbleText: "B" },
    { greeting: "G" },
    { greeting: server.LEGACY_DEFAULT_GREETINGS[0] },
  ])
    assert.equal(
      keys.previewGreeting(vc, keys.greetingKey(vc), DEFAULTS),
      server.effectiveGreeting(vc) ?? DEFAULTS.greeting
    );
});

test("Platzhalter: frühere Vorbelegung zeigt den Standard", () => {
  assert.equal(
    keys.placeholderFieldValue({
      sendMessageText: "Wie kann ich Ihnen helfen?",
    }),
    ""
  );
  assert.equal(
    keys.placeholderFieldValue({ sendMessageText: "Frage?" }),
    "Frage?"
  );
  assert.equal(
    keys.previewPlaceholder(
      { sendMessageText: "Wie kann ich Ihnen helfen?" },
      DEFAULTS
    ),
    "Ihre Frage eingeben"
  );
});

test("Speichern: entfallene Schlüssel bleiben unverändert, es kommen keine neuen dazu", () => {
  const legacy = {
    suggestionStyle: "bars",
    greetingStyle: "text",
    followUps: "none",
    privacyNotice: "modal",
    privacyButtonText: "OK",
    disclaimer: "none",
    disclaimerText: "Eigener KI-Hinweis",
    onlineDot: true,
    courseCards: "off",
    courseCardsAnswerStyle: "long",
    courseCardsLayout: "grid",
    courseCardsPosition: "below",
    inlineOpenOn: "submit",
    inlineEffect: "spring",
    inlineLayout: "flow",
    inlineTheme: "dark",
    inlineHeight: "70vh",
    inlineMaxWidth: "900",
    inlineCollapsedText: "  Text mit Leerzeichen  ",
    windowWidth: "420",
    offsetX: "20",
    inheritFont: "ja",
  };
  const config = { ...legacy, name: "VHS", accentColor: "#123456" };
  const cleaned = keys.cleanConfig(config, {
    initial: config,
    defaults: DEFAULTS,
    greetingKey: "greeting",
  });
  assert.deepEqual(cleaned, config);
  assert.deepEqual(Object.keys(cleaned).sort(), Object.keys(config).sort());
});

test("F03: Begrüßung auf Standard bei Stil „text“ entfernt auch den nie sichtbaren Blasentext", () => {
  const stored = { greeting: "Sichtbar", greetingBubbleText: "Unsichtbar" };
  const gKey = keys.greetingKey(stored);
  assert.equal(gKey, "greeting");
  const opts = { initial: stored, defaults: DEFAULTS, greetingKey: gKey };
  // Feld geleert bzw. Standardtext: sonst würde der Blasentext sichtbar
  for (const greeting of ["", DEFAULTS.greeting]) {
    const cleaned = keys.cleanConfig({ ...stored, greeting }, opts);
    assert.deepEqual(cleaned, {});
    assert.equal(server.effectiveGreeting(cleaned), null);
  }
  // eigener neuer Text: Blasentext bleibt gespeichert, die Begrüßung gilt
  const own = keys.cleanConfig({ ...stored, greeting: " Neu " }, opts);
  assert.deepEqual(own, { greeting: "Neu", greetingBubbleText: "Unsichtbar" });
  assert.equal(server.effectiveGreeting(own), "Neu");
  // frühere Vorbelegung als Blasentext bleibt unberührt
  const legacy = {
    greeting: "Sichtbar",
    greetingBubbleText: server.LEGACY_DEFAULT_GREETINGS[2],
  };
  assert.deepEqual(
    keys.cleanConfig({ ...legacy, greeting: "" }, { ...opts, initial: legacy }),
    { greetingBubbleText: server.LEGACY_DEFAULT_GREETINGS[2] }
  );
});

test("Speichern: Begrüßung leer oder Standard entfernt den Schlüssel; frühere Vorbelegung bleibt unberührt", () => {
  const opts = (initial) => ({
    initial,
    defaults: DEFAULTS,
    greetingKey: "greeting",
  });
  assert.deepEqual(
    keys.cleanConfig({ greeting: ` ${DEFAULTS.greeting} ` }, opts({})),
    {}
  );
  assert.deepEqual(keys.cleanConfig({ greeting: "  " }, opts({})), {});
  assert.deepEqual(keys.cleanConfig({ greeting: " Hallo " }, opts({})), {
    greeting: "Hallo",
  });
  const legacyGreeting = { greeting: server.LEGACY_DEFAULT_GREETINGS[0] };
  assert.deepEqual(
    keys.cleanConfig(legacyGreeting, opts(legacyGreeting)),
    legacyGreeting
  );
  // früherer Blasentext auf Standard gesetzt: eine eigene greeting würde
  // sonst sichtbar -> beide weg
  assert.deepEqual(
    keys.cleanConfig(
      { greetingBubbleText: DEFAULTS.greeting, greeting: "Alt" },
      { initial: {}, defaults: DEFAULTS, greetingKey: "greetingBubbleText" }
    ),
    {}
  );
  // ohne geladene Standardtexte nie als Standard erkannt
  assert.deepEqual(
    keys.cleanConfig(
      { greeting: DEFAULTS.greeting },
      { initial: {}, defaults: null }
    ),
    { greeting: DEFAULTS.greeting }
  );
});

test("Speichern: Platzhalter, Überschrift, Text und Link", () => {
  const base = { initial: {}, defaults: DEFAULTS };
  assert.deepEqual(
    keys.cleanConfig({ sendMessageText: "Wie kann ich Ihnen helfen?" }, base),
    { sendMessageText: "Wie kann ich Ihnen helfen?" }
  );
  assert.deepEqual(keys.cleanConfig({ sendMessageText: " " }, base), {});
  // Überschrift: leer = bewusst keine, Standard = Schlüssel weg
  assert.deepEqual(keys.cleanConfig({ privacyTitle: "  " }, base), {
    privacyTitle: "",
  });
  assert.deepEqual(keys.cleanConfig({ privacyTitle: "Datenschutz" }, base), {});
  // Text: Standard (auch im Altformat) weg, eigener in Normalform
  assert.deepEqual(
    keys.cleanConfig(
      { privacyText: DEFAULTS.privacyText.replace(/^• /gm, "") },
      base
    ),
    {}
  );
  assert.deepEqual(
    keys.cleanConfig({ privacyText: "Absatz\n\n- Punkt" }, base),
    { privacyText: "Absatz\n- Punkt" }
  );
  // unverändert gespeicherter Text bleibt, wie er ist
  const stored = { privacyText: "a | b" };
  assert.deepEqual(
    keys.cleanConfig(stored, { initial: stored, defaults: DEFAULTS }),
    stored
  );
  assert.deepEqual(keys.cleanConfig({ privacyUrl: " /datenschutz " }, base), {
    privacyUrl: "/datenschutz",
  });
  assert.deepEqual(keys.cleanConfig({ privacyUrl: "javascript:x" }, base), {});
  // R5 (7.22-rc8, bewusst geändert): leerer Untertitel = bewusst kein
  // Untertitel, bleibt als "" gespeichert; der Standard entfernt den Schlüssel
  assert.deepEqual(keys.cleanConfig({ assistantSubtitle: "  " }, base), {
    assistantSubtitle: "",
  });
  assert.deepEqual(
    keys.cleanConfig({ assistantSubtitle: DEFAULTS.assistantSubtitle }, base),
    {}
  );
});

test("Prüfen: alte lange Texte blockieren erst nach einer Änderung", () => {
  const long = "x".repeat(301);
  const stored = { greeting: long };
  assert.deepEqual(keys.validateConfig(stored, stored, "greeting"), {});
  assert.ok(
    keys.validateConfig({ greeting: `${long}y` }, stored, "greeting").greeting
  );
  const errors = keys.validateConfig(
    {
      assistantSubtitle: "y".repeat(61),
      privacyTitle: "t".repeat(121),
      privacyUrl: "http://x",
      privacyText: Array(13).fill("p").join("|"),
      sendMessageText: "p".repeat(121),
    },
    {},
    "greeting"
  );
  assert.deepEqual(Object.keys(errors).sort(), [
    "assistantSubtitle",
    "privacyText",
    "privacyTitle",
    "privacyUrl",
    "sendMessageText",
  ]);
  for (const key of Object.keys(errors))
    assert.equal(keys.FIELD_TAB[key], "inhalt");
});

test("Darstellung und Farbschema", () => {
  assert.equal(keys.displayMode({ displayMode: " Inline " }), "inline");
  assert.equal(keys.displayMode({}), "bubble");
  assert.equal(keys.themeChoice({}), "light");
  assert.equal(keys.themeChoice({ theme: "dark" }), "dark");
  assert.equal(keys.themeChoice({ theme: "auto" }), null);
  // R3 (7.22-rc8): „Chatfenster“ und „In der Seite“
  assert.deepEqual(
    keys.DISPLAY_MODE_OPTIONS.map((o) => o.label),
    ["Chatfenster", "In der Seite"]
  );
});

test("F08/F10: Altformat mit mehreren Teilen wird als „• “-Zeilen gespeichert, zweimal normalisiert bleibt gleich", () => {
  assert.equal(
    keys.normalizePrivacyText("Kosten | -10 % Rabatt"),
    "• Kosten\n• -10 % Rabatt"
  );
  for (const value of [
    "Kosten | -10 % Rabatt",
    "a\nb",
    "Fragen: datenschutz@vhs.de | Tel. 0591 123",
    "Ein Satz.",
    "Absatz\n- Punkt",
  ]) {
    const once = keys.normalizePrivacyText(value);
    assert.equal(keys.normalizePrivacyText(once), once, JSON.stringify(value));
    // gleiche Darstellung vor und nach dem Speichern
    assert.deepEqual(keys.privacyBlocks(once), keys.privacyBlocks(value));
  }
  // gespeichert: aus „-10 % Rabatt“ wird kein Absatz plus Punkt ohne Minus
  assert.deepEqual(
    keys.privacyBlocks(keys.normalizePrivacyText("Kosten | -10 % Rabatt")),
    [
      { type: "bullet", text: "Kosten" },
      { type: "bullet", text: "-10 % Rabatt" },
    ]
  );
});

test("F09: Hinweis „ohne Zeichen“ nach derselben Regel wie der Parser (NBSP vor „•“ zählt als Zeichen)", () => {
  assert.equal(keys.privacyWithoutMarks("\u00a0• Punkt\nAbsatz"), false);
  assert.equal(keys.privacyWithoutMarks("\u2003- Punkt\nAbsatz"), false);
  assert.equal(keys.privacyWithoutMarks("a\nb"), true);
  assert.equal(keys.privacyWithoutMarks("a | b"), true);
  assert.equal(keys.privacyWithoutMarks("Ein Satz."), false);
  assert.equal(keys.privacyWithoutMarks(5), false);
});

// Gekürzte Begrüßungsblase (Review 7.22-rc6 F07/F08): seit F08 kürzt allein
// das Widget (shortenGreeting), das Design Center zeigt dieselbe Kürzung in
// der Vorschau. Feste Erwartungen hier, die Gegenprobe gegen den Widget-Code
// mit KUFER_EMBED_DIR unten.
const GREETING_CASES = [
  "Hallo!",
  "y".repeat(300),
  "x".repeat(400),
  Array(80).fill("Wort").join(" "),
  `${"a".repeat(250)}, ${"b".repeat(60)}`,
  `${"c".repeat(298)}\u{1F600}${"d".repeat(10)}`,
];

test("F07: Begrüßungsblase über 300 Zeichen auf ein Wortende gekürzt", () => {
  assert.equal(keys.bubbleGreetingText("Hallo!"), "Hallo!");
  assert.equal(keys.bubbleGreetingText("y".repeat(300)), "y".repeat(300));
  assert.equal(keys.bubbleGreetingText("x".repeat(400)), `${"x".repeat(299)}…`);
  const words = Array(80).fill("Wort").join(" ");
  const short = keys.bubbleGreetingText(words);
  assert.ok(short.length <= 300);
  assert.match(short, / Wort…$/);
  assert.ok(words.startsWith(short.slice(0, -1)));
  assert.equal(
    keys.bubbleGreetingText(`${"a".repeat(250)}, ${"b".repeat(60)}`),
    `${"a".repeat(250)}…`
  );
  assert.equal(
    keys.bubbleGreetingText(`${"c".repeat(298)}\u{1F600}${"d".repeat(10)}`),
    `${"c".repeat(298)}…`
  );
  assert.equal(
    keys.previewGreeting({ greeting: words }, "greeting", DEFAULTS),
    short
  );
  // F08: der Server kürzt nicht mehr und schickt keinen eigenen Blasentext
  assert.equal(server.greetingBubbleText, undefined);
  const out = server.applyEmbedStandards({}, { greeting: words });
  assert.equal(out.greeting, words);
  assert.ok(!("greetingBubbleText" in out));
});

// Gegenprobe gegen den Widget-Code (Checkout von anythingllm-embed in
// KUFER_EMBED_DIR): Kürzung der Begrüßung (shortenGreeting) und frühere
// Vorbelegungen (LEGACY_DEFAULT_GREETINGS) gleich wie im Design Center
// (Review 7.22-rc6 F08 und C1)
const WIDGET_LAYOUT =
  process.env.KUFER_EMBED_DIR &&
  path.join(process.env.KUFER_EMBED_DIR, "src/utils/layout.js");
const widgetSkip =
  WIDGET_LAYOUT && existsSync(WIDGET_LAYOUT)
    ? false
    : "KUFER_EMBED_DIR nicht gesetzt";

// Quelltext ab `start` bis zur passenden schließenden Klammer
function balanced(source, start, open, close) {
  let depth = 0;
  for (let i = source.indexOf(open, start); i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0)
      return source.slice(start, i + 1);
  }
  throw new Error(`keine schließende Klammer ab ${start}`);
}
function widgetConst(source, name) {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(source);
  assert.ok(m, name);
  return Number(m[1]);
}

test(
  "F08/C1: Kürzung und frühere Vorbelegungen wortgleich mit dem Widget",
  { skip: widgetSkip },
  () => {
    const source = readFileSync(WIDGET_LAYOUT, "utf8");
    const fnStart = source.indexOf("function shortenGreeting(");
    assert.ok(fnStart >= 0, "shortenGreeting im Widget");
    const fn = balanced(source, fnStart, "{", "}");
    const shortenGreeting = new Function(
      "GREETING_BUBBLE_TEXT_MAX_LEN",
      "GREETING_WORD_CUT_MIN",
      `${fn}; return shortenGreeting;`
    )(
      widgetConst(source, "GREETING_BUBBLE_TEXT_MAX_LEN"),
      widgetConst(source, "GREETING_WORD_CUT_MIN")
    );
    for (const value of GREETING_CASES)
      assert.equal(
        keys.bubbleGreetingText(value),
        shortenGreeting(value),
        value.slice(0, 20)
      );
    const listStart = source.indexOf("const LEGACY_DEFAULT_GREETINGS = [");
    assert.ok(listStart >= 0, "LEGACY_DEFAULT_GREETINGS im Widget");
    const list = balanced(source, source.indexOf("[", listStart), "[", "]");
    assert.deepEqual(
      new Function(`return ${list};`)(),
      keys.LEGACY_DEFAULT_GREETINGS
    );
    // Standard-Willkommensblasen (deutsch) wie der Vorschlag im Design
    // Center (E3: im Widget je Sprache, UI_TEXTS)
    const ui = source.indexOf("UI_TEXTS = {");
    assert.ok(ui >= 0, "UI_TEXTS im Widget");
    const bubbles = source.indexOf("welcomeBubbles: [", ui);
    assert.deepEqual(
      new Function(
        `return ${balanced(source, source.indexOf("[", bubbles), "[", "]")};`
      )(),
      keys.DEFAULT_WELCOME_BUBBLES
    );
  }
);

test("D2/F04: Inline-Leiste mit Demo-Texten, nur ein früher gespeicherter Leistentext gilt", () => {
  for (const config of [
    {},
    { sendMessageText: "Ihre Frage an uns" },
    { inlineInputPlaceholder: "  " },
    { inlineInputPlaceholder: "q".repeat(121) },
  ]) {
    assert.deepEqual(keys.previewInlineBar(config, DEFAULTS), {
      placeholder: "Stellen Sie hier Ihre Frage …",
      sendText: "Chatten",
    });
    assert.equal(
      keys.storedInlineBarPlaceholder(config),
      server.inlineBarPlaceholder(config)
    );
  }
  const own = { inlineInputPlaceholder: " Was suchen Sie? " };
  assert.equal(
    keys.previewInlineBar(own, DEFAULTS).placeholder,
    "Was suchen Sie?"
  );
  assert.equal(
    keys.storedInlineBarPlaceholder(own),
    server.inlineBarPlaceholder(own)
  );
  // ohne geladene Standardtexte dieselben Demo-Texte
  assert.deepEqual(keys.previewInlineBar({}, null), {
    placeholder: DEFAULTS.inlineInputPlaceholder,
    sendText: DEFAULTS.inlineSendText,
  });
});

test("B-06: Aussehen ohne gespeicherten Wert zeigt die Standards des Widgets (Akzentfarbe Türkis wie live)", () => {
  assert.equal(keys.lookValue({}, "accentColor").toLowerCase(), "#01a5a9");
  assert.equal(keys.lookValue({ accentColor: "" }, "accentColor"), "#01A5A9");
  assert.equal(
    keys.lookValue({ accentColor: "#FFA102" }, "accentColor"),
    "#FFA102"
  );
  // Schrift auf der Kundenfarbe: ohne gespeicherten Wert die Empfehlung
  // nach Kontrast wie im Widget (KIE-565 Nachtrag), auf Türkis Schwarz,
  // gezeigt als #222628 (E1, Fixliste 7.22-rc7)
  assert.equal(keys.lookValue({}, "userTextColor"), "#222628");
  assert.equal(keys.lookValue({}, "chatIcon"), "chatBubble");
  assert.equal(keys.lookValue({}, "position"), "bottom-left");
});
