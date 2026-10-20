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
  "D12: Chatfenster der Vorschau wächst mit dem Inhalt (Mindesthöhe 540 px, keine feste Höhe, kein Deckel), der Nachrichtenbereich scrollt nicht innen, das Fenster hängt oben wie die Box „In der Seite“",
  { skip },
  async () => {
    const html = await preview({});
    const frame = tagOf(html, "chat-window");
    assert.match(styleOf(frame), /min-height:\s*540px/, "Mindesthöhe");
    assert.doesNotMatch(styleOf(frame), /(^|;)\s*height:/, "feste Höhe");
    assert.doesNotMatch(styleOf(frame), /max-height/, "Höhendeckel");
    assert.doesNotMatch(html, /\bh-full\b/, "h-full im Fenster");
    const messages = tagOf(html, "chat-messages");
    assert.doesNotMatch(classOf(messages), /overflow-y-auto|no-scroll/);
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
      const column = page.match(/<div class="([^"]*overflow-y-auto[^"]*)">/);
      assert.ok(column, "Vorschau-Spalte");
      assert.doesNotMatch(column[1], /(^|\s)(flex|grid|items-\S+)(\s|$)/);
      assert.match(page, /class="w-full flex justify-center"/);
      assert.doesNotMatch(page, /\bm-auto\b/);
    }
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
  "D12: In der Seite, aufgeklappt: Beschriftung direkt unter der Blase im selben rechtsbündigen Block, kein innerer Bildlauf in der Box",
  { skip },
  async (t) => {
    const mounted = await renderer.mount(PREVIEW, {
      location: "/",
      props: previewProps({ displayMode: "inline" }),
    });
    t.after(() => mounted.unmount());
    const { container, act } = mounted;
    const bar = byPreview(container, "inline-bar")[0];
    await act(() => click(elements(bar, (el) => el.tagName === "BUTTON")[0]));
    const panel = byPreview(container, "inline-panel")[0];
    assert.ok(panel, "aufgeklappte Box");
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
    // kein Vorfahr in der Box scrollt innen (nichts abgeschnitten)
    for (let el = block; el && el !== panel; el = el.parentNode)
      assert.doesNotMatch(
        el.getAttribute("class") || "",
        /overflow-y-auto|no-scroll/
      );
  }
);

test(
  "D12: Chatfenster geschlossen: die 540-px-Fläche bleibt, Willkommensblasen unten, keine Beispiel-Nutzernachricht",
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
    assert.equal(frame.style.minHeight, "540px");
    assert.ok(!frame.style.height, "keine feste Höhe");
    assert.ok(classes(frame).includes("justify-end"));
    assert.ok(byPreview(frame, "welcome-bubble").length >= 1);
    assert.equal(byPreview(frame, "user-message-caption").length, 0);
  }
);
