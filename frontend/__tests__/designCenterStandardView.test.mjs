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
  applySuggestion: noop,
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

test(
  "Aussehen, Chatblase: Darstellung, Farbschema, Farbe, Schrift, Logo, Position, Chat-Icon, Kasten „Fest eingebaut“",
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
      "Chatblase",
      "Inline in der Seite",
      "Farbschema",
      "Hell",
      "Dunkel",
      "Kundenfarbe",
      "Schrift in Nutzer-Nachrichten",
      "Logo",
      "Position der Chatblase",
      "Chat-Icon",
      "Fest eingebaut, für alle Chatbots gleich",
      "Begrüßung als Blase",
      "Startvorschläge als Knöpfe",
      "Folgefragen als Knöpfe",
      "KI-Hinweis unter der Eingabe",
      "Fenstergröße und Randabstand",
      "Kein Online-Punkt",
    ])
      assert.ok(t.includes(label), label);
    // KIE-565 Nachtrag: Datenschutz-Hinweis ist abschaltbar, nicht fest
    assert.ok(!t.includes("Datenschutz als zweite Blase"));
    assert.ok(
      t.includes(
        "Den Datenschutz-Hinweis schalten Sie im Reiter „Inhalt“ ein oder aus."
      )
    );
    assert.match(html, /data-testid="fixed-standards"/);
    // Lineal-Reihenfolge: der Kasten steht unter den Feldern
    assert.ok(t.indexOf("Chat-Icon") < t.indexOf("Fest eingebaut"));
    // entfallene Felder: keine Überschrift (label) mehr
    for (const label of REMOVED) assert.ok(!html.includes(`>${label}<`), label);
  }
);

test(
  "Aussehen, Inline: ohne Position und Chat-Icon, Kasten wie in der Demo",
  { skip },
  async () => {
    const html = await show(APPEARANCE, {
      config: { displayMode: "inline", theme: "dark" },
      updateField: noop,
      logoPreview: null,
    });
    const t = text(html);
    assert.ok(!html.includes(">Position der Chatblase<"));
    assert.ok(!html.includes(">Chat-Icon<"));
    for (const label of [
      "Fest eingebaut wie in unserer Demo",
      "Öffnet beim Klick ins Feld",
      "Effekt „Verwandeln“",
      "Breite und Höhe der Box",
      "Kurskarten als Zeilen, zuerst die Karten, dann die kurze Antwort",
      "Keine Auswahl nötig: Position, Chat-Icon, Fenstergröße und Effekte entfallen bei Inline.",
    ])
      assert.ok(t.includes(label), label);
    assert.ok(!t.includes("Datenschutz als zweite Blase"));
  }
);

test(
  "Inhalt: Felder in der Reihenfolge des Mockups, Willkommensblasen nur bei Chatblase",
  { skip },
  async () => {
    const bubble = text(
      await show(
        CONTENT,
        contentProps({ name: "VHS", defaultMessages: ["A?"] })
      )
    );
    const order = [
      "Name",
      "Untertitel (optional)",
      "Begrüßungstext",
      "Willkommensblasen",
      "Startvorschläge",
      "Datenschutz-Hinweis",
      "Überschrift (optional)",
      "Link zur Datenschutzerklärung",
      "Text",
      "Platzhalter im Eingabefeld",
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
    assert.ok(inline.includes("Startvorschläge"));
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
    // Platzhalter: Feld leer, Standard grau
    assert.match(html, /placeholder="Ihre Frage eingeben"[^>]*value=""/);
  }
);

test(
  "Einbau: Skript mit echten Werten, Platzhalter nur bei Inline",
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
  "Vorschau: zwei Blasen, Pillen, KI-Zeile, kein Online-Punkt; Hell/Dunkel",
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
    assert.match(
      html,
      /data-preview="disclaimer"[^>]*>KI kann Fehler machen\. Bitte überprüfen Sie die Antworten\./
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
  "D1: Kasten „Fest eingebaut“ der Chatblase nennt Kurskarten (nicht mehr „nur bei Inline“)",
  { skip },
  async () => {
    const t = text(
      await show(APPEARANCE, {
        config: {},
        updateField: noop,
        logoPreview: null,
      })
    );
    assert.ok(t.includes("Kurskarten zuerst, dann die kurze Antwort"));
    assert.ok(!t.includes("nur bei Inline"));
    assert.ok(!t.includes("Antworten mit Kurs-Links"));
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
        assert.match(pre, /break-all/);
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
        "Grauer Text im Eingabefeld des Chats. Leer = Standard."
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

test(
  "D6: leere Listen zeigen den Vorschlag mit „Vorschläge übernehmen“, gefüllte nicht",
  { skip },
  async () => {
    const empty = text(await show(CONTENT, contentProps({})));
    assert.ok(empty.includes("Noch keine gespeichert. Vorschlag:"));
    assert.ok(empty.includes("Welche Sprachkurse gibt es?"));
    assert.ok(empty.includes("Möchten Sie mehr über unser Angebot erfahren?"));
    assert.ok(empty.includes("Vorschlag übernehmen"));
    const filled = text(
      await show(
        CONTENT,
        contentProps({
          defaultMessages: ["A?"],
          chatbotBubblesMessages: ["Hallo!"],
          assistantSubtitle: "Online",
        })
      )
    );
    assert.ok(!filled.includes("Noch keine gespeichert"));
    assert.ok(!filled.includes("Vorschlag übernehmen"));
  }
);
