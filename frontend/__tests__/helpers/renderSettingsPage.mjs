// Rendert Einstellungsseiten des Frontends ohne Browser: Vite lädt die Quellen
// wie im Build (Alias "@", JSX, import.meta.env), React rendert sie serverseitig
// zu HTML. Damit lässt sich prüfen, was die Einstellungs-Sidebar auf einer
// Adresse anzeigt (aufgeklappter Block, markierter Menüpunkt) und ob eine Seite
// die Sidebar überhaupt lädt.
//
// Grenzen: Beim serverseitigen Rendern laufen keine Effekte. Der Chat-Verlauf-
// Schalter (CanViewChatHistory lädt ihn im Effekt) wird deshalb durch einen
// festen Wert ersetzt; Seiten zeigen ihren Zustand vor dem ersten Laden.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const CAN_VIEW_CHAT_HISTORY = path.join(
  FRONTEND_ROOT,
  "src/components/CanViewChatHistory/index.jsx"
);
const VIEWABLE_FLAG = "__TEST_CAN_VIEW_CHAT_HISTORY__";
const SELECTED_CLASS = "bg-theme-sidebar-subitem-selected";

// Der Job „Run backend tests" installiert die Frontend-Pakete nicht.
export const hasFrontendDeps = ["vite", "react-dom", "react-router-dom"].every(
  (name) => existsSync(path.join(FRONTEND_ROOT, "node_modules", name))
);

/**
 * Startet Vite (ohne HTTP-Server) und liefert eine Renderfunktion.
 * @returns {Promise<{render: Function, load: Function, imports: Function, close: Function}>}
 */
export async function createRenderer() {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  // Nur was die geladenen Module beim Import und beim Rendern anfassen.
  globalThis.window = {
    localStorage: globalThis.localStorage,
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
    addEventListener() {},
    removeEventListener() {},
  };

  const { createServer } = await import("vite");
  const server = await createServer({
    root: FRONTEND_ROOT,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { disabled: true },
    plugins: [
      {
        name: "test-can-view-chat-history",
        enforce: "pre",
        load(id) {
          if (id !== CAN_VIEW_CHAT_HISTORY) return null;
          return `
            const state = () => ({
              loading: false,
              viewable: globalThis.${VIEWABLE_FLAG} !== false,
            });
            export const useCanViewChatHistory = state;
            export const CanViewChatHistoryProvider = ({ children }) =>
              children({ viewable: state().viewable });
            export const CanViewChatHistory = ({ children }) => children;
          `;
        },
      },
    ],
  });

  const { default: React } = await import("react");
  const { renderToString } = await import("react-dom/server");
  const { MemoryRouter, Routes, Route } = await import("react-router-dom");
  const { default: i18next } = await import("i18next");
  const { initReactI18next } = await import("react-i18next");
  const { defaultNS, resources } = await server.ssrLoadModule(
    "/src/locales/resources.js"
  );
  await i18next.use(initReactI18next).init({
    lng: "de",
    fallbackLng: "en",
    defaultNS,
    resources,
    lowerCaseLng: true,
    interpolation: { escapeValue: false },
  });
  const { LogoContext } = await server.ssrLoadModule("/src/LogoContext.jsx");
  const { AuthContext } = await server.ssrLoadModule("/src/AuthContext.jsx");

  /**
   * @param {string} modulePath - Seite/Komponente (Default-Export), z. B. "/src/pages/…/index.jsx".
   * @param {object} options
   * @param {string} options.location - Aufgerufene Adresse.
   * @param {string} [options.route] - Routenmuster, falls die Adresse Parameter enthält.
   * @param {string} [options.role] - Rolle des angemeldeten Nutzers.
   * @param {boolean} [options.canViewChatHistory] - Chat-Verlauf einsehbar?
   * @param {Object<string,string>} [options.stored] - Inhalt des Browser-Speichers.
   * @returns {Promise<string>} HTML der Seite.
   */
  async function render(
    modulePath,
    {
      location,
      route = location,
      role = "admin",
      canViewChatHistory = true,
      stored = {},
    }
  ) {
    const { default: Page } = await server.ssrLoadModule(modulePath);
    storage.clear();
    for (const [key, value] of Object.entries(stored)) storage.set(key, value);
    globalThis[VIEWABLE_FLAG] = canViewChatHistory;

    const h = React.createElement;
    const tree = h(
      LogoContext.Provider,
      { value: { logo: "", loginLogo: "", isCustomLogo: false } },
      h(
        AuthContext.Provider,
        { value: { store: { user: { id: 1, role }, authToken: "test" } } },
        h(
          MemoryRouter,
          { initialEntries: [location] },
          h(Routes, null, h(Route, { path: route, element: h(Page) }))
        )
      )
    );

    // React meldet jedes useLayoutEffect beim serverseitigen Rendern.
    const consoleError = console.error;
    console.error = (...args) => {
      if (String(args[0]).includes("useLayoutEffect does nothing")) return;
      consoleError(...args);
    };
    try {
      return renderToString(tree);
    } finally {
      console.error = consoleError;
    }
  }

  /** Lädt ein Modul der Quellen wie im Build, z. B. "/src/utils/paths.js". */
  const load = (modulePath) => server.ssrLoadModule(modulePath);

  /**
   * Alle Quelldateien, die ein Modul direkt oder über andere Module lädt.
   * @param {string} modulePath - z. B. "/src/pages/…/index.jsx".
   * @returns {Promise<Set<string>>} Adressen wie "/src/components/…/index.jsx".
   */
  async function imports(modulePath) {
    await load(modulePath);
    const seen = new Set();
    const queue = [await server.moduleGraph.getModuleByUrl(modulePath, true)];
    while (queue.length) {
      for (const mod of queue.pop().ssrImportedModules) {
        if (seen.has(mod.url)) continue;
        seen.add(mod.url);
        queue.push(mod);
      }
    }
    return seen;
  }

  return { render, load, imports, close: () => server.close() };
}

/**
 * Liest die Menüpunkte der Einstellungs-Sidebar in Anzeigereihenfolge aus dem HTML.
 * Unterpunkte stehen nur im HTML, wenn ihr Block aufgeklappt ist.
 * @param {string} html
 * @returns {{label: string, href: string, child: boolean, active: boolean}[]}
 */
export function menuEntries(html) {
  const row =
    /<div class="\s*flex items-center justify-between w-full([^"]*)"><a class="[^"]*" href="([^"]*)">(?:<svg[\s\S]*?<\/svg>)?<p class="(text-xs|text-sm)[^"]*">([^<]*)<\/p>/g;
  return [...html.matchAll(row)].map(([, rowClass, href, size, label]) => ({
    label,
    href,
    child: size === "text-xs",
    active: rowClass.includes(SELECTED_CLASS),
  }));
}
