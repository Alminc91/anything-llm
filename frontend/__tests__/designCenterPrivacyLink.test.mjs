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
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
// das echte fetch, vor jedem Ersatz gesichert (stubServer stellt es wieder
// her, auch wenn ein Test mehrmals ersetzt; C3, Fixliste rc1)
const REAL_FETCH = globalThis.fetch;

// Wortlaute aus der Spezifikation (AK-1, AK-3, AK-6); der Gruppenhinweis
// seit F10 (Fixliste rc2, Nachtrag 24.10.2026) wie im freigegebenen Mockup
// (issues/datenschutz-fusszeile/mockup/DesignCenter.dc.html) mit dem Satz,
// was ein Klick zeigt
const HINT =
  "Erscheint immer als Link „Datenschutz“ unter der Eingabe. Ein Klick öffnet den Hinweis über dem Chat. Für den Inhalt sind Sie als Betreiber der Website verantwortlich.";
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

// F18 (C3 und NF-7, Fixliste rc3): eine Funktion für „leer oder nur
// Leerzeichen“ im Feld Überschrift. Bis rc3 stand die Regel für reine
// Leerzeichen zusätzlich als Zweig in ContentTab.jsx (F11).
test('F18: privacyTitleFieldValue ergibt bei leerer Überschrift und bei nur Leerzeichen "", sonst den Feldwert', () => {
  for (const privacyTitle of ["", "   ", " \n\t "])
    for (const defaults of [DEFAULTS, null])
      assert.equal(
        keys.privacyTitleFieldValue({ privacyTitle }, defaults),
        "",
        `${JSON.stringify(privacyTitle)} ${defaults ? "mit" : "ohne"} Standardtexte`
      );
  assert.equal(
    keys.privacyTitleFieldValue({ privacyTitle: " Hinweis " }, DEFAULTS),
    " Hinweis "
  );
  assert.equal(
    keys.privacyTitleFieldValue({}, DEFAULTS),
    DEFAULTS.privacyTitle
  );
  assert.equal(keys.privacyTitleFieldValue({}, null), "");
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
  "AK-6: Inhalt ohne Schalter „Datenschutz-Hinweis anzeigen“ (seit AK-12 nur der Schalter für die Blase), Hinweis wörtlich, Überschrift, Text und Link bearbeitbar, für jeden gespeicherten Wert",
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
      // Bewusste Änderung (AK-12, Nutzer 24.10.2026): der einzige Schalter
      // ist „Zusätzlich beim Start als Blase zeigen“ (designCenterPrivacy
      // StartBubble.test.mjs); bis rc4 gab es hier keinen Schalter. Den
      // Schalter „Datenschutz-Hinweis anzeigen“ (bis 7.22.2) gibt es nicht.
      assert.doesNotMatch(html, /data-privacy-switch/, label);
      // Seit KIE-576 Paket 3 steht im Reiter Inhalt zusätzlich der Schalter
      // „Kursanzahl im Untertitel“ (designCenterCourseCount.test.mjs); im
      // Datenschutz-Hinweis bleibt es genau ein Schalter.
      assert.equal((html.match(/role="switch"/g) || []).length, 2, label);
      const privacyAt = html.indexOf("data-privacy-start-bubble");
      assert.ok(privacyAt >= 0, label);
      const privacyBlock = html.slice(
        privacyAt,
        html.indexOf("</label>", privacyAt)
      );
      assert.equal(
        (privacyBlock.match(/role="switch"/g) || []).length,
        1,
        label
      );
      assert.ok(t.includes("Zusätzlich beim Start als Blase zeigen"), label);
      // ab dem Datenschutz-Hinweis kein gesperrtes fieldset (das einzige
      // fieldset im Reiter ist seit KIE-576 Paket 3 der Untertitel)
      assert.doesNotMatch(html.slice(privacyAt), /<fieldset/, label);
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
      // F10: ein Begriff in der Gruppe, „Hinweis“ (wie Gruppe und Mockup),
      // nicht daneben „Datenschutz-Fenster“
      assert.ok(t.includes("Steht im Hinweis unter dem Text."), label);
      assert.ok(!t.includes("Datenschutz-Fenster"), label);
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

// F11 (Fixliste rc2, Nachtrag 24.10.2026; Opus EMP-4, Sonnet
// EMP-1-AltTitelLeer): Das leere Feld Überschrift zeigt den Standard
// „Datenschutz“ als Platzhalter, wie das Textfeld den Standardtext. Das gilt
// auch für eine vor 7.23 gespeicherte leere Überschrift ("" oder nur
// Leerzeichen, solange sie nicht bearbeitet ist); eine Bearbeitung zeigt
// das Feld unverändert. Der Platzhalter kommt aus derselben Quelle wie die
// Überschrift im Fenster der Vorschau.
const titleTag = (html) =>
  tagWith(html, 'aria-label="Überschrift des Datenschutz-Hinweises"');
const attrOf = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};

test(
  "F11: leeres Feld Überschrift zeigt „Datenschutz“ als Platzhalter, auch bei alt gespeicherter leerer Überschrift und ohne Standardtexte",
  { skip },
  async () => {
    const { previewPrivacy } = await renderer.load(PREVIEW);
    const standard = previewPrivacy({ privacyTitle: "" }, DEFAULTS).title;
    assert.equal(standard, "Datenschutz");
    for (const [label, config, initial, defaults, value] of [
      ["gespeichert leer", { privacyTitle: "" }, null, DEFAULTS, ""],
      ["gespeichert Leerzeichen", { privacyTitle: "   " }, null, DEFAULTS, ""],
      ["geleert", { privacyTitle: "" }, {}, DEFAULTS, ""],
      ["Standardtexte fehlen", {}, null, null, ""],
      // nur Leerzeichen gilt auch beim Tippen wie leer (F18,
      // privacyTitleFieldValue); bis rc3 blieb das Feld dann, wie es war
      ["bearbeitet Leerzeichen", { privacyTitle: "  " }, {}, DEFAULTS, ""],
      ["bearbeitet", { privacyTitle: " Hin" }, {}, DEFAULTS, " Hin"],
      ["eigener Text", { privacyTitle: "Hinweis" }, null, DEFAULTS, "Hinweis"],
      ["nichts gespeichert", {}, null, DEFAULTS, "Datenschutz"],
    ]) {
      const html = await renderer.render(CONTENT, {
        location: "/",
        props: {
          ...contentProps(config, initial ?? config),
          defaults,
          defaultsError: defaults === null,
        },
      });
      const field = titleTag(html);
      assert.equal(attrOf(field, "placeholder"), standard, label);
      assert.equal(attrOf(field, "value") ?? "", value, label);
      // der Hinweis unter dem Feld nennt denselben Standard
      assert.ok(text(html).includes(`Leer: es gilt „${standard}“.`), label);
    }
  }
);

// F12 (Fixliste rc2, Nachtrag 24.10.2026; Opus EMP-5): „(optional)“ bei
// der Überschrift entfällt wie im Mockup; Text und Link sind ebenso
// freiwillig und tragen es auch nicht. Außerhalb der Gruppe bleibt es
// (Untertitel, Support-E-Mail).
test(
  "F12: Überschrift, Text und Link des Datenschutz-Hinweises ohne „(optional)“",
  { skip },
  async () => {
    for (const displayMode of [undefined, "inline"]) {
      const html = await renderer.render(CONTENT, {
        location: "/",
        props: contentProps({ displayMode }),
      });
      const fields = html.match(
        /data-privacy-fields=""[\s\S]*?Fest eingebaut: der KI-Hinweis/
      );
      assert.ok(fields, `${displayMode}: Gruppe fehlt`);
      const group = text(fields[0]);
      assert.ok(group.includes("Überschrift Standardtext"), group);
      assert.ok(!group.includes("(optional)"), group);
      const t = text(html);
      assert.ok(t.includes("Untertitel (optional)"), displayMode);
      assert.ok(t.includes("Support-E-Mail (optional)"), displayMode);
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
      // role="dialog" und aria-labelledby wie im Widget (AK-5); in der
      // Vorschau nie aria-modal, das Design Center daneben bleibt
      // erreichbar (R3-D1, Fixliste rc3)
      assert.equal(dialog.getAttribute("aria-modal"), null);
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
      // Fokus beim Öffnen auf der Überschrift
      assert.equal(
        document.activeElement,
        heading,
        "Fokus auf der Überschrift"
      );
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
  "AK-9, F14 (R3-D1, NF-2): Tab-Reihenfolge wie im Widget (Text, Schließen, Schließen-Symbol), keine Tab-Falle: Umschalt+Tab von der Überschrift und Tab vom Schließen-Symbol verlassen das Fenster; Standardtexte ohne eigene Werte",
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
    // Tab bewegt immer der Browser, das Fenster greift nie ein (bis rc3 eine
    // Tab-Falle wie im Widget: Umschalt+Tab sprang auf das Schließen-Symbol,
    // Tab vom Symbol zurück auf den Text)
    let prevented = false;
    const tab = (shiftKey) => ({
      key: "Tab",
      shiftKey,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    });
    for (const [from, shiftKey] of [
      [heading, true],
      [body, true],
      [close, false],
      [x, false],
    ]) {
      prevented = false;
      from.focus();
      await act(() => handlersOf(dialog).onKeyDown(tab(shiftKey)));
      assert.ok(!prevented, `${shiftKey ? "Umschalt+" : ""}Tab abgefangen`);
      assert.equal(document.activeElement, from, "Fokus nicht versetzt");
      assert.equal(dialogs(container).length, 1, "Fenster bleibt offen");
    }
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

// defaultsReady: Standardtexte erst, wenn dieses Versprechen erfüllt ist
function stubServer(t, embeds, defaultsReady = null) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, body });
    let answer = {};
    if (url.endsWith("/embeds")) answer = { embeds };
    else if (url.includes("/embed/defaults")) {
      await defaultsReady;
      answer = { lang: "de", defaults: DEFAULTS };
    } else if (url.includes("/embed/update/"))
      answer = { success: true, error: null };
    return { ok: true, status: 200, json: async () => answer };
  };
  t.after(() => {
    globalThis.fetch = REAL_FETCH;
  });
  return calls;
}

async function openDesignCenter(t, embeds, id, defaultsReady = null) {
  const calls = stubServer(t, embeds, defaultsReady);
  const mounted = await renderer.mount(DESIGN_CENTER, {
    location: "/settings/chatbot/design",
    props: { embedId: id },
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

// ---------------------------------------------------------------------------
// Zustand des Vorschau-Fensters (F2 der Fixliste rc1: F-2, F-3, F-4, C2;
// seit rc4 nie modal: F14 der Fixliste rc3, R3-D1)
// ---------------------------------------------------------------------------

// liegt das Element in einem inerten Teil (oder ist es selbst inert)?
const isInert = (el) => {
  for (let n = el; n; n = n.parentNode)
    if (typeof n.hasAttribute === "function" && n.hasAttribute("inert"))
      return true;
  return false;
};
// Fokus wie im Browser: ein Element in einem inerten Teil bekommt ihn nicht
// (das Test-Dokument kennt inert nicht)
const withBrowserFocus = (el) => {
  const focus = el.focus;
  el.focus = function (options) {
    if (!isInert(this)) focus.call(this, options);
  };
  return el;
};
const headingOf = (dialog) =>
  elements(
    dialog,
    (el) => el.getAttribute("id") === dialog.getAttribute("aria-labelledby")
  )[0];
const titleField = (container) =>
  byAria(container, "Überschrift des Datenschutz-Hinweises");
const typeInto = (act, field, value) =>
  act(() => handlersOf(field).onChange({ target: { value } }));

test(
  "F14 (R3-D1, NF-1): nie modal: Klick auf „Datenschutz“ öffnet ohne aria-modal mit Fokus auf der Überschrift; danach ins Feld, ungültig oder gültig tippen: offen, ohne aria-modal, der Fokus bleibt im Feld",
  { skip },
  async (t) => {
    const { container, act, document } = await openDesignCenter(
      t,
      [widget(4, STORED)],
      4
    );
    await act(() => click(byPreview(container, "privacy-link")[0]));
    let [dialog] = dialogs(container);
    assert.equal(dialog.getAttribute("aria-modal"), null);
    assert.equal(document.activeElement, headingOf(dialog));
    // Klick ins Feld ohne Tippen (NF-1, Ablauf 1)
    const url = byAria(container, "Link zur Datenschutzerklärung");
    url.focus();
    [dialog] = dialogs(container);
    assert.ok(dialog, "Fenster bleibt offen");
    assert.equal(dialog.getAttribute("aria-modal"), null);
    // ungültige Adresse, die Vorschau ändert sich nicht (NF-1, Ablauf 2)
    await typeInto(act, url, "www.vhs.de/datenschutz");
    [dialog] = dialogs(container);
    assert.ok(dialog, "Fenster bleibt offen");
    assert.equal(dialog.getAttribute("aria-modal"), null);
    assert.equal(document.activeElement, url);
    const title = titleField(container);
    title.focus();
    await typeInto(act, title, "Neue Überschrift");
    [dialog] = dialogs(container);
    assert.ok(dialog, "Fenster bleibt offen");
    assert.equal(plain(headingOf(dialog)), "Neue Überschrift");
    assert.equal(dialog.getAttribute("aria-modal"), null);
    assert.equal(document.activeElement, title);
  }
);

test(
  "F14 (R3-D1, NF-2): eine Feldänderung öffnet das Fenster ohne Fokuswechsel; Tab im Fenster greift nicht ein; Schließen ohne Fokus im Fenster lässt ihn im Feld, Schließen und Esc mit Fokus im Fenster geben ihn dem Link",
  { skip },
  async (t) => {
    const { container, act, document } = await openDesignCenter(
      t,
      [widget(4, STORED)],
      4
    );
    const link = withBrowserFocus(byPreview(container, "privacy-link")[0]);
    const title = titleField(container);
    title.focus();
    await typeInto(act, title, "Eins");
    let [dialog] = dialogs(container);
    assert.ok(dialog, "Feldänderung öffnet");
    assert.equal(dialog.getAttribute("aria-modal"), null);
    assert.equal(document.activeElement, title, "Fokus bleibt im Feld");
    // weiter per Tab ins Fenster und vom Schließen-Symbol wieder hinaus:
    // kein Eingriff (NF-2)
    const x = byAria(dialog, CLOSE_LABEL);
    x.focus();
    let prevented = false;
    await act(() =>
      handlersOf(dialog).onKeyDown({
        key: "Tab",
        shiftKey: false,
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {},
      })
    );
    assert.ok(!prevented, "Tab vom Schließen-Symbol abgefangen");
    assert.equal(document.activeElement, x);
    // Klick auf „Schließen“, ohne dass der Button den Fokus bekommt (wie in
    // Safari): der Fokus bleibt im Feld
    title.focus();
    await act(() =>
      handlersOf(buttonByText(dialog, "Schließen")).onClick({ detail: 1 })
    );
    assert.equal(dialogs(container).length, 0);
    assert.equal(document.activeElement, title, "Fokus bleibt im Feld");
    // Klick mit Fokus auf dem Button: der Fokus geht an den Link
    await typeInto(act, title, "Zwei");
    [dialog] = dialogs(container);
    assert.equal(document.activeElement, title);
    await act(() => click(buttonByText(dialog, "Schließen")));
    assert.equal(dialogs(container).length, 0);
    assert.equal(document.activeElement, link);
    // Esc im Fenster: ebenso
    title.focus();
    await typeInto(act, title, "Drei");
    [dialog] = dialogs(container);
    const body = byPreview(dialog, "privacy-dialog-body")[0];
    body.focus();
    await act(() =>
      handlersOf(dialog).onKeyDown({
        key: "Escape",
        preventDefault() {},
        stopPropagation() {},
      })
    );
    assert.equal(dialogs(container).length, 0);
    assert.equal(document.activeElement, link);
  }
);

for (const [name, displayMode, toggleLabel, messages, panelName] of [
  ["Chatfenster", undefined, "Chat schließen", "chat-messages", "chat-panel"],
  ["In der Seite", "inline", "Einklappen", "inline-messages", "inline-panel"],
])
  test(
    `F2 (F-3), F14 (C6) ${name}: unter dem offenen Fenster sind Kopf-Schalter, Verlauf und Link „Datenschutz“ inert, in einer gemeinsamen Hülle; wird der Link bedient, bekommt die Überschrift den Fokus, Schließen gibt ihn dem Link zurück`,
    { skip },
    async (t) => {
      const { container, act, document } = await openDesignCenter(
        t,
        [widget(4, { ...STORED, displayMode })],
        4
      );
      const link = withBrowserFocus(byPreview(container, "privacy-link")[0]);
      const covered = () => [
        byAria(container, toggleLabel),
        link,
        byPreview(container, messages)[0],
      ];
      for (const el of covered()) assert.ok(!isInert(el), "zu: bedienbar");
      const title = titleField(container);
      title.focus();
      await typeInto(act, title, "Neu");
      const [dialog] = dialogs(container);
      assert.equal(dialog.getAttribute("aria-modal"), null);
      for (const el of covered())
        assert.ok(
          isInert(el),
          `offen: ${el.getAttribute("aria-label") || el.getAttribute("data-preview")} inert`
        );
      assert.ok(!isInert(dialog), "das Fenster selbst ist bedienbar");
      // eine Hülle je Darstellung (C6, NF-10): genau ein inertes Element im
      // Panel, es enthält Kopf, Verlauf und Eingabe, das Fenster nicht
      const panel = byPreview(container, panelName)[0];
      const shells = elements(panel, (el) => el.hasAttribute("inert"));
      assert.equal(shells.length, 1, "eine inerte Hülle");
      for (const part of ["header", messages, "input"])
        assert.ok(
          shells[0].contains(byPreview(panel, part)[0]),
          `${part} in der Hülle`
        );
      assert.ok(!shells[0].contains(dialog), "Fenster außerhalb der Hülle");
      // der Link wird bedient (im Browser nur noch per Skript erreichbar):
      // der Fokus geht auf die Überschrift, nicht modal (R3-D1)
      await act(() => handlersOf(link).onClick({ detail: 0 }));
      assert.equal(dialogs(container)[0], dialog, "dasselbe Fenster");
      assert.equal(dialog.getAttribute("aria-modal"), null);
      assert.equal(document.activeElement, headingOf(dialog));
      // Schließen: erst ohne inert, dann der Fokus auf den Link
      await act(() => click(buttonByText(dialog, "Schließen")));
      assert.equal(dialogs(container).length, 0);
      for (const el of covered()) assert.ok(!isInert(el), "wieder bedienbar");
      assert.equal(document.activeElement, link);
    }
  );

test(
  "F2 (F-4): eine andere Änderung (Begrüßung, Akzentfarbe) schließt das Fenster, damit sie in der Vorschau zu sehen ist; Änderungen an Überschrift, Text und Link lassen es offen",
  { skip },
  async (t) => {
    const { container, act, document } = await openDesignCenter(
      t,
      [widget(4, STORED)],
      4
    );
    const open = () => dialogs(container).length === 1;
    const title = titleField(container);
    title.focus();
    await typeInto(act, title, "Neu");
    assert.ok(open(), "Überschrift öffnet");
    await typeInto(
      act,
      byAria(container, "Text des Datenschutz-Hinweises"),
      "• Eins"
    );
    await typeInto(
      act,
      byAria(container, "Link zur Datenschutzerklärung"),
      "/datenschutz"
    );
    assert.ok(open(), "Text und Link lassen es offen");
    // Begrüßung: das selbst geöffnete Fenster schließt, der Fokus bleibt
    const greeting = byAria(container, "Begrüßungstext");
    greeting.focus();
    await typeInto(act, greeting, "Guten Tag!");
    assert.ok(!open(), "Begrüßung schließt das Fenster");
    assert.equal(document.activeElement, greeting, "Fokus bleibt im Feld");
    assert.ok(
      text(container.textContent).includes("Guten Tag!"),
      "Begrüßung in der Vorschau"
    );
    // nach einem Klick auf den Link geöffnet: auch eine Änderung der Optik
    // (Akzentfarbe im Reiter Aussehen) schließt es
    await act(() => click(byPreview(container, "privacy-link")[0]));
    assert.ok(open());
    await act(() => click(buttonByText(container, "Aussehen")));
    await typeInto(
      act,
      byAria(container, "Akzentfarbe als Farbcode"),
      "#C4430A"
    );
    assert.ok(!open(), "Akzentfarbe schließt das Fenster");
  }
);

// F15 (NF-3, Fixliste rc3): Ob eine andere Änderung das Fenster schließt,
// entscheidet der bereinigte Stand (cleanConfig, wie „Ungespeicherte
// Änderungen“), nicht die rohen Werte. Speichern bereinigt auch Felder
// außerhalb des Datenschutzes (geleerte Begrüßung entfällt, Leerzeichen am
// Ende), in der Vorschau ändert sich dadurch nichts: Speichern ist keine
// Bearbeitung (wie F43 bei den Startvorschlägen).
test(
  "F15 (NF-3): Speichern schließt das Fenster nicht, auch wenn es andere Felder bereinigt (geleerte Begrüßung, Leerzeichen am Ende)",
  { skip },
  async (t) => {
    for (const greetingValue of ["", "Guten Tag! "]) {
      const label = JSON.stringify(greetingValue);
      const { container, act, calls } = await openDesignCenter(
        t,
        [widget(4, STORED)],
        4
      );
      await typeInto(act, byAria(container, "Begrüßungstext"), greetingValue);
      const text = byAria(container, "Text des Datenschutz-Hinweises");
      text.focus();
      await typeInto(act, text, "• Ein Punkt");
      assert.equal(dialogs(container).length, 1, `${label}: Text öffnet`);
      await act(() => click(buttonByText(container, "Speichern")));
      assert.ok(savedBody(calls), `${label}: gespeichert`);
      assert.ok(!unsaved(container), `${label}: nichts mehr ungespeichert`);
      assert.equal(
        dialogs(container).length,
        1,
        `${label}: Fenster bleibt nach dem Speichern offen`
      );
    }
  }
);

// Der bereinigte Stand hängt an den Standardtexten (cleanConfig vergleicht
// mit ihnen). Kommen sie erst, wenn das Fenster schon offen ist, ist das
// keine Änderung: Die Signatur ist bis dahin null wie bei allen Blöcken der
// Vorschau (C4, loadedSignature). Gespeichert ist die Standard-Begrüßung
// mit Leerzeichen am Ende: ohne Standardtexte bereinigt getrimmt, mit ihnen
// unverändert (Standard, nicht bearbeitet).
test(
  "F15 (C4): Standardtexte kommen erst nach dem Klick auf „Datenschutz“: das Fenster bleibt offen",
  { skip },
  async (t) => {
    let release;
    const defaultsReady = new Promise((resolve) => {
      release = resolve;
    });
    const { container, act } = await openDesignCenter(
      t,
      [widget(4, { name: "VHS", greeting: `${DEFAULTS.greeting} ` })],
      4,
      defaultsReady
    );
    await act(() => click(byPreview(container, "privacy-link")[0]));
    assert.equal(dialogs(container).length, 1, "Klick öffnet");
    await act(() => release());
    await act();
    assert.ok(
      titleField(container).getAttribute("placeholder"),
      "Standardtexte geladen"
    );
    assert.equal(dialogs(container).length, 1, "Fenster bleibt offen");
  }
);

// F3 (R1-D1 der Fixliste rc1): eine Linkfarbe für den Link „Datenschutz“,
// den Link zur Datenschutzerklärung und alle Fokusrahmen im Fenster, wie im
// Widget (theme.js privacyLinkColor): hell die Akzentfarbe, dunkel fest
// DARK.link #5CC8CB, je mit mindestens 4,5:1 zur Fläche der Fußzeile und
// des Fensters (Fokusrahmen brauchen 3:1). Seit L1 (Korrektur zu AK-12)
// hat auch der Link in der Datenschutz-Blase diese Farbe, ihre Fläche
// (hell #ffffff, dunkel #2a2a2f) steht schon in der Liste; Test dazu in
// designCenterPrivacyStartBubble.
const PRIVACY_SURFACES = { light: ["#ffffff"], dark: ["#1d1d21", "#2a2a2f"] };
const LINK_ACCENTS = [
  undefined,
  "#FFA102",
  "#63b4e3",
  "#01A5A9",
  "#FFFF00",
  "#1d1d21",
  "#ffffff",
];

test(
  "F3 (R1-D1): Link „Datenschutz“, Link zur Datenschutzerklärung und alle Fokusrahmen im Fenster in einer Farbe, hell aus der Akzentfarbe, dunkel #5CC8CB, mindestens 4,5:1 zu Fußzeile und Fenster",
  { skip },
  async (t) => {
    const { contrastRatio } = await import(
      "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/contrast.js"
    );
    for (const theme of ["light", "dark"])
      for (const displayMode of [undefined, "inline"])
        for (const accentColor of LINK_ACCENTS) {
          const label = `${theme} ${displayMode} ${accentColor}`;
          const mounted = await renderer.mount(PREVIEW, {
            location: "/",
            props: previewProps({
              theme,
              displayMode,
              accentColor,
              privacyUrl: "/datenschutz",
            }),
          });
          t.after(() => mounted.unmount());
          const { container, act } = mounted;
          const link = byPreview(container, "privacy-link")[0];
          const color = link.style.color;
          assert.equal(link.style.outlineColor, color, label);
          await act(() => click(link));
          const [dialog] = dialogs(container);
          const rings = [
            byPreview(dialog, "privacy-dialog-body")[0],
            buttonByText(dialog, "Schließen"),
            byAria(dialog, CLOSE_LABEL),
          ];
          for (const el of rings)
            assert.equal(el.style.outlineColor, color, `${label} Fokusrahmen`);
          assert.equal(
            byPreview(dialog, "privacy-statement-link")[0].style.color,
            color,
            `${label} Link zur Datenschutzerklärung`
          );
          for (const surface of PRIVACY_SURFACES[theme])
            assert.ok(
              contrastRatio(color, surface) >= 4.5,
              `${label}: ${color} auf ${surface}`
            );
          if (theme === "dark")
            assert.equal(color.toLowerCase(), "#5cc8cb", label);
        }
  }
);

// F3 (R1-D2 der Fixliste rc1): Bei „In der Seite“ ist die Textspalte des
// Fensters höchstens etwa 70 Zeichen breit und linksbündig; Kopfzeile mit
// Schließen-Symbol und Button-Zeile bleiben über die ganze Breite, der
// Textbereich scrollt weiter über die ganze Breite. Im Chatfenster keine
// Grenze.
test(
  "F3 (R1-D2): Textspalte des Fensters bei „In der Seite“ höchstens 70 Zeichen breit, Kopf, Button-Zeile und Bildlauf über die ganze Breite; im Chatfenster ohne Grenze",
  { skip },
  async (t) => {
    for (const displayMode of [undefined, "inline"]) {
      const mounted = await renderer.mount(PREVIEW, {
        location: "/",
        props: previewProps({ displayMode, privacyUrl: "/datenschutz" }),
      });
      t.after(() => mounted.unmount());
      const { container, act } = mounted;
      await act(() => click(byPreview(container, "privacy-link")[0]));
      const [dialog] = dialogs(container);
      const body = byPreview(dialog, "privacy-dialog-body")[0];
      const [column] = byPreview(body, "privacy-dialog-text");
      assert.ok(column, `${displayMode}: Textspalte fehlt`);
      // der ganze Inhalt steht in der Spalte, der Bildlauf bleibt am Rand
      assert.deepEqual(body.childNodes, [column]);
      assert.ok(plain(column).includes(AI_TEXT));
      assert.ok(plain(column).includes("Datenschutzerklärung"));
      assert.equal(body.style.maxWidth, undefined);
      if (displayMode === "inline") {
        assert.equal(column.style.maxWidth, "70ch");
        assert.doesNotMatch(column.getAttribute("class") || "", /mx-auto/);
      } else assert.equal(column.style.maxWidth, undefined);
      // Kopf und Button-Zeile ohne Grenze
      for (const el of [
        headingOf(dialog).parentNode,
        buttonByText(dialog, "Schließen").parentNode,
      ])
        assert.equal(el.style.maxWidth, undefined, displayMode);
    }
  }
);

// F13 (Fixliste rc2, Nachtrag 24.10.2026; Opus EMP-7): Das
// Schließen-Symbol steht mittig zur ersten Zeile der Überschrift, im
// Chatfenster und bei „In der Seite“ (bis rc2 dort 6 px tiefer: Mitte
// Überschrift 298, Symbol 304). Gerechnet aus den Klassen der Vorschau
// (Tailwind-Abstand n = n × 4 px), im Browser gemessen in der Anleitung.
const TW_LEADING = { "leading-tight": 1.25, "leading-snug": 1.375 };
const twSpace = (cls, prefix) => {
  const m = (cls || "").match(
    new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?=\\s|$)`)
  );
  assert.ok(m, `${prefix}-… fehlt in „${cls}“`);
  return Number(m[1]) * 4;
};
test(
  "F13: Schließen-Symbol mittig zur ersten Zeile der Überschrift, im Chatfenster und bei „In der Seite“",
  { skip },
  async (t) => {
    for (const displayMode of [undefined, "inline"]) {
      const mounted = await renderer.mount(PREVIEW, {
        location: "/",
        props: previewProps({ displayMode }),
      });
      t.after(() => mounted.unmount());
      const { container, act } = mounted;
      await act(() => click(byPreview(container, "privacy-link")[0]));
      const [dialog] = dialogs(container);
      const heading = headingOf(dialog);
      const headCls = heading.parentNode.getAttribute("class");
      const titleCls = heading.getAttribute("class");
      const size = Number(titleCls.match(/text-\[(\d+(?:\.\d+)?)px\]/)[1]);
      const leading = Object.entries(TW_LEADING).find(([c]) =>
        titleCls.split(/\s+/).includes(c)
      );
      assert.ok(leading, `Zeilenhöhe in „${titleCls}“`);
      const titleMid = twSpace(headCls, "pt") + (size * leading[1]) / 2;
      const iconCls = byAria(dialog, CLOSE_LABEL).getAttribute("class");
      const iconMid = twSpace(iconCls, "top") + twSpace(iconCls, "h") / 2;
      assert.ok(
        Math.abs(iconMid - titleMid) <= 1,
        `${displayMode}: Symbol ${iconMid} px, Überschrift ${titleMid} px`
      );
    }
  }
);

// F13 (Fixliste rc2, Nachtrag 24.10.2026; Opus EMP-8): Fläche, Schrift und
// Trennlinien des Fensters der Vorschau aus denselben Werten wie das Widget
// (theme.js PRIVACY_DIALOG_COLORS): hell Schrift #222628 und Linien
// #E9E9E9, dunkel #F4F2EF und #787B82 (bis rc2 die Palette der Vorschau,
// hell #1c1917 und #e7e5e4, dunkel #f4f4f5 und rgba(255,255,255,.12)). Das
// Schließen-Symbol hat wie im Widget die Schrift des Fensters (color:
// inherit; bis rc2 das gedämpfte Grau der Vorschau).
const DIALOG_COLORS = {
  light: { text: "#222628", bg: "#ffffff", line: "#e9e9e9" },
  dark: { text: "#f4f2ef", bg: "#2a2a2f", line: "#787b82" },
};
test(
  "F13: Fläche, Schrift, Trennlinien und Schließen-Symbol des Fensters wie im Widget, hell und dunkel, in beiden Darstellungen",
  { skip },
  async (t) => {
    for (const theme of ["light", "dark"])
      for (const displayMode of [undefined, "inline"]) {
        const label = `${theme} ${displayMode}`;
        const want = DIALOG_COLORS[theme];
        const mounted = await renderer.mount(PREVIEW, {
          location: "/",
          // eigene Akzentfarbe: das Fenster bleibt trotzdem fest
          props: previewProps({ theme, displayMode, accentColor: "#C4430A" }),
        });
        t.after(() => mounted.unmount());
        const { container, act } = mounted;
        await act(() => click(byPreview(container, "privacy-link")[0]));
        const [dialog] = dialogs(container);
        const lower = (v) => String(v ?? "").toLowerCase();
        assert.equal(lower(dialog.style.color), want.text, label);
        assert.equal(lower(dialog.style.backgroundColor), want.bg, label);
        assert.equal(
          lower(headingOf(dialog).parentNode.style.borderBottom),
          `1px solid ${want.line}`,
          `${label} Linie unter der Überschrift`
        );
        assert.equal(
          lower(buttonByText(dialog, "Schließen").parentNode.style.borderTop),
          `1px solid ${want.line}`,
          `${label} Linie über dem Button`
        );
        assert.equal(
          byAria(dialog, CLOSE_LABEL).style.color,
          "inherit",
          `${label} Schließen-Symbol`
        );
      }
  }
);

// Gegenprobe gegen das Widget (KUFER_EMBED_DIR, Checkout von
// anythingllm-embed): dieselbe Farbe wie privacyLinkColor im Widget für
// dieselbe gespeicherte Akzentfarbe (der Server liefert sie als linkColor,
// endpoints/embed/index.js)
const WIDGET_THEME = process.env.KUFER_EMBED_DIR
  ? path.join(process.env.KUFER_EMBED_DIR, "src/utils/theme.js")
  : null;
test(
  "F3 Gleichlauf: Linkfarbe der Vorschau gleich privacyLinkColor des Widgets, hell und dunkel (KUFER_EMBED_DIR)",
  {
    skip:
      skip ||
      (WIDGET_THEME && fs.existsSync(WIDGET_THEME)
        ? false
        : "KUFER_EMBED_DIR nicht gesetzt"),
  },
  async () => {
    const theme = await import(pathToFileURL(WIDGET_THEME).href);
    const { previewPrivacyLinkColor } = await renderer.load(PREVIEW);
    for (const scheme of ["light", "dark"])
      for (const accentColor of LINK_ACCENTS) {
        const settings = accentColor ? { linkColor: accentColor } : {};
        assert.equal(
          previewPrivacyLinkColor({ theme: scheme, accentColor }).toLowerCase(),
          theme.privacyLinkColor(settings, scheme).toLowerCase(),
          `${scheme} ${accentColor}`
        );
      }
  }
);

test(
  "F13 Gleichlauf: Farben des Fensters der Vorschau gleich PRIVACY_DIALOG_COLORS des Widgets, hell und dunkel (KUFER_EMBED_DIR)",
  {
    skip:
      skip ||
      (WIDGET_THEME && fs.existsSync(WIDGET_THEME)
        ? false
        : "KUFER_EMBED_DIR nicht gesetzt"),
  },
  async () => {
    const theme = await import(pathToFileURL(WIDGET_THEME).href);
    const { PREVIEW_PRIVACY_DIALOG_COLORS } = await renderer.load(PREVIEW);
    for (const scheme of ["light", "dark"])
      for (const key of ["text", "bg", "line"])
        assert.equal(
          PREVIEW_PRIVACY_DIALOG_COLORS[scheme][key].toLowerCase(),
          theme.PRIVACY_DIALOG_COLORS[scheme][key].toLowerCase(),
          `${scheme} ${key}`
        );
    // und die festen Werte aus der Fixliste (Gegenprobe des Tests oben)
    for (const scheme of ["light", "dark"])
      for (const key of ["text", "bg", "line"])
        assert.equal(
          theme.PRIVACY_DIALOG_COLORS[scheme][key].toLowerCase(),
          DIALOG_COLORS[scheme][key],
          `Widget ${scheme} ${key}`
        );
  }
);

// C3 (F6, Fixliste rc1): Ein Test ersetzt fetch dreimal; danach gilt wieder
// das echte fetch, nicht ein früherer Ersatz (bis rc1 stellte jede
// Rückgabe den jeweils vorigen Wert her, zuletzt den zweiten Ersatz).
test("C3: nach den Tests mit ersetztem fetch gilt wieder das echte fetch", () => {
  assert.equal(globalThis.fetch, REAL_FETCH);
});
