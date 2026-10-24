// Korrekturrunde 7.22-rc9 (Fixliste fixliste-7.22-rc9.md), R11: Reiter
// Aussehen und Inhalt kompakter. Kurze, zusammengehörige Felder stehen
// paarweise in einem Zweispalten-Raster (ab 1.100 px Fensterbreite, seit
// rc13 E15 ab 1.280 px, darunter einspaltig), Hinweise unter dem jeweiligen
// Feld; Darstellung, Begrüßung, Datenschutz-Text, Link, Listen bleiben
// einspaltig. Begrüßung und Datenschutz-Text wachsen mit dem Inhalt
// (Mindesthöhe 2 bzw. 5 Zeilen, keine innere Bildlaufleiste).
// Willkommensblasen anzeigen mit kurzen Beschriftungen Aus / Erster Besuch /
// Jeder Besuch (Schlüssel unverändert);
// Desktop und Handy bleiben je eine Zeile, weil zwei Auswahlgruppen in der
// Größe der übrigen (B-02) nicht in die Spalte passen. „Antworten mit
// Kursen“ bleibt untereinander, die Auswahl ist zu breit für die halbe
// Spalte. Chat-Icon wie im Mockup: sechs runde Buttons in einer Reihe ohne
// Beschriftung darunter, Name als Tooltip und aria-label (mit Beschriftung
// wurden es zwei Reihen). Reihenfolge nach Mockup Ansichten 1 bis 3.
// Darstellung serverseitig gerendert, Tippen mit eingehängter Seite; die
// Maße im Browser prüft .test-storage/r11/r11_check.py (Playwright).
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
const CONTROLS = `${DIR}/controls.jsx`;
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
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const show = (modulePath, props) =>
  renderer.render(modulePath, { location: "/", props });
const appearance = (config, extra = {}) =>
  show(APPEARANCE, {
    config,
    updateField: noop,
    setChoice: noop,
    logoPreview: null,
    ...extra,
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
  setPrivacyNotice: noop,
  setChoice: noop,
  addListItem: noop,
  updateListItem: noop,
  removeListItem: noop,
});

// Das Raster (data-pair) und seine Zellen: Index im HTML, Klassen und die
// erste Beschriftung jeder Zelle. Die Zellen sind die direkten Kinder; ihr
// Ende findet die Klammerzählung der <div>-Tags.
function pairs(html) {
  const found = [];
  const re = /<div class="([^"]*)" data-pair="">/g;
  let m;
  while ((m = re.exec(html))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    const cells = [];
    let cellStart = null;
    const tag = /<div\b[^>]*>|<\/div>/g;
    tag.lastIndex = start;
    let t;
    while ((t = tag.exec(html))) {
      const closing = t[0] === "</div>";
      if (!closing) {
        if (depth === 1) cellStart = t.index;
        depth++;
      } else {
        depth--;
        if (depth === 1) {
          const cell = html.slice(cellStart, t.index + 6);
          cells.push({
            html: cell,
            // erste Beschriftung, auch mit verschachteltem „(optional)“
            label: text(
              cell.match(/<(label|span)[^>]*>([\s\S]*?)<\/\1>/)?.[2] || ""
            ),
          });
        }
        if (depth === 0) {
          i = t.index;
          break;
        }
      }
    }
    found.push({ at: m.index, end: i, classes: m[1], cells });
  }
  return found;
}
const labelsOf = (html) => pairs(html).map((p) => p.cells.map((c) => c.label));

// Position eines Texts oder Musters im HTML
const at = (html, s) => {
  const i = typeof s === "string" ? html.indexOf(s) : html.search(s);
  assert.ok(i >= 0, String(s));
  return i;
};
// Steht die Beschriftung innerhalb eines Rasters?
const inPair = (html, label) => {
  const i = at(html, `>${label}<`);
  return pairs(html).some((p) => p.at < i && i < p.end);
};

// ---------------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------------

// E15 (Fixliste 7.22-rc13, bewusst geändert): zweispaltig ab Desktop
// (Tailwind xl, 1.280 px) statt ab 1.100 px; einzeln geprüft in
// designCenterFixesRc13.test.mjs
test(
  "Raster: einspaltig, ab Desktop (xl, 1.280 px Fensterbreite) zweispaltig",
  { skip },
  async () => {
    const controls = await renderer.load(CONTROLS);
    assert.match(controls.FIELD_PAIR_CLASS, /\bgrid\b/);
    assert.match(controls.FIELD_PAIR_CLASS, /\bgrid-cols-1\b/);
    assert.match(controls.FIELD_PAIR_CLASS, /(^|\s)xl:grid-cols-2\b/);
    // kein md: (768 px), sonst wären die Spalten bei 1024 px zu schmal
    assert.doesNotMatch(controls.FIELD_PAIR_CLASS, /\bmd:grid-cols/);
  }
);

test(
  "Aussehen, Chatfenster: Darstellung allein, dann Akzentfarbe | Schrift, Logo | Chat-Icon, Farbschema | Position, Antworten mit Kursen untereinander, Zeile zuletzt",
  { skip },
  async () => {
    const html = await appearance({ courseCards: "auto" });
    assert.deepEqual(labelsOf(html), [
      ["Akzentfarbe", "Schrift auf der Akzentfarbe"],
      ["Logo", "Chat-Icon"],
      ["Farbschema", "Position des Chat-Buttons"],
    ]);
    for (const label of ["Darstellung", "Kurse anzeigen als", "Reihenfolge"])
      assert.ok(!inPair(html, label), `${label} gehört nicht ins Raster`);
    const t = text(html);
    const order = [
      "Darstellung",
      "Akzentfarbe",
      "Schrift auf der Akzentfarbe",
      "Logo",
      "Chat-Icon",
      "Farbschema",
      "Position des Chat-Buttons",
      "Antworten mit Kursen",
      "Kurse anzeigen als",
      "Reihenfolge",
      "Fest vorgegeben:",
    ];
    let pos = -1;
    for (const label of order) {
      const next = t.indexOf(label, pos + 1);
      assert.ok(next > pos, `${label} fehlt oder steht falsch`);
      pos = next;
    }
    assert.doesNotMatch(t, /[–—]/);
  }
);

test(
  "Aussehen, In der Seite: Akzentfarbe | Schrift, Farbschema | Logo; kein Chat-Icon, keine Position",
  { skip },
  async () => {
    const html = await appearance({ displayMode: "inline" });
    assert.deepEqual(labelsOf(html), [
      ["Akzentfarbe", "Schrift auf der Akzentfarbe"],
      ["Farbschema", "Logo"],
    ]);
    assert.ok(!html.includes(">Chat-Icon<"));
    assert.ok(!html.includes(">Position des Chat-Buttons<"));
    const t = text(html);
    assert.ok(t.indexOf("Farbschema") < t.indexOf("Logo"));
    assert.ok(t.indexOf("Logo") < t.indexOf("Antworten mit Kursen"));
  }
);

test(
  "Aussehen: Hinweis unter dem Feld, Empfehlung in der Zelle der Schrift, Kontrastwarnung über die volle Breite unter dem Paar",
  { skip },
  async () => {
    const html = await appearance({ accentColor: "#777777" });
    // Darstellung: erst die Auswahl, dann der Hinweis
    assert.ok(
      at(html, /aria-pressed="true"[^>]*>Chatfenster</) <
        at(html, "Chatfenster: Button unten in der Ecke")
    );
    // Akzentfarbe: Farbfeld vor dem Hinweis
    assert.ok(
      at(html, 'aria-label="Akzentfarbe als Farbcode"') <
        at(html, "Buttons, Nutzer-Nachrichten und Links in Akzentfarbe.")
    );
    const [first] = pairs(html);
    const schrift = first.cells[1];
    assert.equal(schrift.label, "Schrift auf der Akzentfarbe");
    assert.match(schrift.html, /data-testid="user-text-advice"/);
    assert.ok(text(schrift.html).includes("Empfohlen: Weiß"));
    // die Warnung (vier Zeilen in der halben Spalte) steht unter dem Paar
    assert.doesNotMatch(schrift.html, /data-testid="user-text-warning"/);
    const warning = at(html, 'data-testid="user-text-warning"');
    assert.ok(first.end < warning, "Warnung unter dem Paar");
    assert.ok(warning < at(html, ">Logo<"), "Warnung vor dem nächsten Paar");
    assert.ok(text(html).includes("Kontrast nur 4,4:1"));
    assert.match(
      html.match(/<p[^>]*data-testid="user-text-warning"[^>]*>/)[0],
      /light:text-amber-700/
    );
    // ohne Warnung kein leerer Platz
    assert.doesNotMatch(
      await appearance({ accentColor: "#003366" }),
      /data-testid="user-text-warning"/
    );
    // Logo und Farbschema: Hinweise entfallen seit S3 (rc10), geprüft in
    // designCenterFixesRc10
  }
);

test(
  "Chat-Icon: sechs Icons in einer Reihe ohne Beschriftung, Name als Tooltip und für Screenreader, gewähltes hervorgehoben",
  { skip },
  async () => {
    const html = await appearance({ chatIcon: "support" });
    const row = html.slice(at(html, 'data-chat-icons=""'));
    const buttons = [
      ...row.matchAll(/<button[^>]*title="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g),
    ].slice(0, 6);
    assert.deepEqual(
      buttons.map((m) => m[1]),
      ["Sprechblase", "Support", "Suche", "Fernglas", "Magie", "Plus"]
    );
    for (const m of buttons) {
      assert.match(m[0], new RegExp(`aria-label="${m[1]}"`), m[1]);
      // im Button nur das Symbol, kein sichtbarer Text
      assert.equal(text(m[2]), "", m[1]);
      assert.doesNotMatch(m[0], /text-\[10px\]/);
      assert.match(m[0], /\bw-10 h-10\b/);
    }
    const support = buttons.find((m) => m[1] === "Support")[0];
    assert.match(support, /aria-pressed="true"/);
    assert.match(support, /border-primary-button/);
    assert.match(
      buttons.find((m) => m[1] === "Sprechblase")[0],
      /aria-pressed="false"/
    );
    // in der rechten Zelle des Paars Logo | Chat-Icon, der Hinweis darunter
    const [, logoPair] = pairs(html);
    assert.equal(logoPair.cells[1].label, "Chat-Icon");
    assert.match(logoPair.cells[1].html, /data-chat-icons=""/);
    assert.ok(
      logoPair.cells[1].html.indexOf('data-chat-icons=""') <
        logoPair.cells[1].html.indexOf("Das Icon auf dem Chat-Button.")
    );
    // bei „In der Seite“ keine Icons
    assert.doesNotMatch(
      await appearance({ displayMode: "inline" }),
      /data-chat-icons=""/
    );
  }
);

// ---------------------------------------------------------------------------
// Reiter Inhalt
// ---------------------------------------------------------------------------

test(
  "Inhalt: Überschrift schmal allein; Name, Untertitel (untereinander, Rückmeldung 20.10.), Begrüßung, Text, Link, Listen und Willkommensblasen einspaltig",
  { skip },
  async () => {
    const html = await show(CONTENT, contentProps({}));
    // Name und Untertitel standen seit R11 paarweise; seit der Rückmeldung
    // des Nutzers vom 20.10. untereinander über die volle Spaltenbreite
    assert.deepEqual(labelsOf(html), [["Überschrift (optional)"]]);
    for (const label of [
      "Name",
      "Untertitel",
      "Begrüßungstext",
      "Text",
      "Link zur Datenschutzerklärung",
      "Fragen zum Anklicken",
      "Platzhalter im Eingabefeld",
      "Willkommensblasen",
      "Willkommensblasen anzeigen",
      "Support-E-Mail",
    ])
      assert.ok(!inPair(html, label), `${label} gehört nicht ins Raster`);
    // Reihenfolge nach Mockup Ansicht 3
    const t = text(html);
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
      "Desktop",
      "Handy",
      "Support-E-Mail",
    ];
    let pos = -1;
    for (const label of order) {
      const next = t.indexOf(label, pos + 1);
      assert.ok(next > pos, `${label} fehlt oder steht falsch`);
      pos = next;
    }
    // bei „In der Seite“ dieselben Paare
    const inline = await show(CONTENT, contentProps({ displayMode: "inline" }));
    assert.deepEqual(labelsOf(inline), [["Überschrift (optional)"]]);
  }
);

test(
  "Inhalt: Hinweise unter dem Feld (Name, Untertitel, Überschrift, Link, Platzhalter, Support)",
  { skip },
  async () => {
    // Hinweis des Untertitels nur mit Schalter „Kursanzahl im Untertitel“
    // aus (KIE-576 Paket 3, Standard an: dann steht dort, dass die
    // Kursanzahl den Untertitel ersetzt)
    const html = await show(CONTENT, contentProps({ courseCountMode: "off" }));
    for (const [field, hint] of [
      ['aria-label="Name des Chatbots"', "Leer: es gilt „KI-Berater“."],
      ['aria-label="Untertitel"', "Leer: kein Untertitel."],
      [
        'aria-label="Überschrift des Datenschutz-Hinweises"',
        "Leer: keine Überschrift.",
      ],
      [
        'placeholder="https://www.ihre-seite.de/datenschutz"',
        "Steht am Ende der Blase.",
      ],
      [
        'aria-label="Platzhalter im Eingabefeld"',
        "Grauer Text im Eingabefeld des Chats.",
      ],
      ['type="email"', "E-Mail-Adresse für den Support-Link im Chat."],
    ])
      assert.ok(
        at(html, field) < at(html, hint),
        `${hint} steht nicht unter dem Feld`
      );
    // Fehler statt Hinweis
    const withError = await show(CONTENT, {
      ...contentProps({ assistantSubtitle: "x".repeat(200) }),
      errors: { assistantSubtitle: "Höchstens 80 Zeichen." },
    });
    assert.ok(text(withError).includes("Höchstens 80 Zeichen."));
    assert.ok(!text(withError).includes("Leer: kein Untertitel."));
  }
);

test(
  "Willkommensblasen anzeigen: Aus / Erster Besuch / Jeder Besuch, Schlüssel und Werte unverändert, Hinweis mit den neuen Begriffen",
  { skip },
  async () => {
    assert.deepEqual(
      keys.WELCOME_BUBBLES_OPTIONS.map((o) => [o.value, o.label]),
      [
        ["off", "Aus"],
        ["first", "Erster Besuch"],
        ["every", "Jeder Besuch"],
      ]
    );
    assert.deepEqual(
      keys.WELCOME_BUBBLES_OPTIONS.map((o) => o.value),
      [...server.WELCOME_BUBBLES_VALUES]
    );
    const html = await show(
      CONTENT,
      contentProps({ welcomeBubblesMobile: "every" })
    );
    const t = text(html);
    for (const part of [
      "„Erster Besuch“: Die Blasen erscheinen einmal",
      "„Jeder Besuch“: bei jedem neuen Besuch wieder",
      "„Aus“: keine Blasen, nur der Chat-Button.",
    ])
      assert.ok(t.includes(part), part);
    assert.ok(!t.includes("Beim ersten Besuch"));
    assert.ok(!t.includes("Bei jedem Besuch"));
    // je Gerät eine Zeile (Beschriftung links, dann die drei Optionen);
    // nebeneinander passen die beiden Gruppen nicht (siehe Kopfkommentar)
    const row = (key) => {
      const start = at(html, `data-device="${key}"`);
      return html.slice(start, html.indexOf("</div></div>", start));
    };
    const desktop = row("welcomeBubblesDesktop");
    const mobile = row("welcomeBubblesMobile");
    for (const r of [desktop, mobile])
      for (const label of ["Aus", "Erster Besuch", "Jeder Besuch"])
        assert.ok(r.includes(`>${label}<`), label);
    assert.ok(desktop.indexOf(">Desktop<") < desktop.indexOf(">Aus<"));
    assert.match(mobile, /aria-pressed="true"[^>]*>Jeder Besuch</);
    assert.ok(!inPair(html, "Willkommensblasen anzeigen"));
    assert.ok(
      !pairs(html).some((p) => p.cells.some((c) => c.label === "Desktop"))
    );
    // der Hinweis steht unter beiden Zeilen
    assert.ok(
      at(html, 'data-device="welcomeBubblesMobile"') <
        at(html, "„Erster Besuch“: Die Blasen")
    );
  }
);

// ---------------------------------------------------------------------------
// Wachsende Textfelder
// ---------------------------------------------------------------------------

test(
  "Begrüßung und Datenschutz-Text: Mindesthöhe 2 bzw. 5 Zeilen, ohne Bildlaufleiste und Ziehgriff",
  { skip },
  async () => {
    const html = await show(CONTENT, contentProps({}));
    const greeting = html.match(
      /<textarea[^>]*aria-label="Begrüßungstext"[^>]*>/
    )?.[0];
    const privacy = html.match(
      /<textarea[^>]*aria-label="Text des Datenschutz-Hinweises"[^>]*>/
    )?.[0];
    assert.ok(greeting && privacy, "Textfelder fehlen");
    assert.match(greeting, /rows="2"/);
    assert.match(privacy, /rows="5"/);
    for (const tag of [greeting, privacy]) {
      assert.match(tag, /data-autogrow=""/);
      assert.match(tag, /\boverflow-hidden\b/);
      assert.match(tag, /\bresize-none\b/);
      assert.doesNotMatch(tag, /\bresize-y\b/);
    }
    const content = await renderer.load(CONTENT);
    assert.equal(content.GREETING_MIN_ROWS, 2);
    assert.equal(content.PRIVACY_TEXT_MIN_ROWS, 5);
  }
);

test("fitTextareaHeight: Inhaltshöhe plus Rahmen, ohne Maße keine feste Höhe", async () => {
  const { fitTextareaHeight } = await renderer.load(CONTROLS);
  const el = {
    style: {},
    scrollHeight: 120,
    offsetHeight: 50,
    clientHeight: 48,
  };
  fitTextareaHeight(el);
  assert.equal(el.style.height, "122px");
  // neu messen nach kürzerem Text: erst auf auto, dann die kleinere Höhe
  el.scrollHeight = 60;
  fitTextareaHeight(el);
  assert.equal(el.style.height, "62px");
  const unmeasured = { style: {} };
  fitTextareaHeight(unmeasured);
  assert.equal(unmeasured.style.height, "");
  assert.doesNotThrow(() => fitTextareaHeight(null));
});

// Seite eingehängt: Tippen passt die Höhe an (Maße am Element nachgestellt)
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
  globalThis.fetch = async (url) => {
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
}

test(
  "Tippen in die Begrüßung passt die Höhe des Feldes an",
  { skip },
  async (t) => {
    stubServer(t, [widget(9, null)]);
    const mounted = await renderer.mount(DESIGN_CENTER, {
      location: "/settings/embed-config/9/appearance",
      route: "/settings/embed-config/:embedId/appearance",
    });
    t.after(() => mounted.unmount());
    await mounted.act();
    const { container, act } = mounted;
    await act(() =>
      click(
        elements(
          container,
          (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Inhalt"
        )[0]
      )
    );
    const textarea = elements(
      container,
      (el) => el.getAttribute("aria-label") === "Begrüßungstext"
    )[0];
    assert.ok(textarea);
    assert.equal(textarea.getAttribute("rows"), "2");
    // Maße wie im Browser nach dem Tippen von fünf Zeilen
    Object.defineProperty(textarea, "scrollHeight", {
      value: 118,
      configurable: true,
    });
    Object.defineProperty(textarea, "offsetHeight", {
      value: 50,
      configurable: true,
    });
    Object.defineProperty(textarea, "clientHeight", {
      value: 48,
      configurable: true,
    });
    await act(() =>
      handlersOf(textarea).onChange({
        target: { value: "Zeile 1\nZeile 2\nZeile 3\nZeile 4\nZeile 5" },
      })
    );
    assert.equal(textarea.style.height, "120px");
  }
);
