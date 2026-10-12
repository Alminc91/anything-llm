// KIE-535, AK-1/AK-2/AK-6/AK-10: Auf den Adressen des Bereichs „Chatbot“ ist
// „Chatbot“ der erste Eintrag der Einstellungs-Sidebar, aufgeklappt, und der
// Unterpunkt der aufgerufenen Adresse ist markiert.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
  menuEntries,
} from "./helpers/renderSettingsPage.mjs";

const SIDEBAR = "/src/components/SettingsSidebar/index.jsx";
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

for (const current of [WIDGETS, CONVERSATIONS, MESSAGES]) {
  test(
    `${current.href}: „Chatbot“ erster Eintrag, aufgeklappt, „${current.label}“ markiert`,
    { skip },
    async () => {
      const html = await renderer.render(SIDEBAR, { location: current.href });
      const entries = menuEntries(html);
      const block = chatbotBlock(entries);

      assert.ok(block, "Obermenüpunkt „Chatbot“ fehlt");
      assert.equal(block.index, 0, "„Chatbot“ ist nicht der erste Eintrag");
      assert.deepEqual(
        block.children.map(view),
        [WIDGETS, CONVERSATIONS, MESSAGES].map((entry) => ({
          ...entry,
          active: entry === current,
        }))
      );
      assert.deepEqual(
        entries.filter((e) => e.active).map((e) => e.label),
        [current.label],
        "genau ein markierter Menüpunkt"
      );
    }
  );
}

test(
  "Ohne einsehbaren Chat-Verlauf: unter „Chatbot“ nur „Widgets“, markiert",
  { skip },
  async () => {
    const html = await renderer.render(SIDEBAR, {
      location: WIDGETS.href,
      role: "default",
      canViewChatHistory: false,
    });
    const block = chatbotBlock(menuEntries(html));

    assert.ok(block, "Obermenüpunkt „Chatbot“ fehlt");
    assert.equal(block.index, 0, "„Chatbot“ ist nicht der erste Eintrag");
    assert.deepEqual(block.children.map(view), [{ ...WIDGETS, active: true }]);
  }
);

test(
  "Zugeklappt gespeicherter Block auf einer Chatbot-Adresse: „Chatbot“ selbst ist markiert",
  { skip },
  async () => {
    // Zustand vor dem Effekt, der den Block bei passender Adresse wieder aufklappt.
    const html = await renderer.render(SIDEBAR, {
      location: CONVERSATIONS.href,
      stored: { anything_llm_menu_chatbot_expanded: "false" },
    });
    const block = chatbotBlock(menuEntries(html));

    assert.ok(block, "Obermenüpunkt „Chatbot“ fehlt");
    assert.equal(block.parent.active, true);
    assert.deepEqual(block.children, []);
  }
);

test(
  "Fremde Einstellungsseite: „Chatbot“ bleibt zugeklappt und unmarkiert",
  { skip },
  async () => {
    const html = await renderer.render(SIDEBAR, {
      location: "/settings/users",
    });
    const block = chatbotBlock(menuEntries(html));

    assert.equal(block.index, 0, "„Chatbot“ ist nicht der erste Eintrag");
    assert.equal(block.parent.active, false);
    assert.deepEqual(block.children, []);
  }
);
