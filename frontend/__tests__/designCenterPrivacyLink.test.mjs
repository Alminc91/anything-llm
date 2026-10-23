// Datenschutz als Link in der Fußzeile (issues/datenschutz-fusszeile.md,
// Nutzer 23.10.2026, Release 7.23). Design Center, Reiter Inhalt: keine
// Auswahl und kein Schalter für den Datenschutz-Hinweis mehr, Felder
// Überschrift, Text und Link bleiben, dazu der Hinweis aus AK-6; beim
// Speichern wird privacyNotice nicht geschrieben (AK-6), ein gespeicherter
// Altwert wirkt nicht (AK-7). Vorschau: dieselbe Fußzeile wie das Widget
// („Unsere KI kann Fehler machen · Datenschutz“), keine Datenschutz-Blase,
// das Datenschutz-Fenster öffnet per Klick über dem Chat und schließt mit
// „Schließen“, dem Schließen-Symbol und Esc; Änderungen an Überschrift, Text
// und Link erscheinen sofort im Fenster (AK-9).
//
// Ersetzt designCenterPrivacySwitch.test.mjs (Schalter „Datenschutz-Hinweis
// anzeigen“, KIE-565 Nachtrag, bis 7.22.2).
//
// Reine Logik (widgetKeys.js), Darstellung serverseitig gerendert, Fenster
// und Speichern mit eingehängter Vorschau bzw. Seite und ersetztem fetch
// (wie designCenterStandardSave.test.mjs).
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

// Wortlaute aus der Spezifikation (AK-1, AK-3, AK-6)
const HINT =
  "Der Datenschutz-Hinweis erscheint immer als Link „Datenschutz“ unter der Eingabe. Für den Inhalt sind Sie als Betreiber der Website verantwortlich.";
const FIXED_NOTE =
  "Fest eingebaut: der KI-Hinweis „Unsere KI kann Fehler machen“ und daneben der Link „Datenschutz“.";
const FOOTER = "Unsere KI kann Fehler machen · Datenschutz";
const AI_TITLE = "Hinweis zur KI";
const AI_TEXT =
  "Unser KI-Berater ist auf richtige Auskünfte optimiert. Wie jede KI kann er sich dennoch einmal irren. Wichtige Angaben wie Termine und Preise finden Sie zur Kontrolle immer auf unserer Website.";
const CLOSE_LABEL = "Datenschutz schließen";

// gespeicherte Werte von privacyNotice: keiner, die Altwerte bis 7.22.2 und
// der Wert, den der Server seit 7.23 fest liefert
const NOTICE_VALUES = [undefined, "bubble", "none", " NONE ", "modal", "link"];
const withNotice = (config, privacyNotice) =>
  privacyNotice === undefined ? { ...config } : { ...config, privacyNotice };

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
// Text eines Elements ohne Zeilenumbrüche, Leerraum vereinheitlicht
const plain = (el) => el.textContent.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Logik (widgetKeys.js)
// ---------------------------------------------------------------------------

test("AK-6: keine Schalter-Logik mehr (privacyNoticeOn, withPrivacyNotice entfallen)", () => {
  assert.equal("privacyNoticeOn" in keys, false);
  assert.equal("withPrivacyNotice" in keys, false);
  assert.deepEqual(keys.PRIVACY_FIELD_KEYS, [
    "privacyTitle",
    "privacyText",
    "privacyUrl",
  ]);
});

test("AK-6: cleanConfig schreibt privacyNotice nie; ein gespeicherter Altwert bleibt wörtlich stehen", () => {
  for (const stored of NOTICE_VALUES) {
    const initial = withNotice({ name: "VHS" }, stored);
    // auch ein abweichender Wert im Bearbeitungsstand wird nicht geschrieben
    for (const edited of [undefined, "bubble", "none", "link"]) {
      const config = withNotice(
        { name: "VHS", privacyTitle: " Hinweis " },
        edited
      );
      const out = keys.cleanConfig(config, {
        initial,
        defaults: DEFAULTS,
        greetingKey: "greeting",
      });
      const label = `gespeichert ${JSON.stringify(stored)}, bearbeitet ${JSON.stringify(edited)}`;
      if (stored === undefined)
        assert.equal("privacyNotice" in out, false, label);
      else assert.equal(out.privacyNotice, stored, label);
      assert.equal(out.privacyTitle, "Hinweis", label);
    }
    // ohne Änderung: keine „Ungespeicherten Änderungen“ (bereinigt gleich)
    assert.deepEqual(
      keys.cleanConfig(initial, { initial, defaults: DEFAULTS }),
      initial
    );
  }
});

test("AK-7: früher ausgeschaltet (none): Überschrift, Text und Link werden geprüft und bereinigt wie bei jedem Widget", () => {
  const stored = {
    privacyNotice: "none",
    privacyTitle: "Hinweis",
    privacyText: "Punkt eins\nPunkt zwei",
    privacyUrl: "/datenschutz",
  };
  const opts = { initial: stored, defaults: DEFAULTS, greetingKey: "greeting" };
  const invalid = {
    ...stored,
    privacyText: "x".repeat(2000),
    privacyUrl: "javascript:alert(1)",
  };
  const errors = keys.validateConfig(invalid, stored, "greeting");
  assert.ok(errors.privacyText, "Text über der Grenze");
  assert.ok(errors.privacyUrl, "kein http(s)-Link");
  assert.deepEqual(
    keys.cleanConfig(
      {
        ...stored,
        privacyTitle: "  Neu  ",
        privacyText: "• Eins",
        privacyUrl: " https://example.org/datenschutz ",
      },
      opts
    ),
    {
      privacyNotice: "none",
      privacyTitle: "Neu",
      privacyText: "• Eins",
      privacyUrl: "https://example.org/datenschutz",
    }
  );
});

// F5 (C1, Fixliste rc1): Eine leere Überschrift ist kein eigener Zustand
// mehr. Sie gilt wie der Standard: beim Speichern entfernt (wie der
// Standard nur nach einer Bearbeitung, F05), der Server liefert sie nicht
// aus, die Vorschau zeigt den Standard. Bis 7.22.2 hieß leer „keine
// Überschrift“.
test("F5: leere Überschrift gilt wie der Standard: beim Speichern entfernt, ungeändert gespeichert bleibt sie stehen", () => {
  for (const privacyTitle of ["", "   "]) {
    for (const initial of [{}, { privacyTitle: "Hinweis" }])
      assert.deepEqual(
        keys.cleanConfig(
          { privacyTitle },
          { initial, defaults: DEFAULTS, greetingKey: "greeting" }
        ),
        {},
        `${JSON.stringify(privacyTitle)} aus ${JSON.stringify(initial)}`
      );
    const stored = { privacyTitle };
    assert.deepEqual(
      keys.cleanConfig(stored, { initial: stored, defaults: DEFAULTS }),
      stored
    );
  }
});

test("F5: Vorschau zeigt bei leerer Überschrift den Standard, ohne Sonderfall in der Darstellung", async () => {
  if (!hasFrontendDeps) return;
  const { previewPrivacy } = await renderer.load(PREVIEW);
  for (const privacyTitle of ["", "   ", undefined]) {
    assert.equal(
      previewPrivacy({ privacyTitle }, DEFAULTS).title,
      "Datenschutz"
    );
    assert.equal(previewPrivacy({ privacyTitle }, null).title, "Datenschutz");
  }
  assert.equal(
    previewPrivacy({ privacyTitle: " Hinweis " }, DEFAULTS).title,
    "Hinweis"
  );
  assert.equal("standardTitle" in previewPrivacy({}, DEFAULTS), false);
});

// ---------------------------------------------------------------------------
// Reiter Inhalt
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

const tagWith = (html, attr) => {
  const m = html.match(new RegExp(`<(input|textarea)[^>]*${attr}[^>]*>`));
  assert.ok(m, `Feld ${attr} fehlt`);
  return m[0];
};

test(
  "AK-6: Inhalt ohne Schalter, Hinweis wörtlich, Überschrift, Text und Link bearbeitbar, für jeden gespeicherten Wert",
  { skip },
  async () => {
    for (const privacyNotice of NOTICE_VALUES) {
      const html = await renderer.render(CONTENT, {
        location: "/",
        props: contentProps(
          withNotice(
            {
              privacyTitle: "Hinweis",
              privacyText: "• Eigener Punkt",
              privacyUrl: "/datenschutz",
            },
            privacyNotice
          )
        ),
      });
      const t = text(html);
      const label = String(privacyNotice);
      assert.ok(t.includes(HINT), label);
      assert.ok(t.includes(FIXED_NOTE), label);
      assert.ok(!t.includes("Datenschutz-Hinweis anzeigen"), label);
      assert.ok(!t.includes("Wir empfehlen, den Hinweis anzuzeigen"), label);
      assert.ok(!t.includes("ausgeschaltet"), label);
      assert.doesNotMatch(html, /data-privacy-switch|role="switch"/, label);
      assert.doesNotMatch(html, /<fieldset/, label);
      for (const field of [
        tagWith(html, 'aria-label="Überschrift des Datenschutz-Hinweises"'),
        tagWith(html, 'aria-label="Text des Datenschutz-Hinweises"'),
        tagWith(html, 'aria-label="Link zur Datenschutzerklärung"'),
      ])
        assert.doesNotMatch(field, /disabled/, `${label} ${field}`);
      assert.match(html, /value="Hinweis"/);
      assert.match(html, /value="\/datenschutz"/);
      assert.ok(t.includes("• Eigener Punkt"));
      // keine Datenschutz-Blase mehr: Hinweise zu Begrüßung und Link
      assert.ok(!t.includes("zweite Blase"), label);
      assert.ok(!t.includes("Ende der Blase"), label);
      assert.ok(t.includes("Steht im Datenschutz-Fenster unter dem Text."));
      // leere Überschrift: im Fenster der Standard wie im Widget
      assert.ok(t.includes("Leer: es gilt „Datenschutz“."), label);
      assert.ok(!t.includes("Leer: keine Überschrift."), label);
      assert.ok(
        t.includes(
          "Empfohlen: Ohne Link fehlt im Hinweis der Verweis auf Ihre Datenschutzerklärung."
        )
      );
      assert.doesNotMatch(t, /[–—]/);
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
const footerOf = (html) => {
  const m = html.match(/<p[^>]*data-preview="disclaimer"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(m, "Fußzeile fehlt");
  return m;
};

test(
  "AK-1/AK-7/AK-9: Vorschau ohne Datenschutz-Blase, Fußzeile „Unsere KI kann Fehler machen · Datenschutz“ mit Link, in beiden Darstellungen und für jeden gespeicherten Wert",
  { skip },
  async () => {
    for (const displayMode of [undefined, "inline"])
      for (const privacyNotice of NOTICE_VALUES) {
        const label = `${displayMode} ${privacyNotice}`;
        const html = await renderer.render(PREVIEW, {
          location: "/",
          props: previewProps(
            withNotice(
              { displayMode, privacyUrl: "https://example.org/datenschutz" },
              privacyNotice
            )
          ),
        });
        assert.doesNotMatch(html, /data-preview="privacy-bubble"/, label);
        assert.match(html, /data-preview="greeting-bubble"/, label);
        const [footer, inner] = footerOf(html);
        assert.equal(text(inner), FOOTER, label);
        // eine Zeile, nicht abgeschnitten
        assert.match(footer, /whitespace-nowrap/, label);
        // nur „Datenschutz“ ist der Link: ein Button mit Unterstreichung
        const link = inner.match(/<button[^>]*>Datenschutz<\/button>/);
        assert.ok(link, label);
        assert.match(link[0], /type="button"/);
        assert.match(link[0], /data-preview="privacy-link"/);
        assert.match(link[0], /\bunderline\b/);
        assert.match(link[0], /aria-haspopup="dialog"/);
        assert.equal((inner.match(/<button/g) || []).length, 1, label);
        // das Fenster ist zu Beginn geschlossen
        assert.doesNotMatch(html, /role="dialog"/, label);
        assert.ok(!text(html).includes(AI_TITLE), label);
      }
  }
);

test(
  "AK-2: Linkfarbe mit mindestens 4,5:1 zur Fläche, hell und dunkel, auch bei heller Akzentfarbe",
  { skip },
  async () => {
    const { contrastRatio } = await import(
      "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/contrast.js"
    );
    for (const [theme, panel] of [
      ["light", "#ffffff"],
      ["dark", "#1d1d21"],
    ])
      for (const accentColor of [undefined, "#FFA102", "#01A5A9", "#1d1d21"]) {
        const html = await renderer.render(PREVIEW, {
          location: "/",
          props: previewProps({ theme, accentColor }),
        });
        const [, inner] = footerOf(html);
        const color = inner.match(
          /<button[^>]*style="[^"]*(?<![-\w])color:\s*([^;"]+)/
        );
        assert.ok(color, `${theme} ${accentColor}: Linkfarbe fehlt`);
        assert.ok(
          contrastRatio(color[1].trim(), panel) >= 4.5,
          `${theme} ${accentColor}: ${color[1]} auf ${panel}`
        );
      }
  }
);

// ---------------------------------------------------------------------------
// Vorschau eingehängt: Fenster öffnen und schließen
// ---------------------------------------------------------------------------

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

const OWN = {
  privacyTitle: "Hinweis der VHS",
  privacyText: "• Erster Punkt\nEin Absatz <img src=x onerror=alert(1)>",
  privacyUrl: "https://example.org/datenschutz",
};

for (const [name, displayMode, panelName] of [
  ["Chatfenster", undefined, "chat-panel"],
  ["In der Seite", "inline", "inline-panel"],
])
  test(
    `AK-9 ${name}: Klick auf „Datenschutz“ öffnet das Fenster über dem Chat; Schließen, Symbol und Esc schließen, Fokus zurück auf den Link`,
    { skip },
    async (t) => {
      const mounted = await renderer.mount(PREVIEW, {
        location: "/",
        props: previewProps({ displayMode, ...OWN }),
      });
      t.after(() => mounted.unmount());
      const { container, act, document } = mounted;
      const panel = byPreview(container, panelName)[0];
      assert.ok(panel, `${panelName} fehlt`);
      const link = () => byPreview(container, "privacy-link")[0];
      assert.equal(dialogs(container).length, 0);

      const open = async () => {
        await act(() => click(link()));
        const [dialog] = dialogs(container);
        assert.ok(dialog, "Fenster fehlt");
        return dialog;
      };
      const dialog = await open();
      // über dem ganzen Chat: direkt im Panel, deckt es ganz ab
      assert.equal(dialog.parentNode, panel);
      assert.match(panel.getAttribute("class"), /\brelative\b/);
      assert.match(dialog.getAttribute("class"), /\babsolute\b/);
      assert.match(dialog.getAttribute("class"), /\binset-0\b/);
      // Barrierefreiheit wie im Widget (AK-5)
      assert.equal(dialog.getAttribute("aria-modal"), "true");
      const titleId = dialog.getAttribute("aria-labelledby");
      assert.ok(titleId);
      const heading = elements(
        dialog,
        (el) => el.getAttribute("id") === titleId
      )[0];
      assert.ok(heading, "Überschrift fehlt");
      assert.equal(plain(heading), OWN.privacyTitle);
      assert.equal(link().getAttribute("aria-expanded"), "true");
      // Inhalt: Text (als Text, kein HTML), Hinweis zur KI, Link, Schließen
      const body = plain(dialog);
      assert.ok(body.includes("Erster Punkt"));
      assert.ok(body.includes("Ein Absatz <img src=x onerror=alert(1)>"));
      assert.equal(elements(dialog, (el) => el.tagName === "IMG").length, 0);
      assert.ok(body.includes(AI_TITLE));
      assert.ok(body.includes(AI_TEXT));
      assert.ok(body.includes("Datenschutzerklärung"));
      assert.ok(
        body.indexOf("Erster Punkt") < body.indexOf(AI_TITLE) &&
          body.indexOf(AI_TITLE) < body.indexOf("Datenschutzerklärung")
      );
      assert.ok(buttonByText(dialog, "Schließen"));
      assert.ok(byAria(dialog, CLOSE_LABEL));
      // Fokus beim Öffnen im Fenster
      assert.ok(dialog.contains(document.activeElement), "Fokus im Fenster");
      // der Verlauf bleibt darunter erhalten
      assert.equal(byPreview(container, "greeting-bubble").length, 1);

      // „Schließen“
      await act(() => click(buttonByText(dialog, "Schließen")));
      assert.equal(dialogs(container).length, 0);
      assert.equal(document.activeElement, link());
      assert.equal(link().getAttribute("aria-expanded"), "false");
      // Schließen-Symbol
      let again = await open();
      await act(() => click(byAria(again, CLOSE_LABEL)));
      assert.equal(dialogs(container).length, 0);
      assert.equal(document.activeElement, link());
      // Esc
      again = await open();
      await act(() =>
        handlersOf(again).onKeyDown({
          key: "Escape",
          preventDefault() {},
          stopPropagation() {},
        })
      );
      assert.equal(dialogs(container).length, 0);
      assert.equal(document.activeElement, link());
      assert.equal(byPreview(container, "greeting-bubble").length, 1);
    }
  );

test(
  "AK-9: Tab-Reihenfolge wie im Widget (Text, Schließen, Schließen-Symbol) und bleibt im Fenster; Standardtexte ohne eigene Werte",
  { skip },
  async (t) => {
    const mounted = await renderer.mount(PREVIEW, {
      location: "/",
      props: previewProps({}),
    });
    t.after(() => mounted.unmount());
    const { container, act, document } = mounted;
    await act(() => click(byPreview(container, "privacy-link")[0]));
    const [dialog] = dialogs(container);
    const x = byAria(dialog, CLOSE_LABEL);
    const close = buttonByText(dialog, "Schließen");
    const body = byPreview(dialog, "privacy-dialog-body")[0];
    // Dokumentreihenfolge: Überschrift, Text, Schließen, Schließen-Symbol
    const order = elements(
      dialog,
      (el) => el === body || el === close || el === x
    );
    assert.deepEqual(order, [body, close, x]);
    assert.equal(body.getAttribute("tabindex"), "0");
    // Fokus nach dem Öffnen auf der Überschrift
    const heading = elements(
      dialog,
      (el) => el.getAttribute("id") === dialog.getAttribute("aria-labelledby")
    )[0];
    assert.equal(document.activeElement, heading);
    let prevented = false;
    const tab = (shiftKey) => ({
      key: "Tab",
      shiftKey,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    });
    // Umschalt+Tab von der Überschrift: zum letzten (Schließen-Symbol)
    await act(() => handlersOf(dialog).onKeyDown(tab(true)));
    assert.equal(document.activeElement, x);
    assert.ok(prevented);
    // Tab vom letzten: zurück zum Text
    prevented = false;
    await act(() => handlersOf(dialog).onKeyDown(tab(false)));
    assert.equal(document.activeElement, body);
    assert.ok(prevented);
    // dazwischen der Browser (kein Eingriff)
    prevented = false;
    close.focus();
    await act(() => handlersOf(dialog).onKeyDown(tab(false)));
    assert.ok(!prevented);
    // ohne eigene Werte: Standard-Überschrift und Standardpunkte, kein Link
    // zur Datenschutzerklärung
    assert.equal(plain(heading), DEFAULTS.privacyTitle);
    const text = plain(dialog);
    assert.ok(!text.includes("Datenschutzerklärung"));
    for (const line of DEFAULTS.privacyText.split("\n"))
      assert.ok(text.includes(line.replace(/^• /, "")), line);
  }
);

test(
  "AK-3: leere Überschrift ergibt im Fenster den Standard „Datenschutz“ wie im Widget",
  { skip },
  async (t) => {
    for (const privacyTitle of ["", "  "]) {
      const mounted = await renderer.mount(PREVIEW, {
        location: "/",
        props: previewProps({ privacyTitle }),
      });
      t.after(() => mounted.unmount());
      const { container, act } = mounted;
      await act(() => click(byPreview(container, "privacy-link")[0]));
      const [dialog] = dialogs(container);
      const heading = elements(
        dialog,
        (el) => el.getAttribute("id") === dialog.getAttribute("aria-labelledby")
      )[0];
      assert.equal(plain(heading), "Datenschutz");
      assert.doesNotMatch(heading.getAttribute("class"), /sr-only/);
    }
  }
);

test(
  "NAK-1/NAK-3: Überschrift und Text nie als HTML, Link zur Datenschutzerklärung nur als https-Adresse oder Pfad",
  { skip },
  async (t) => {
    for (const privacyUrl of [
      "javascript:alert(1)",
      "http://example.org/datenschutz",
      "//fremd.example/x",
      " data:text/html,x",
    ]) {
      const mounted = await renderer.mount(PREVIEW, {
        location: "/",
        props: previewProps({
          privacyTitle: '<a href="javascript:alert(1)">Titel</a>',
          privacyText: '<img src=x onerror="alert(1)">\n• <b>fett</b>',
          privacyUrl,
        }),
      });
      t.after(() => mounted.unmount());
      const { container, act } = mounted;
      await act(() => click(byPreview(container, "privacy-link")[0]));
      const [dialog] = dialogs(container);
      for (const tag of ["A", "IMG", "B"])
        assert.equal(
          elements(dialog, (el) => el.tagName === tag).length,
          0,
          `${privacyUrl}: ${tag}`
        );
      const body = plain(dialog);
      assert.ok(body.includes('<a href="javascript:alert(1)">Titel</a>'));
      assert.ok(body.includes('<img src=x onerror="alert(1)">'));
      assert.ok(!body.includes("Datenschutzerklärung"), privacyUrl);
    }
  }
);

test("Rückfalltexte der Vorschau gleich den deutschen Standardtexten des Servers", async () => {
  if (!hasFrontendDeps) return;
  const { PRIVACY_PREVIEW_TEXTS } = await renderer.load(PREVIEW);
  for (const [key, value] of Object.entries(PRIVACY_PREVIEW_TEXTS))
    assert.equal(value, DEFAULTS[key], key);
});

// ---------------------------------------------------------------------------
// Design Center eingehängt: Bearbeiten erscheint sofort im Fenster, Speichern
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
const savedBody = (calls) => {
  const call = calls.find((c) => c.url.includes("/embed/update/"));
  return call ? JSON.parse(call.body.visual_config) : null;
};
const unsaved = (container) =>
  container.textContent.includes("Ungespeicherte Änderungen");

// Bestandskunde mit eigenem Datenschutz-Text und dem Altwert "bubble"
const STORED = {
  accentColor: "#FFA102",
  name: "VHS",
  privacyNotice: "bubble",
  privacyTitle: "Hinweis",
  privacyText: "Punkt eins\nPunkt zwei",
  privacyButtonText: "OK",
};

test(
  "AK-9: Überschrift, Text und Link ändern: das Fenster der Vorschau öffnet sich und zeigt die Änderung sofort, ohne dem Feld den Fokus zu nehmen",
  { skip },
  async (t) => {
    const { container, act, document } = await openDesignCenter(
      t,
      [widget(4, STORED)],
      4
    );
    // beim Öffnen kein Fenster, keine Änderung
    assert.equal(dialogs(container).length, 0);
    assert.ok(!unsaved(container));
    const title = byAria(container, "Überschrift des Datenschutz-Hinweises");
    title.focus();
    await act(() =>
      handlersOf(title).onChange({ target: { value: "Neue Überschrift" } })
    );
    let [dialog] = dialogs(container);
    assert.ok(dialog, "Fenster öffnet bei Änderung");
    assert.ok(plain(dialog).includes("Neue Überschrift"));
    assert.equal(document.activeElement, title, "Fokus bleibt im Feld");
    // ohne Fokus im Fenster nicht modal: das Design Center bleibt für
    // Screenreader erreichbar
    assert.equal(dialog.getAttribute("aria-modal"), null);
    const textarea = byAria(container, "Text des Datenschutz-Hinweises");
    await act(() =>
      handlersOf(textarea).onChange({ target: { value: "• Neuer Punkt" } })
    );
    [dialog] = dialogs(container);
    assert.ok(plain(dialog).includes("Neuer Punkt"));
    assert.ok(!plain(dialog).includes("Punkt eins"));
    const url = byAria(container, "Link zur Datenschutzerklärung");
    assert.ok(!plain(dialog).includes("Datenschutzerklärung"));
    await act(() =>
      handlersOf(url).onChange({ target: { value: "/datenschutz" } })
    );
    [dialog] = dialogs(container);
    assert.ok(plain(dialog).includes("Datenschutzerklärung"));
    // Schließen in der Vorschau ist keine Änderung am Widget
    await act(() => click(buttonByText(dialog, "Schließen")));
    assert.equal(dialogs(container).length, 0);
    assert.ok(unsaved(container));
  }
);

test(
  "AK-6: Speichern schreibt privacyNotice nicht: gespeicherter Altwert bleibt, ohne Wert kommt keiner dazu",
  { skip },
  async (t) => {
    let { container, act, calls } = await openDesignCenter(
      t,
      [widget(4, STORED)],
      4
    );
    const title = () =>
      byAria(container, "Überschrift des Datenschutz-Hinweises");
    await act(() => handlersOf(title()).onChange({ target: { value: "Neu" } }));
    await act(() => click(buttonByText(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { ...STORED, privacyTitle: "Neu" });

    ({ container, act, calls } = await openDesignCenter(
      t,
      [widget(9, null)],
      9
    ));
    assert.ok(!unsaved(container));
    await act(() =>
      handlersOf(title()).onChange({ target: { value: "Hinweis" } })
    );
    await act(() => click(buttonByText(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { privacyTitle: "Hinweis" });

    // früher ausgeschaltet: die Felder sind bearbeitbar und werden
    // gespeichert, privacyNotice bleibt wörtlich (bis 7.22.2 waren sie
    // gesperrt und blieben wie gespeichert)
    const off = { ...STORED, privacyNotice: "none" };
    ({ container, act, calls } = await openDesignCenter(
      t,
      [widget(5, off)],
      5
    ));
    await act(() =>
      handlersOf(title()).onChange({ target: { value: " Neu " } })
    );
    await act(() => click(buttonByText(container, "Speichern")));
    assert.deepEqual(savedBody(calls), { ...off, privacyTitle: "Neu" });
  }
);
