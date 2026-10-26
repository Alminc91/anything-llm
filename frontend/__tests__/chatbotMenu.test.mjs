// KB-2: Menü „Chatbot“ mit gemeinsamer Widget-Auswahl, serverseitig
// gerendert (helpers/renderSettingsPage.mjs, render) und am Quelltext der
// Routentabelle geprüft. Das Verhalten im Dokument (Umleitungen, Auswahl,
// Merkregel, Abkürzungen der Widget-Zeile): chatbotWidgetSelection.test.mjs.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRenderer,
  hasFrontendDeps,
  menuEntries,
} from "./helpers/renderSettingsPage.mjs";

const SIDEBAR = "/src/components/SettingsSidebar/index.jsx";
const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src"
);
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const labelsOf = (entries) => entries.map((entry) => entry.label);

const CONVERSATIONS = "/settings/chatbot/conversations";
const DESIGN = "/settings/chatbot/design";
const WIDGETS = "/settings/chatbot/widgets";
const STATUS = "/settings/chatbot/status";

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

/** Kopf „Chatbot“ und seine sichtbaren Unterpunkte. */
function chatbotBlock(html) {
  const entries = menuEntries(html);
  const start = entries.findIndex((e) => !e.child && e.label === "Chatbot");
  assert.notEqual(start, -1, "Obermenüpunkt „Chatbot“ fehlt");
  const children = [];
  for (const entry of entries.slice(start + 1)) {
    if (!entry.child) break;
    children.push(entry);
  }
  return { head: entries[start], children, entries };
}

/** Die Seitenleiste unter einer Adresse, auch mit Suchteil. */
const renderAt = (location, options = {}) =>
  renderer.render(SIDEBAR, {
    location,
    route: location.split("?")[0],
    ...options,
  });

// ---------------------------------------------------------------------------
// AK-1: Reihenfolge, Rollen, „Status“ (seit KB-3 eingeschaltet)
// ---------------------------------------------------------------------------

test(
  "AK-1: „Chatbot“ hat Status, Konversationen, Design Center, Widgets, für admin, manager und default (KB-3)",
  { skip },
  async () => {
    for (const role of ["admin", "manager", "default"]) {
      const html = await renderer.render(SIDEBAR, {
        location: CONVERSATIONS,
        role,
      });
      const { children } = chatbotBlock(html);
      assert.deepEqual(
        children.map(({ label, href }) => ({ label, href })),
        [
          { label: "Status", href: STATUS },
          { label: "Konversationen", href: CONVERSATIONS },
          { label: "Design Center", href: DESIGN },
          { label: "Widgets", href: WIDGETS },
        ],
        role
      );
    }
  }
);

test(
  "AK-1: Der Schalter für „Status“ ist seit KB-3 an; im Menü steht „Status“ an erster Stelle, mit allen drei Rollen",
  { skip },
  async () => {
    const area = await renderer.load("/src/utils/chatbotArea.js");
    assert.equal(area.STATUS_PAGE_READY, true);
    const { default: paths } = await renderer.load("/src/utils/paths.js");
    assert.equal(paths.settings.chatbot.status(), STATUS);
    assert.equal(paths.settings.chatbot.design(), DESIGN);

    // Reihenfolge und Rollen am Quelltext
    const sidebar = readFileSync(
      path.join(SRC, "components/SettingsSidebar/index.jsx"),
      "utf8"
    );
    const block = sidebar.slice(sidebar.indexOf("function ChatbotOption"));
    const order = [
      "settings.chatbot-status",
      "settings.chatbot-conversations",
      "settings.chatbot-design-center",
      "settings.chatbot-widgets",
    ].map((key) => block.indexOf(`t("${key}")`));
    assert.ok(
      order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
      order.join(", ")
    );
    assert.match(
      block,
      /hidden: !STATUS_PAGE_READY,\s*btnText: t\("settings\.chatbot-status"\)/
    );
    assert.match(
      block,
      /const roles = \["admin", "manager", "default"\];/,
      "Rollen wie bisher"
    );
  }
);

test(
  "AK-1: Bezeichnungen zentral in der Übersetzung (de und en)",
  { skip },
  async () => {
    const { resources } = await renderer.load("/src/locales/resources.js");
    for (const [lang, status, design] of [
      ["de", "Status", "Design Center"],
      ["en", "Status", "Design Center"],
    ]) {
      const settings = resources[lang].common.settings;
      assert.equal(settings["chatbot-status"], status, lang);
      assert.equal(settings["chatbot-design-center"], design, lang);
    }
  }
);

// ---------------------------------------------------------------------------
// AK-2: Adressen in der Routentabelle
// ---------------------------------------------------------------------------

test(
  "AK-2: Routentabelle: /settings/chatbot/design zeigt das Design Center, die frühere Adresse leitet weiter, /settings/chatbot/status ist angelegt",
  { skip: false },
  () => {
    const main = readFileSync(path.join(SRC, "main.jsx"), "utf8");
    const routeOf = (address) => {
      const start = main.indexOf(`path: "${address}"`);
      assert.notEqual(start, -1, address);
      return main.slice(start, main.indexOf("\n      },", start));
    };
    assert.match(
      routeOf(DESIGN),
      /<PrivateRoute Component=\{ChatbotDesignCenter\} \/>/
    );
    assert.match(
      routeOf(STATUS),
      /<PrivateRoute Component=\{ChatbotStatus\} \/>/
    );
    assert.match(
      routeOf("/settings/embed-config/:embedId/appearance"),
      /element: <DesignCenterRedirect \/>/
    );
    // Das Design Center hängt nur noch an der neuen Adresse.
    assert.doesNotMatch(main, /ChatEmbedWidgets\/EmbedAppearance/);
  }
);

// ---------------------------------------------------------------------------
// AK-3: Die Menülinks tragen das Widget mit
// ---------------------------------------------------------------------------

test(
  "AK-3: Mit ?widget=3 tragen Konversationen und Design Center das Widget, „Konversationen“ bleibt markiert",
  { skip },
  async () => {
    const html = await renderAt(`${CONVERSATIONS}?widget=3`);
    const { children } = chatbotBlock(html);
    assert.deepEqual(
      children.map(({ label, href, active }) => ({ label, href, active })),
      [
        { label: "Status", href: `${STATUS}?widget=3`, active: false },
        {
          label: "Konversationen",
          href: `${CONVERSATIONS}?widget=3`,
          active: true,
        },
        { label: "Design Center", href: `${DESIGN}?widget=3`, active: false },
        { label: "Widgets", href: WIDGETS, active: false },
      ]
    );
  }
);

test(
  "AK-3: Ohne oder mit ungültigem widget= tragen die Menülinks kein Widget",
  { skip },
  async () => {
    for (const location of [WIDGETS, `${WIDGETS}?widget=abc`]) {
      const { children } = chatbotBlock(await renderAt(location));
      assert.deepEqual(
        children.map((entry) => entry.href),
        [STATUS, CONVERSATIONS, DESIGN, WIDGETS],
        location
      );
    }
  }
);

// ---------------------------------------------------------------------------
// AK-6: Der Gruppenkopf öffnet den ersten Unterpunkt
// ---------------------------------------------------------------------------

test(
  "AK-6: Der Kopf „Chatbot“ verweist auf den ersten sichtbaren Unterpunkt, mit dem Widget der Adresse",
  { skip },
  async () => {
    const withHistory = chatbotBlock(await renderAt(`${DESIGN}?widget=7`));
    assert.equal(withHistory.head.href, `${STATUS}?widget=7`);

    const withoutHistory = chatbotBlock(
      await renderer.render(SIDEBAR, {
        location: "/settings/users",
        canViewChatHistory: false,
      })
    );
    assert.equal(withoutHistory.head.href, STATUS);
  }
);

// ---------------------------------------------------------------------------
// NAK-3: Die übrige Seitenleiste bleibt, wie sie ist
// ---------------------------------------------------------------------------

test(
  "NAK-3: Die übrigen Gruppen der Seitenleiste bleiben, wie sie sind: ein Gruppenkopf klappt nur auf (Link auf die aufgerufene Adresse), Unterpunkte und Markierung wie bisher",
  { skip },
  async () => {
    const location = "/settings/llm-preference";
    const entries = menuEntries(await renderAt(location));
    const heads = entries.filter((entry) => !entry.child);
    assert.equal(heads[0].label, "Chatbot");
    assert.ok(heads.length > 3, labelsOf(heads).join(", "));
    for (const head of heads.slice(1))
      assert.ok(!head.href.startsWith("/settings/chatbot"), head.label);
    const providers = entries.findIndex((e) => e.label === "KI-Anbieter");
    assert.equal(entries[providers].href, location);
    assert.deepEqual(
      { ...entries[providers + 1], child: undefined },
      { label: "LLM", href: location, active: true, child: undefined }
    );
  }
);

test(
  "NAK-3: MenuOption bleibt nah an AnythingLLM: nur Pfadvergleich ohne Suchteil, opensFirstChild und der Punkt am Menü (KB-3)",
  { skip: false },
  () => {
    const source = readFileSync(
      path.join(SRC, "components/SettingsSidebar/MenuOption/index.jsx"),
      "utf8"
    );
    // Pfadvergleich, opensFirstChild und der eigene Handler des Links
    // (Fixliste r2 Nr. 1: der Pfeil behält das Umschalten aus AnythingLLM)
    const kufer = source.match(/Kufer \(KB-2\)/g) ?? [];
    assert.equal(kufer.length, 3, "drei gekennzeichnete Kufer-Stellen");
    assert.match(
      source,
      /<button onClick=\{handleClick\} className="p-2 text-white">/
    );
    assert.equal(
      (source.match(/Kufer \(KB-3, AK-5\)/g) ?? []).length,
      1,
      "eine Kufer-Stelle für den Punkt am Menü"
    );
    assert.match(source, /function hasVisibleOptions\(user = null/);
  }
);

// Fixliste r2 Nr. 4 (F6): Der Ladetext der Seiten im Bereich „Chatbot“ kommt
// aus der Übersetzung (common.loading), auch im Design Center.
test("F6: kein fester Ladetext im Bereich „Chatbot“", { skip }, () => {
  const dir = path.join(SRC, "pages/GeneralSettings/ChatEmbedWidgets");
  const sources = readdirSync(dir, { recursive: true }).filter((file) =>
    /\.jsx?$/.test(file)
  );
  assert.ok(sources.length > 5);
  const fixed = sources.filter((file) =>
    />\s*Laden\s*(\.\.\.|…)?\s*</.test(
      readFileSync(path.join(dir, file), "utf8")
    )
  );
  assert.deepEqual(fixed, []);
});
