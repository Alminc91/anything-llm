// KIE-535, AK-7: Das Design Center bleibt eine Vollbildseite ohne
// Einstellungs-Sidebar; „Zurück“ und der Rücksprung nach einem Ladefehler
// führen auf die Widget-Liste.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createRenderer,
  hasFrontendDeps,
  menuEntries,
} from "./helpers/renderSettingsPage.mjs";

const DESIGN_CENTER =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/index.jsx";
const SIDEBAR = "/src/components/SettingsSidebar/index.jsx";
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

test("Design Center rendert keine Einstellungs-Sidebar", { skip }, async () => {
  const html = await renderer.render(DESIGN_CENTER, {
    location: "/settings/embed-config/7/appearance",
    route: "/settings/embed-config/:embedId/appearance",
  });

  assert.match(html, /Laden\.\.\./);
  assert.deepEqual(menuEntries(html), []);
  assert.doesNotMatch(html, /href="\/settings\//);
});

test(
  "Design Center lädt die Einstellungs-Sidebar gar nicht",
  { skip },
  async () => {
    // Beim serverseitigen Rendern ist nur der Ladezustand zu sehen. Dass auch
    // die geladene Seite ohne Sidebar bleibt, zeigen die geladenen Module.
    const loaded = await renderer.imports(DESIGN_CENTER);
    assert.ok(loaded.has("/src/utils/paths.js"), [...loaded].join("\n"));
    assert.deepEqual(
      [...loaded].filter((url) => url.includes("/SettingsSidebar/")),
      []
    );

    // Gegenprobe: Die Sidebar selbst findet ihre Menüpunkte auf demselben Weg.
    const sidebar = await renderer.imports(SIDEBAR);
    assert.ok(
      sidebar.has("/src/components/SettingsSidebar/MenuOption/index.jsx")
    );
  }
);

test(
  "Design Center: „Zurück“ und Rücksprung nach Ladefehler führen auf /settings/chatbot/widgets",
  { skip },
  async () => {
    const { default: paths } = await renderer.load("/src/utils/paths.js");
    assert.equal(paths.settings.chatbot.widgets(), "/settings/chatbot/widgets");

    // Beide Rücksprünge laufen über navigate(); andere Wege aus der Seite
    // (Links, window.location) gibt es nicht.
    const source = readFileSync(
      new URL(`..${DESIGN_CENTER}`, import.meta.url),
      "utf8"
    );
    const target = "navigate(paths.settings.chatbot.widgets())";
    const calls = source.match(/\bnavigate\(.*/g) ?? [];
    assert.equal(calls.length, 2, calls.join("\n"));
    for (const call of calls) assert.ok(call.startsWith(target), call);
    assert.match(
      source,
      /showToast\("Einbettung nicht gefunden\.", "error"\);\s*navigate\(paths\.settings\.chatbot\.widgets\(\)\);/,
      "Rücksprung nach Ladefehler"
    );
    assert.match(
      source,
      /onClick=\{\(\) => navigate\(paths\.settings\.chatbot\.widgets\(\)\)\}[^>]*>\s*<ArrowLeft /,
      "Schaltfläche „Zurück“"
    );
    assert.doesNotMatch(source, /embed-chat-widgets|<Link\b|window\.location/);
  }
);
