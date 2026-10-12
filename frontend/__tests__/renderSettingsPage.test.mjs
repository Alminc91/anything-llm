// Der Test-Renderer startet Vite nur, um die Quellen zu laden. Er darf dabei
// keinen Netzwerk-Port öffnen: Ohne Gegenmaßnahme legt Vite im Middleware-Modus
// einen eigenen HMR-WebSocket-Server auf Port 24678 an, der ohne Anmeldung auf
// allen Schnittstellen lauscht (auch mit `hmr: false`).
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";

const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

test("Test-Renderer öffnet keinen Netzwerk-Port", { skip }, async () => {
  // Jeder lauschende Server (HTTP, WebSocket) geht über net.Server#listen;
  // der Aufruf zählt auch dann, wenn der Port gerade belegt ist.
  const listen = mock.method(net.Server.prototype, "listen");
  try {
    const renderer = await createRenderer();
    try {
      const { default: paths } = await renderer.load("/src/utils/paths.js");
      assert.equal(
        paths.settings.chatbot.widgets(),
        "/settings/chatbot/widgets"
      );
    } finally {
      await renderer.close();
    }
    assert.deepEqual(
      listen.mock.calls.map((call) => call.arguments),
      [],
      "net.Server#listen aufgerufen mit (Port, Host)"
    );
  } finally {
    listen.mock.restore();
  }
});
