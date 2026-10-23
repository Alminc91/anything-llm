// Korrekturrunde 7.22-rc13 (Fixliste fixliste-7.22-rc13.md, „F · Fork“), Teil
// Design Center mit eingehängter Seite (helpers/renderSettingsPage.mjs,
// mount; fetch ersetzt: GET /embeds, GET /embed/defaults, POST
// /embed/update/:id):
// F04 Datenschutz-Schalter: Begrüßung bleibt live der Text aus dem Feld.
// F05 Speichern eines anderen Feldes lässt gespeicherte Standardwerte stehen.
// F10 Vorschau: geänderte Begrüßung wird im Verlauf ins Bild gescrollt.
// F11 Klick auf die markierte Option (Standard) ist keine Änderung.
// F13 Listen-Handler bearbeiten die Liste des Servers (GET /embed/defaults).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements, handlersOf } from "./helpers/testDom.mjs";

const DESIGN_CENTER =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/index.jsx";
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

// defaultsGate: Promise, bis zu der GET /embed/defaults wartet (Standardtexte
// kommen erst nach dem Zeichnen an)
function stubServer(t, embeds, defaults = DEFAULTS, defaultsGate = null) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, body });
    let answer = {};
    if (url.endsWith("/embeds")) answer = { embeds };
    else if (url.includes("/embed/defaults")) {
      if (defaultsGate) await defaultsGate;
      answer = { lang: "de", defaults };
    } else if (url.includes("/embed/update/"))
      answer = { success: true, error: null };
    return { ok: true, status: 200, json: async () => answer };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

async function open(t, embeds, id, defaults, defaultsGate) {
  const calls = stubServer(t, embeds, defaults, defaultsGate);
  const mounted = await renderer.mount(DESIGN_CENTER, {
    location: `/settings/embed-config/${id}/appearance`,
    route: "/settings/embed-config/:embedId/appearance",
  });
  t.after(() => mounted.unmount());
  await mounted.act();
  return { ...mounted, calls };
}

const buttons = (container, label) =>
  elements(
    container,
    (el) => el.tagName === "BUTTON" && el.textContent.trim() === label
  );
const byLabel = (container, label) =>
  elements(container, (el) => el.getAttribute("aria-label") === label)[0];
const savedBody = (calls) => {
  const call = calls.find((c) => c.url.includes("/embed/update/"));
  return call ? JSON.parse(call.body.visual_config) : null;
};
const unsaved = (container) =>
  container.textContent.includes("Ungespeicherte Änderungen");
const listInputs = (container, list) =>
  elements(
    elements(container, (el) => el.getAttribute("data-list") === list)[0],
    (el) => el.tagName === "INPUT"
  );
const valueOf = (el) => el.getAttribute("value") ?? el.value ?? "";
const privacySwitch = (container) =>
  elements(
    elements(container, (el) => el.hasAttribute?.("data-privacy-switch"))[0],
    (el) => el.tagName === "INPUT" && el.getAttribute("type") === "checkbox"
  )[0];

// ---------------------------------------------------------------------------
// F13 Listen-Handler mit der Liste des Servers
// ---------------------------------------------------------------------------

test(
  "F13: Zeile der Vorbelegung ändern bearbeitet die Liste des Servers, nicht die Kopie",
  { skip },
  async (t) => {
    // Server liefert andere Standard-Startvorschläge als die Kopie
    // DEFAULT_SUGGESTIONS (etwa nach einer einseitigen Änderung)
    const defaults = {
      ...DEFAULTS,
      defaultMessages: ["Server A?", "Server B?", "Server C?"],
    };
    const { container, act, calls } = await open(
      t,
      [widget(3, null)],
      3,
      defaults
    );
    await act(() => click(buttons(container, "Inhalt")[0]));
    assert.deepEqual(listInputs(container, "suggestions").map(valueOf), [
      "Server A?",
      "Server B?",
      "Server C?",
    ]);
    await act(() =>
      handlersOf(listInputs(container, "suggestions")[0]).onChange({
        target: { value: "Neu?" },
      })
    );
    assert.deepEqual(listInputs(container, "suggestions").map(valueOf), [
      "Neu?",
      "Server B?",
      "Server C?",
    ]);
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), {
      defaultMessages: ["Neu?", "Server B?", "Server C?"],
    });
  }
);

test(
  "F13: Entfernen und Hinzufügen arbeiten auf der Liste des Servers",
  { skip },
  async (t) => {
    const defaults = {
      ...DEFAULTS,
      defaultMessages: ["Server A?", "Server B?", "Server C?"],
    };
    const { container, act, calls } = await open(
      t,
      [widget(3, null)],
      3,
      defaults
    );
    await act(() => click(buttons(container, "Inhalt")[0]));
    const remove = elements(
      elements(
        container,
        (el) => el.getAttribute("data-list") === "suggestions"
      )[0],
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label")
    );
    assert.ok(remove.length >= 3, "Entfernen-Buttons fehlen");
    await act(() => click(remove[2]));
    await act(() => click(buttons(container, "Vorschlag hinzufügen")[0]));
    await act(() =>
      handlersOf(listInputs(container, "suggestions")[2]).onChange({
        target: { value: "Eigene?" },
      })
    );
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), {
      defaultMessages: ["Server A?", "Server B?", "Eigene?"],
    });
  }
);

// ---------------------------------------------------------------------------
// F11 Klick auf die markierte Option
// ---------------------------------------------------------------------------

test(
  "F11: neues Widget: Klick auf markiertes Links, Hell, Chatfenster, Sprechblase ist keine Änderung",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(9, null)], 9);
    assert.ok(!unsaved(container));
    for (const label of ["Links", "Hell", "Chatfenster"]) {
      const button = buttons(container, label)[0];
      assert.ok(button, label);
      assert.equal(button.getAttribute("aria-pressed"), "true", label);
      await act(() => click(button));
      assert.ok(!unsaved(container), label);
    }
    await act(() => click(byLabel(container, "Sprechblase")));
    assert.ok(!unsaved(container), "Sprechblase");
    // eine echte Wahl speichert nur sie
    await act(() => click(buttons(container, "Rechts")[0]));
    assert.ok(unsaved(container));
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), { position: "bottom-right" });
  }
);

// ---------------------------------------------------------------------------
// F05 gespeicherte Standardwerte bleiben
// ---------------------------------------------------------------------------

test(
  "F05: gespeicherte Standardfarbe und Standardname bleiben beim Speichern des Farbschemas",
  { skip },
  async (t) => {
    // Standardfarbe seit 23.10.2026 Petrol; das frühere Türkis wäre hier
    // eine Kundenfarbe und prüfte die Regel nicht
    const stored = {
      accentColor: "#007C82",
      name: "KI-Berater",
      defaultMessages: [...DEFAULTS.defaultMessages],
    };
    const { container, act, calls } = await open(t, [widget(6, stored)], 6);
    assert.ok(!unsaved(container));
    await act(() => click(buttons(container, "Dunkel")[0]));
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), { ...stored, theme: "dark" });
  }
);

// ---------------------------------------------------------------------------
// F04 Datenschutz-Schalter und Begrüßung
// ---------------------------------------------------------------------------

test(
  "F04: Schalter aus „none“ einschalten: live bleibt die Begrüßung aus dem Feld",
  { skip },
  async (t) => {
    const stored = {
      greeting: "Willkommen bei der VHS X",
      greetingBubbleText: "Hallo, nie sichtbar",
      greetingStyle: "text",
      privacyNotice: "none",
    };
    const { container, act, calls } = await open(t, [widget(7, stored)], 7);
    await act(() => click(buttons(container, "Inhalt")[0]));
    const field = () => byLabel(container, "Begrüßungstext");
    assert.equal(
      field().textContent || field().value,
      "Willkommen bei der VHS X"
    );
    await act(() =>
      handlersOf(privacySwitch(container)).onChange({
        target: { checked: true },
      })
    );
    await act(() => click(buttons(container, "Speichern")[0]));
    const saved = savedBody(calls);
    assert.equal(saved.privacyNotice, "bubble");
    assert.equal(
      server.effectiveGreeting(saved),
      "Willkommen bei der VHS X",
      JSON.stringify(saved)
    );
    // nach dem Speichern zeigt das Feld weiter denselben Text
    assert.equal(
      field().textContent || field().value,
      "Willkommen bei der VHS X"
    );
  }
);

// ---------------------------------------------------------------------------
// F10 Vorschau holt die geänderte Begrüßung ins Bild
// ---------------------------------------------------------------------------

test(
  "F10: Standardtexte kommen nach dem Zeichnen: Verlauf bleibt unten; Begrüßung ändern scrollt den Verlauf der Vorschau zur Begrüßung",
  { skip },
  async (t) => {
    let releaseDefaults;
    const defaultsGate = new Promise((resolve) => {
      releaseDefaults = resolve;
    });
    const { container, act } = await open(
      t,
      [widget(8, null)],
      8,
      DEFAULTS,
      defaultsGate
    );
    await act(() => click(buttons(container, "Inhalt")[0]));
    const preview = (kind) =>
      elements(container, (el) => el.getAttribute("data-preview") === kind)[0];
    const messages = preview("chat-messages");
    const greeting = preview("greeting-bubble");
    assert.ok(messages && greeting);
    // Maße wie im Browser bei 1440×900: Verlauf 454 px hoch, ans Ende
    // gescrollt, die Begrüßung steht oben außerhalb
    messages.scrollTop = 116;
    messages.getBoundingClientRect = () => ({ top: 100, bottom: 554 });
    greeting.getBoundingClientRect = () => ({ top: 0, bottom: 60 });
    // die Standardtexte kommen an (Begrüßung, Pillen): keine Bearbeitung,
    // der Verlauf bleibt, wo er beim Öffnen stand
    await act(async () => {
      releaseDefaults();
      await defaultsGate;
    });
    assert.equal(greeting.textContent, DEFAULTS.greeting);
    assert.equal(messages.scrollTop, 116, "kein Sprung beim Laden");
    await act(() =>
      handlersOf(byLabel(container, "Begrüßungstext")).onChange({
        target: { value: "Willkommen!" },
      })
    );
    assert.equal(greeting.textContent, "Willkommen!");
    assert.ok(messages.scrollTop < 116, String(messages.scrollTop));
    assert.equal(messages.scrollTop, 116 - (100 + 8));
  }
);
