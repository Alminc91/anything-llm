// Korrekturrunde 7.22-rc8 (Fixliste fixliste-7.22-rc8.md, Teil Fork Design
// Center) und Restpunkte rc7 Nr. 1, 5, 6: R1 KI-Hinweis, R2 Zeile statt
// Kasten, R3 Begriffe, R4 Standard der Kurskarten je Darstellung, R5
// Vorbelegung statt „übernehmen“, R6 Reihenfolge im Reiter Inhalt, R7 kein
// Layoutsprung beim Datenschutz-Schalter, R9 Symbole beim Farbschema, R10
// Akzentfarbe. Logik als reine Funktionen, Darstellung serverseitig
// gerendert, Bedienung und Speichern mit eingehängter Seite und ersetztem
// fetch (wie designCenterStandardSave.test.mjs).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements, handlersOf } from "./helpers/testDom.mjs";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance";
const DESIGN_CENTER = `${DIR}/index.jsx`;
const APPEARANCE = `${DIR}/AppearanceTab.jsx`;
const CONTENT = `${DIR}/ContentTab.jsx`;
const EMBED = `${DIR}/EmbedTab.jsx`;
const PREVIEW = `${DIR}/WidgetPreview.jsx`;
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const require = createRequire(import.meta.url);
const server = require("../../server/utils/chats/embedStandards.js");
const {
  embedDefaultTexts,
} = require("../../server/utils/chats/embedDefaults.js");
const DEFAULTS = embedDefaultTexts("de");

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const noop = () => {};
const text = (html) =>
  html
    .replace(/<wbr\/?>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const show = (modulePath, props) =>
  renderer.render(modulePath, { location: "/", props });
const appearance = (config, extra = {}) =>
  show(APPEARANCE, { config, updateField: noop, logoPreview: null, ...extra });
const preview = (config) =>
  show(PREVIEW, {
    config,
    logoPreview: null,
    defaults: DEFAULTS,
    greetingKey: "greeting",
  });
const contentProps = (config) => ({
  config,
  initialConfig: config,
  errors: {},
  defaults: DEFAULTS,
  defaultsError: false,
  greetingKey: "greeting",
  updateField: noop,
  updateOptionalField: noop,
  resetKeys: noop,
  setChoice: noop,
  addListItem: noop,
  updateListItem: noop,
  removeListItem: noop,
});

// <button …>Beschriftung</button>, auch hinter einem Symbol (R9)
function buttonTag(html, label) {
  return [
    ...html.matchAll(
      /<button[^>]*>((?:<svg[\s\S]*?<\/svg>)?)([^<]*)<\/button>/g
    ),
  ].find((m) => m[2] === label);
}

// ---------------------------------------------------------------------------
// R1: KI-Hinweis
// ---------------------------------------------------------------------------

// Bewusste Änderung (Datenschutz-Fußzeile, Nutzer 23.10.2026, 7.23): Der
// KI-Hinweis ist kurz, in derselben Zeile folgt der Link „Datenschutz“; die
// Bitte, Antworten zu prüfen, steht im Datenschutz-Fenster. Bis 7.22.2
// „Unsere KI kann Fehler machen. Bitte prüfen Sie die Antworten.“ bzw. „Our
// AI can make mistakes. Please double-check the answers.“
test(
  "R1: KI-Hinweis wörtlich (de/en), Vorschau zeigt ihn mit dem Link „Datenschutz“",
  { skip },
  async () => {
    assert.equal(DEFAULTS.disclaimerText, "Unsere KI kann Fehler machen");
    assert.equal(
      embedDefaultTexts("en").disclaimerText,
      "Our AI can make mistakes"
    );
    const footer = (html) =>
      text(
        html.match(/<p[^>]*data-preview="disclaimer"[^>]*>([\s\S]*?)<\/p>/)[1]
      );
    for (const config of [{}, { displayMode: "inline" }])
      assert.equal(
        footer(await preview(config)),
        "Unsere KI kann Fehler machen · Datenschutz"
      );
    // ohne geladene Standardtexte derselbe Text
    const fallback = await show(PREVIEW, {
      config: {},
      logoPreview: null,
      defaults: null,
      greetingKey: "greeting",
    });
    assert.equal(
      footer(fallback),
      "Unsere KI kann Fehler machen · Datenschutz"
    );
    assert.ok(!text(fallback).includes("Bitte prüfen Sie die Antworten"));
  }
);

// ---------------------------------------------------------------------------
// R2, R3, R9, R10: Reiter Aussehen
// ---------------------------------------------------------------------------

test(
  "R2: Kasten „Fest eingebaut“ entfällt, eine gedämpfte Zeile am Ende, je Darstellung",
  { skip },
  async () => {
    const bubble = await appearance({});
    assert.doesNotMatch(bubble, /data-testid="fixed-standards"/);
    assert.doesNotMatch(bubble, /LockSimple|Fest eingebaut/);
    const note = bubble.match(
      /<p[^>]*data-testid="fixed-note"[^>]*>([^<]*)<\/p>/
    );
    assert.ok(note, "Zeile fehlt");
    assert.equal(
      note[1],
      "Fest vorgegeben: der KI-Hinweis unter der Eingabe und die Größe des Chatfensters."
    );
    assert.match(note[0], /text-theme-text-secondary/);
    // ganz unten: nach „Antworten mit Kursen“
    const t = text(bubble);
    assert.ok(
      t.lastIndexOf("Fest vorgegeben") > t.indexOf("Antworten mit Kursen")
    );
    assert.ok(!t.includes("Datenschutz-Schalter"));
    assert.ok(!t.includes("Den Datenschutz-Hinweis schalten Sie"));

    const inline = await appearance({ displayMode: "inline" });
    assert.equal(
      inline.match(/<p[^>]*data-testid="fixed-note"[^>]*>([^<]*)<\/p>/)[1],
      "Fest vorgegeben: der KI-Hinweis unter der Eingabe und die Größe der aufgeklappten Box."
    );
  }
);

test(
  "R3: Begriffe in allen Reitern und der Vorschau: Chatfenster, In der Seite, Name und Untertitel, Titelleiste; kein Chatblase, Inline, Kopf, Knopf, Gedankenstrich",
  { skip },
  async () => {
    const pages = [];
    for (const displayMode of ["bubble", "inline"]) {
      const config = { displayMode };
      pages.push(["aussehen", displayMode, text(await appearance(config))]);
      pages.push([
        "inhalt",
        displayMode,
        text(await show(CONTENT, contentProps(config))),
      ]);
      pages.push([
        "einbau",
        displayMode,
        text(await show(EMBED, { config, embed: { uuid: "abc-123" } })),
      ]);
      pages.push(["vorschau", displayMode, text(await preview(config))]);
    }
    for (const [tab, mode, page] of pages) {
      const where = `${tab} ${mode}`;
      assert.ok(!page.includes("Chatblase"), where);
      assert.ok(!page.includes("Chat-Blase"), where);
      assert.doesNotMatch(page, /\bInline\b/, where);
      assert.doesNotMatch(page, /Knopf|Knöpf/, where);
      assert.doesNotMatch(page, /[–—]/, where);
      assert.ok(!page.includes("Kundenfarbe"), where);
    }
    const aussehen = pages[0][2];
    assert.ok(aussehen.includes("Chatfenster"));
    assert.ok(aussehen.includes("In der Seite"));
    assert.ok(
      aussehen.includes(
        "Chatfenster: Button unten in der Ecke, öffnet ein Chatfenster. In der Seite: Eingabeleiste direkt im Seiteninhalt, an der Stelle des Platzhalters (Reiter „Einbau“)."
      )
    );
    assert.ok(aussehen.includes("Position des Chat-Buttons"));
    // Chat-Icon-Name seit R11 (7.22-rc9) nicht mehr als Text unter dem
    // Icon, sondern als Tooltip und aria-label
    assert.match(
      await appearance({ displayMode: "bubble" }),
      /<button[^>]*title="Sprechblase"[^>]*aria-label="Sprechblase"/
    );
    const inhalt = pages[1][2];
    assert.ok(inhalt.includes("Name und Untertitel"));
    assert.ok(!/\bKopf\b/.test(inhalt));
    assert.ok(inhalt.includes("Titelleiste des Chats"));
    const einbau = pages[2][2];
    assert.ok(einbau.includes("Beim Chatfenster genügt das Skript"));
    const einbauInline = pages[6][2];
    assert.ok(einbauInline.includes("nur bei „In der Seite“"));
    assert.ok(
      einbauInline.includes(
        "Fehlt der Platzhalter auf einer Seite, erscheint dort automatisch das Chatfenster."
      )
    );
    const vorschauInline = pages[7][2];
    assert.ok(
      vorschauInline.includes("Vorschau: Eingabeleiste in Ihrer Seite")
    );
  }
);

test(
  "R3: Marke „nur bei „In der Seite““ nur im Einbau-Schritt 2",
  { skip },
  async () => {
    const inline = await show(EMBED, {
      config: { displayMode: "inline" },
      embed: { uuid: "abc-123" },
    });
    assert.match(
      inline,
      /data-testid="step-badge"[^>]*>nur bei „In der Seite“</
    );
    const bubble = await show(EMBED, {
      config: {},
      embed: { uuid: "abc-123" },
    });
    assert.doesNotMatch(bubble, /data-testid="step-badge"/);
  }
);

test(
  "R9: Sonne bei Hell, Mond bei Dunkel, 16 px, aria-hidden, Text bleibt",
  { skip },
  async () => {
    const html = await appearance({});
    const hell = buttonTag(html, "Hell");
    const dunkel = buttonTag(html, "Dunkel");
    assert.ok(hell && dunkel, "Buttons fehlen");
    for (const tag of [hell[1], dunkel[1]]) {
      assert.match(tag, /<svg/);
      assert.match(tag, /width="16" height="16"/);
      assert.match(tag, /aria-hidden="true"/);
    }
    // verschiedene Symbole (Pfad der Sonne enthält Strahlen-Linien, der Mond
    // nicht): die beiden SVGs sind nicht gleich
    assert.notEqual(hell[1], dunkel[1]);
    // keine Symbole bei den übrigen Auswahlgruppen
    for (const label of ["Chatfenster", "In der Seite", "Links", "Rechts"])
      assert.equal(buttonTag(html, label)[1], "", label);
  }
);

test(
  "R10: „Akzentfarbe“ in Feld, Hinweisen, Warnung und aria-labels; Schlüssel accentColor bleibt",
  { skip },
  async () => {
    // Schwarz auf dem Standard #007C82: 3,06:1, abgeschnitten „3,0:1“
    const html = await appearance({ userTextColor: "#222628" });
    const t = text(html);
    assert.ok(t.includes("Akzentfarbe"));
    assert.ok(t.includes("Schrift auf der Akzentfarbe"));
    assert.ok(
      t.includes("Buttons, Nutzer-Nachrichten und Links in Akzentfarbe.")
    );
    // der Hinweis unter „Schrift auf der Akzentfarbe“ („… Buttons in
    // Akzentfarbe.“) entfällt seit S3 (rc10): dort nur noch die Empfehlung
    assert.ok(t.includes("Empfohlen:"));
    assert.match(html, /aria-label="Akzentfarbe wählen"/);
    assert.match(html, /aria-label="Akzentfarbe als Farbcode"/);
    assert.ok(
      t.includes(
        "Kontrast nur 3,0:1: Unter 4,5:1 ist die Schrift auf der Akzentfarbe schwer lesbar."
      )
    );
    assert.ok(!t.includes("Kundenfarbe"));
    assert.equal(keys.FIELD_TAB.accentColor, "aussehen");
    assert.equal(
      keys.userTextColorAdvice({ accentColor: "#777777" }).warning,
      "Kontrast nur 4,4:1: Weder Weiß noch Schwarz erreicht auf dieser Akzentfarbe 4,5:1. Eine hellere oder dunklere Akzentfarbe ist besser lesbar."
    );
  }
);

// ---------------------------------------------------------------------------
// Restpunkte rc7 Nr. 1, 5, 6
// ---------------------------------------------------------------------------

test(
  "Restpunkt 1: Umbruchstellen nur nach „/“ (seit S2 rc10 nicht mehr nach „.“)",
  { skip },
  async () => {
    const embedTab = await renderer.load(EMBED);
    // C8 (Fixliste 7.22-rc16): Teile direkt aus splitAfterSlashes
    // (snippetWithBreaks entfällt, CopyBlock setzt die <wbr> selbst)
    const strings = embedTab.splitAfterSlashes(
      'src="https://kunde.ki.kufer.de/embed/anythingllm-chat-widget.min.js" data-embed-id="a-b"'
    );
    // jeder Teil außer dem letzten endet mit „/“
    for (const part of strings.slice(0, -1)) assert.match(part, /\/$/);
    assert.ok(strings.some((p) => p.includes("anythingllm-chat-widget.")));
    assert.ok(strings.some((p) => p.includes("a-b")));
  }
);

test("Restpunkt 5: durchscheinende oder ungültige Akzentfarbe: weder Empfehlung noch Warnung (nur der Feldfehler)", () => {
  for (const accentColor of [
    "rgba(0,0,0,0.15)",
    "#01A5A980",
    "rgb(0 0 0 / 0.5)",
    "#01A5",
    "red",
  ]) {
    const advice = keys.userTextColorAdvice({ accentColor });
    assert.equal(advice.recommendedLabel, null, accentColor);
    assert.equal(advice.warning, null, accentColor);
    assert.equal(advice.ratio, null, accentColor);
  }
  // deckend: wie bisher
  assert.equal(
    keys.userTextColorAdvice({ accentColor: "rgb(0, 0, 0)" }).recommendedLabel,
    "Weiß"
  );
});

test(
  "Restpunkt 5: Farbfeld breit genug, Vorschau bricht lange Wörter um",
  { skip },
  async () => {
    const look = await appearance({});
    assert.doesNotMatch(look, /w-44/);
    assert.match(look, /max-w-xs/);
    // R5: der Standard steht im Feld, kein Platzhalter
    assert.match(
      look,
      /aria-label="Akzentfarbe als Farbcode"[^>]*value="#007C82"|value="#007C82"[^>]*aria-label="Akzentfarbe als Farbcode"/
    );
    assert.doesNotMatch(look, /placeholder="#007C82"/);

    const word = "Supercalifragilistic".repeat(4);
    const html = await preview({
      defaultMessages: [word],
      greeting: word,
      privacyText: word,
      name: "VHS",
      // Kurskarten gewählt, damit auch der Kartentitel geprüft wird
      courseCards: "auto",
    });
    // die Datenschutz-Blase entfällt seit 7.23 (Datenschutz-Fußzeile); den
    // Umbruch im Datenschutz-Fenster prüft designCenterPrivacyLink.test.mjs
    for (const marker of [
      "pill",
      "greeting-bubble",
      "user-message",
      "answer-text",
      "follow-up-pill",
    ]) {
      const tag = html.match(
        new RegExp(`<[a-z]+[^>]*data-preview="${marker}"[^>]*>`)
      );
      assert.ok(tag, marker);
      assert.match(tag[0], /\[overflow-wrap:anywhere\]/, marker);
    }
    // auch die Willkommensblasen und die Kurskarten-Titel
    assert.match(
      html.replace(/\n/g, " "),
      /data-preview="course-card"[^>]*>\s*<span[^>]*\[overflow-wrap:anywhere\]/
    );
  }
);

test("Restpunkt 6: Kontrast wird abgeschnitten, nie aufgerundet (4,38 -> 4,3; 4,49 -> 4,4)", () => {
  assert.equal(keys.contrastLabel(4.38), "4,3:1");
  assert.equal(keys.contrastLabel(4.49), "4,4:1");
  assert.equal(keys.contrastLabel(4.5), "4,5:1");
  // damit nie „4,5:1“ neben der Warnung „unter 4,5:1“ steht
  for (let r = 4.4; r < 4.5; r += 0.007)
    assert.notEqual(keys.contrastLabel(r), "4,5:1", String(r));
});

// ---------------------------------------------------------------------------
// R4: Standard der Kurskarten je Darstellung (Logik; Bedienung in
// designCenterCourseAnswers.test.mjs)
// ---------------------------------------------------------------------------

test("R4: Standard wie im Server, Reihenfolge-Standard bleibt above", () => {
  assert.deepEqual(keys.COURSE_CARDS_DEFAULTS, {
    inline: "auto",
    bubble: "off",
  });
  assert.deepEqual(keys.COURSE_CARDS_DEFAULTS, server.COURSE_CARDS_DEFAULTS);
  for (const displayMode of [undefined, "bubble", "inline", " INLINE ", "x"])
    assert.equal(
      keys.choiceDefault({ displayMode }, "courseCards"),
      server.defaultCourseCards(displayMode),
      String(displayMode)
    );
  assert.equal(keys.choiceDefault({}, "courseCardsPosition"), "above");
  assert.equal(
    keys.choiceDefault({ displayMode: "inline" }, "courseCardsPosition"),
    "above"
  );
});

test(
  "R4: „(Standard)“ am passenden Button, wechselt mit der Darstellung",
  { skip },
  async () => {
    const bubble = text(await appearance({}));
    assert.ok(bubble.includes("Nur Text mit Links (Standard)"));
    assert.ok(!bubble.includes("Kurskarten (Standard)"));
    const inline = text(await appearance({ displayMode: "inline" }));
    assert.ok(inline.includes("Kurskarten (Standard)"));
    assert.ok(!inline.includes("Nur Text mit Links (Standard)"));
    assert.ok(inline.includes("Karten zuerst (Standard)"));
    // auch mit gespeicherter Wahl bleibt die Marke informativ
    const stored = text(
      await appearance({ displayMode: "inline", courseCards: "off" })
    );
    assert.ok(stored.includes("Kurskarten (Standard)"));
    // S3 (rc10, bewusst geändert): eine Zeile statt der Erklärung je
    // Darstellung; welcher Standard gilt, zeigt „(Standard)“ am Button
    assert.ok(bubble.includes("Standard hängt von der Darstellung ab."));
    assert.ok(
      !bubble.includes(
        "Standard: beim Chatfenster „Nur Text mit Links“, in der Seite „Kurskarten“."
      )
    );
  }
);

// ---------------------------------------------------------------------------
// R5: Vorbelegung, Speichern nur geänderter Felder
// ---------------------------------------------------------------------------

// Bewusste Änderung E42 (7.22-rc23): DEFAULT_SUGGESTIONS leer (bis
// 7.22-rc22 genau zwei Beispiele)
test("R5, Bewusste Änderung E42: Vorbelegungen (DEFAULT_SUGGESTIONS leer, Willkommensblasen = Widget-Standard)", () => {
  assert.deepEqual(keys.DEFAULT_SUGGESTIONS, []);
  assert.deepEqual(
    keys.LIST_DEFAULTS.defaultMessages,
    keys.DEFAULT_SUGGESTIONS
  );
  assert.deepEqual(
    keys.LIST_DEFAULTS.chatbotBubblesMessages,
    keys.DEFAULT_WELCOME_BUBBLES
  );
  for (const list of Object.values(keys.LIST_DEFAULTS))
    for (const item of list) assert.doesNotMatch(item, /[–—]|Yoga|Sprachkurse/);
  // listItems: gespeicherte Liste (auch leer), sonst eine Kopie der Vorbelegung
  assert.deepEqual(
    keys.listItems({}, "defaultMessages"),
    keys.DEFAULT_SUGGESTIONS
  );
  assert.notEqual(
    keys.listItems({}, "defaultMessages"),
    keys.DEFAULT_SUGGESTIONS
  );
  assert.deepEqual(
    keys.listItems({ defaultMessages: [] }, "defaultMessages"),
    []
  );
  assert.deepEqual(
    keys.listItems(
      { chatbotBubblesMessages: ["Hi"] },
      "chatbotBubblesMessages"
    ),
    ["Hi"]
  );
  // Feldwerte
  assert.equal(keys.nameFieldValue({}, DEFAULTS), "KI-Berater");
  assert.equal(keys.nameFieldValue({ name: "" }, DEFAULTS), "");
  assert.equal(
    keys.nameFieldValue({ name: "Ihr Online-Berater" }, DEFAULTS),
    "Ihr Online-Berater"
  );
  assert.equal(
    keys.subtitleFieldValue({}, DEFAULTS),
    "Online-Berater mit künstlicher Intelligenz"
  );
  assert.equal(
    keys.subtitleFieldValue({ assistantSubtitle: "" }, DEFAULTS),
    ""
  );
  // Platzhalter-Standard seit der Nutzerentscheidung vom 23.10.2026 wie die
  // eingeklappte Leiste; der alte Standard gilt wie die alte Vorbelegung
  // als nicht gesetzt
  assert.equal(
    keys.placeholderFieldValue({}, DEFAULTS),
    "Stellen Sie hier Ihre Frage …"
  );
  for (const sendMessageText of [
    "Wie kann ich Ihnen helfen?",
    "Ihre Frage eingeben",
    "Enter your question",
  ])
    assert.equal(
      keys.placeholderFieldValue({ sendMessageText }, DEFAULTS),
      "Stellen Sie hier Ihre Frage …"
    );
  assert.equal(
    keys.placeholderFieldValue({ sendMessageText: "Frage?" }, DEFAULTS),
    "Frage?"
  );
  assert.equal(keys.accentFieldValue({}), "#007C82");
  assert.equal(keys.accentFieldValue({ accentColor: "#1" }), "#1");
});

// Bewusste Änderung E42 (7.22-rc23): mit dem leeren Standard der
// Startvorschläge ist eine leere Liste ohne gespeicherten Wert der Standard
// (kein Schlüssel); die früheren Beispiele sind eine eigene Liste. Ein
// unverändert gespeichertes [] bleibt (Test „E42: cleanConfig …“ in
// designCenterFixesRc10.test.mjs).
test('R5, Bewusste Änderung E42: cleanConfig entfernt Werte, die dem Standard entsprechen; Untertitel "" bleibt', () => {
  const base = { initial: {}, defaults: DEFAULTS, greetingKey: "greeting" };
  const clean = (config) => keys.cleanConfig(config, base);
  assert.deepEqual(clean({ name: "KI-Berater" }), {});
  assert.deepEqual(clean({ name: " KI-Berater " }), {});
  assert.deepEqual(clean({ name: "" }), {});
  assert.deepEqual(clean({ name: " VHS " }), { name: "VHS" });
  assert.deepEqual(clean({ accentColor: "#007c82" }), {});
  // früherer Standard, jetzt eine Kundenfarbe
  assert.deepEqual(clean({ accentColor: "#01A5A9" }), {
    accentColor: "#01A5A9",
  });
  assert.deepEqual(clean({ accentColor: " " }), {});
  assert.deepEqual(clean({ accentColor: "#123456" }), {
    accentColor: "#123456",
  });
  assert.deepEqual(clean({ assistantSubtitle: "" }), { assistantSubtitle: "" });
  assert.deepEqual(
    clean({ assistantSubtitle: DEFAULTS.assistantSubtitle }),
    {}
  );
  assert.deepEqual(clean({ assistantSubtitle: " Beratung " }), {
    assistantSubtitle: "Beratung",
  });
  assert.deepEqual(clean({ sendMessageText: DEFAULTS.sendMessageText }), {});
  assert.deepEqual(
    clean({ sendMessageText: " Stellen Sie hier Ihre Frage … " }),
    {}
  );
  // alter Standard (bis 7.22.2-rc4, 23.10.2026): bleibt wie jede frühere
  // Vorbelegung stehen und gilt als nicht gesetzt
  assert.deepEqual(clean({ sendMessageText: "Ihre Frage eingeben" }), {
    sendMessageText: "Ihre Frage eingeben",
  });
  assert.deepEqual(
    clean({ defaultMessages: [...keys.DEFAULT_SUGGESTIONS] }),
    {}
  );
  assert.deepEqual(
    clean({
      defaultMessages: [
        " Ich suche einen Deutschkurs. ",
        "",
        "Gibt es Excel-Kurse am Abend?",
      ],
    }),
    {
      defaultMessages: [
        "Ich suche einen Deutschkurs.",
        "Gibt es Excel-Kurse am Abend?",
      ],
    }
  );
  assert.deepEqual(clean({ defaultMessages: [] }), {});
  assert.deepEqual(clean({ defaultMessages: ["", " "] }), {});
  assert.deepEqual(clean({ defaultMessages: ["A?", ""] }), {
    defaultMessages: ["A?"],
  });
  assert.deepEqual(clean({ chatbotBubblesMessages: [] }), {});
  assert.deepEqual(
    clean({ chatbotBubblesMessages: [...keys.DEFAULT_WELCOME_BUBBLES] }),
    {}
  );
  assert.deepEqual(clean({ chatbotBubblesMessages: ["Hallo!", ""] }), {
    chatbotBubblesMessages: ["Hallo!"],
  });
  // ohne geladene Standardtexte gilt nichts als Standard (kein Verlust)
  const noDefaults = { initial: {}, defaults: null, greetingKey: "greeting" };
  assert.deepEqual(keys.cleanConfig({ name: "KI-Berater" }, noDefaults), {
    name: "KI-Berater",
  });
  assert.deepEqual(
    keys.cleanConfig(
      { assistantSubtitle: DEFAULTS.assistantSubtitle },
      noDefaults
    ),
    { assistantSubtitle: DEFAULTS.assistantSubtitle }
  );
});

// ---------------------------------------------------------------------------
// R5, R7: Seite eingehängt
// ---------------------------------------------------------------------------

const widget = (id, visualConfig) => ({
  id,
  uuid: `uuid-${id}`,
  enabled: true,
  chat_mode: "query",
  allowlist_domains: null,
  chat_retention_days: null,
  visual_config: visualConfig === null ? null : JSON.stringify(visualConfig),
  createdAt: "2026-10-01T08:00:00.000Z",
  workspace: { id: 100 + id, name: `Workspace ${id}`, slug: `ws-${id}` },
  _count: { embed_chats: 0 },
});

function stubServer(t, embeds) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, body });
    let answer = {};
    if (url.endsWith("/embeds")) answer = { embeds };
    else if (url.includes("/embed/defaults"))
      answer = { lang: "de", defaults: DEFAULTS };
    else if (url.includes("/embed/update/"))
      answer = { success: true, error: null };
    return { ok: true, status: 200, json: async () => answer };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const button = (root, label) =>
  elements(
    root,
    (el) => el.tagName === "BUTTON" && el.textContent.trim() === label
  )[0];
const byLabel = (container, label) =>
  elements(container, (el) => el.getAttribute("aria-label") === label)[0];
const valueOf = (el) => el.getAttribute("value") ?? el.value ?? "";
const listInputs = (container, list) =>
  elements(
    elements(container, (el) => el.getAttribute("data-list") === list)[0],
    (el) => el.tagName === "INPUT"
  );

async function open(t, embeds, id, tab = null) {
  const calls = stubServer(t, embeds);
  const mounted = await renderer.mount(DESIGN_CENTER, {
    location: `/settings/embed-config/${id}/appearance`,
    route: "/settings/embed-config/:embedId/appearance",
  });
  t.after(() => mounted.unmount());
  await mounted.act();
  if (tab) await mounted.act(() => click(button(mounted.container, tab)));
  return { ...mounted, calls };
}

const savedBody = (calls) => {
  const call = calls.find((c) => c.url.includes("/embed/update/"));
  return call ? JSON.parse(call.body.visual_config) : null;
};
const unsaved = (container) =>
  container.textContent.includes("Ungespeicherte Änderungen");
const type = (act, el, value) =>
  act(() => handlersOf(el).onChange({ target: { value } }));

// Bewusste Änderung E42 (7.22-rc23): die Vorbelegung der Startvorschläge
// ist leer; eine neue leere Zeile ist noch keine Änderung, ein Text schon,
// zurück auf leer wieder nicht (bis 7.22-rc22: erste Beispielzeile ändern
// und zurück)
test(
  "R5, Bewusste Änderung E42: „Ungespeicherte Änderungen“ nur bei echter Änderung: Vorbelegung bearbeiten und zurück, Standard eintippen",
  { skip },
  async (t) => {
    const { container, act } = await open(t, [widget(9, null)], 9, "Inhalt");
    assert.ok(!unsaved(container));
    assert.deepEqual(listInputs(container, "suggestions"), []);
    await act(() => click(button(container, "Vorschlag hinzufügen")));
    const [first] = listInputs(container, "suggestions");
    assert.ok(first, "neue Zeile fehlt");
    assert.ok(!unsaved(container), "leere Zeile ist keine Änderung");
    await type(act, first, "Ich suche einen Sprachkurs.");
    assert.ok(unsaved(container));
    await type(act, first, "");
    assert.ok(!unsaved(container), "zurück auf die Vorbelegung (leer)");
    const name = byLabel(container, "Name des Chatbots");
    await type(act, name, "VHS");
    assert.ok(unsaved(container));
    await type(act, name, "KI-Berater");
    assert.ok(!unsaved(container), "Standard eingetippt");
    await type(act, name, "");
    assert.ok(!unsaved(container), "leer = Standard");
    const subtitle = byLabel(container, "Untertitel");
    await type(act, subtitle, "");
    assert.ok(unsaved(container), "leerer Untertitel ist eine Änderung");
    await type(act, subtitle, "Online-Berater mit künstlicher Intelligenz");
    assert.ok(!unsaved(container));
  }
);

test(
  'R5: Untertitel leeren speichert ""; „Standardtext“ setzt zurück (Schlüssel weg)',
  { skip },
  async (t) => {
    const stored = { accentColor: "#FFA102" };
    const { container, act, calls } = await open(
      t,
      [widget(4, stored)],
      4,
      "Inhalt"
    );
    const subtitle = byLabel(container, "Untertitel");
    assert.equal(
      valueOf(subtitle),
      "Online-Berater mit künstlicher Intelligenz"
    );
    await type(act, subtitle, "");
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { ...stored, assistantSubtitle: "" });
    // Vorschau ohne Untertitel
    assert.ok(
      !container.textContent.includes(
        "Online-Berater mit künstlicher Intelligenz"
      )
    );
    calls.length = 0;
    const standard = elements(
      subtitle.parentNode,
      (el) =>
        el.tagName === "BUTTON" && el.textContent.trim() === "Standardtext"
    )[0];
    await act(() => click(standard));
    assert.equal(
      valueOf(byLabel(container, "Untertitel")),
      "Online-Berater mit künstlicher Intelligenz"
    );
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), stored);
  }
);

test(
  "R5: Willkommensblasen bearbeiten speichert die Liste; alle gelöscht = Standardblasen (Schlüssel weg)",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(
      t,
      [widget(8, null)],
      8,
      "Inhalt"
    );
    const [first] = listInputs(container, "welcome-bubbles");
    await type(act, first, "Hallo!");
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), {
      chatbotBubblesMessages: [
        "Hallo!",
        "Möchten Sie mehr über unser Angebot erfahren? Ich helfe gerne weiter!",
      ],
    });
    calls.length = 0;
    const remove = () =>
      elements(
        elements(
          container,
          (el) => el.getAttribute("data-list") === "welcome-bubbles"
        )[0],
        (el) => el.getAttribute("aria-label") === "Eintrag entfernen"
      )[0];
    while (remove()) await act(() => click(remove()));
    assert.ok(
      container.textContent.includes(
        "Leer: es gelten die Standardblasen. Abschalten über „Willkommensblasen anzeigen“."
      )
    );
    assert.ok(unsaved(container));
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), {});
  }
);

test(
  "R5: Platzhalter und Überschrift haben „Standardtext“; der Standard als Wert wird nicht geschrieben",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(
      t,
      [widget(5, null)],
      5,
      "Inhalt"
    );
    const placeholder = byLabel(container, "Platzhalter im Eingabefeld");
    assert.equal(valueOf(placeholder), "Stellen Sie hier Ihre Frage …");
    const title = byLabel(container, "Überschrift des Datenschutz-Hinweises");
    assert.equal(valueOf(title), "Datenschutz");
    for (const field of [placeholder, title]) {
      const standard = elements(
        field.parentNode,
        (el) =>
          el.tagName === "BUTTON" && el.textContent.trim() === "Standardtext"
      )[0];
      assert.ok(standard, "Standardtext-Button");
      assert.equal(standard.getAttribute("disabled"), "");
    }
    await type(act, placeholder, "Frage?");
    await type(act, title, "Hinweis");
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), {
      sendMessageText: "Frage?",
      privacyTitle: "Hinweis",
    });
    calls.length = 0;
    const reset = elements(
      placeholder.parentNode,
      (el) =>
        el.tagName === "BUTTON" && el.textContent.trim() === "Standardtext"
    )[0];
    await act(() => click(reset));
    assert.equal(
      valueOf(byLabel(container, "Platzhalter im Eingabefeld")),
      "Stellen Sie hier Ihre Frage …"
    );
    await act(() => click(button(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { privacyTitle: "Hinweis" });
  }
);

test(
  "R6: Link zur Datenschutzerklärung unter dem Text, Willkommensblasen-Gruppe nach dem Platzhalter",
  { skip },
  async () => {
    const t = text(await show(CONTENT, contentProps({})));
    const at = (s) => {
      const i = t.indexOf(s);
      assert.ok(i >= 0, s);
      return i;
    };
    // Überschrift ohne „(optional)“ seit F12 (Fixliste datenschutz rc2)
    assert.ok(
      at("Überschrift Standardtext") < at("Link zur Datenschutzerklärung")
    );
    assert.ok(
      at("Freier Text. Zeilen mit") < at("Link zur Datenschutzerklärung")
    );
    assert.ok(at("Link zur Datenschutzerklärung") < at("Startvorschläge"));
    assert.ok(at("Startvorschläge") < at("Platzhalter im Eingabefeld"));
    assert.ok(at("Platzhalter im Eingabefeld") < at("Geschlossener Chat"));
    assert.ok(at("Geschlossener Chat") < at("Willkommensblasen anzeigen"));
    assert.ok(at("Willkommensblasen anzeigen") < at("Support-E-Mail"));
  }
);

// R7: Datenschutz-Schalter aus -> Layoutsprung und weißer Bereich (Browser-
// Messung .test-storage/r7, Playwright). Ursache: der versteckte Schalter
// (sr-only = position: absolute) hatte keinen positionierten Vorfahren und
// lag an seiner statischen Position außerhalb des Fensters; der Fokus beim
// Klick scrollte das Dokument dorthin. Hier die DOM-Bedingungen.
// Bewusste Änderung (Datenschutz-Fußzeile, Nutzer 23.10.2026, 7.23): Der
// einzige Schalter (Datenschutz-Hinweis) entfällt und mit ihm die Komponente
// Switch in controls.jsx. Bis 7.22.2 prüfte R7 hier den positionierten
// Rahmen um den versteckten Schalter; der Seitenrahmen (Test unten) bleibt.
test(
  "R7 seit 7.23: kein versteckter Schalter mehr im Reiter Inhalt, Switch entfällt",
  { skip },
  async () => {
    const html = await show(CONTENT, contentProps({}));
    assert.doesNotMatch(html, /role="switch"|data-switch-state/);
    const controls = await renderer.load(`${DIR}/controls.jsx`);
    assert.equal("Switch" in controls, false);
  }
);

test(
  "R7: Umschalten erzeugt keine Dokument-Verlängerung: Seitenwurzel ist relative und overflow-hidden",
  { skip },
  async (t) => {
    const { container } = await open(t, [widget(9, null)], 9, "Inhalt");
    const root = container.firstChild;
    const cls = root.getAttribute("class");
    assert.match(cls, /\brelative\b/);
    assert.match(cls, /\boverflow-hidden\b/);
    assert.match(cls, /\bh-screen\b/);
  }
);
