// Korrekturrunde 7.22-rc16 (Fixliste fixliste-7.22-rc16.md, „F · Fork“), Teil
// Design Center mit eingehängter Seite (helpers/renderSettingsPage.mjs,
// mount; fetch ersetzt: GET /embeds, GET /embed/defaults, POST
// /embed/update/:id):
// F42 Vorschau: nach einem Ladefehler der Standardtexte kommt ein
//     bearbeiteter Block trotzdem ins Bild (F10).
// F43 Vorschau: Speichern ist keine Bearbeitung; getrimmte Startvorschläge
//     holen die Pillen nicht ins Bild.
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

// defaultsFail: GET /embed/defaults antwortet mit HTTP 500; defaultsGate:
// Promise, bis zu der die Antwort wartet (kommt erst nach dem Zeichnen an)
function stubServer(t, embeds, { defaultsFail = false, defaultsGate } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, body });
    let answer = {};
    if (url.endsWith("/embeds")) answer = { embeds };
    else if (url.includes("/embed/defaults")) {
      if (defaultsGate) await defaultsGate;
      if (defaultsFail)
        return { ok: false, status: 500, json: async () => ({}) };
      answer = { lang: "de", defaults: DEFAULTS };
    } else if (url.includes("/embed/update/"))
      answer = { success: true, error: null };
    return { ok: true, status: 200, json: async () => answer };
  };
  // Embed.getDefaults meldet den Fehler zusätzlich auf der Konsole
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    globalThis.fetch = original;
    console.error = originalError;
  });
  return calls;
}

async function open(t, embeds, id, options) {
  const calls = stubServer(t, embeds, options);
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
const preview = (container, kind) =>
  elements(container, (el) => el.getAttribute("data-preview") === kind)[0];
const savedBody = (calls) => {
  const call = calls.find((c) => c.url.includes("/embed/update/"));
  return call ? JSON.parse(call.body.visual_config) : null;
};

// ---------------------------------------------------------------------------
// F42 Ladefehler der Standardtexte
// ---------------------------------------------------------------------------

test(
  "F42: Standardtexte nicht ladbar: kein Sprung, wenn der Fehler ankommt; Begrüßung ändern scrollt den Verlauf der Vorschau zur Begrüßung",
  { skip },
  async (t) => {
    let releaseDefaults;
    const defaultsGate = new Promise((resolve) => {
      releaseDefaults = resolve;
    });
    const { container, act } = await open(t, [widget(9, null)], 9, {
      defaultsFail: true,
      defaultsGate,
    });
    await act(() => click(buttons(container, "Inhalt")[0]));
    const messages = preview(container, "chat-messages");
    const greeting = preview(container, "greeting-bubble");
    assert.ok(messages && greeting);
    // Maße wie im Browser bei 1440×900 (wie im F10-Test, rc13): Verlauf
    // 454 px hoch, ans Ende gescrollt, die Begrüßung steht oben außerhalb
    messages.scrollTop = 116;
    messages.getBoundingClientRect = () => ({ top: 100, bottom: 554 });
    greeting.getBoundingClientRect = () => ({ top: 0, bottom: 60 });
    // der Fehler kommt an: keine Bearbeitung, kein Sprung
    await act(async () => {
      releaseDefaults();
      await defaultsGate;
    });
    assert.equal(messages.scrollTop, 116, "kein Sprung beim Ladefehler");
    await act(() =>
      handlersOf(byLabel(container, "Begrüßungstext")).onChange({
        target: { value: "Willkommen!" },
      })
    );
    assert.equal(greeting.textContent, "Willkommen!");
    assert.equal(messages.scrollTop, 116 - (100 + 8));
  }
);

test(
  "F42: Standardtexte nicht ladbar (sofort): Startvorschlag ändern holt die Pillen ins Bild",
  { skip },
  async (t) => {
    const { container, act } = await open(
      t,
      [widget(10, { defaultMessages: ["Yoga"] })],
      10,
      { defaultsFail: true }
    );
    await act(() => click(buttons(container, "Inhalt")[0]));
    const messages = preview(container, "chat-messages");
    const pills = preview(container, "pills");
    assert.ok(messages && pills);
    messages.scrollTop = 0;
    messages.getBoundingClientRect = () => ({ top: 100, bottom: 554 });
    pills.getBoundingClientRect = () => ({ top: 600, bottom: 640 });
    const row = elements(
      elements(
        container,
        (el) => el.getAttribute("data-list") === "suggestions"
      )[0],
      (el) => el.tagName === "INPUT"
    )[0];
    await act(() =>
      handlersOf(row).onChange({ target: { value: "Yoga am Abend" } })
    );
    assert.ok(messages.scrollTop > 0, String(messages.scrollTop));
  }
);

// ---------------------------------------------------------------------------
// F43 Speichern holt die Pillen nicht ins Bild
// ---------------------------------------------------------------------------

test(
  "F43: Startvorschlag mit Leerzeichen am Ende, Begrüßung ändern und speichern: die Vorschau springt nicht zu den Pillen",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(
      t,
      [widget(11, { defaultMessages: ["Yoga "] })],
      11
    );
    await act(() => click(buttons(container, "Inhalt")[0]));
    const messages = preview(container, "chat-messages");
    const greeting = preview(container, "greeting-bubble");
    const pills = preview(container, "pills");
    assert.ok(messages && greeting && pills);
    // Verlauf oben: Begrüßung sichtbar, Pillen unten außerhalb
    messages.scrollTop = 0;
    messages.getBoundingClientRect = () => ({ top: 100, bottom: 554 });
    greeting.getBoundingClientRect = () => ({ top: 110, bottom: 170 });
    pills.getBoundingClientRect = () => ({ top: 600, bottom: 640 });
    await act(() =>
      handlersOf(byLabel(container, "Begrüßungstext")).onChange({
        target: { value: "Willkommen!" },
      })
    );
    assert.equal(messages.scrollTop, 0, "Begrüßung schon im Bild");
    await act(() => click(buttons(container, "Speichern")[0]));
    const saved = savedBody(calls);
    assert.deepEqual(saved.defaultMessages, ["Yoga"]);
    assert.equal(saved.greeting, "Willkommen!");
    assert.equal(
      messages.scrollTop,
      0,
      "Speichern ist keine Bearbeitung der Startvorschläge"
    );
    // eine echte Änderung der Startvorschläge holt sie weiter ins Bild
    const row = elements(
      elements(
        container,
        (el) => el.getAttribute("data-list") === "suggestions"
      )[0],
      (el) => el.tagName === "INPUT"
    )[0];
    await act(() =>
      handlersOf(row).onChange({ target: { value: "Yoga am Abend" } })
    );
    assert.ok(messages.scrollTop > 0, String(messages.scrollTop));
  }
);
