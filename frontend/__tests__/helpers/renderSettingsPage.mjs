// Rendert Einstellungsseiten des Frontends ohne Browser: Vite lädt die Quellen
// wie im Build (Alias "@", JSX, import.meta.env), React rendert sie serverseitig
// zu HTML. Damit lässt sich prüfen, was die Einstellungs-Sidebar auf einer
// Adresse anzeigt (aufgeklappter Block, markierter Menüpunkt) und ob eine Seite
// die Sidebar überhaupt lädt.
//
// Grenzen: Beim serverseitigen Rendern laufen keine Effekte. Der Chat-Verlauf-
// Schalter (CanViewChatHistory lädt ihn im Effekt) wird deshalb durch einen
// festen Wert ersetzt; Seiten zeigen ihren Zustand vor dem ersten Laden.
// Komponenten lassen sich mit Eigenschaften rendern (props, exportName), um
// einen bestimmten Stand zu zeigen. DOMPurify (utils/chat/purify.js) ist
// ersetzt, weil es ein Dokument braucht.
//
// mount() hängt dieselbe Seite stattdessen mit React DOM in ein Dokument ohne
// Browser ein (helpers/testDom.mjs): Effekte laufen, Handler lassen sich
// aufrufen, der Zustand ändert sich. Das Dokument bleibt danach im Prozess
// stehen – Tests mit mount() gehören in eine eigene Datei.
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "./testDom.mjs";

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const CAN_VIEW_CHAT_HISTORY = path.join(
  FRONTEND_ROOT,
  "src/components/CanViewChatHistory/index.jsx"
);
const VIEWABLE_FLAG = "__TEST_CAN_VIEW_CHAT_HISTORY__";
const PURIFY = path.join(FRONTEND_ROOT, "src/utils/chat/purify.js");
const SELECTED_CLASS = "bg-theme-sidebar-subitem-selected";

// Der Job „Run backend tests" installiert die Frontend-Pakete nicht.
export const hasFrontendDeps = ["vite", "react-dom", "react-router-dom"].every(
  (name) => existsSync(path.join(FRONTEND_ROOT, "node_modules", name))
);

/**
 * Startet Vite (ohne lauschenden Server) und liefert eine Renderfunktion.
 * @returns {Promise<{render: Function, mount: Function, load: Function, imports: Function, close: Function}>}
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
    // Vite öffnet im Middleware-Modus sonst einen eigenen HMR-WebSocket-Server
    // auf Port 24678 an allen Schnittstellen, auch mit `hmr: false`. Mit einem
    // übergebenen, nie gestarteten HTTP-Server lauscht nichts.
    server: {
      middlewareMode: true,
      hmr: { server: http.createServer() },
      watch: null,
    },
    optimizeDeps: { disabled: true },
    plugins: [
      {
        name: "test-can-view-chat-history",
        enforce: "pre",
        load(id) {
          // DOMPurify braucht ein Dokument und richtet sich beim Laden des
          // Moduls ein. Ohne Browser gibt es nichts zu bereinigen: Wer es im
          // Test dennoch aufruft, bekommt einen Fehler statt ungeprüftes HTML.
          if (id === PURIFY)
            return `
              export default {
                setConfig() {},
                sanitize() {
                  throw new Error("DOMPurify steht im Test-Renderer nicht zur Verfügung.");
                },
              };
            `;
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
   * Die Seite mit allem, was sie umgibt: Logo, angemeldeter Nutzer, Adresse.
   * @param {string} modulePath - Seite/Komponente (Default-Export), z. B. "/src/pages/…/index.jsx".
   * @param {object} options
   * @param {string} options.location - Aufgerufene Adresse.
   * @param {string} [options.route] - Routenmuster, falls die Adresse Parameter enthält.
   * @param {string} [options.role] - Rolle des angemeldeten Nutzers.
   * @param {boolean} [options.canViewChatHistory] - Chat-Verlauf einsehbar?
   * @param {Object<string,string>} [options.stored] - Inhalt des Browser-Speichers.
   * @param {string} [options.exportName] - Benannter Export statt des Default-Exports.
   * @param {object} [options.props] - Eigenschaften der Komponente.
   * @returns {Promise<object>} React-Element.
   */
  async function treeOf(
    modulePath,
    {
      location,
      route = location,
      role = "admin",
      canViewChatHistory = true,
      stored = {},
      exportName = "default",
      props = {},
    }
  ) {
    const { [exportName]: Page } = await server.ssrLoadModule(modulePath);
    if (!Page) throw new Error(`${modulePath}: kein Export „${exportName}“`);
    storage.clear();
    for (const [key, value] of Object.entries(stored)) storage.set(key, value);
    globalThis[VIEWABLE_FLAG] = canViewChatHistory;

    const h = React.createElement;
    return h(
      LogoContext.Provider,
      { value: { logo: "", loginLogo: "", isCustomLogo: false } },
      h(
        AuthContext.Provider,
        { value: { store: { user: { id: 1, role }, authToken: "test" } } },
        h(
          MemoryRouter,
          { initialEntries: [location] },
          h(Routes, null, h(Route, { path: route, element: h(Page, props) }))
        )
      )
    );
  }

  /**
   * Rendert die Seite serverseitig – ihr Zustand vor dem ersten Laden.
   * @param {string} modulePath - siehe treeOf
   * @param {object} options - siehe treeOf
   * @returns {Promise<string>} HTML der Seite.
   */
  async function render(modulePath, options) {
    const tree = await treeOf(modulePath, options);

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

  let dom = null;
  /** Richtet beim ersten mount() das Dokument ein und lädt React DOM. */
  async function useDom() {
    if (dom) return dom;
    const document = createDocument();
    globalThis.document = document;
    Object.assign(globalThis.window, {
      document,
      // React DOM prüft vor jedem Zeichnen, ob der Fokus in einem iframe liegt.
      HTMLIFrameElement: class {},
      // Nicht das oberste Fenster: React DOM sucht dann nicht nach den DevTools.
      top: null,
    });
    // React meldet sonst jede Zustandsänderung als „nicht in act(...)".
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { createRoot } = await import("react-dom/client");
    dom = { document, createRoot };
    return dom;
  }

  /**
   * Hängt die Seite in ein Dokument ohne Browser ein: Effekte laufen, der
   * Zustand ändert sich. Alles, was den Zustand ändert (Handler aufrufen,
   * Antworten abwarten), gehört in act().
   * @param {string} modulePath - siehe treeOf
   * @param {object} options - siehe treeOf
   * @returns {Promise<{container: object, document: object, act: (action?: Function) => Promise<void>, unmount: () => Promise<void>}>}
   */
  async function mount(modulePath, options) {
    const tree = await treeOf(modulePath, options);
    const { document, createRoot } = await useDom();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    // Nach der Aktion eine Runde der Ereignisschleife: Dann sind auch die
    // Antworten eines ersetzten fetch verarbeitet.
    const act = (action = () => {}) =>
      React.act(async () => {
        await action();
        await new Promise((resolve) => setImmediate(resolve));
      });
    await act(() => root.render(tree));
    let mounted = true;
    return {
      container,
      document,
      act,
      unmount: async () => {
        if (!mounted) return;
        mounted = false;
        await act(() => root.unmount());
        document.body.removeChild(container);
      },
    };
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

  return { render, mount, load, imports, close: () => server.close() };
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
