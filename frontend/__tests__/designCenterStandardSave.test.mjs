// Design Center vereinfacht (15./16.10.2026): Reiter, Vorbelegung und
// Speichern ohne Datenverlust. Die Seite ist mit React DOM in ein Dokument
// ohne Browser eingehängt (helpers/renderSettingsPage.mjs, mount), fetch ist
// ersetzt: GET /embeds, GET /embed/defaults (echte Standardtexte des
// Servers), POST /embed/update/:id.
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

// Bestandskunde mit Altwerten aller entfallenen Optionen (7.21)
const LEGACY = {
  accentColor: "#FFA102",
  userTextColor: "#FFFFFF",
  chatIcon: "support",
  position: "bottom-right",
  name: "Ihr Online-Berater",
  greeting:
    "Hallo und herzlich willkommen! Ich helfe Ihnen gerne weiter und beantworte Ihre Fragen mit intelligenten, KI-gestützten Antworten.",
  sendMessageText: "Wie kann ich Ihnen helfen?",
  supportEmail: "",
  defaultMessages: ["Kurse?"],
  chatbotBubblesMessages: ["Hallo!"],
  logoFilename: null,
  logoUrl: null,
  suggestionStyle: "bars",
  greetingStyle: "text",
  greetingBubbleText: "Eigene Blase von früher",
  onlineDot: true,
  followUps: "none",
  privacyNotice: "modal",
  privacyButtonText: "OK",
  privacyText: "Punkt eins\nPunkt zwei",
  disclaimer: "none",
  disclaimerText: "Eigener KI-Hinweis",
  courseCards: "auto",
  courseCardsLayout: "grid",
  courseCardsAnswerStyle: "long",
  courseCardsPosition: "below",
  windowWidth: "420px",
  offsetX: 20,
  inlineTheme: "dark",
  inlineMaxWidth: "900px",
};

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

async function open(t, embeds, id) {
  const calls = stubServer(t, embeds);
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
const savedBody = (calls) => {
  const call = calls.find((c) => c.url.includes("/embed/update/"));
  return call ? JSON.parse(call.body.visual_config) : null;
};

test(
  "Reiter Aussehen, Inhalt, Einbau; Aussehen ist zuerst offen",
  { skip },
  async (t) => {
    const { container } = await open(t, [widget(4, LEGACY)], 4);
    const tabs = elements(container, (el) => el.getAttribute("role") === "tab");
    assert.deepEqual(
      tabs.map((el) => el.textContent.trim()),
      ["Aussehen", "Inhalt", "Einbau"]
    );
    assert.equal(tabs[0].getAttribute("aria-selected"), "true");
    assert.ok(container.textContent.includes("Fest eingebaut"));
  }
);

test(
  "Bestandskunde: Speichern ändert nur das bearbeitete Feld, Altwerte bleiben wörtlich",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(4, LEGACY)], 4);
    // nichts geändert: keine Leiste „Ungespeicherte Änderungen“
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => click(buttons(container, "Inhalt")[0]));
    // Begrüßung: früherer Blasentext hat Vorrang und steht im Feld
    const greeting = elements(
      container,
      (el) => el.getAttribute("aria-label") === "Begrüßungstext"
    )[0];
    assert.equal(
      greeting.textContent || greeting.value,
      "Eigene Blase von früher"
    );
    const name = elements(
      container,
      (el) =>
        el.tagName === "INPUT" &&
        el.getAttribute("placeholder") === "KI-Berater"
    )[0];
    await act(() =>
      handlersOf(name).onChange({ target: { value: "VHS Rhein" } })
    );
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), { ...LEGACY, name: "VHS Rhein" });
  }
);

test(
  "Begrüßungstext ändern schreibt in den Schlüssel, der gilt; „Standardtext“ entfernt beide",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(4, LEGACY)], 4);
    await act(() => click(buttons(container, "Inhalt")[0]));
    const greeting = () =>
      elements(
        container,
        (el) => el.getAttribute("aria-label") === "Begrüßungstext"
      )[0];
    await act(() =>
      handlersOf(greeting()).onChange({ target: { value: " Willkommen! " } })
    );
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), {
      ...LEGACY,
      greetingBubbleText: "Willkommen!",
    });

    calls.length = 0;
    const standard = elements(
      container,
      (el) =>
        el.tagName === "BUTTON" && el.textContent.trim() === "Standardtext"
    )[0];
    await act(() => click(standard));
    await act(() => click(buttons(container, "Speichern")[0]));
    const body = savedBody(calls);
    assert.ok(!("greetingBubbleText" in body));
    assert.ok(!("greeting" in body));
    const rest = { ...LEGACY };
    delete rest.greeting;
    delete rest.greetingBubbleText;
    assert.deepEqual(body, rest);
  }
);

// D6 (Fixliste 7.22-rc3): Vorbelegungen nie ungefragt speichern (Review F05,
// Browser B-03). Gespeichert wird nur, was der Kunde ändert oder als
// Vorschlag übernimmt.
const inputByPlaceholder = (container, placeholder) =>
  elements(
    container,
    (el) =>
      el.tagName === "INPUT" && el.getAttribute("placeholder") === placeholder
  )[0];

test(
  "D6: neues Widget ist beim Öffnen nicht ungespeichert; eine Farbänderung speichert nur die Farbe",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(9, null)], 9);
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    const color = elements(
      container,
      (el) => el.getAttribute("aria-label") === "Kundenfarbe als Farbcode"
    )[0];
    // ohne gespeicherte Farbe: Feld leer, Standard des Widgets grau
    assert.equal(color.getAttribute("placeholder"), "#01A5A9");
    await act(() =>
      handlersOf(color).onChange({ target: { value: "#123456" } })
    );
    assert.ok(container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), { accentColor: "#123456" });
  }
);

test(
  "D6/B-03: Bestandskunde ohne Startvorschläge und Willkommensblasen: Speichern schreibt keine dazu",
  { skip },
  async (t) => {
    const stored = { accentColor: "#FFA102", name: "VHS" };
    const { container, act, calls } = await open(t, [widget(5, stored)], 5);
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => click(buttons(container, "Inhalt")[0]));
    // Vorschläge sichtbar, aber nicht im Bearbeitungsstand
    assert.ok(container.textContent.includes("Welche Sprachkurse gibt es?"));
    assert.ok(container.textContent.includes("Hallo! Ich bin Ihr KI-Berater."));
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() =>
      handlersOf(inputByPlaceholder(container, "KI-Berater")).onChange({
        target: { value: "VHS Rhein" },
      })
    );
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), { ...stored, name: "VHS Rhein" });
  }
);

test(
  "D6: „Vorschläge übernehmen“ und „Vorschlag übernehmen“ schreiben erst nach Bestätigung",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(9, null)], 9);
    await act(() => click(buttons(container, "Inhalt")[0]));
    const apply = buttons(container, "Vorschläge übernehmen");
    // Willkommensblasen (Chatblase) und Startvorschläge
    assert.equal(apply.length, 2);
    for (const button of apply) await act(() => click(button));
    await act(() => click(buttons(container, "Vorschlag übernehmen")[0]));
    assert.ok(container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), {
      chatbotBubblesMessages: [
        "Hallo! Ich bin Ihr KI-Berater.",
        "Möchten Sie mehr über unser Angebot erfahren? Ich helfe gerne weiter!",
      ],
      defaultMessages: [
        "Welche Sprachkurse gibt es?",
        "Wie melde ich mich an?",
        "Kurse am Wochenende",
      ],
      assistantSubtitle: "Online-Berater mit künstlicher Intelligenz",
    });
  }
);

test(
  "Darstellung Inline blendet Position, Chat-Icon und Willkommensblasen aus; Einbau zeigt den Platzhalter",
  { skip },
  async (t) => {
    const { container, act } = await open(t, [widget(4, LEGACY)], 4);
    assert.ok(container.textContent.includes("Position der Chatblase"));
    await act(() => click(buttons(container, "Inline in der Seite")[0]));
    assert.ok(!container.textContent.includes("Position der Chatblase"));
    assert.ok(
      container.textContent.includes("Fest eingebaut wie in unserer Demo")
    );
    await act(() => click(buttons(container, "Inhalt")[0]));
    assert.ok(!container.textContent.includes("Willkommensblasen"));
    await act(() => click(buttons(container, "Einbau")[0]));
    assert.ok(
      container.textContent.includes('<div id="kufer-assistent"></div>')
    );
    assert.ok(container.textContent.includes('data-embed-id="uuid-4"'));
  }
);
