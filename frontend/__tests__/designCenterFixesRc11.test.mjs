// Korrekturrunde 7.22-rc11 (Fixliste fixliste-7.22-rc11.md), Design Center:
// D11 Wortlaut im Reiter Aussehen: „Position des Chat-Buttons“ statt
//     „Position des Chatfensters“ (wie im Mockup); nur beim Chatfenster.
// D12 Vorschau: Die Beschriftung „Beispiel-Nutzernachricht“ unter der
//     Nutzer-Nachricht ist vollständig sichtbar und rechtsbündig unter der
//     Blase, in beiden Darstellungen. Ursache beim Chatfenster: feste Höhe
//     540 px, der Nachrichtenbereich scrollte innen (Bildlaufleiste
//     versteckt) und schnitt die Beschriftung an der Unterkante ab. Jetzt
//     wächst das Chatfenster wie die Box „In der Seite“ mit dem Inhalt
//     (540 px als Mindesthöhe, nichts abgeschnitten) und hängt wie sie oben
//     (R7: nichts springt, wenn Inhalt dazukommt oder wegfällt); die
//     Vorschau scrollt, wenn das Fenster zu niedrig ist.
// Maße im Browser (beide Darstellungen, hell und dunkel, 1024×768 bis
// 1920×1080): .test-storage/rc11/rc11_check.py (Playwright) mit
// .test-storage/rc10/harness.mjs.
// Rückmeldung des Nutzers vom 20.10.2026 (nach rc11): Das Chatfenster war mit
// D12 „langgezogen“ und deutlich höher als das Widget auf der Website. Jetzt
// hat es wieder eine feste Höhe, dieselbe Rechnung wie live (77 % der
// Vorschaufläche statt 100vh, mindestens 400 px; ohne Maß beim serverseitigen
// Rendern 400 px), der Nachrichtenbereich scrollt innen mit SICHTBARER
// Bildlaufleiste, beim Öffnen steht der Verlauf unten (Beispiel-Nutzer-
// nachricht, Beschriftung und Eingabe sichtbar), Begrüßung und Datenschutz-
// Blase sind durch Hochscrollen erreichbar. Die Box „In der Seite“ hatte
// dasselbe Problem (wuchs auf rund 700 px, live 520 px): feste 520 px wie der
// Serverstandard inlineHeight, Verlauf scrollt innen. Die D12-Tests unten
// sind entsprechend umgestellt; Maße im Browser:
// .test-storage/rc12/rc12_preview_check.py.
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
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const show = (modulePath, props) =>
  renderer.render(modulePath, { location: "/", props });
const appearance = (config) =>
  show(APPEARANCE, {
    config,
    updateField: noop,
    setChoice: noop,
    logoPreview: null,
  });
const previewProps = (config) => ({
  config,
  logoPreview: null,
  defaults: DEFAULTS,
  greetingKey: "greeting",
});
const preview = (config) => show(PREVIEW, previewProps(config));
// Start-Tag des Elements mit diesem data-preview-Wert
const tagOf = (html, name) => {
  const m = html.match(new RegExp(`<[a-z]+[^>]*data-preview="${name}"[^>]*>`));
  assert.ok(m, `data-preview="${name}" fehlt`);
  return m[0];
};
const classOf = (tag) => (tag.match(/class="([^"]*)"/) || [, ""])[1];
const styleOf = (tag) => (tag.match(/style="([^"]*)"/) || [, ""])[1];
const byPreview = (root, name) =>
  elements(root, (el) => el.getAttribute("data-preview") === name);
const childElements = (node) =>
  node.childNodes.filter((child) => child.nodeType === 1);
const classes = (el) => (el.getAttribute("class") || "").split(/\s+/);

// ---------------------------------------------------------------------------
// D11: Wortlaut
// ---------------------------------------------------------------------------

test(
  "D11: Reiter Aussehen, Chatfenster: Überschrift „Position des Chat-Buttons“ zwischen Farbschema und Antworten mit Kursen, kein „Position des Chatfensters“",
  { skip },
  async () => {
    const html = await appearance({});
    assert.ok(html.includes(">Position des Chat-Buttons<"), "Überschrift");
    assert.ok(!html.includes("Position des Chatfensters"), "alter Wortlaut");
    const t = text(html);
    assert.ok(t.indexOf("Farbschema") < t.indexOf("Position des Chat-Buttons"));
    assert.ok(
      t.indexOf("Position des Chat-Buttons") < t.indexOf("Antworten mit Kursen")
    );
    // die Auswahl darunter bleibt: Links, Rechts („Links“ steht auch im
    // Hinweis zur Akzentfarbe, deshalb ab der Überschrift suchen)
    const from = t.indexOf("Position des Chat-Buttons");
    const links = t.indexOf("Links", from);
    assert.ok(links > from && links < t.indexOf("Rechts", from));
    assert.doesNotMatch(t, /[–—]/);
  }
);

test(
  "D11: In der Seite ohne Position (weder alter noch neuer Wortlaut)",
  { skip },
  async () => {
    const html = await appearance({ displayMode: "inline" });
    assert.ok(!html.includes("Position des Chat-Buttons"));
    assert.ok(!html.includes("Position des Chatfensters"));
  }
);

// ---------------------------------------------------------------------------
// D12: Vorschau, Beschriftung unter der Nutzer-Nachricht
// ---------------------------------------------------------------------------

test(
  "Rückmeldung 20.10.: Chatfenster der Vorschau mit fester Höhe wie live (77 % der Vorschaufläche, mindestens 400 px; ohne Maß 400 px), kein Wachsen, der Nachrichtenbereich scrollt innen mit sichtbarer Bildlaufleiste, das Fenster hängt oben wie die Box „In der Seite“",
  { skip },
  async () => {
    const {
      previewWindowHeight,
      WINDOW_MIN_HEIGHT_PX,
      WINDOW_HEIGHT_SHARE,
      INLINE_PANEL_HEIGHT_PX,
    } = await renderer.load(PREVIEW);
    // Maße des Widgets: WINDOW_MIN_HEIGHT_PX (utils/layout.js), 77 % der
    // Höhe (App.jsx md:allm-max-h-[77%]), inlineHeight 520px (Serverstandard)
    assert.equal(WINDOW_MIN_HEIGHT_PX, 400);
    assert.equal(WINDOW_HEIGHT_SHARE, 0.77);
    assert.equal(INLINE_PANEL_HEIGHT_PX, 520);
    assert.equal(server.INLINE_FIXED_STANDARDS.inlineHeight, "520px");
    // 1440×900: Vorschaufläche 765 px hoch → 589 px; zum Vergleich live auf
    // einer 900-px-Seite 693 px; 1024×768 (633 px) → 487 px; kleine Flächen
    // nie unter 400 px; ohne Maß 400 px
    assert.equal(previewWindowHeight(765), 589);
    assert.equal(previewWindowHeight(900), 693);
    assert.equal(previewWindowHeight(633), 487);
    assert.equal(previewWindowHeight(500), 400);
    assert.equal(previewWindowHeight(0), 400);
    assert.equal(previewWindowHeight(null), 400);
    assert.equal(previewWindowHeight(undefined), 400);
    const html = await preview({});
    const frame = tagOf(html, "chat-window");
    assert.match(
      styleOf(frame),
      /(^|;)\s*height:\s*400px/,
      "feste Höhe (ohne Maß die Mindesthöhe)"
    );
    assert.doesNotMatch(styleOf(frame), /min-height|max-height/);
    const messages = tagOf(html, "chat-messages");
    assert.match(classOf(messages), /\boverflow-y-auto\b/, "scrollt innen");
    assert.match(classOf(messages), /\bmin-h-0\b/);
    assert.match(
      classOf(messages),
      /\bpreview-scrollbar\b/,
      "sichtbare Bildlaufleiste"
    );
    assert.doesNotMatch(classOf(messages), /no-scroll/);
    assert.match(styleOf(messages), /color-scheme:\s*light/);
    // Reihenfolge im Fenster: Kopf, Nachrichten, Eingabe
    assert.ok(
      html.indexOf(frame) < html.indexOf(messages) &&
        html.indexOf(messages) < html.indexOf('data-preview="input"')
    );
    // Beschriftung und Beispiel-Antwort liegen im Nachrichtenbereich
    const area = html.slice(
      html.indexOf(messages),
      html.indexOf('data-preview="input"')
    );
    assert.ok(area.includes('data-preview="user-message-caption"'));
    assert.ok(area.includes('data-preview="answer-caption"'));
    // hängt oben (R7), nicht mehr mittig; die Vorschau-Spalte ist kein
    // Flex-Container (sonst würde das Fenster auf die Spaltenhöhe gestaucht
    // und schnitte die Eingabe unten ab, statt dass die Spalte scrollt)
    for (const page of [html, await preview({ displayMode: "inline" })]) {
      const column = page.match(
        /<div class="([^"]*overflow-y-auto[^"]*)" data-preview="area">/
      );
      assert.ok(column, "Vorschau-Spalte (Vorschaufläche)");
      assert.doesNotMatch(column[1], /(^|\s)(flex|grid|items-\S+)(\s|$)/);
      assert.match(page, /class="w-full flex justify-center"/);
      assert.doesNotMatch(page, /\bm-auto\b/);
    }
    // dunkles Farbschema: Bildlaufleiste zum Schema
    const dark = tagOf(await preview({ theme: "dark" }), "chat-messages");
    assert.match(styleOf(dark), /color-scheme:\s*dark/);
    assert.match(
      styleOf(dark),
      /--preview-scrollbar-thumb:\s*rgba\(255,255,255/
    );
  }
);

test(
  "Nutzer 23.10.2026 (vorher Rückmeldung 20.10.): beim Öffnen des Chatfensters steht der Verlauf oben (scrollTop = 0), auch wenn er vorher gescrollt war; scrollToStart ohne Element ohne Wirkung",
  { skip },
  async (t) => {
    const { scrollToStart } = await renderer.load(PREVIEW);
    const fake = { scrollHeight: 1234, scrollTop: 600 };
    scrollToStart(fake);
    assert.equal(fake.scrollTop, 0);
    scrollToStart(null);

    const mounted = await renderer.mount(PREVIEW, {
      location: "/",
      props: previewProps({}),
    });
    t.after(() => mounted.unmount());
    const { container, act } = mounted;
    const first = byPreview(container, "chat-messages")[0];
    assert.ok(first, "Nachrichtenbereich");
    // Maße wie im Browser: der Verlauf ist höher als sein Bereich
    const proto = Object.getPrototypeOf(first);
    Object.defineProperty(proto, "scrollHeight", {
      get() {
        return 900;
      },
      configurable: true,
    });
    t.after(() => delete proto.scrollHeight);
    const toggle = () =>
      elements(
        container,
        (el) =>
          el.tagName === "BUTTON" &&
          /^Chat (schließen|öffnen)$/.test(el.getAttribute("aria-label") || "")
      ).at(-1);
    assert.equal(first.scrollTop, 0, "beim ersten Öffnen oben");
    // runtergescrollt, schließen und wieder öffnen: der neue
    // Nachrichtenbereich steht oben, nicht am Ende (scrollHeight 900)
    first.scrollTop = 500;
    await act(() => click(toggle()));
    assert.equal(byPreview(container, "chat-messages").length, 0);
    await act(() => click(toggle()));
    const messages = byPreview(container, "chat-messages")[0];
    assert.ok(messages, "Nachrichtenbereich nach dem Öffnen");
    assert.equal(messages.scrollTop, 0);
  }
);

test(
  "D12: Beschriftung „Beispiel-Nutzernachricht“ steht direkt unter der Blase, beide rechtsbündig (items-end), eine Zeile, nicht gekürzt",
  { skip },
  async () => {
    const html = await preview({});
    const wrap = html.match(
      /<div class="([^"]*)" data-preview="user-message-block"><div[^>]*data-preview="user-message"[^>]*>Gibt es Kurse am Wochenende\?<\/div><span class="([^"]*)"[^>]*data-preview="user-message-caption">Beispiel-Nutzernachricht<\/span><\/div>/
    );
    assert.ok(wrap, "Blase und Beschriftung in einem Block");
    assert.match(wrap[1], /\bflex\b/);
    assert.match(wrap[1], /\bflex-col\b/);
    assert.match(wrap[1], /\bitems-end\b/);
    assert.match(wrap[2], /\bwhitespace-nowrap\b/, "eine Zeile");
    assert.doesNotMatch(wrap[2], /truncate|overflow-hidden/);
  }
);

test(
  "D12 / 20.10.: In der Seite, aufgeklappt: Beschriftung direkt unter der Blase im selben rechtsbündigen Block; die Box ist fest 520 px hoch wie live, der Verlauf scrollt innen mit sichtbarer Bildlaufleiste und steht beim Aufklappen oben (Nutzer 23.10.2026)",
  { skip },
  async (t) => {
    const mounted = await renderer.mount(PREVIEW, {
      location: "/",
      props: previewProps({ displayMode: "inline" }),
    });
    t.after(() => mounted.unmount());
    const { container, act } = mounted;
    // startet aufgeklappt (7.22.1, Spezifikation §12 Eintrag 12); erst
    // einklappen, dann prüft der Test das Aufklappen
    assert.ok(byPreview(container, "inline-panel")[0], "startet aufgeklappt");
    await act(() =>
      click(
        elements(
          container,
          (el) => el.getAttribute("aria-label") === "Einklappen"
        )[0]
      )
    );
    const bar = byPreview(container, "inline-bar")[0];
    assert.ok(bar, "eingeklappte Leiste");
    // Maße wie im Browser: der Verlauf ist höher als sein Bereich
    const proto = Object.getPrototypeOf(bar);
    Object.defineProperty(proto, "scrollHeight", {
      get() {
        return 900;
      },
      configurable: true,
    });
    t.after(() => delete proto.scrollHeight);
    await act(() => click(elements(bar, (el) => el.tagName === "BUTTON")[0]));
    const panel = byPreview(container, "inline-panel")[0];
    assert.ok(panel, "aufgeklappte Box");
    assert.equal(panel.style.height, "520px", "feste Höhe wie live");
    assert.ok(!panel.style.minHeight && !panel.style.maxHeight);
    const messages = byPreview(panel, "inline-messages")[0];
    for (const cls of [
      "flex-1",
      "min-h-0",
      "overflow-y-auto",
      "preview-scrollbar",
    ])
      assert.ok(classes(messages).includes(cls), cls);
    assert.ok(!classes(messages).includes("no-scroll"));
    assert.equal(messages.scrollTop, 0, "Verlauf steht oben, nicht am Ende");
    const caption = byPreview(panel, "user-message-caption")[0];
    assert.ok(caption, "Beschriftung in der Box");
    assert.equal(caption.textContent, "Beispiel-Nutzernachricht");
    const block = caption.parentNode;
    assert.equal(block.getAttribute("data-preview"), "user-message-block");
    const kids = childElements(block);
    assert.equal(kids.length, 2, "Blase und Beschriftung");
    assert.equal(kids[0].getAttribute("data-preview"), "user-message");
    assert.equal(kids[1], caption);
    for (const cls of ["flex", "flex-col", "items-end"])
      assert.ok(classes(block).includes(cls), cls);
    // der Block liegt im scrollenden Nachrichtenbereich (nichts wird
    // abgeschnitten, nur gescrollt), kein verstecktes Scrollen dazwischen
    let scroller = null;
    for (let el = block; el && el !== panel; el = el.parentNode) {
      assert.doesNotMatch(el.getAttribute("class") || "", /no-scroll/);
      if (classes(el).includes("overflow-y-auto")) scroller = el;
    }
    assert.equal(scroller, messages);
  }
);

test(
  "D12 / 20.10.: Chatfenster geschlossen: die Fläche in Fensterhöhe bleibt (der Chat-Button springt nicht), Willkommensblasen unten, keine Beispiel-Nutzernachricht",
  { skip },
  async (t) => {
    const mounted = await renderer.mount(PREVIEW, {
      location: "/",
      props: previewProps({}),
    });
    t.after(() => mounted.unmount());
    const { container, act } = mounted;
    const frame = byPreview(container, "chat-window")[0];
    assert.ok(frame, "Chatfenster");
    assert.equal(byPreview(frame, "user-message-caption").length, 1);
    const close = elements(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.getAttribute("aria-label") === "Chat schließen"
    ).at(-1);
    await act(() => click(close));
    // ohne Maß (kein Browser) die Mindesthöhe 400 px, geöffnet wie geschlossen
    assert.equal(frame.style.height, "400px");
    assert.ok(!frame.style.minHeight, "keine Mindesthöhe mehr");
    assert.ok(classes(frame).includes("justify-end"));
    assert.ok(byPreview(frame, "welcome-bubble").length >= 1);
    assert.equal(byPreview(frame, "user-message-caption").length, 0);
  }
);
