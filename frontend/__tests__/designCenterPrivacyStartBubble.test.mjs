// AK-12 (issues/datenschutz-fusszeile.md, Nutzer 24.10.2026, Vertrag
// Punkt 1 und 6 in issues/datenschutz-fusszeile/auftrag-ak12-blase.md):
// Design Center, Reiter Inhalt, Gruppe „Datenschutz-Hinweis“: Schalter
// „Zusätzlich beim Start als Blase zeigen“ direkt unter dem Gruppenhinweis,
// vor den Feldern. An speichert privacyStartBubble: true, aus entfernt den
// Schlüssel (nie false, cleanConfig). Die Felder bleiben immer bearbeitbar.
// Vorschau (Chatfenster und In der Seite): an zeigt unter der
// Begrüßungsblase die Datenschutz-Blase wie in 7.22.2 (Fläche, Schrift und
// Abstände wie die Begrüßung; Überschrift fett, Text als Punkte, Link
// „Datenschutzerklärung“ nur mit gültiger Adresse; ohne den Punkt „Hinweis
// zur KI“; alles als Text), mit den Werten der Felder. Der Link „Datenschutz“
// in der Fußzeile bleibt (D1), das Datenschutz-Fenster verhält sich wie
// bisher (R3-D1, E3).
//
// Reine Logik (widgetKeys.js), Darstellung serverseitig gerendert, Schalter,
// Speichern und Fenster mit eingehängter Seite und ersetztem fetch (wie
// designCenterPrivacyLink.test.mjs).
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
const CONTENT = `${DIR}/ContentTab.jsx`;
const PREVIEW = `${DIR}/WidgetPreview.jsx`;
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const require = createRequire(import.meta.url);
const {
  embedDefaultTexts,
} = require("../../server/utils/chats/embedDefaults.js");
const DEFAULTS = embedDefaultTexts("de");
const REAL_FETCH = globalThis.fetch;

// Wortlaute aus dem Vertrag (Punkt 6, D3 vom 24.10.2026)
const SWITCH_LABEL = "Zusätzlich beim Start als Blase zeigen";
const SWITCH_HINT =
  "Standard: nur als Link „Datenschutz“ unter der Eingabe. Mit Blase steht der Hinweis gleich beim Öffnen unter der Begrüßung und braucht mehr Platz.";
// Gruppenhinweis (AK-6, unverändert)
const GROUP_HINT =
  "Erscheint immer als Link „Datenschutz“ unter der Eingabe. Ein Klick öffnet den Hinweis über dem Chat. Für den Inhalt sind Sie als Betreiber der Website verantwortlich.";
const FOOTER = "Unsere KI kann Fehler machen · Datenschutz";
const AI_TITLE = "Hinweis zur KI";

// Werte, die nicht genau true sind: der Schalter ist aus, keine Blase
const NOT_TRUE = [undefined, false, "true", " TRUE ", 1, "1", null, {}, [true]];

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
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const plain = (el) => el.textContent.replace(/\s+/g, " ").trim();
const withValue = (config, privacyStartBubble) =>
  privacyStartBubble === undefined
    ? { ...config }
    : { ...config, privacyStartBubble };

// ---------------------------------------------------------------------------
// Logik (widgetKeys.js)
// ---------------------------------------------------------------------------

test("AK-12: privacyStartBubbleOn zählt nur genau true (eine Stelle für Schalter und Vorschau)", () => {
  assert.equal(typeof keys.privacyStartBubbleOn, "function");
  assert.equal(keys.privacyStartBubbleOn({ privacyStartBubble: true }), true);
  for (const value of NOT_TRUE)
    assert.equal(
      keys.privacyStartBubbleOn(withValue({}, value)),
      false,
      JSON.stringify(value)
    );
  // alte Werte von privacyNotice schalten die Blase nicht ein (D2)
  for (const privacyNotice of ["bubble", "BUBBLE", "modal", "none", "link"])
    assert.equal(keys.privacyStartBubbleOn({ privacyNotice }), false);
  assert.equal(keys.privacyStartBubbleOn(), false);
});

test("AK-12: cleanConfig speichert true und entfernt jeden anderen Wert (aus = kein Schlüssel, nie false)", () => {
  const opts = (initial) => ({
    initial,
    defaults: DEFAULTS,
    greetingKey: "greeting",
  });
  for (const initial of [{}, { privacyStartBubble: true }])
    assert.deepEqual(
      keys.cleanConfig(
        { name: "VHS", privacyStartBubble: true },
        opts(initial)
      ),
      { name: "VHS", privacyStartBubble: true }
    );
  for (const value of NOT_TRUE)
    for (const initial of [
      {},
      { privacyStartBubble: true },
      withValue({}, value),
    ]) {
      const out = keys.cleanConfig(
        withValue({ name: "VHS" }, value),
        opts(initial)
      );
      assert.deepEqual(
        out,
        { name: "VHS" },
        `${JSON.stringify(value)} bei gespeichert ${JSON.stringify(initial)}`
      );
    }
  // privacyNotice bleibt, wie es gespeichert ist; es schaltet nichts
  const legacy = { privacyNotice: "bubble" };
  assert.deepEqual(keys.cleanConfig(legacy, opts(legacy)), legacy);
});

// ---------------------------------------------------------------------------
// Reiter Inhalt, serverseitig gerendert
// ---------------------------------------------------------------------------

const contentProps = (config, initialConfig = config) => ({
  config,
  initialConfig,
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
const switchTag = (html) => {
  const m = html.match(/<input[^>]*role="switch"[^>]*>/g) || [];
  assert.equal(m.length, 1, "genau ein Schalter im Reiter Inhalt");
  return m[0];
};

test(
  "AK-12: Schalter mit Beschriftung und Hinweis direkt unter dem Gruppenhinweis, vor den Feldern; an nur bei true; Felder immer bearbeitbar",
  { skip },
  async () => {
    for (const displayMode of [undefined, "inline"])
      for (const value of [true, ...NOT_TRUE]) {
        const label = `${displayMode} ${JSON.stringify(value)}`;
        const html = await renderer.render(CONTENT, {
          location: "/",
          props: contentProps(
            withValue({ displayMode, privacyNotice: "bubble" }, value)
          ),
        });
        const input = switchTag(html);
        assert.match(input, /type="checkbox"/, label);
        assert.equal(/\schecked=""/.test(input), value === true, label);
        // Beschriftung und Zustand im selben label wie der Schalter
        const box = html.match(
          /<label[^>]*>(?:(?!<\/label>)[\s\S])*role="switch"[\s\S]*?<\/label>/
        );
        assert.ok(box, `${label}: label fehlt`);
        const boxText = text(box[0]);
        assert.ok(boxText.includes(SWITCH_LABEL), `${label}: ${boxText}`);
        assert.ok(
          boxText.includes(value === true ? "An" : "Aus"),
          `${label}: ${boxText}`
        );
        // Reihenfolge: Gruppenhinweis, Schalter, Hinweis, Felder
        const t = text(html);
        const at = (s) => {
          const i = t.indexOf(s);
          assert.ok(i >= 0, `${label}: fehlt ${s}`);
          return i;
        };
        assert.ok(at(GROUP_HINT) < at(SWITCH_LABEL), label);
        assert.ok(at(SWITCH_LABEL) < at(SWITCH_HINT), label);
        const fields = html.indexOf('data-privacy-fields=""');
        assert.ok(fields > html.indexOf('role="switch"'), label);
        assert.ok(t.indexOf(SWITCH_HINT) < at("Überschrift Standardtext"));
        // Felder immer bearbeitbar (kein gesperrtes fieldset wie bis 7.22.2)
        assert.doesNotMatch(html, /<fieldset/, label);
        for (const aria of [
          "Überschrift des Datenschutz-Hinweises",
          "Text des Datenschutz-Hinweises",
          "Link zur Datenschutzerklärung",
        ]) {
          const field = html.match(
            new RegExp(`<(input|textarea)[^>]*aria-label="${aria}"[^>]*>`)
          );
          assert.ok(field, `${label}: ${aria}`);
          assert.doesNotMatch(field[0], /disabled/, `${label}: ${aria}`);
        }
        assert.doesNotMatch(t, /[–—]/, label);
      }
  }
);

// ---------------------------------------------------------------------------
// Vorschau, serverseitig gerendert
// ---------------------------------------------------------------------------

const previewProps = (config) => ({
  config,
  logoPreview: null,
  defaults: DEFAULTS,
  greetingKey: "greeting",
});
// öffnendes Tag eines Elements der Vorschau und sein Inhalt bis zum
// passenden Ende (die Blasen enthalten nur p, span und strong)
const blockOf = (html, name) => {
  const start = html.indexOf(`data-preview="${name}"`);
  if (start < 0) return null;
  const open = html.lastIndexOf("<div", start);
  let depth = 0;
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = open;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  return null;
};
const openTag = (block) => block.match(/^<div[^>]*>/)[0];
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const OWN = {
  privacyTitle: "Hinweis der VHS",
  privacyText: "• Erster Punkt\n• Zweiter Punkt\nEin Absatz",
  privacyUrl: "https://example.org/datenschutz",
};

test(
  "AK-12: Vorschau an: Datenschutz-Blase unter der Begrüßung, vor Startvorschlägen und Beispiel, mit den Werten der Feldern; Fußzeile mit Link bleibt, das Fenster ist zu",
  { skip },
  async () => {
    for (const displayMode of [undefined, "inline"])
      for (const theme of ["light", "dark"]) {
        const label = `${displayMode} ${theme}`;
        const html = await renderer.render(PREVIEW, {
          location: "/",
          props: previewProps({
            displayMode,
            theme,
            defaultMessages: ["Yoga am Abend"],
            privacyStartBubble: true,
            ...OWN,
          }),
        });
        const bubble = blockOf(html, "privacy-bubble");
        assert.ok(bubble, `${label}: Blase fehlt`);
        const order = [
          "greeting-bubble",
          "privacy-bubble",
          "pills",
          "user-message-block",
        ].map((name) => html.indexOf(`data-preview="${name}"`));
        assert.deepEqual(
          [...order].sort((a, b) => a - b),
          order,
          `${label}: Reihenfolge ${order}`
        );
        assert.ok(
          order.every((i) => i >= 0),
          label
        );
        // Inhalt: Überschrift fett, Punkte, Absatz, Link, kein KI-Punkt
        const t = text(bubble);
        assert.equal(
          t,
          "Hinweis der VHS • Erster Punkt • Zweiter Punkt Ein Absatz Datenschutzerklärung",
          label
        );
        const title = bubble.match(/<(p|strong)[^>]*>Hinweis der VHS<\/\1>/);
        assert.ok(title, `${label}: Überschrift`);
        assert.match(title[0], /\bfont-bold\b/, label);
        assert.ok(!t.includes(AI_TITLE), label);
        const link = bubble.match(/<span[^>]*>Datenschutzerklärung<\/span>/);
        assert.ok(link, `${label}: Link`);
        assert.match(link[0], /\bunderline\b/, label);
        // Fußzeile mit Link bleibt (D1), Fenster zu
        const footer = html.match(
          /<p[^>]*data-preview="disclaimer"[^>]*>([\s\S]*?)<\/p>/
        );
        assert.equal(text(footer[1]), FOOTER, label);
        assert.doesNotMatch(html, /role="dialog"/, label);
      }
  }
);

test(
  "AK-12 (D4): Blase mit Fläche, Schrift, Rundung und Innenabstand wie die Begrüßungsblase, hell und dunkel",
  { skip },
  async () => {
    // Größe, Rundung, Innenabstand, Breite und Umbruch: dieselben Klassen
    const LOOK =
      /^(text-\[[^\]]+\]|leading-\S+|rounded\S*|px-\S+|py-\S+|max-w-\S+|\[overflow-wrap:anywhere\])$/;
    for (const displayMode of [undefined, "inline"])
      for (const theme of ["light", "dark"]) {
        const label = `${displayMode} ${theme}`;
        const html = await renderer.render(PREVIEW, {
          location: "/",
          props: previewProps({ displayMode, theme, privacyStartBubble: true }),
        });
        const greeting = openTag(blockOf(html, "greeting-bubble"));
        const privacy = openTag(blockOf(html, "privacy-bubble"));
        assert.equal(attr(privacy, "style"), attr(greeting, "style"), label);
        const look = (tag) =>
          attr(tag, "class")
            .split(/\s+/)
            .filter((c) => LOOK.test(c))
            .sort();
        assert.ok(look(greeting).length >= 6, label);
        assert.deepEqual(look(privacy), look(greeting), label);
      }
  }
);

test(
  "AK-12: ohne eigene Werte Standardüberschrift und Standardtext, kein Link; leere Überschrift gilt wie der Standard",
  { skip },
  async () => {
    for (const config of [{}, { privacyTitle: "" }, { privacyTitle: "  " }]) {
      const html = await renderer.render(PREVIEW, {
        location: "/",
        props: previewProps({ ...config, privacyStartBubble: true }),
      });
      const t = text(blockOf(html, "privacy-bubble"));
      assert.ok(t.startsWith("Datenschutz "), t);
      for (const line of DEFAULTS.privacyText.split("\n"))
        assert.ok(t.includes(line.replace(/^• /, "")), line);
      assert.ok(!t.includes("Datenschutzerklärung"), t);
      assert.ok(!t.includes(AI_TITLE), t);
    }
  }
);

test(
  "AK-12, AK-1, D2: Vorschau ohne Blase, wenn der Wert nicht genau true ist, auch bei privacyNotice „bubble“",
  { skip },
  async () => {
    for (const displayMode of [undefined, "inline"]) {
      // Gegenprobe: genau true zeigt die Blase (sonst prüfte der Test nichts)
      const on = await renderer.render(PREVIEW, {
        location: "/",
        props: previewProps({ displayMode, ...OWN, privacyStartBubble: true }),
      });
      assert.match(on, /data-preview="privacy-bubble"/, `${displayMode} true`);
      for (const value of NOT_TRUE)
        for (const privacyNotice of [undefined, "bubble"]) {
          const label = `${displayMode} ${JSON.stringify(value)} ${privacyNotice}`;
          const config = withValue({ displayMode, ...OWN }, value);
          if (privacyNotice) config.privacyNotice = privacyNotice;
          const html = await renderer.render(PREVIEW, {
            location: "/",
            props: previewProps(config),
          });
          assert.doesNotMatch(html, /data-preview="privacy-bubble"/, label);
          assert.match(html, /data-preview="greeting-bubble"/, label);
        }
    }
  }
);

test(
  "AK-12, NAK-1, NAK-3: Blase zeigt Überschrift und Text nur als Text, Link nur bei https-Adresse oder Pfad",
  { skip },
  async () => {
    for (const [privacyUrl, linked] of [
      ["https://example.org/datenschutz", true],
      ["/datenschutz", true],
      ["javascript:alert(1)", false],
      ["http://example.org/datenschutz", false],
      ["//fremd.example/x", false],
      [" data:text/html,x", false],
    ]) {
      const html = await renderer.render(PREVIEW, {
        location: "/",
        props: previewProps({
          privacyStartBubble: true,
          privacyTitle: '<a href="javascript:alert(1)">Titel</a>',
          privacyText: '<img src=x onerror="alert(1)">\n• <b>fett</b>',
          privacyUrl,
        }),
      });
      const bubble = blockOf(html, "privacy-bubble");
      assert.doesNotMatch(bubble, /<(a|img|b)\b/i, privacyUrl);
      const t = text(bubble);
      assert.ok(t.includes('<a href="javascript:alert(1)">Titel</a>'), t);
      assert.ok(t.includes('<img src=x onerror="alert(1)">'), t);
      assert.ok(t.includes("<b>fett</b>"), t);
      assert.equal(t.includes("Datenschutzerklärung"), linked, privacyUrl);
      // ungültige Adresse: kein Link-Element und keine Adresse im Tooltip
      assert.equal(
        /data-preview="privacy-statement-link"/.test(bubble),
        linked,
        privacyUrl
      );
      assert.equal(/\stitle="/.test(bubble), linked, privacyUrl);
    }
  }
);

// ---------------------------------------------------------------------------
// Design Center eingehängt: Schalter, Vorschau, Speichern, Fenster
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
    globalThis.fetch = REAL_FETCH;
  });
  return calls;
}

const byPreview = (root, name) =>
  elements(root, (el) => el.getAttribute("data-preview") === name);
const dialogs = (root) =>
  elements(root, (el) => el.getAttribute("role") === "dialog");
const buttonByText = (root, label) =>
  elements(
    root,
    (el) => el.tagName === "BUTTON" && el.textContent.trim() === label
  )[0];
const byAria = (root, label) =>
  elements(root, (el) => el.getAttribute("aria-label") === label)[0];
const theSwitch = (root) => {
  const found = elements(root, (el) => el.getAttribute("role") === "switch");
  assert.equal(found.length, 1, "genau ein Schalter");
  return found[0];
};
const unsaved = (container) =>
  container.textContent.includes("Ungespeicherte Änderungen");
const savedBodies = (calls) =>
  calls
    .filter((c) => c.url.includes("/embed/update/"))
    .map((c) => JSON.parse(c.body.visual_config));

async function openDesignCenter(t, embeds, id) {
  const calls = stubServer(t, embeds);
  const mounted = await renderer.mount(DESIGN_CENTER, {
    location: `/settings/embed-config/${id}/appearance`,
    route: "/settings/embed-config/:embedId/appearance",
  });
  t.after(() => mounted.unmount());
  await mounted.act();
  await mounted.act(() => click(buttonByText(mounted.container, "Inhalt")));
  return { ...mounted, calls };
}
const toggle = (act, el, checked) =>
  act(() => handlersOf(el).onChange({ target: { checked } }));

test(
  "AK-12: Schalter an zeigt die Blase sofort in der Vorschau und speichert {privacyStartBubble: true}; aus entfernt den Schlüssel",
  { skip },
  async (t) => {
    const { container, act, calls } = await openDesignCenter(
      t,
      [widget(9, null)],
      9
    );
    assert.ok(!unsaved(container));
    assert.equal(byPreview(container, "privacy-bubble").length, 0);
    assert.equal(theSwitch(container).checked, false);
    await toggle(act, theSwitch(container), true);
    assert.equal(theSwitch(container).checked, true);
    const [bubble] = byPreview(container, "privacy-bubble");
    assert.ok(bubble, "Blase in der Vorschau");
    assert.ok(plain(bubble).startsWith(DEFAULTS.privacyTitle));
    assert.ok(unsaved(container));
    // Fußzeile mit Link bleibt
    assert.equal(byPreview(container, "privacy-link").length, 1);
    // an und wieder aus: keine Änderung
    await toggle(act, theSwitch(container), false);
    assert.equal(byPreview(container, "privacy-bubble").length, 0);
    assert.ok(!unsaved(container));
    await toggle(act, theSwitch(container), true);
    await act(() => click(buttonByText(container, "Speichern")));
    assert.deepEqual(savedBodies(calls), [{ privacyStartBubble: true }]);
    assert.ok(!unsaved(container));
    // aus: Schlüssel entfernt, nicht false
    await toggle(act, theSwitch(container), false);
    assert.ok(unsaved(container));
    await act(() => click(buttonByText(container, "Speichern")));
    assert.deepEqual(savedBodies(calls)[1], {});
  }
);

test(
  "AK-12: gespeicherte Blase ausschalten behält alle übrigen Werte; ein gespeichertes false oder „true“ zeigt den Schalter aus und wird beim Speichern entfernt",
  { skip },
  async (t) => {
    const stored = {
      name: "VHS",
      privacyNotice: "bubble",
      privacyTitle: "Hinweis",
      privacyStartBubble: true,
    };
    let { container, act, calls } = await openDesignCenter(
      t,
      [widget(4, stored)],
      4
    );
    assert.equal(theSwitch(container).checked, true);
    assert.equal(byPreview(container, "privacy-bubble").length, 1);
    await toggle(act, theSwitch(container), false);
    await act(() => click(buttonByText(container, "Speichern")));
    const rest = { ...stored };
    delete rest.privacyStartBubble;
    assert.deepEqual(savedBodies(calls), [rest]);

    for (const value of [false, "true"]) {
      ({ container, act, calls } = await openDesignCenter(
        t,
        [widget(5, { name: "VHS", privacyStartBubble: value })],
        5
      ));
      assert.equal(theSwitch(container).checked, false, String(value));
      assert.equal(byPreview(container, "privacy-bubble").length, 0);
      // nicht „ungespeichert“, aber beim nächsten Speichern bereinigt
      assert.ok(!unsaved(container), String(value));
      const title = byAria(container, "Überschrift des Datenschutz-Hinweises");
      await act(() => handlersOf(title).onChange({ target: { value: "Neu" } }));
      await act(() => click(buttonByText(container, "Speichern")));
      assert.deepEqual(savedBodies(calls), [
        { name: "VHS", privacyTitle: "Neu" },
      ]);
    }
  }
);

for (const [name, displayMode] of [
  ["Chatfenster", undefined],
  ["In der Seite", "inline"],
])
  test(
    `AK-12 ${name}: Felder ändern zeigt die Änderung in der Blase und öffnet das Fenster wie bisher (E3); der Schalter schließt ein offenes Fenster, die Blase ist dann zu sehen`,
    { skip },
    async (t) => {
      const { container, act } = await openDesignCenter(
        t,
        [widget(6, { displayMode, privacyStartBubble: true })],
        6
      );
      const title = byAria(container, "Überschrift des Datenschutz-Hinweises");
      title.focus();
      await act(() =>
        handlersOf(title).onChange({ target: { value: "Neue Überschrift" } })
      );
      // Fenster öffnet ohne Fokuswechsel, wie ohne Blase (E3)
      let [dialog] = dialogs(container);
      assert.ok(dialog, "Fenster öffnet bei Änderung");
      assert.ok(plain(dialog).includes("Neue Überschrift"));
      assert.equal(dialog.getAttribute("aria-modal"), null);
      const [bubble] = byPreview(container, "privacy-bubble");
      assert.ok(plain(bubble).startsWith("Neue Überschrift"));
      const url = byAria(container, "Link zur Datenschutzerklärung");
      await act(() =>
        handlersOf(url).onChange({ target: { value: "/datenschutz" } })
      );
      assert.ok(
        plain(byPreview(container, "privacy-bubble")[0]).endsWith(
          "Datenschutzerklärung"
        )
      );
      // Schalter: eine andere Einstellung, das Fenster schließt (F-4)
      await toggle(act, theSwitch(container), false);
      assert.equal(dialogs(container).length, 0);
      assert.equal(byPreview(container, "privacy-bubble").length, 0);
      await act(() => click(byPreview(container, "privacy-link")[0]));
      [dialog] = dialogs(container);
      assert.ok(dialog, "Link öffnet das Fenster");
      await toggle(act, theSwitch(container), true);
      assert.equal(dialogs(container).length, 0);
      assert.equal(byPreview(container, "privacy-bubble").length, 1);
    }
  );

test("C3: nach den Tests mit ersetztem fetch gilt wieder das echte fetch", () => {
  assert.equal(globalThis.fetch, REAL_FETCH);
});
