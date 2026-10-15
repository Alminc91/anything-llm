// Design Center vereinfacht (15./16.10.2026): Logik der Felder
// (EmbedAppearance/widgetKeys.js) als reine Funktionen. Der Datenschutz-Text
// und die früheren Vorbelegungen müssen genau wie im Server behandelt werden
// (server/utils/chats/embedStandards.js), sonst zeigte das Design Center
// etwas anderes als das Widget: Vergleich gegen den Server-Code.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
    keys.greetingKey({ greetingBubbleText: "Eigene Blase", greeting: "x" }),
    "greetingBubbleText"
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
  assert.deepEqual(keys.cleanConfig({ assistantSubtitle: "  " }, base), {});
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
  assert.deepEqual(
    keys.DISPLAY_MODE_OPTIONS.map((o) => o.label),
    ["Chatblase", "Inline in der Seite"]
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

test("F07: Begrüßungsblase wie im Server (über 300 Zeichen auf ein Wortende gekürzt)", () => {
  const cases = [
    "Hallo!",
    "y".repeat(300),
    "x".repeat(400),
    Array(80).fill("Wort").join(" "),
    `${"a".repeat(250)}, ${"b".repeat(60)}`,
    `${"c".repeat(298)}\u{1F600}${"d".repeat(10)}`,
  ];
  for (const value of cases)
    assert.equal(
      keys.bubbleGreetingText(value),
      server.greetingBubbleText(value),
      value.slice(0, 20)
    );
  const long = Array(80).fill("Wort").join(" ");
  assert.equal(
    keys.previewGreeting({ greeting: long }, "greeting", DEFAULTS),
    server.greetingBubbleText(long)
  );
});

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

test("B-06: Aussehen ohne gespeicherten Wert zeigt die Standards des Widgets (Kundenfarbe Türkis wie live)", () => {
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
