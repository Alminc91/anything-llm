// KIE-535, AK-7: Im Design Center ist die Einstellungs-Sidebar zu sehen,
// „Chatbot“ ist aufgeklappt und „Widgets“ markiert.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
  menuEntries,
} from "./helpers/renderSettingsPage.mjs";

const DESIGN_CENTER =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/index.jsx";
const SIDEBAR = "/src/components/SettingsSidebar/index.jsx";
const DESIGN_CENTER_ROUTE = "/settings/embed-config/:embedId/appearance";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const WIDGETS = { label: "Widgets", href: "/settings/chatbot/widgets" };
const CONVERSATIONS = {
  label: "Konversationen",
  href: "/settings/chatbot/conversations",
};
const MESSAGES = {
  label: "Nachrichtentabelle",
  href: "/settings/chatbot/messages",
};

/** Die Einträge des Blocks „Chatbot“: Obermenüpunkt und seine sichtbaren Unterpunkte. */
function chatbotBlock(entries) {
  const start = entries.findIndex((e) => !e.child && e.label === "Chatbot");
  if (start === -1) return null;
  const children = [];
  for (const entry of entries.slice(start + 1)) {
    if (!entry.child) break;
    children.push(entry);
  }
  return { index: start, parent: entries[start], children };
}

const view = ({ label, href, active }) => ({ label, href, active });

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

test(
  "Design Center: Sidebar sichtbar, „Chatbot“ aufgeklappt, „Widgets“ markiert",
  { skip },
  async () => {
    const html = await renderer.render(DESIGN_CENTER, {
      location: "/settings/embed-config/7/appearance",
      route: DESIGN_CENTER_ROUTE,
    });
    const entries = menuEntries(html);
    const block = chatbotBlock(entries);

    assert.ok(
      block,
      "Sidebar mit Obermenüpunkt „Chatbot“ fehlt im Design Center"
    );
    assert.equal(block.index, 0, "„Chatbot“ ist nicht der erste Eintrag");
    assert.deepEqual(block.children.map(view), [
      { ...WIDGETS, active: true },
      { ...CONVERSATIONS, active: false },
      { ...MESSAGES, active: false },
    ]);
    assert.deepEqual(
      entries.filter((e) => e.active).map((e) => e.label),
      ["Widgets"],
      "genau ein markierter Menüpunkt"
    );
    // Der Inhalt des Design Centers steht neben der Sidebar.
    assert.match(html, /Laden\.\.\./);
  }
);

test(
  "Design Center ohne einsehbaren Chat-Verlauf: nur „Widgets“, markiert",
  { skip },
  async () => {
    const html = await renderer.render(DESIGN_CENTER, {
      location: "/settings/embed-config/7/appearance",
      route: DESIGN_CENTER_ROUTE,
      role: "default",
      canViewChatHistory: false,
    });
    const block = chatbotBlock(menuEntries(html));

    assert.ok(
      block,
      "Sidebar mit Obermenüpunkt „Chatbot“ fehlt im Design Center"
    );
    assert.deepEqual(block.children.map(view), [{ ...WIDGETS, active: true }]);
  }
);

test(
  "Design Center mit zugeklappt gespeichertem Block: „Chatbot“ selbst ist markiert",
  { skip },
  async () => {
    // Zustand vor dem Effekt, der den Block bei passender Adresse wieder aufklappt.
    const html = await renderer.render(DESIGN_CENTER, {
      location: "/settings/embed-config/7/appearance",
      route: DESIGN_CENTER_ROUTE,
      stored: { anything_llm_menu_chatbot_expanded: "false" },
    });
    const block = chatbotBlock(menuEntries(html));

    assert.ok(
      block,
      "Sidebar mit Obermenüpunkt „Chatbot“ fehlt im Design Center"
    );
    assert.equal(block.parent.active, true);
    assert.deepEqual(block.children, []);
  }
);

test(
  "Präfix gilt nur für das Design Center: auf „Konversationen“ ist „Widgets“ nicht markiert",
  { skip },
  async () => {
    const html = await renderer.render(SIDEBAR, {
      location: "/settings/chatbot/conversations",
    });
    const entries = menuEntries(html);

    assert.deepEqual(chatbotBlock(entries).children.map(view), [
      { ...WIDGETS, active: false },
      { ...CONVERSATIONS, active: true },
      { ...MESSAGES, active: false },
    ]);
    assert.deepEqual(
      entries.filter((e) => e.active).map((e) => e.label),
      ["Konversationen"]
    );
  }
);

test(
  "Präfix klappt „Chatbot“ nicht auf fremden Einstellungsseiten auf",
  { skip },
  async () => {
    const html = await renderer.render(SIDEBAR, {
      location: "/settings/users",
    });
    const block = chatbotBlock(menuEntries(html));

    assert.equal(block.parent.active, false);
    assert.deepEqual(block.children, []);
  }
);
