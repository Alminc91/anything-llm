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

// Vorschau „In der Seite“ eingeklappt: Sie startet seit 7.22.1 aufgeklappt
// (Spezifikation §12 Eintrag 12), die Leiste erscheint nach „Einklappen“.
async function collapsedInline(t, props) {
  const mounted = await renderer.mount(PREVIEW, { location: "/", props });
  t.after(() => mounted.unmount());
  const { container, act } = mounted;
  await act(() =>
    click(
      elements(
        container,
        (el) => el.getAttribute("aria-label") === "Einklappen"
      )[0]
    )
  );
  return container;
}
const text = (html) =>
  html
    // Umbruchstellen im Skript-Schnipsel (EmbedTab CopyBlock)
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
      // Bewusste Änderung (Datenschutz-Fußzeile, 7.23): kein Schalter
      // „Datenschutz-Hinweis anzeigen“ mehr, dafür der Hinweis zum Link
      "erscheint immer als Link „Datenschutz“ unter der Eingabe",
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
    // Vorbelegung zählt nicht); seit 23.10.2026 derselbe Text wie in der
    // eingeklappten Leiste
    assert.match(
      html,
      /aria-label="Platzhalter im Eingabefeld"[^>]*value="Stellen Sie hier Ihre Frage …"|value="Stellen Sie hier Ihre Frage …"[^>]*aria-label="Platzhalter im Eingabefeld"/
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

// Bewusste Änderung (Datenschutz-Fußzeile, Nutzer 23.10.2026, 7.23): keine
// Datenschutz-Blase mehr, die Fußzeile trägt den Link „Datenschutz“; Text und
// Link zur Datenschutzerklärung stehen im Fenster, das erst der Klick öffnet
// (designCenterPrivacyLink.test.mjs). Bis 7.22.2 hieß der Test „zwei Blasen“
// und prüfte Text, Link und leere Überschrift in der Datenschutz-Blase.
test(
  "Vorschau: Begrüßungsblase, Pillen, KI-Zeile mit Link „Datenschutz“ (R1, 7.23), kein Online-Punkt; Hell/Dunkel",
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
    assert.doesNotMatch(html, /data-preview="privacy-bubble"/);
    // Datenschutz-Text und Link erst im Fenster
    assert.ok(!t.includes("Absatz • Punkt"));
    assert.ok(!t.includes("Datenschutzerklärung"));
    assert.match(html, /data-preview="pills"/);
    assert.ok(t.includes("Welche Sprachkurse gibt es?"));
    // R1 (7.22-rc8): „Unsere KI“; seit 7.23 kurz, daneben der Link
    assert.ok(t.includes("Unsere KI kann Fehler machen · Datenschutz"));
    assert.match(html, /data-preview="privacy-link"[^>]*>Datenschutz</);
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
    // „In der Seite“ startet aufgeklappt (7.22.1); die Leiste prüft D2
    assert.match(dark, /data-preview="inline-panel"/);
    assert.doesNotMatch(dark, /data-preview="inline-bar"/);
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
  "B-07/C04/27: Einbau bricht lange Zeilen um, Theme-Farben statt fester Farben, Hinweis auf Angaben im Einbau-Code (seit E28 rc18: ändern nicht, was das Design Center einstellt)",
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
      // E23 (Fixliste 7.22-rc17 F50, bewusst geändert; vorher E18 aus
      // rc16), Wortlaut nach E28 (Fixliste 7.22-rc18 F61): Angaben im
      // Einbau-Code ändern nicht, was das Design Center einstellt
      assert.ok(
        text(html).includes(
          "Der Einbau-Code braucht nur diese Angaben. Was Sie hier im Design Center einstellen, ändern Angaben im Einbau-Code nicht."
        ),
        text(html)
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
  "B-06: ohne gespeicherte Kundenfarbe zeigen Aussehen und Vorschau das Petrol des Widgets",
  { skip },
  async () => {
    const look = await show(APPEARANCE, {
      config: {},
      updateField: noop,
      logoPreview: null,
    });
    // Standard seit 23.10.2026 Petrol #007C82, vorher Türkis #01A5A9
    assert.match(look, /type="color"[^>]*value="#007C82"/i);
    assert.ok(!look.includes("#607D8B"));
    assert.ok(!/#01A5A9/i.test(look));
    const preview = await show(PREVIEW, {
      config: {},
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
    });
    assert.match(preview, /background-color:#007C82/i);
    assert.ok(!preview.includes("#607D8B"));
    assert.ok(!/#01A5A9/i.test(preview));
  }
);

// Nutzerentscheidung 23.10.2026 (ersetzt D2): eingeklappt und aufgeklappt
// derselbe Platzhalter, der eigene Platzhalter des Chats auch in der Leiste
test(
  "23.10.2026: Inline-Leiste der Vorschau mit dem Platzhalter des Chats, auch mit eigenem Platzhalter; früherer Leistentext gilt",
  { skip },
  async (t) => {
    const props = (config) => ({
      config: { displayMode: "inline", ...config },
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
    });
    // Standard: eingeklappt und aufgeklappt „Stellen Sie hier Ihre Frage …“
    const standard = (await collapsedInline(t, props({}))).textContent;
    assert.ok(standard.includes("Stellen Sie hier Ihre Frage …"));
    assert.ok(!standard.includes("Ihre Frage eingeben"));
    const expandedStandard = text(await show(PREVIEW, props({})));
    assert.ok(expandedStandard.includes("Stellen Sie hier Ihre Frage …"));
    assert.ok(!expandedStandard.includes("Ihre Frage eingeben"));
    // eigener Platzhalter: auch eingeklappt
    const own = (
      await collapsedInline(t, props({ sendMessageText: "Ihre Frage an uns" }))
    ).textContent;
    assert.ok(own.includes("Ihre Frage an uns"));
    assert.ok(!own.includes("Stellen Sie hier Ihre Frage …"));
    // über 120 Zeichen (früher gespeichert): eingeklappt der Standard
    const long = (
      await collapsedInline(t, props({ sendMessageText: "p".repeat(121) }))
    ).textContent;
    assert.ok(long.includes("Stellen Sie hier Ihre Frage …"));
    // früher gespeicherter Leistentext geht vor
    const legacy = (
      await collapsedInline(
        t,
        props({
          inlineInputPlaceholder: "Was suchen Sie?",
          sendMessageText: "Ihre Frage an uns",
        })
      )
    ).textContent;
    assert.ok(legacy.includes("Was suchen Sie?"));
    assert.ok(!legacy.includes("Ihre Frage an uns"));
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
        "Grauer Text im Eingabefeld des Chats. Leer: es gilt der Standardtext. Die eingeklappte Leiste zeigt denselben Text."
      )
    );
    assert.ok(!inlineHint.includes("zeigt fest"));
    // auch mit eigenem Platzhalter derselbe Text
    const ownHint = text(
      await show(
        CONTENT,
        contentProps({
          displayMode: "inline",
          sendMessageText: "Ihre Frage an uns",
        })
      )
    );
    assert.ok(
      ownHint.includes("Die eingeklappte Leiste zeigt denselben Text.")
    );
    // früher gespeicherter Platzhalter über 120 Zeichen: Leiste mit Standard
    const longHint = text(
      await show(
        CONTENT,
        contentProps({
          displayMode: "inline",
          sendMessageText: "p".repeat(121),
        })
      )
    );
    assert.ok(
      longHint.includes(
        "Die eingeklappte Leiste zeigt „Stellen Sie hier Ihre Frage …“."
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
  "B-06 / 20.10.: aufgeklapptes Inline-Panel der Vorschau schneidet nichts ab: feste Höhe wie live (520 px), der Verlauf scrollt innen mit sichtbarer Bildlaufleiste (kein verstecktes Scrollen), Link „Datenschutz“ statt Datenschutz-Blase (7.23)",
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
    const { container } = mounted;
    // startet aufgeklappt (7.22.1, Spezifikation §12 Eintrag 12)
    assert.equal(
      elements(
        container,
        (el) => el.getAttribute("data-preview") === "inline-bar"
      ).length,
      0
    );
    const panel = elements(
      container,
      (el) => el.getAttribute("data-preview") === "inline-panel"
    )[0];
    assert.ok(panel, "Panel aufgeklappt");
    assert.equal(panel.style.height, "520px");
    assert.ok(!panel.style.maxHeight && !panel.style.minHeight);
    const messages = elements(
      panel,
      (el) => el.getAttribute("data-preview") === "inline-messages"
    )[0];
    assert.match(messages.getAttribute("class"), /\boverflow-y-auto\b/);
    assert.match(messages.getAttribute("class"), /\bpreview-scrollbar\b/);
    assert.doesNotMatch(messages.getAttribute("class"), /no-scroll/);
    // Bewusste Änderung (Datenschutz-Fußzeile, 7.23): keine Datenschutz-
    // Blase mehr, der Link steht in der Fußzeile des Panels
    assert.equal(
      elements(
        panel,
        (el) => el.getAttribute("data-preview") === "privacy-bubble"
      ).length,
      0
    );
    assert.equal(
      elements(
        panel,
        (el) => el.getAttribute("data-preview") === "privacy-link"
      ).length,
      1
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

// Bewusste Änderung E42 (7.22-rc23): die Vorbelegung der Startvorschläge
// ist leer, das Feld zeigt ohne gespeicherte Liste keine Zeile, nur den
// Hinweis (bis 7.22-rc22 zwei Beispiele)
test(
  "R5, Bewusste Änderung E42: ohne gespeicherte Werte stehen die Vorbelegungen in den Feldern, Startvorschläge leer, keine Vorschläge zum Übernehmen",
  { skip },
  async () => {
    const html = await show(CONTENT, contentProps({}));
    const t = text(html);
    assert.ok(!t.includes("Noch keine gespeichert"));
    assert.ok(!t.includes("übernehmen"));
    assert.deepEqual(inputValues(html, "suggestions"), []);
    assert.ok(t.includes("Leer: keine Startvorschläge."));
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

// Bewusste Änderung (Datenschutz-Fußzeile, Nutzer 23.10.2026, 7.23): Die
// Datenschutz-Blase entfällt; das Datenschutz-Fenster hat Fläche und Schrift
// der Begrüßungs- und Antwortblasen (D2). Bis 7.22.2 prüfte der Test die
// Datenschutz-Blase wie die Begrüßung (Fläche, Schatten, Schriftgröße).
test(
  "Nutzer 23.10.2026: Begrüßungsblase und Datenschutz-Fenster der Vorschau wie im Widget (Fläche, Schriftgröße), hell weiß, dunkel #2a2a2f",
  { skip },
  async (t) => {
    for (const [theme, bg] of [
      ["light", "#ffffff"],
      ["dark", "#2a2a2f"],
    ]) {
      const html = await show(PREVIEW, {
        config: { theme },
        logoPreview: null,
        defaults: DEFAULTS,
        greetingKey: "greeting",
      });
      const greeting = html.match(
        /<div[^>]*data-preview="greeting-bubble"[^>]*>/
      )?.[0];
      assert.ok(greeting, theme);
      assert.match(greeting, new RegExp(`background-color:${bg}`, "i"), theme);
      assert.match(greeting, /box-shadow:0 4px 14px/, theme);
      assert.match(greeting, /text-\[12\.5px\]/, theme);
      assert.doesNotMatch(html, /text-\[11\.5px\]/, theme);
      assert.doesNotMatch(html, /data-preview="privacy-bubble"/, theme);

      const mounted = await renderer.mount(PREVIEW, {
        location: "/",
        props: {
          config: { theme },
          logoPreview: null,
          defaults: DEFAULTS,
          greetingKey: "greeting",
        },
      });
      t.after(() => mounted.unmount());
      const { container, act } = mounted;
      const byPreview = (name) =>
        elements(
          container,
          (el) => el.getAttribute("data-preview") === name
        )[0];
      await act(() => click(byPreview("privacy-link")));
      const dialog = byPreview("privacy-dialog");
      assert.ok(dialog, theme);
      assert.equal(
        dialog.style.backgroundColor.toLowerCase(),
        bg.toLowerCase(),
        theme
      );
      assert.match(
        byPreview("privacy-dialog-body").getAttribute("class"),
        /text-\[12\.5px\]/
      );
      // lange Wörter brechen um wie in den Blasen (Restpunkt 5, rc7)
      assert.match(
        byPreview("privacy-dialog-body").getAttribute("class"),
        /\[overflow-wrap:anywhere\]/
      );
    }
  }
);

test(
  "Nutzer 23.10.2026: Schatten des aufgeklappten Panels „In der Seite“ aus der Akzentfarbe (wie im Widget), hell getönt, dunkel mit Rand in der Akzentfarbe",
  { skip },
  async () => {
    const { inlinePanelShadow } = await renderer.load(PREVIEW);
    // Petrol (Standard) und das Orange der rhein-Demo: Akzent × 0,33
    assert.equal(
      inlinePanelShadow("#007C82", "light"),
      "0 30px 70px -30px rgba(0,41,43,.45), 0 4px 14px rgba(23,24,27,.06)"
    );
    assert.equal(
      inlinePanelShadow("#C4430A", "light"),
      "0 30px 70px -30px rgba(65,22,3,.45), 0 4px 14px rgba(23,24,27,.06)"
    );
    assert.equal(
      inlinePanelShadow("#C4430A", "dark"),
      "0 30px 70px -30px rgba(0,0,0,.8), 0 0 0 1px rgba(196,67,10,.1)"
    );
    // ungültige Farbe: Standard
    assert.equal(
      inlinePanelShadow("kein-farbcode", "light"),
      inlinePanelShadow("#007C82", "light")
    );
    const html = await show(PREVIEW, {
      config: { displayMode: "inline", accentColor: "#C4430A" },
      logoPreview: null,
      defaults: DEFAULTS,
      greetingKey: "greeting",
    });
    const panel = html.match(/<div[^>]*data-preview="inline-panel"[^>]*>/)?.[0];
    assert.ok(panel, "Panel");
    assert.match(panel, /box-shadow:0 30px 70px -30px rgba\(65,22,3,\.45\)/);
  }
);
