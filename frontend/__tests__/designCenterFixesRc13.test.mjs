// Korrekturrunde 7.22-rc13 (Fixliste fixliste-7.22-rc13.md, Abschnitt
// „F · Fork“, Funde aus review-7.22-nachreview-rc12.md), Teil Design Center
// ohne eingehängte Seite (Logik und serverseitig gerendertes HTML):
// F04 Begrüßung bleibt beim Datenschutz-Schalter der Text aus dem Feld.
// F05 Unverändert gespeicherte Standardwerte bleiben beim Speichern stehen.
// F06 Kein Lookbehind im Frontend (Safari unter 16.4).
// F07 Im Einbau-Schnipsel sind nur die Adressen nicht umbrechend.
// F09 Dialog „Einbettungscode kopieren“ mit „In der Seite“ und „Chatfenster“.
// F10 Neue Bildlaufposition, damit ein bearbeiteter Block sichtbar ist.
// F11 Klick auf die markierte Option schreibt nichts (withLook).
// F12 Unter „Schrift auf der Akzentfarbe“ nur die Empfehlung.
// C1  Nachschlagen der Altfarbe nur mit eigenen Schlüsseln.
// C2  Grenze des Datenschutz-Texts mit Tausenderpunkt.
// N3  Kopf der Vorschau: Name und Untertitel brechen um, nie gekürzt
//     (Nutzerentscheidung 20.10.2026, wie im Widget).
// E15 Felder paarweise ab Desktop (Tailwind xl, 1.280 px) statt 1.100 px.
// Mit eingehängter Seite (Speichern, Vorschau): designCenterFixesRc13Save.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements } from "./helpers/testDom.mjs";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance";
const APPEARANCE = `${DIR}/AppearanceTab.jsx`;
const CONTENT = `${DIR}/ContentTab.jsx`;
const CONTROLS = `${DIR}/controls.jsx`;
const EMBED = `${DIR}/EmbedTab.jsx`;
const PREVIEW = `${DIR}/WidgetPreview.jsx`;
const FRONTEND = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const require = createRequire(import.meta.url);
const {
  embedDefaultTexts,
} = require("../../server/utils/chats/embedDefaults.js");
const server = require("../../server/utils/chats/embedStandards.js");
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
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// F05 Unverändert gespeicherte Standardwerte bleiben
// ---------------------------------------------------------------------------

// Gespeichert sind genau die Standards (frühere Design-Center-Versionen
// speicherten volle Konfigurationen)
const STORED_DEFAULTS = {
  accentColor: "#01A5A9",
  name: "KI-Berater",
  assistantSubtitle: DEFAULTS.assistantSubtitle,
  sendMessageText: DEFAULTS.sendMessageText,
  greeting: DEFAULTS.greeting,
  privacyTitle: DEFAULTS.privacyTitle,
  defaultMessages: [...DEFAULTS.defaultMessages],
  chatbotBubblesMessages: [...keys.DEFAULT_WELCOME_BUBBLES],
};

test("F05: unverändert gespeicherte Standardwerte bleiben beim Speichern eines anderen Feldes", () => {
  const initial = { ...STORED_DEFAULTS };
  const config = { ...initial, theme: "dark" };
  const out = keys.cleanConfig(config, { initial, defaults: DEFAULTS });
  assert.deepEqual(out, { ...STORED_DEFAULTS, theme: "dark" });
  // ein gespeichertes [] der Willkommensblasen bleibt ebenso stehen
  const empty = { chatbotBubblesMessages: [] };
  assert.deepEqual(
    keys.cleanConfig({ ...empty, theme: "dark" }, { initial: empty }),
    { chatbotBubblesMessages: [], theme: "dark" }
  );

  // in dieser Sitzung auf den Standard gebracht -> Schlüssel entfernt (R5)
  const own = {
    accentColor: "#123456",
    name: "VHS",
    assistantSubtitle: "Eigener Untertitel",
    sendMessageText: "Eigene Frage?",
    privacyTitle: "Hinweis",
    defaultMessages: ["Eigene?"],
    chatbotBubblesMessages: ["Eigene Blase"],
  };
  const reset = { ...STORED_DEFAULTS, accentColor: "#01a5a9" };
  delete reset.greeting;
  assert.deepEqual(
    keys.cleanConfig(reset, { initial: own, defaults: DEFAULTS }),
    {}
  );
  // ohne gespeicherten Stand (initial {}) wie bisher: Standard -> entfernt
  assert.deepEqual(
    keys.cleanConfig(
      { accentColor: "#01A5A9", name: " KI-Berater " },
      {
        defaults: DEFAULTS,
      }
    ),
    {}
  );
});

test("F05: Liste bearbeitet und wieder auf den gespeicherten Inhalt gebracht gilt als unverändert", () => {
  const initial = { defaultMessages: [...DEFAULTS.defaultMessages] };
  // neues Array mit demselben Inhalt (nach Bearbeiten und Zurücksetzen)
  const config = { defaultMessages: [...DEFAULTS.defaultMessages] };
  assert.deepEqual(
    keys.cleanConfig(config, { initial, defaults: DEFAULTS }),
    initial
  );
});

// ---------------------------------------------------------------------------
// F04 Begrüßung bleibt beim Datenschutz-Schalter der Text aus dem Feld
// ---------------------------------------------------------------------------

const BOTH_TEXTS = {
  greeting: "Willkommen bei der VHS X",
  greetingBubbleText: "Hallo, alter Blasentext",
  greetingStyle: "text",
};

test("F04: Einschalten aus „none“ -> Begrüßung bleibt greeting, der unsichtbare Blasentext entfällt", () => {
  const initial = { ...BOTH_TEXTS, privacyNotice: "none" };
  const gKey = keys.greetingKey(initial);
  assert.equal(gKey, "greeting");
  assert.equal(server.effectiveGreeting(initial), BOTH_TEXTS.greeting);
  const config = keys.withPrivacyNotice(initial, initial, true);
  const out = keys.cleanConfig(config, {
    initial,
    defaults: DEFAULTS,
    greetingKey: gKey,
  });
  assert.equal(out.privacyNotice, "bubble");
  assert.equal(out.greeting, BOTH_TEXTS.greeting);
  assert.ok(!("greetingBubbleText" in out));
  // live (Server) dieselbe Begrüßung wie vorher und im Feld
  assert.equal(server.effectiveGreeting(out), BOTH_TEXTS.greeting);
  assert.equal(keys.greetingKey(out), gKey);

  // ohne Wechsel des Schalters bleibt alles stehen (kein Datenverlust)
  for (const privacyNotice of ["none", "bubble", undefined]) {
    const stored = { ...BOTH_TEXTS };
    if (privacyNotice) stored.privacyNotice = privacyNotice;
    const kept = keys.cleanConfig(
      { ...stored, theme: "dark" },
      {
        initial: stored,
        defaults: DEFAULTS,
        greetingKey: keys.greetingKey(stored),
      }
    );
    assert.deepEqual(kept, { ...stored, theme: "dark" });
  }
});

test("F04: Ausschalten bei „bubble“ -> Begrüßung bleibt der Blasentext, greeting entfällt", () => {
  const initial = { ...BOTH_TEXTS, privacyNotice: "bubble" };
  const gKey = keys.greetingKey(initial);
  assert.equal(gKey, "greetingBubbleText");
  const config = keys.withPrivacyNotice(initial, initial, false);
  const out = keys.cleanConfig(config, {
    initial,
    defaults: DEFAULTS,
    greetingKey: gKey,
  });
  assert.equal(out.privacyNotice, "none");
  assert.equal(out.greetingBubbleText, BOTH_TEXTS.greetingBubbleText);
  assert.ok(!("greeting" in out));
  assert.equal(server.effectiveGreeting(out), BOTH_TEXTS.greetingBubbleText);
});

// ---------------------------------------------------------------------------
// F11 Klick auf die markierte Option schreibt nichts
// ---------------------------------------------------------------------------

test("F11: Klick auf den markierten Standard ohne gespeicherten Wert schreibt nichts", () => {
  for (const [key, value] of [
    ["position", "bottom-left"],
    ["theme", "light"],
    ["displayMode", "bubble"],
    ["chatIcon", "chatBubble"],
  ]) {
    const out = keys.withLook({}, {}, key, value);
    assert.ok(!(key in out), `${key}: ${JSON.stringify(out)}`);
  }
});

test("F11: andere Option gesetzt, zurück auf den Standard entfernt den Schlüssel wieder", () => {
  const right = keys.withLook({}, {}, "position", "bottom-right");
  assert.equal(right.position, "bottom-right");
  assert.ok(
    !("position" in keys.withLook(right, {}, "position", "bottom-left"))
  );
  const dark = keys.withLook({ name: "VHS" }, {}, "theme", "dark");
  assert.deepEqual(dark, { name: "VHS", theme: "dark" });
  assert.deepEqual(keys.withLook(dark, {}, "theme", "light"), { name: "VHS" });
});

test("F11: gespeicherter Wert bleibt wörtlich, wenn er schon markiert ist", () => {
  const initial = { displayMode: " Inline ", theme: "DARK" };
  assert.equal(
    keys.withLook(initial, initial, "displayMode", "inline").displayMode,
    " Inline "
  );
  assert.equal(keys.withLook(initial, initial, "theme", "dark").theme, "DARK");
  // früheres „auto“ (nichts markiert): Hell wird gesetzt
  const auto = { theme: "auto" };
  assert.equal(keys.withLook(auto, auto, "theme", "light").theme, "light");
  // gespeichertes Rechts, Klick auf Links: Links wird geschrieben
  const stored = { position: "bottom-right" };
  assert.equal(
    keys.withLook(stored, stored, "position", "bottom-left").position,
    "bottom-left"
  );
});

// ---------------------------------------------------------------------------
// F12 nur die Empfehlung
// ---------------------------------------------------------------------------

test(
  "F12: unter „Schrift auf der Akzentfarbe“ nur „Empfohlen: …“, ohne Zusatzsatz",
  { skip },
  async () => {
    for (const config of [
      {},
      { accentColor: "#003366" },
      { displayMode: "inline" },
    ]) {
      const html = await renderer.render(APPEARANCE, {
        location: "/",
        props: {
          config,
          updateField: noop,
          setChoice: noop,
          logoPreview: null,
        },
      });
      const advice = html.match(
        /data-testid="user-text-advice"[^>]*>\s*<p[^>]*>([^<]*)<\/p>/
      );
      assert.ok(advice, "Empfehlung fehlt");
      assert.match(advice[1], /^Empfohlen: (Weiß|Schwarz)$/);
      assert.ok(!text(html).includes("Solange Sie nichts wählen"));
    }
  }
);

// ---------------------------------------------------------------------------
// F06 kein Lookbehind, F07 nur Adressen nicht umbrechend
// ---------------------------------------------------------------------------

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(jsx?|mjs)$/.test(entry.name) ? [full] : [];
  });
}

test("F06: kein Lookbehind (?<= bzw. (?<! in den Quellen des Frontends (Safari unter 16.4)", () => {
  const hits = sourceFiles(path.join(FRONTEND, "src")).filter((file) =>
    /\(\?<[=!]/.test(fs.readFileSync(file, "utf8"))
  );
  assert.deepEqual(
    hits.map((f) => path.relative(FRONTEND, f)),
    []
  );
});

test(
  "F06: splitAfterSlashes trennt wie bisher nach „/“, nicht nach „</“",
  { skip },
  async () => {
    const embedTab = await renderer.load(EMBED);
    // Bezug: der frühere Ausdruck (hier in Node, nicht im Bundle)
    const before = (s) => s.split(new RegExp("(?<=[^<]\\/)"));
    for (const sample of [
      embedTab.embedScriptSnippet(
        { uuid: "abc-123" },
        { dev: false, origin: "https://kunde.ki.kufer.de" }
      ),
      '<div id="kufer-assistent"></div>',
      "/a/b/",
      "a",
      "",
      "</script>",
      "//x",
    ])
      assert.deepEqual(
        embedTab.splitAfterSlashes(sample),
        before(sample),
        JSON.stringify(sample)
      );
  }
);

test(
  "F07: nur die Adressen sind nicht umbrechende Stücke; die Zeile mit der UUID bricht um",
  { skip },
  async () => {
    const uuid = "0d6c1f3e-5a4b-4c2d-9e8f-123456789abc";
    const embedTab = await renderer.load(EMBED);
    const snippet = embedTab.embedScriptSnippet(
      { uuid },
      { dev: false, origin: "https://kunde.ki.kufer.de" }
    );
    const segments = embedTab.snippetSegments(snippet);
    assert.equal(segments.map((s) => s.text).join(""), snippet);
    assert.deepEqual(
      segments.filter((s) => s.url).map((s) => s.text),
      [
        "https://kunde.ki.kufer.de/api/embed",
        "https://kunde.ki.kufer.de/embed/anythingllm-chat-widget.min.js",
      ]
    );
    assert.ok(
      segments.some((s) => !s.url && s.text.includes(`data-embed-id="${uuid}"`))
    );
    // Platzhalter ohne Adresse: ein freier Abschnitt
    assert.deepEqual(
      embedTab.snippetSegments('<div id="kufer-assistent"></div>'),
      [{ text: '<div id="kufer-assistent"></div>', url: false }]
    );
    // im HTML: die UUID-Zeile steht in keinem whitespace-pre-Stück
    const html = await renderer.render(EMBED, {
      location: "/",
      props: { config: {}, embed: { uuid } },
    });
    const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1];
    const parts = [
      ...pre.matchAll(
        /<span class="whitespace-pre" data-snippet-part="">([\s\S]*?)<\/span>/g
      ),
    ].map((m) => m[1]);
    assert.ok(parts.length >= 5);
    assert.ok(!parts.some((p) => p.includes(uuid)), parts.join("|"));
    const free = pre.replace(
      /<span class="whitespace-pre" data-snippet-part="">[\s\S]*?<\/span>|<wbr\/?>/g,
      ""
    );
    assert.ok(free.includes(`data-embed-id=&quot;${uuid}&quot;`), free);
  }
);

// ---------------------------------------------------------------------------
// F09 Dialog „Einbettungscode kopieren“
// ---------------------------------------------------------------------------

test("F09: Dialog „Einbettungscode kopieren“ nennt „In der Seite“ und „Chatfenster“, nicht „Inline“ oder „Chat-Blase“", async () => {
  for (const lang of ["de", "en"]) {
    const { default: locale } = await import(
      `../src/locales/${lang}/common.js`
    );
    const { label, hint } = locale["code-snippet-modal"]["inline-tag"];
    for (const value of [label, hint]) {
      assert.doesNotMatch(value, /\bInline\b|inline display/i, value);
      assert.doesNotMatch(value, /Chat-Blase|chat bubble/i, value);
      assert.doesNotMatch(value, /[–—]/, value);
    }
    assert.ok(label.includes("In der Seite"), label);
    assert.ok(
      hint.includes("„In der Seite“") || hint.includes("“In der Seite”"),
      hint
    );
    assert.ok(hint.includes("Chatfenster"), hint);
  }
  const { default: de } = await import("../src/locales/de/common.js");
  assert.ok(
    de["code-snippet-modal"]["inline-tag"].hint.includes(
      "Fehlt der Platzhalter auf einer Seite, erscheint dort automatisch das Chatfenster."
    )
  );
});

// ---------------------------------------------------------------------------
// F10 Bildlaufposition für den bearbeiteten Block
// ---------------------------------------------------------------------------

test(
  "F10: revealScrollTop holt einen Block oben oder unten ins Bild, sichtbar bleibt alles",
  { skip },
  async () => {
    const { revealScrollTop, REVEAL_MARGIN_PX: m } =
      await renderer.load(PREVIEW);
    const view = { viewTop: 100, viewBottom: 554 };
    // Begrüßung oben verdeckt (Verlauf um 116 px nach unten gescrollt)
    assert.equal(
      revealScrollTop({ scrollTop: 116, ...view, top: 0, bottom: 40 }),
      116 - (100 + m - 0)
    );
    // nie unter 0
    assert.equal(
      revealScrollTop({ scrollTop: 20, ...view, top: -400, bottom: -300 }),
      0
    );
    // unten verdeckt: so weit, dass die Unterkante sichtbar ist
    assert.equal(
      revealScrollTop({ scrollTop: 0, ...view, top: 500, bottom: 600 }),
      600 - (554 - m)
    );
    // höher als der Verlauf: die Oberkante bleibt sichtbar
    assert.equal(
      revealScrollTop({ scrollTop: 0, ...view, top: 300, bottom: 1300 }),
      300 - (100 + m)
    );
    // sichtbar: unverändert
    assert.equal(
      revealScrollTop({ scrollTop: 50, ...view, top: 200, bottom: 300 }),
      50
    );
  }
);

// ---------------------------------------------------------------------------
// C1, C2
// ---------------------------------------------------------------------------

test("C1: Namen von Object.prototype als gespeicherte Schrift bleiben der Text", () => {
  for (const userTextColor of ["__proto__", "constructor", " Constructor "])
    assert.equal(
      keys.storedUserTextColor({ userTextColor }),
      userTextColor,
      userTextColor
    );
  assert.equal(
    keys.storedUserTextColor({ userTextColor: "#000000" }),
    "#222628"
  );
});

test("C2: Grenze des Datenschutz-Texts mit Tausenderpunkt in beiden Meldungen", () => {
  assert.equal(
    keys.privacyTextError("x".repeat(1001)),
    "Maximal 1.000 Zeichen insgesamt."
  );
  const raw = Array(10).fill("x".repeat(99)).join("\n");
  assert.equal(
    keys.privacyTextError(raw),
    "Maximal 1.000 Zeichen insgesamt, mit den Zeichen „• “ am Zeilenanfang."
  );
});

// ---------------------------------------------------------------------------
// N3 Kopf der Vorschau: umbrechen statt kürzen
// ---------------------------------------------------------------------------

// Langer Kundenname (ein langes Wort darin) und Untertitel bis zur Grenze
// von 60 Zeichen
const LONG_NAME =
  "Volkshochschule Landkreis Mittelweserbergland Weiterbildungsberatungszentrum";
const LONG_SUBTITLE =
  "Ihre persönliche Beratung zu allen Kursen und Anmeldungen";
const NO_SHORTENING =
  /\btruncate\b|text-ellipsis|whitespace-nowrap|overflow-hidden|line-clamp/;

const previewProps = (config) => ({
  config,
  logoPreview: null,
  defaults: DEFAULTS,
  greetingKey: "greeting",
});

// Klassen des Elements, dessen Inhalt genau dieser Text ist
function classOfText(html, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = html.match(
    new RegExp(`<span class="([^"]*)"[^>]*>${escaped}</span>`)
  );
  assert.ok(m, `Text fehlt: ${value}`);
  return m[1];
}
// Klassen der Kopfzeile (der Container um das Logo)
function headerClass(html) {
  const m = html.match(/<div class="([^"]*)"[^>]*><img [^>]*alt="Logo"/);
  assert.ok(m, "Kopfzeile fehlt");
  return m[1];
}
function assertWraps(cls, what) {
  assert.doesNotMatch(cls, NO_SHORTENING, `${what}: ${cls}`);
  assert.ok(cls.includes("[overflow-wrap:anywhere]"), `${what}: ${cls}`);
}

test(
  "N3: Chatfenster: langer Name, Standard-Untertitel und langer Untertitel stehen vollständig im Kopf, umbrechend statt gekürzt, der Kopf wächst",
  { skip },
  async () => {
    for (const config of [
      { name: LONG_NAME },
      { name: LONG_NAME, assistantSubtitle: LONG_SUBTITLE },
    ]) {
      const html = await renderer.render(PREVIEW, {
        location: "/",
        props: previewProps(config),
      });
      const subtitle = config.assistantSubtitle ?? DEFAULTS.assistantSubtitle;
      assertWraps(classOfText(html, LONG_NAME), "Name");
      assertWraps(classOfText(html, subtitle), "Untertitel");
      const header = headerClass(html);
      // keine feste Höhe: mindestens 60 px, mit dem Text höher
      assert.doesNotMatch(header, /(^|\s)h-\[60px\]/, header);
      assert.match(header, /(^|\s)min-h-\[60px\]/, header);
      assert.doesNotMatch(header, NO_SHORTENING, header);
    }
  }
);

test(
  "N3: In der Seite, aufgeklappt: Name und Untertitel vollständig und umbrechend, der Button rechts bleibt daneben",
  { skip },
  async (t) => {
    const mounted = await renderer.mount(PREVIEW, {
      location: "/",
      props: previewProps({
        displayMode: "inline",
        name: LONG_NAME,
        assistantSubtitle: LONG_SUBTITLE,
      }),
    });
    t.after(() => mounted.unmount());
    const { container, act } = mounted;
    const bar = elements(
      container,
      (el) => el.getAttribute("data-preview") === "inline-bar"
    )[0];
    await act(() => click(elements(bar, (el) => el.tagName === "BUTTON")[0]));
    const byText = (value) =>
      elements(
        container,
        (el) => el.tagName === "SPAN" && el.textContent === value
      )[0];
    for (const [value, what] of [
      [LONG_NAME, "Name"],
      [LONG_SUBTITLE, "Untertitel"],
    ]) {
      const el = byText(value);
      assert.ok(el, `${what} fehlt`);
      assertWraps(el.getAttribute("class") || "", what);
    }
    // Kopfzeile: der Button „Einklappen“ liegt neben dem Text in einem
    // nicht schrumpfenden Bereich
    const collapse = elements(
      container,
      (el) => el.getAttribute("aria-label") === "Einklappen"
    )[0];
    assert.ok(collapse, "Einklappen");
    const holder = collapse.parentNode;
    assert.match(holder.getAttribute("class") || "", /\bflex-shrink-0\b/);
    const header = holder.parentNode;
    assert.match(header.getAttribute("class") || "", /\bmin-h-\[60px\]/);
    assert.ok(header.textContent.includes(LONG_NAME));
    assert.ok(header.textContent.includes(LONG_SUBTITLE));
  }
);

// ---------------------------------------------------------------------------
// E15 Felder paarweise ab Desktop
// ---------------------------------------------------------------------------

test(
  "E15: Felder paarweise ab Desktop (xl, 1.280 px), keine eigene Schwelle bei 1.100 px",
  { skip },
  async () => {
    const controls = await renderer.load(CONTROLS);
    const cls = controls.FIELD_PAIR_CLASS.split(/\s+/);
    assert.ok(cls.includes("grid-cols-1"), controls.FIELD_PAIR_CLASS);
    assert.ok(cls.includes("xl:grid-cols-2"), controls.FIELD_PAIR_CLASS);
    // keine Zwischenschwelle (min-[…], md:, lg:) für die Spalten
    assert.ok(
      !cls.some((c) => /^(min-\[|md:|lg:|2xl:).*grid-cols/.test(c)),
      controls.FIELD_PAIR_CLASS
    );
    // so in beiden Reitern gerendert
    for (const [modulePath, props] of [
      [
        APPEARANCE,
        {
          config: {},
          updateField: noop,
          setChoice: noop,
          logoPreview: null,
        },
      ],
      [
        CONTENT,
        {
          config: {},
          initialConfig: {},
          errors: {},
          defaults: DEFAULTS,
          defaultsError: false,
          greetingKey: "greeting",
          updateField: noop,
          updateOptionalField: noop,
          resetKeys: noop,
          setPrivacyNotice: noop,
          setChoice: noop,
          addListItem: noop,
          updateListItem: noop,
          removeListItem: noop,
        },
      ],
    ]) {
      const html = await renderer.render(modulePath, { location: "/", props });
      const pairs = [...html.matchAll(/<div class="([^"]*)" data-pair="">/g)];
      assert.ok(pairs.length > 0, modulePath);
      for (const [, pairClass] of pairs) {
        assert.ok(pairClass.split(/\s+/).includes("xl:grid-cols-2"), pairClass);
        assert.doesNotMatch(pairClass, /1100px/, pairClass);
      }
    }
  }
);
