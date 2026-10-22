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
    // R2 (7.22-rc8): statt des Kastens eine Zeile
    assert.ok(container.textContent.includes("Fest vorgegeben:"));
    assert.ok(!container.textContent.includes("Fest eingebaut"));
  }
);

// Feld über seine Beschriftung (R5: Name und Platzhalter zeigen den
// Standard als Wert, kein Platzhalter-Attribut mehr)
const byLabel = (container, label) =>
  elements(container, (el) => el.getAttribute("aria-label") === label)[0];
// Wert eines kontrollierten Feldes im Dokument ohne Browser
const valueOf = (el) => el.getAttribute("value") ?? el.value ?? "";
// „Standardtext“-Button zum Feld mit dieser Beschriftung (Button steht in
// der Kopfzeile desselben Feld-Blocks)
const standardButtonFor = (container, label) =>
  elements(
    byLabel(container, label).parentNode,
    (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Standardtext"
  )[0];

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
    const name = byLabel(container, "Name des Chatbots");
    // E2: der alte Name ist ein eigener Kundenwert und steht im Feld
    assert.equal(valueOf(name), "Ihr Online-Berater");
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
    const standard = standardButtonFor(container, "Begrüßungstext");
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
// Browser B-03). Seit R5 (7.22-rc8) stehen die Vorbelegungen als echte
// Feldwerte da; gespeichert wird weiter nur, was der Kunde ändert.
const listInputs = (container, list) =>
  elements(
    elements(container, (el) => el.getAttribute("data-list") === list)[0],
    (el) => el.tagName === "INPUT"
  );

test(
  "D6: neues Widget ist beim Öffnen nicht ungespeichert; eine Farbänderung speichert nur die Farbe",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(9, null)], 9);
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    const color = byLabel(container, "Akzentfarbe als Farbcode");
    // ohne gespeicherte Farbe: der Standard des Widgets als Feldwert (R5)
    assert.equal(valueOf(color), "#01A5A9");
    await act(() =>
      handlersOf(color).onChange({ target: { value: "#123456" } })
    );
    assert.ok(container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), { accentColor: "#123456" });
  }
);

// Bewusste Änderung E42 (7.22-rc23): Vorbelegung der Startvorschläge leer
// (bis 7.22-rc22 zwei Beispiele als Feldwerte)
test(
  "D6/B-03/R5, Bewusste Änderung E42: Bestandskunde ohne Startvorschläge und Willkommensblasen: Vorbelegung im Feld, Speichern schreibt keine dazu",
  { skip },
  async (t) => {
    const stored = { accentColor: "#FFA102", name: "VHS" };
    const { container, act, calls } = await open(t, [widget(5, stored)], 5);
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => click(buttons(container, "Inhalt")[0]));
    // Vorbelegung als Feldwerte, aber nicht im Bearbeitungsstand; die
    // Startvorschläge sind leer (E42)
    assert.deepEqual(listInputs(container, "suggestions").map(valueOf), []);
    assert.ok(container.textContent.includes("Leer: keine Startvorschläge."));
    assert.deepEqual(listInputs(container, "welcome-bubbles").map(valueOf), [
      "Hallo! Ich bin Ihr KI-Berater.",
      "Möchten Sie mehr über unser Angebot erfahren? Ich helfe gerne weiter!",
    ]);
    assert.equal(
      valueOf(byLabel(container, "Untertitel")),
      "Online-Berater mit künstlicher Intelligenz"
    );
    assert.ok(!container.textContent.includes("Vorschlag übernehmen"));
    assert.ok(!container.textContent.includes("Vorschläge übernehmen"));
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() =>
      handlersOf(byLabel(container, "Name des Chatbots")).onChange({
        target: { value: "VHS Rhein" },
      })
    );
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), { ...stored, name: "VHS Rhein" });
  }
);

// Bewusste Änderung E42 (7.22-rc23): ohne gespeicherte Liste ist das Feld
// leer; der Kunde fügt eigene Vorschläge hinzu (bis 7.22-rc22 änderte er
// die erste von zwei Beispielzeilen). Eine Liste, die der Kunde danach
// wieder leert, ist der Standard (Schlüssel entfällt, live ebenso keine
// Startvorschläge); bis 7.22-rc22 wurde sie als [] gespeichert.
test(
  "R5, Bewusste Änderung E42: eigene Startvorschläge werden mit der ganzen Liste gespeichert; alle gelöscht = Standard (keine Startvorschläge)",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(9, null)], 9);
    await act(() => click(buttons(container, "Inhalt")[0]));
    assert.deepEqual(listInputs(container, "suggestions"), []);
    for (const value of ["Welche Kurse gibt es?", "Gibt es Yoga am Abend?"]) {
      await act(() => click(buttons(container, "Vorschlag hinzufügen")[0]));
      const inputs = listInputs(container, "suggestions");
      await act(() =>
        handlersOf(inputs[inputs.length - 1]).onChange({ target: { value } })
      );
    }
    assert.ok(container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), {
      defaultMessages: ["Welche Kurse gibt es?", "Gibt es Yoga am Abend?"],
    });

    calls.length = 0;
    const remove = () =>
      elements(
        elements(
          container,
          (el) => el.getAttribute("data-list") === "suggestions"
        )[0],
        (el) => el.getAttribute("aria-label") === "Eintrag entfernen"
      )[0];
    while (remove()) await act(() => click(remove()));
    assert.ok(container.textContent.includes("Leer: keine Startvorschläge."));
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), {});
  }
);

test(
  "Darstellung „In der Seite“ blendet Position, Chat-Icon und Willkommensblasen aus; Einbau zeigt den Platzhalter",
  { skip },
  async (t) => {
    const { container, act } = await open(t, [widget(4, LEGACY)], 4);
    assert.ok(container.textContent.includes("Position des Chat-Buttons"));
    await act(() => click(buttons(container, "In der Seite")[0]));
    assert.ok(!container.textContent.includes("Position des Chat-Buttons"));
    assert.ok(
      container.textContent.includes(
        "Fest vorgegeben: der KI-Hinweis unter der Eingabe und die Größe der aufgeklappten Box."
      )
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
