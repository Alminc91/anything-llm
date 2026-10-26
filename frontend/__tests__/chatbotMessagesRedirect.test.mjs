// KIE-538, AK-8: Die Nachrichtentabelle ist entfallen. Ihre frühere Adresse
// /settings/chatbot/messages leitet auf „Konversationen“ um – und von dort,
// bei abgeschaltetem Chat-Verlauf, weiter auf „Widgets“.
//
// Die Seiten sind mit React DOM in ein Dokument ohne Browser eingehängt
// (helpers/renderSettingsPage.mjs, mount): Die Umleitungen laufen wie im
// Browser als Effekte. Die Routentabelle selbst (main.jsx) lässt sich ohne
// Browser nicht laden; ihr Eintrag für die frühere Adresse ist in
// chatbotSidebar.test.mjs am Quelltext geprüft und hier nachgebildet.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";

const PAGE = "/src/pages/GeneralSettings/ChatEmbedWidgets/index.jsx";
const WIDGETS = "/settings/chatbot/widgets";
const CONVERSATIONS = "/settings/chatbot/conversations";
const MESSAGES = "/settings/chatbot/messages";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

test(
  "Chat-Verlauf einsehbar: Unter „Konversationen“ steht die Ansicht; eine Ansicht „Nachrichtentabelle“ gibt es nicht mehr",
  { skip },
  async () => {
    const html = await renderer.render(PAGE, {
      exportName: "ChatbotConversations",
      location: CONVERSATIONS,
    });
    // Zustand vor dem ersten Laden der Widgets
    assert.ok(html.includes("Laden..."), "Ansicht „Konversationen“ fehlt");
    assert.ok(!html.includes("Nachrichtentabelle"));

    const page = await renderer.load(PAGE);
    assert.deepEqual(Object.keys(page).sort(), [
      "ChatbotConversations",
      "ChatbotDesignCenter",
      "ChatbotStatus",
      "ChatbotWidgets",
      "DesignCenterRedirect",
    ]);
  }
);

test(
  "Die frühere Adresse der Nachrichtentabelle führt zu „Konversationen“ – bei abgeschaltetem Chat-Verlauf weiter zu „Widgets“",
  { skip },
  async () => {
    const { default: React } = await import("react");
    const { Navigate } = await import("react-router-dom");
    const h = React.createElement;
    const marker = (name) => h("div", null, name);
    // wie in main.jsx
    const redirect = {
      path: MESSAGES,
      element: h(Navigate, { to: CONVERSATIONS, replace: true }),
    };

    /** Ruft die frühere Adresse auf und nennt, was am Ende zu sehen ist. */
    async function open(options) {
      const mounted = await renderer.mount(PAGE, {
        location: MESSAGES,
        ...options,
        otherRoutes: [redirect, ...options.otherRoutes],
      });
      await mounted.act();
      const text = mounted.container.textContent;
      await mounted.unmount();
      return text;
    }

    // Die Umleitung selbst: von der früheren Adresse zu „Konversationen“.
    assert.equal(
      await open({
        exportName: "ChatbotWidgets",
        route: "/nicht-aufgerufen",
        otherRoutes: [
          { path: CONVERSATIONS, element: marker("Konversationen") },
          { path: WIDGETS, element: marker("Widget-Liste") },
        ],
      }),
      "Konversationen"
    );

    // Chat-Verlauf abgeschaltet: Die Ansicht „Konversationen“ (die echte
    // Seite) wird nicht eingehängt und leitet weiter zur Widget-Liste.
    assert.equal(
      await open({
        exportName: "ChatbotConversations",
        route: CONVERSATIONS,
        canViewChatHistory: false,
        otherRoutes: [{ path: WIDGETS, element: marker("Widget-Liste") }],
      }),
      "Widget-Liste"
    );
  }
);
