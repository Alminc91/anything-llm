// KIE-535, AK-1/AK-2/AK-6/AK-10: Auf den Adressen des Bereichs „Chatbot“ ist
// „Chatbot“ der erste Eintrag der Einstellungs-Sidebar, aufgeklappt, und der
// Unterpunkt der aufgerufenen Adresse ist markiert.
//
// KIE-538, AK-8: Die Nachrichtentabelle ist entfallen; die frühere Adresse
// /settings/chatbot/messages leitet auf „Konversationen“ um (das Verhalten
// der Umleitung: chatbotMessagesRedirect.test.mjs).
//
// KB-2, AK-1: „Chatbot“ hat die Unterpunkte Status (seit KB-3 sichtbar),
// Konversationen, Design Center und Widgets (weitere Prüfungen:
// chatbotMenu.test.mjs).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const STATUS = { label: "Status", href: "/settings/chatbot/status" };
const CONVERSATIONS = {
  label: "Konversationen",
  href: "/settings/chatbot/conversations",
};
const DESIGN = { label: "Design Center", href: "/settings/chatbot/design" };
// Frühere Adresse der Nachrichtentabelle (KIE-538)
const MESSAGES_HREF = "/settings/chatbot/messages";
const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src"
);

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

for (const current of [WIDGETS, CONVERSATIONS]) {
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
        [STATUS, CONVERSATIONS, DESIGN, WIDGETS].map((entry) => ({
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
  "Ohne einsehbaren Chat-Verlauf: unter „Chatbot“ nur „Status“, „Design Center“ und „Widgets“, „Widgets“ markiert",
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
    assert.deepEqual(block.children.map(view), [
      { ...STATUS, active: false },
      { ...DESIGN, active: false },
      { ...WIDGETS, active: true },
    ]);
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

// ---------------------------------------------------------------------------
// KIE-538, AK-8: Die Nachrichtentabelle ist entfernt
// ---------------------------------------------------------------------------

test(
  "Nachrichtentabelle entfernt (AK-8): „Chatbot“ hat genau die Unterpunkte „Status“, „Konversationen“, „Design Center“ und „Widgets“ (KB-2, KB-3) – für jede Rolle",
  { skip },
  async () => {
    for (const role of ["admin", "manager", "default"]) {
      const html = await renderer.render(SIDEBAR, {
        location: CONVERSATIONS.href,
        role,
      });
      const block = chatbotBlock(menuEntries(html));
      assert.deepEqual(
        block.children.map(({ label, href }) => ({ label, href })),
        [STATUS, CONVERSATIONS, DESIGN, WIDGETS],
        role
      );
      assert.ok(!html.includes("Nachrichtentabelle"), role);
      assert.ok(!html.includes(MESSAGES_HREF), role);
    }
  }
);

test(
  "Nachrichtentabelle entfernt (AK-8): paths kennt keine „messages“ (KB-2: status, conversations, design, widgets); die Route der früheren Adresse leitet auf „Konversationen“ um",
  { skip },
  async () => {
    const { default: paths } = await renderer.load("/src/utils/paths.js");
    assert.deepEqual(Object.keys(paths.settings.chatbot), [
      "status",
      "conversations",
      "design",
      "widgets",
    ]);
    assert.equal(paths.settings.chatbot.widgets(), WIDGETS.href);
    assert.equal(paths.settings.chatbot.conversations(), CONVERSATIONS.href);

    // Die Routentabelle (main.jsx) lässt sich ohne Browser nicht laden: Der
    // Eintrag der früheren Adresse wird im Quelltext geprüft.
    const main = readFileSync(path.join(SRC, "main.jsx"), "utf8");
    const routes = [
      ...main.matchAll(
        /\{\s*path:\s*"\/settings\/chatbot\/messages",\s*([^}]*)\}/g
      ),
    ];
    assert.equal(routes.length, 1, "genau eine Route für die frühere Adresse");
    assert.equal(
      routes[0][1].replace(/\s+/g, " ").trim(),
      `element: <Navigate to="${CONVERSATIONS.href}" replace />,`
    );
    assert.ok(!main.includes("ChatbotMessages"));
  }
);

test(
  "Nachrichtentabelle entfernt (AK-8): Die Seite und ihre Aufrufe sind aus den Quellen verschwunden",
  { skip: false },
  () => {
    const chatbot = path.join(SRC, "pages/GeneralSettings/ChatEmbedWidgets");
    assert.equal(existsSync(path.join(chatbot, "EmbedChats")), false);
    assert.deepEqual(readdirSync(chatbot).sort(), [
      "CourseStatus",
      "EmbedAnalytics",
      "EmbedAppearance",
      "EmbedConfigs",
      "WidgetSelection.jsx",
      "index.jsx",
    ]);

    const model = readFileSync(path.join(SRC, "models/embed.js"), "utf8");
    // Liste einzelner Nachrichten und „einzelne Nachricht löschen“
    assert.doesNotMatch(model, /\bchats:\s*async/);
    assert.doesNotMatch(model, /\bdeleteChat\b/);
    assert.doesNotMatch(model, /embed\/chats\/\$\{/);

    // Kein Quelltext verweist mehr auf die Seite oder ihre Texte.
    // „chat-row.view-thoughts“ benutzt die Darstellung der Antworten weiter.
    const stale =
      /ChatEmbedWidgets\/EmbedChats|\.\/EmbedChats|EmbedChatsView|ChatbotMessages|chatbot\.messages|chatbot-messages|["'`]chat-row\.(?!view-thoughts)|["'`]embed-chats\.|toast\.embed-chats/;
    const hits = [];
    (function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(jsx?|mjs)$/.test(entry.name)) {
          if (stale.test(readFileSync(file, "utf8")))
            hits.push(path.relative(SRC, file));
        }
      }
    })(SRC);
    assert.deepEqual(hits, []);
  }
);
