// Design Center vereinfacht (15./16.10.2026): Was die Reiter und die
// Vorschau zeigen. Serverseitig gerendert mit festen Eigenschaften
// (helpers/renderSettingsPage.mjs, render mit props), ohne Browser.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements } from "./helpers/testDom.mjs";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance";
const APPEARANCE = `${DIR}/AppearanceTab.jsx`;
const CONTENT = `${DIR}/ContentTab.jsx`;
const EMBED = `${DIR}/EmbedTab.jsx`;
const PREVIEW = `${DIR}/WidgetPreview.jsx`;
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const require = createRequire(import.meta.url);
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
    // Umbruchstellen im Skript-Schnipsel (EmbedTab snippetWithBreaks)
    .replace(/<wbr\/?>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

async function show(modulePath, props) {
  return renderer.render(modulePath, { location: "/", props });
}

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
  setPrivacyNotice: noop,
  addListItem: noop,
  updateListItem: noop,
  removeListItem: noop,
});

// Felder, die es nicht mehr gibt (Auftrag Abschnitt C, „Entfallen“)
const REMOVED = [
  "Startvorschläge als",
  "Begrüßung als",
  "Text der Begrüßungsblase",
  "Online-Punkt am Logo",
  "Antwort & Karten",
  "Antwort &amp; Karten",
  "Kartenlayout",
  "Antwortstil",
  "Text des KI-Hinweises",
  "Standardtexte",
  "Leisten-Stil",
  "Startzustand",
  "Fensterbreite",
  "Fensterhöhe",
  "Abstand zum Rand",
  "Max. Breite",
  "Höhe aufgeklappt",
  "Effekt beim Aufklappen",
  "Chat öffnen",
  "Knopftext",
];

// Begriffe und Aufbau seit 7.22-rc8: R2 (Zeile statt Kasten), R3
// (Chatfenster / In der Seite, Name und Untertitel), R6 (Reihenfolge im
// Reiter Inhalt), R10 (Akzentfarbe)
test(
  "Aussehen, Chatfenster: Darstellung, Farbschema, Akzentfarbe, Schrift, Logo, Position, Chat-Icon, Zeile „Fest vorgegeben“",
  { skip },
  async () => {
    const html = await show(APPEARANCE, {
      config: { position: "bottom-left", chatIcon: "support" },
      updateField: noop,
      logoPreview: null,
    });
    const t = text(html);
    for (const label of [
      "Darstellung",
      "Chatfenster",
      "In der Seite",
      "Chatfenster: Button unten in der Ecke, öffnet ein Chatfenster. In der Seite: Eingabeleiste direkt im Seiteninhalt, an der Stelle des Platzhalters (Reiter „Einbau“).",
      "Farbschema",
      "Hell",
      "Dunkel",
      "Akzentfarbe",
      "Schrift auf der Akzentfarbe",
      "Logo",
      "Position des Chat-Buttons",
      "Chat-Icon",
      "Fest vorgegeben: der KI-Hinweis unter der Eingabe und die Größe des Chatfensters.",
    ])
      assert.ok(t.includes(label), label);
    // KIE-565 Nachtrag: Datenschutz-Hinweis ist abschaltbar, nicht fest
    assert.ok(!t.includes("Datenschutz als zweite Blase"));
    // R2: kein Kasten mehr
    assert.doesNotMatch(html, /data-testid="fixed-standards"/);
    assert.ok(!t.includes("Fest eingebaut"));
    assert.match(html, /data-testid="fixed-note"/);
    // Lineal-Reihenfolge: die Zeile steht ganz unten
    assert.ok(t.indexOf("Chat-Icon") < t.indexOf("Fest vorgegeben"));
    assert.ok(t.indexOf("Antworten mit Kursen") < t.indexOf("Fest vorgegeben"));
    // R3/R10: alte Begriffe nirgends sichtbar
    assert.ok(!t.includes("Chatblase"));
    assert.doesNotMatch(t, /\bInline\b/);
    assert.ok(!t.includes("Kundenfarbe"));
    assert.ok(!t.includes("Kopf"));
    // entfallene Felder: keine Überschrift (label) mehr
    for (const label of REMOVED) assert.ok(!html.includes(`>${label}<`), label);
  }
);

test(
  "Aussehen, In der Seite: ohne Position und Chat-Icon, Zeile für die aufgeklappte Box",
  { skip },
  async () => {
    const html = await show(APPEARANCE, {
      config: { displayMode: "inline", theme: "dark" },
      updateField: noop,
      logoPreview: null,
    });
    const t = text(html);
    assert.ok(!html.includes(">Position des Chat-Buttons<"));
    assert.ok(!html.includes(">Chat-Icon<"));
    assert.ok(
      t.includes(
        "Fest vorgegeben: der KI-Hinweis unter der Eingabe und die Größe der aufgeklappten Box."
      )
    );
    assert.ok(t.includes("Auf dem Handy öffnet der Chat im Vollbild."));
    assert.ok(!t.includes("Fest eingebaut"));
    assert.ok(!t.includes("Datenschutz als zweite Blase"));
    assert.ok(!t.includes("Chatblase"));
    assert.doesNotMatch(t, /\bInline\b/);
  }
);

test(
  "Inhalt: Felder in der Reihenfolge des Chats (R6), Geschlossener Chat nur beim Chatfenster",
  { skip },
  async () => {
    const bubble = text(
      await show(
        CONTENT,
        contentProps({ name: "VHS", defaultMessages: ["A?"] })
      )
    );
    const order = [
      "Name und Untertitel",
      "Name",
      "Untertitel (optional)",
      "Begrüßung",
      "Begrüßungstext",
      "Datenschutz-Hinweis",
      "Datenschutz-Hinweis anzeigen",
      "Überschrift (optional)",
      "Text",
      "Link zur Datenschutzerklärung",
      "Startvorschläge",
      "Platzhalter im Eingabefeld",
      "Geschlossener Chat",
      "Willkommensblasen",
      "Willkommensblasen anzeigen",
      "Support-E-Mail (optional)",
    ];
    let pos = -1;
    for (const label of order) {
      const next = bubble.indexOf(label, pos + 1);
      assert.ok(next > pos, `${label} fehlt oder steht falsch`);
      pos = next;
    }
    assert.ok(bubble.includes("Standardtext"));
    assert.ok(
      bubble.includes(
        "Zeilen mit „•“ oder „-“ am Anfang werden zu Aufzählungspunkten"
      )
    );
    const bubbleHtml = await show(
      CONTENT,
      contentProps({ name: "VHS", defaultMessages: ["A?"] })
    );
    for (const label of REMOVED)
      assert.ok(!bubbleHtml.includes(`>${label}<`), label);

    const inline = text(
      await show(CONTENT, contentProps({ displayMode: "inline" }))
    );
    assert.ok(!inline.includes("Willkommensblasen"));
    assert.ok(!inline.includes("Geschlossener Chat"));
    assert.ok(inline.includes("Startvorschläge"));
    // R3: „Kopf“ nur noch als „Titelleiste des Chats“, keine alten Begriffe
    for (const page of [bubble, inline]) {
      assert.ok(!page.includes("Kopf"));
      assert.ok(page.includes("Titelleiste des Chats"));
      assert.ok(!page.includes("Chatblase"));
      assert.doesNotMatch(page, /\bInline\b/);
      assert.ok(!page.includes("Vorschlag übernehmen"));
      assert.ok(!page.includes("Vorschläge übernehmen"));
      assert.ok(!page.includes("Solange keine eigenen gespeichert sind"));
    }
  }
);

test(
  "Inhalt: Standardtexte als Wert, frühere Vorbelegungen nicht, Altformat des Datenschutz-Texts als „• “-Zeilen",
  { skip },
  async () => {
    const html = await show(
      CONTENT,
      contentProps({
        greeting:
          "Hallo und herzlich willkommen! Ich helfe Ihnen gerne weiter und beantworte Ihre Fragen mit intelligenten, KI-gestützten Antworten.",
        sendMessageText: "Wie kann ich Ihnen helfen?",
        privacyText: "Punkt eins\nPunkt zwei",
      })
    );
    assert.ok(html.includes(DEFAULTS.greeting));
    assert.ok(!html.includes("Hallo und herzlich willkommen"));
    assert.ok(html.includes("• Punkt eins\n• Punkt zwei"));
    // Platzhalter: R5, der Standard steht als Wert im Feld (frühere
    // Vorbelegung zählt nicht)
    assert.match(
      html,
      /aria-label="Platzhalter im Eingabefeld"[^>]*value="Ihre Frage eingeben"|value="Ihre Frage eingeben"[^>]*aria-label="Platzhalter im Eingabefeld"/
    );
  }
);

test(
  "Einbau: Skript mit echten Werten, Platzhalter nur bei „In der Seite“",
  { skip },
  async () => {
    const embedTab = await renderer.load(EMBED);
    assert.equal(
      embedTab.embedScriptSnippet(
        { uuid: "abc-123" },
        { dev: false, origin: "https://kunde.ki.kufer.de" }
      ),
      `<script
  data-embed-id="abc-123"
  data-base-api-url="https://kunde.ki.kufer.de/api/embed"
  src="https://kunde.ki.kufer.de/embed/anythingllm-chat-widget.min.js">
</script>`
    );
    const bubble = text(
      await show(EMBED, { config: {}, embed: { uuid: "abc-123" } })
    );
    assert.ok(bubble.includes('data-embed-id="abc-123"'));
    assert.ok(bubble.includes("Skript einmal einbauen, am besten im Footer"));
    assert.ok(!bubble.includes('<div id="kufer-assistent"></div>'));
    assert.ok(!bubble.includes("Platzhalter dort einfügen"));
    for (const name of ["WordPress", "TYPO3", "Andere"])
      assert.ok(bubble.includes(name), name);

    const inline = text(
      await show(EMBED, {
        config: { displayMode: "inline" },
        embed: { uuid: "abc-123" },
      })
    );
    assert.ok(inline.includes('<div id="kufer-assistent"></div>'));
    assert.ok(
      inline.includes(
        "Platzhalter dort einfügen, wo die Leiste erscheinen soll"
      )
    );
    assert.ok(
      inline.includes(
        "Platzhalter: Block „Individuelles HTML“ an die gewünschte Stelle."
      )
    );
  }
);

test(
  "Vorschau: zwei Blasen, Pillen, KI-Zeile (R1), kein Online-Punkt; Hell/Dunkel",
  { skip },
  async () => {
    const html = await show(PREVIEW, {
      config: {
        name: "VHS Rhein",
        assistantSubtitle: "Online-Berater",
        onlineDot: true,
        defaultMessages: ["Welche Sprachkurse gibt es?", ""],
        privacyText: "Absatz\n- Punkt",
        privacyTitle: "",
        privacyUrl: "/datenschutz",
      },
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
    });
    const t = text(html);
    assert.match(
      html,
      /data-preview="greeting-bubble"[^>]*>Hallo! Ich bin Ihr KI-Berater/
    );
    assert.match(html, /data-preview="privacy-bubble"/);
    assert.ok(t.includes("Absatz • Punkt"));
    assert.ok(t.includes("Datenschutzerklärung"));
    // leere Überschrift: keine
    assert.ok(
      !/data-preview="privacy-bubble"[^>]*><p class="font-semibold"/.test(html)
    );
    assert.match(html, /data-preview="pills"/);
    assert.ok(t.includes("Welche Sprachkurse gibt es?"));
    // R1 (7.22-rc8): „Unsere KI“
    assert.match(
      html,
      /data-preview="disclaimer"[^>]*>Unsere KI kann Fehler machen\. Bitte prüfen Sie die Antworten\./
    );
    assert.ok(!html.includes("bg-green-500"), "kein Online-Punkt");
    assert.match(html, /data-preview-theme="light"/);
    assert.doesNotMatch(t, /[–—]/);

    const dark = await show(PREVIEW, {
      config: { displayMode: "inline", theme: "dark" },
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
    });
    assert.match(dark, /data-preview-theme="dark"/);
    assert.match(dark, /data-preview="inline-bar"/);
    assert.ok(text(dark).includes("Stellen Sie hier Ihre Frage …"));
    assert.ok(text(dark).includes("Chatten"));
  }
);

test(
  "KIE-567/R2: statt des Kastens eine Zeile; Reihenfolge wählbar, nichts Widersprüchliches",
  { skip },
  async () => {
    for (const config of [{}, { displayMode: "inline" }]) {
      const t = text(
        await show(APPEARANCE, { config, updateField: noop, logoPreview: null })
      );
      assert.ok(!t.includes("Kurskarten als Zeilen mit kurzer Antwort"));
      assert.ok(!t.includes("Kurskarten zuerst, dann die kurze Antwort"));
      assert.ok(!t.includes("zuerst die Karten, dann die kurze Antwort"));
      assert.ok(!t.includes("nur bei Inline"));
      assert.equal((t.match(/Fest vorgegeben:/g) || []).length, 1);
    }
  }
);

test(
  "B-07/C04/27: Einbau bricht lange Zeilen um, Theme-Farben statt fester Farben, Hinweis auf ältere Angaben am Skript",
  { skip },
  async () => {
    for (const config of [{}, { displayMode: "inline" }]) {
      const html = await show(EMBED, { config, embed: { uuid: "abc-123" } });
      const pres = html.match(/<pre class="[^"]*"/g);
      assert.ok(pres.length >= 1);
      for (const pre of pres) {
        assert.match(pre, /whitespace-pre-wrap/);
        // Browser 7.22-rc6 B-11: nicht mitten im Wort (statt break-all)
        assert.match(pre, /\[overflow-wrap:anywhere\]/);
        assert.doesNotMatch(pre, /break-all/);
        assert.doesNotMatch(pre, /overflow-x-auto|whitespace-pre[ "]/);
      }
      assert.doesNotMatch(html, /bg-black\/30|bg-white\/5|bg-white\/10/);
      assert.ok(
        text(html).includes(
          "Alle Einstellungen kommen automatisch aus dem Design Center und gelten auch dann, wenn am Skript noch ältere Angaben stehen (z. B. data-theme)."
        )
      );
    }
    const look = await show(APPEARANCE, {
      config: {},
      updateField: noop,
      logoPreview: null,
    });
    assert.doesNotMatch(look, /bg-black\/30|bg-white\/5|bg-white\/10/);
  }
);

test(
  "B-06: ohne gespeicherte Kundenfarbe zeigen Aussehen und Vorschau das Türkis des Widgets",
  { skip },
  async () => {
    const look = await show(APPEARANCE, {
      config: {},
      updateField: noop,
      logoPreview: null,
    });
    assert.match(look, /type="color"[^>]*value="#01A5A9"/i);
    assert.ok(!look.includes("#607D8B"));
    const preview = await show(PREVIEW, {
      config: {},
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
    });
    assert.match(preview, /background-color:#01A5A9/i);
    assert.ok(!preview.includes("#607D8B"));
  }
);

test(
  "D2: Inline-Leiste der Vorschau mit Demo-Text, auch mit eigenem Platzhalter des Chat-Felds; früherer Leistentext gilt",
  { skip },
  async () => {
    const own = text(
      await show(PREVIEW, {
        config: { displayMode: "inline", sendMessageText: "Ihre Frage an uns" },
        logoPreview: null,
        defaults: DEFAULTS,
        greetingKey: "greeting",
      })
    );
    assert.ok(own.includes("Stellen Sie hier Ihre Frage …"));
    assert.ok(!own.includes("Ihre Frage an uns"));
    const legacy = text(
      await show(PREVIEW, {
        config: {
          displayMode: "inline",
          inlineInputPlaceholder: "Was suchen Sie?",
        },
        logoPreview: null,
        defaults: DEFAULTS,
        greetingKey: "greeting",
      })
    );
    assert.ok(legacy.includes("Was suchen Sie?"));
    // Hinweis beim Feld „Platzhalter“
    const bubbleHint = text(await show(CONTENT, contentProps({})));
    assert.ok(
      bubbleHint.includes(
        "Grauer Text im Eingabefeld des Chats. Leer: es gilt der Standardtext."
      )
    );
    assert.ok(!bubbleHint.includes("in der Inline-Leiste"));
    const inlineHint = text(
      await show(CONTENT, contentProps({ displayMode: "inline" }))
    );
    assert.ok(
      inlineHint.includes(
        "Die eingeklappte Leiste zeigt fest „Stellen Sie hier Ihre Frage …“."
      )
    );
    const legacyHint = text(
      await show(
        CONTENT,
        contentProps({
          displayMode: "inline",
          inlineInputPlaceholder: "Was suchen Sie?",
        })
      )
    );
    assert.ok(
      legacyHint.includes(
        "Die eingeklappte Leiste zeigt Ihren früher gespeicherten Text „Was suchen Sie?“."
      )
    );
  }
);

test(
  "B-06: aufgeklapptes Inline-Panel der Vorschau schneidet nichts ab (keine feste Höhe, kein verstecktes Scrollen)",
  { skip },
  async (t) => {
    const mounted = await renderer.mount(PREVIEW, {
      location: "/",
      props: {
        config: { displayMode: "inline" },
        logoPreview: null,
        defaults: DEFAULTS,
        greetingKey: "greeting",
      },
    });
    t.after(() => mounted.unmount());
    const { container, act } = mounted;
    const bar = elements(
      container,
      (el) => el.getAttribute("data-preview") === "inline-bar"
    )[0];
    await act(() => click(elements(bar, (el) => el.tagName === "BUTTON")[0]));
    const panel = elements(
      container,
      (el) => el.getAttribute("data-preview") === "inline-panel"
    )[0];
    assert.ok(panel, "Panel aufgeklappt");
    const style = panel.getAttribute("style") || "";
    assert.doesNotMatch(style, /(^|;)\s*height:/);
    assert.doesNotMatch(style, /max-height/);
    const messages = elements(
      panel,
      (el) => el.getAttribute("data-preview") === "inline-messages"
    )[0];
    assert.doesNotMatch(messages.getAttribute("class"), /overflow|no-scroll/);
    assert.ok(
      elements(
        panel,
        (el) => el.getAttribute("data-preview") === "privacy-bubble"
      ).length === 1
    );
  }
);

test(
  "F09/F07: Hinweise beim Datenschutz-Text und bei einer langen alten Begrüßung",
  { skip },
  async () => {
    const nbsp = text(
      await show(CONTENT, {
        ...contentProps({ privacyText: "\u00a0• Punkt\nAbsatz" }),
        initialConfig: {},
      })
    );
    assert.ok(!nbsp.includes("Ohne eine Zeile mit"));
    const legacy = text(
      await show(CONTENT, {
        // gerade eingetippt (nicht der gespeicherte Stand)
        ...contentProps({ privacyText: "a\nb" }),
        initialConfig: {},
      })
    );
    assert.ok(legacy.includes("Ohne eine Zeile mit „•“ oder „-“"));
    const long = Array(80).fill("Willkommen").join(" ");
    const greeting = text(
      await show(CONTENT, contentProps({ greeting: long }))
    );
    assert.ok(
      greeting.includes(
        "Der gespeicherte Text ist länger als 300 Zeichen. Im Chat erscheint er gekürzt (wie in der Vorschau)."
      )
    );
  }
);

// R5 (7.22-rc8, bewusst geändert): keine Vorschläge mit „übernehmen“ mehr,
// die Vorbelegung steht als Wert in den Feldern
// Werte der Eingabefelder einer Liste (bis zum Button „… hinzufügen“)
const inputValues = (html, list) => {
  const at = html.indexOf(`data-list="${list}"`);
  assert.ok(at > 0, `${list} fehlt`);
  const block = html.slice(at, html.indexOf("hinzufügen", at));
  return [...block.matchAll(/<input[^>]*value="([^"]*)"/g)].map((m) => m[1]);
};

test(
  "R5: ohne gespeicherte Werte stehen die Vorbelegungen in den Feldern, keine Vorschläge zum Übernehmen",
  { skip },
  async () => {
    const html = await show(CONTENT, contentProps({}));
    const t = text(html);
    assert.ok(!t.includes("Noch keine gespeichert"));
    assert.ok(!t.includes("übernehmen"));
    assert.deepEqual(inputValues(html, "suggestions"), [
      "Ich suche einen Deutschkurs.",
      "Gibt es Excel-Kurse am Abend?",
    ]);
    assert.deepEqual(inputValues(html, "welcome-bubbles"), [
      "Hallo! Ich bin Ihr KI-Berater.",
      "Möchten Sie mehr über unser Angebot erfahren? Ich helfe gerne weiter!",
    ]);
    assert.ok(!t.includes("Welche Sprachkurse gibt es?"));
    assert.match(
      html,
      /aria-label="Name des Chatbots"[^>]*value="KI-Berater"|value="KI-Berater"[^>]*aria-label="Name des Chatbots"/
    );
    assert.match(
      html,
      /aria-label="Untertitel"[^>]*value="Online-Berater mit künstlicher Intelligenz"|value="Online-Berater mit künstlicher Intelligenz"[^>]*aria-label="Untertitel"/
    );
    assert.ok(t.includes("Leer: es gilt „KI-Berater“."));
    assert.ok(t.includes("Leer: kein Untertitel."));

    const filled = await show(
      CONTENT,
      contentProps({
        defaultMessages: ["A?"],
        chatbotBubblesMessages: ["Hallo!"],
        assistantSubtitle: "Online",
        name: "VHS",
      })
    );
    assert.deepEqual(inputValues(filled, "suggestions"), ["A?"]);
    assert.deepEqual(inputValues(filled, "welcome-bubbles"), ["Hallo!"]);
    assert.match(filled, /value="Online"/);
    assert.match(filled, /value="VHS"/);

    // leer gespeichert: Startvorschläge [] = keine; Willkommensblasen [] =
    // Standardblasen; Untertitel "" = kein Untertitel
    const empty = await show(
      CONTENT,
      contentProps({
        defaultMessages: [],
        chatbotBubblesMessages: [],
        assistantSubtitle: "",
      })
    );
    const e = text(empty);
    assert.deepEqual(inputValues(empty, "suggestions"), []);
    assert.deepEqual(inputValues(empty, "welcome-bubbles"), []);
    assert.ok(e.includes("Leer: keine Startvorschläge."));
    assert.ok(
      e.includes(
        "Leer: es gelten die Standardblasen. Abschalten über „Willkommensblasen anzeigen“."
      )
    );
    assert.match(
      empty,
      /aria-label="Untertitel"[^>]*value=""|value=""[^>]*aria-label="Untertitel"/
    );
  }
);
