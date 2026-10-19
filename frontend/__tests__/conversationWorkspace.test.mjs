// KIE-575: Konversationen als Arbeitsbereich ab lg – volle Breite, Liste und
// Verlauf je mit eigener Bildlaufleiste, der Verlauf von sich aus offen
// (neueste Konversation vorgewählt), ✕ schließt und merkt sich das, ↑/↓
// blättern auch ohne Klick, Nachladen am Ende der Spalte.
//
// Die Liste ist mit React DOM in ein Dokument ohne Browser eingehängt
// (helpers/renderSettingsPage.mjs, mount) – hinter einer Sonde für die
// Adresse (helpers/ConversationListProbe.jsx). Breite: Ohne matchMedia gilt
// die Ansicht als schmal; stubWidth(t, true) stellt „ab lg“ nach.
//
// Maße (Breiten, Höhen, Scrollen der Spalten) bleiben Sache des
// Browser-Tests (AK-1, AK-2, AK-9: frontend/__tests__/browser/
// kie575Layout.manual.mjs); hier stehen Zustand, Anfragen, Fokus, Adresse
// und die Klassen des Layouts.
import test, { after, before } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import {
  click,
  createDocument,
  elements,
  handlersOf,
} from "./helpers/testDom.mjs";
import requests from "../../server/__tests__/endpoints/support/embedAnalyticsRequests.js";

const { ROUTES } = requests;

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const PROBE = "/__tests__/helpers/ConversationListProbe.jsx";
const PAGE = "/src/pages/GeneralSettings/ChatEmbedWidgets/index.jsx";
const LOCATION = "/settings/chatbot/conversations";
const PANEL_KEY = "kie.conversations.panel";
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

const EMBED_ID = 3;
const PERIOD = { fromDay: "2026-09-13", toDay: "2026-10-13" };

/** Zeitpunkt zu einer Berliner Wanduhrzeit (Oktober 2026: UTC+2). */
const berlin = (day, time) => Date.parse(`${day}T${time}:00+02:00`);

/** Eine Zeile der Liste, wie der Server sie liefert (neueste zuerst). */
function row(id, extra = {}) {
  return {
    conversation_id: `konv-${id}`,
    session_id: `sitzung-${id}`,
    embed_id: EMBED_ID,
    first_chat_id: id,
    started_at: berlin("2026-10-12", "12:00") - id * 60000,
    last_message_at: berlin("2026-10-12", "12:05") - id * 60000,
    message_count: 1,
    negative_count: 0,
    positive_count: 0,
    conversation_number: id,
    first_negative_reason: null,
    preview: `Frage ${id}`,
    workspace: "VHS Musterstadt",
    ...extra,
  };
}

/** Eine Nachricht der Einzelansicht (Antwort leer: kein DOMPurify). */
function message(id, extra = {}) {
  return {
    id,
    prompt: `Frage ${id}`,
    response: JSON.stringify({ text: "", sources: [] }),
    createdAt: new Date(berlin("2026-10-12", "12:05") - id * 60000).toISOString(),
    conversation_id: `konv-${id}`,
    session_id: `sitzung-${id}`,
    feedbackScore: null,
    feedbackText: null,
    feedbackReason: null,
    ...extra,
  };
}

/**
 * Der Server der Liste: state.rows ist der Bestand (letzte Nachricht
 * absteigend); q trifft die Vorschau. Blättern über den Schlüssel (after)
 * – mit state.byOffset über offset auf dem Bestand zum Zeitpunkt der
 * Anfrage (so entstehen Doppelte, wenn vorn eine Zeile dazukommt). Der
 * Verlauf jeder Konversation: eine Nachricht, sofern state.details nichts
 * anderes sagt.
 */
async function workspaceServer(t, state) {
  const { API_BASE } = await renderer.load("/src/utils/constants.js");
  const listPath = new RegExp(
    `^${API_BASE}${ROUTES.conversations.path.replace(":embedId", "\\d+")}$`
  );
  const isList = (url) => listPath.test(url);
  const calls = [];
  const original = globalThis.fetch;
  const json = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => null },
    json: async () => body,
  });
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      method: init.method,
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    if (isList(url)) {
      const { offset = 0, limit = 20, after, q, feedbackFilter } = call.body;
      let rows = state.rows;
      if (q)
        rows = rows.filter((r) =>
          r.preview.toLowerCase().includes(q.toLowerCase())
        );
      if (feedbackFilter === "negative")
        rows = rows.filter((r) => r.negative_count > 0);
      let rest = rows;
      if (after) {
        // hinter dem Schlüssel – mit state.overlap um so viele Zeilen davor
        // (der Bestand hat sich zwischen zwei Seiten verschoben: Doppelte)
        const index = rows.findIndex(
          (r) => r.first_chat_id === after.firstChatId
        );
        rest =
          index < 0
            ? rows.filter(
                (r) =>
                  r.last_message_at < after.lastMessageAt ||
                  (r.last_message_at === after.lastMessageAt &&
                    r.first_chat_id < after.firstChatId)
              )
            : rows.slice(Math.max(0, index + 1 - (state.overlap ?? 0)));
      }
      const start = after ? 0 : offset;
      Object.defineProperty(call, "start", {
        value: rows.length - rest.length + start,
      });
      if (state.failList?.(call.body))
        return json({ success: false, error: "kaputt" }, 500);
      return json({
        success: true,
        conversations: rest.slice(start, start + limit),
        hasMore: start + limit < rest.length,
        totalCount: rows.length,
        maxId: 100000,
      });
    }
    if (url === `${API_BASE}/embeds`)
      return json({ embeds: state.embeds ?? [] });
    if (url === `${API_BASE}${ROUTES.lastActivity.path}`)
      return json({ success: true, lastActivity: [] });
    if (url.endsWith("/analytics/summary"))
      return json({
        success: true,
        granularity: "day",
        fromDay: call.body.fromDay,
        toDay: call.body.toDay,
        firstLedgerDay: "2026-01-01",
        totals: {
          messages: 10,
          conversations: state.rows.length,
          feedbackPositive: 0,
          feedbackNegative: 0,
        },
        buckets: [],
      });
    const detail = url.match(/\/conversation\/(\d+)$/);
    if (call.method === "GET" && detail) {
      const id = Number(detail[1]);
      const answer = state.details?.[id];
      if (answer?.status >= 400)
        return {
          ok: false,
          status: answer.status,
          headers: { get: () => null },
          json: async () => {
            throw new SyntaxError("Unexpected token 'F'");
          },
        };
      return json({
        success: true,
        messages: answer?.messages ?? [message(id)],
      });
    }
    if (url.endsWith("/conversation/deletion-preview"))
      return json({ success: true, messageCount: 1, visitor: null });
    return json({ success: false, error: "unbekannt" }, 404);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return {
    calls,
    lists: () => calls.filter((call) => isList(call.url)),
    details: () =>
      calls
        .filter(
          (call) =>
            call.method === "GET" && /\/conversation\/\d+$/.test(call.url)
        )
        .map((call) => Number(call.url.match(/(\d+)$/)[1])),
    previews: () =>
      calls.filter((call) => call.url.endsWith("/conversation/deletion-preview"))
        .length,
  };
}

/**
 * Hängt die Liste (hinter der Sonde) unter einer Adresse ein. stored: der
 * Browser-Speicher, etwa { "kie.conversations.panel": "closed" }.
 */
async function mountList(t, { query = "", props = {}, stored = {} } = {}) {
  const mounted = await renderer.mount(PROBE, {
    location: `${LOCATION}${query}`,
    route: LOCATION,
    props: { embedId: EMBED_ID, ...PERIOD, ...props },
    stored,
  });
  const { document } = mounted;
  if (!document.getElementById("root")) {
    const root = document.createElement("div");
    root.setAttribute("id", "root");
    document.body.appendChild(root);
  }
  // Wie im Browser: Ein Element, das nicht mehr im Dokument ist (die
  // Ansicht eines früheren Tests), hat den Fokus an <body> verloren.
  if (!document.body.contains(document.activeElement))
    document.activeElement = document.body;
  t.after(() => mounted.unmount());
  await mounted.act();
  const probe = () => one(mounted.container, "data-location-search");
  return {
    ...mounted,
    /** die Suche der Adresse, z. B. "?widget=3&conversation=2" */
    search: () => probe().getAttribute("data-location-search"),
    /** letzte Navigation: "PUSH" | "REPLACE" | "POP" */
    navigationType: () => probe().getAttribute("data-navigation-type"),
  };
}

const withAttribute = (root, name) =>
  elements(root, (element) => element.hasAttribute(name));
const one = (root, name) => {
  const [element, ...more] = withAttribute(root, name);
  assert.ok(element, `kein Element mit ${name}`);
  assert.equal(more.length, 0, `mehrere Elemente mit ${name}`);
  return element;
};
const rowsOf = (container) => withAttribute(container, "data-conversation-row");
const rowIds = (container) =>
  rowsOf(container).map((r) => Number(r.getAttribute("data-conversation-row")));
const panelOf = (container) =>
  withAttribute(container, "data-conversation-panel")[0] ?? null;
const emptyPanelOf = (container) =>
  withAttribute(container, "data-conversation-panel-empty")[0] ?? null;
const currentRows = (container) =>
  rowsOf(container)
    .filter((r) => r.getAttribute("aria-current") === "true")
    .map((r) => Number(r.getAttribute("data-conversation-row")));
const classesOf = (element) =>
  (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const hasClasses = (element, names) =>
  names.every((name) => classesOf(element).includes(name));
const stored = () => globalThis.localStorage.getItem(PANEL_KEY);
/** Dasselbe Element? (assert.equal druckte sonst den ganzen DOM-Baum.) */
const same = (actual, expected, message) =>
  assert.ok(actual === expected, message ?? "nicht dasselbe Element");
const wait = (ms) => delay(ms);
/** Tippt in das Suchfeld (Handler des Elements). */
async function type({ container, act }, value) {
  const input = one(container, "data-search-input");
  await act(() => handlersOf(input).onChange({ target: { value } }));
}

/** window.matchMedia für eine Breite (lg = ab 1024 px). */
function stubWidth(t, wide) {
  const original = globalThis.window.matchMedia;
  globalThis.window.matchMedia = (query) => ({
    matches: query.includes("1024") ? wide : false,
    addEventListener() {},
    removeEventListener() {},
  });
  t.after(() => {
    globalThis.window.matchMedia = original;
  });
}

/**
 * Tastatur-Lauscher am Fenster mitschneiden (Pfeiltasten der Liste, Escape
 * des Panels); fire() spielt eine Taste auf dem fokussierten Element ab.
 */
function captureWindowKeys(t) {
  const win = globalThis.window;
  const listeners = [];
  const original = {
    add: win.addEventListener,
    remove: win.removeEventListener,
  };
  win.addEventListener = (type, listener) => {
    if (type === "keydown") listeners.push(listener);
  };
  win.removeEventListener = (type, listener) => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
  t.after(() => {
    win.addEventListener = original.add;
    win.removeEventListener = original.remove;
  });
  return {
    count: () => listeners.length,
    fire: async (act, key) => {
      const document = globalThis.document;
      const event = {
        key,
        target: document.activeElement ?? document.body,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      await act(() => {
        for (const listener of [...listeners]) listener(event);
      });
      return event;
    },
  };
}

/** scrollIntoView aller Elemente mitschneiden: [Element, Optionen]. */
function captureScrolls(t) {
  const prototype = Object.getPrototypeOf(
    createDocument().createElement("div")
  );
  const scrolled = [];
  const original = prototype.scrollIntoView;
  prototype.scrollIntoView = function (options) {
    scrolled.push([this, options]);
  };
  t.after(() => {
    prototype.scrollIntoView = original;
  });
  return scrolled;
}

/** IntersectionObserver der Liste abfangen: je Beobachter Ziel und Rahmen. */
function stubIntersectionObserver(t) {
  const observers = [];
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback, options = {}) {
      this.callback = callback;
      this.root = options.root ?? null;
      this.observed = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(element) {
      this.observed.push(element);
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  t.after(() => {
    if (original === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = original;
  });
  return {
    all: observers,
    /** der zuletzt angelegte, noch verbundene Beobachter */
    active: () => observers.filter((o) => !o.disconnected).at(-1) ?? null,
    /** Das Ende kommt in Sicht. */
    reach: (act, observer) =>
      act(() =>
        observer.callback(
          observer.observed.map((target) => ({ isIntersecting: true, target }))
        )
      ),
  };
}

// ---------------------------------------------------------------------------
// AK-3, NAK-1, NAK-2: von selbst offen, ohne Adresse, Fokus und Sprung
// ---------------------------------------------------------------------------

test(
  "AK-3 / NAK-1 / NAK-2: Ab lg ist die neueste Konversation vorgewählt und ihr Verlauf zu sehen – Adresse ohne conversation, nichts gemerkt, Fokus bleibt auf <body>, kein Sprung; genau ein Verlauf und eine Lösch-Vorschau geladen",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const scrolled = captureScrolls(t);
    const server = await workspaceServer(t, { rows: [row(1), row(2), row(3)] });
    const view = await mountList(t);
    const { container, document, act } = view;
    await act();
    assert.ok(panelOf(container), "Verlauf offen");
    assert.equal(emptyPanelOf(container), null);
    assert.deepEqual(currentRows(container), [1]);
    assert.match(panelOf(container).textContent, /Frage 1/);
    assert.equal(view.search(), "");
    assert.equal(stored(), null, "die Vorwahl merkt sich nichts");
    same(document.activeElement, document.body, "kein Fokusdiebstahl");
    assert.deepEqual(scrolled, [], "kein Scrollen beim Öffnen");
    assert.deepEqual(server.details(), [1]);
    assert.equal(server.previews(), 1);
    assert.equal(server.lists().length, 1);
    // Ab lg kein Dialog (kein inert, keine Rolle) – die Liste bleibt bedienbar
    assert.equal(panelOf(container).hasAttribute("role"), false);
    assert.equal(
      elements(document.body, (e) => e.hasAttribute("inert")).length,
      0
    );
  }
);

test(
  "AK-8: Unter lg bleibt alles wie heute – nichts vorgewählt, kein Platzhalter, kein Verlauf geladen; ein Klick öffnet das Vollbild mit neuem Eintrag (PUSH)",
  { skip },
  async (t) => {
    stubWidth(t, false);
    const server = await workspaceServer(t, { rows: [row(1), row(2)] });
    const view = await mountList(t);
    const { container, act } = view;
    await act();
    assert.equal(panelOf(container), null);
    assert.equal(emptyPanelOf(container), null);
    assert.deepEqual(server.details(), []);
    assert.deepEqual(currentRows(container), []);
    await act(() => click(rowsOf(container)[1]));
    await act();
    assert.equal(panelOf(container).getAttribute("role"), "dialog");
    assert.equal(view.search(), "?widget=3&conversation=2");
    assert.equal(view.navigationType(), "PUSH");
    assert.equal(stored(), null, "unter lg wird nichts gemerkt");
  }
);

// ---------------------------------------------------------------------------
// AK-4: ✕ schließt und merkt „closed“; Klick öffnet und merkt „open“
// ---------------------------------------------------------------------------

test(
  "AK-4: ✕ schließt den Verlauf (Liste allein, „closed“ gemerkt); nach dem Neuladen bleibt er zu und lädt nichts; ein Klick auf eine Zeile öffnet ihn (Adresse ersetzt, „open“ gemerkt); nach dem Neuladen ist er wieder offen",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const server = await workspaceServer(t, {
      rows: [row(1), row(2), row(3)],
    });
    const first = await mountList(t);
    await first.act();
    assert.deepEqual(currentRows(first.container), [1]);
    await first.act(() => click(one(first.container, "data-panel-close")));
    await first.act();
    assert.equal(panelOf(first.container), null);
    assert.equal(emptyPanelOf(first.container), null, "kein Platzhalter");
    assert.deepEqual(currentRows(first.container), []);
    assert.equal(stored(), "closed");
    assert.equal(first.search(), "", "die Vorwahl stand nie in der Adresse");
    await first.unmount();

    // Neuladen mit gemerkt „closed“: zu, kein Verlauf geladen (NAK-2)
    const detailsBefore = server.details().length;
    const second = await mountList(t, { stored: { [PANEL_KEY]: "closed" } });
    await second.act();
    assert.equal(panelOf(second.container), null);
    assert.equal(emptyPanelOf(second.container), null);
    assert.equal(server.details().length, detailsBefore);
    // Klick: öffnet, ersetzt die Adresse (kein neuer Eintrag), merkt „open“
    await second.act(() => click(rowsOf(second.container)[1]));
    await second.act();
    assert.ok(panelOf(second.container));
    assert.deepEqual(currentRows(second.container), [2]);
    assert.equal(second.search(), "?widget=3&conversation=2");
    assert.equal(second.navigationType(), "REPLACE");
    assert.equal(stored(), "open");
    // ✕ nimmt die Konversation aus der Adresse und merkt „closed“
    await second.act(() => click(one(second.container, "data-panel-close")));
    await second.act();
    assert.equal(panelOf(second.container), null);
    assert.equal(second.search(), "?widget=3");
    assert.equal(stored(), "closed");
    await second.unmount();

    // Neuladen mit gemerkt „open“: die neueste von selbst
    const third = await mountList(t, { stored: { [PANEL_KEY]: "open" } });
    await third.act();
    assert.deepEqual(currentRows(third.container), [1]);
    assert.equal(third.search(), "");
  }
);

test(
  "AK-7: Ein Link (?conversation=) öffnet immer – auch bei gemerkt „closed“, ohne das Gemerkte zu ändern; ✕ schließt und nimmt ihn aus der Adresse",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const server = await workspaceServer(t, { rows: [row(1), row(2)] });
    const view = await mountList(t, {
      query: "?widget=3&conversation=2",
      stored: { [PANEL_KEY]: "closed" },
    });
    const { container, act } = view;
    await act();
    assert.ok(panelOf(container));
    assert.deepEqual(currentRows(container), [2]);
    assert.deepEqual(server.details(), [2]);
    assert.equal(stored(), "closed");
    await act(() => click(one(container, "data-panel-close")));
    await act();
    assert.equal(panelOf(container), null);
    assert.equal(emptyPanelOf(container), null);
    assert.equal(view.search(), "?widget=3");
  }
);

// ---------------------------------------------------------------------------
// AK-6, NAK-3: ↑/↓ ohne Klick, Escape nur unter lg
// ---------------------------------------------------------------------------

test(
  "AK-6: ↑/↓ blättern direkt nach dem Öffnen der Seite (Fokus auf <body>) und im Kopf des Panels – der Fokus bleibt, die gewählte Zeile kommt in der Spalte in Sicht („nearest“); nicht im Suchfeld, nicht über den Anfang hinaus",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const keys = captureWindowKeys(t);
    const scrolled = captureScrolls(t);
    const server = await workspaceServer(t, {
      rows: [row(1), row(2), row(3)],
    });
    const view = await mountList(t);
    const { container, document, act } = view;
    await act();
    same(document.activeElement, document.body);
    assert.deepEqual(currentRows(container), [1]);

    const down = await keys.fire(act, "ArrowDown");
    await act();
    assert.deepEqual(currentRows(container), [2]);
    same(document.activeElement, document.body, "Fokus bleibt");
    assert.deepEqual(server.details(), [1, 2]);
    assert.equal(view.search(), "?widget=3&conversation=2");
    assert.equal(view.navigationType(), "REPLACE");
    // die gewählte Zeile in der Spalte in Sicht
    assert.deepEqual(
      scrolled.map(([element, options]) => [
        element.getAttribute("data-conversation-row"),
        options,
      ]),
      [["2", { block: "nearest" }]]
    );
    assert.equal(down?.defaultPrevented, true, "die Seite scrollt nicht");

    await keys.fire(act, "ArrowUp");
    await act();
    assert.deepEqual(currentRows(container), [1]);
    // über den Anfang hinaus: nichts
    await keys.fire(act, "ArrowUp");
    await act();
    assert.deepEqual(currentRows(container), [1]);

    // im Kopf des Panels (✕ hat den Fokus): blättert
    one(container, "data-panel-close").focus();
    await keys.fire(act, "ArrowDown");
    await act();
    assert.deepEqual(currentRows(container), [2]);
    same(document.activeElement, one(container, "data-panel-close"));

    // im Suchfeld: nichts (die Pfeiltasten gehören dem Feld)
    one(container, "data-search-input").focus();
    const inField = await keys.fire(act, "ArrowDown");
    await act();
    assert.deepEqual(currentRows(container), [2]);
    assert.equal(inField?.defaultPrevented, false);

    // auf einer Zeile: der Handler der Zeile (Fokus wechselt, Panel folgt)
    rowsOf(container)[1].focus();
    await act(() =>
      handlersOf(rowsOf(container)[1]).onKeyDown({
        key: "ArrowDown",
        preventDefault() {},
      })
    );
    await act();
    assert.deepEqual(currentRows(container), [3]);
    same(document.activeElement, rowsOf(container)[2]);
  }
);

test(
  "NAK-3: Escape schließt den Verlauf ab lg nicht (nur ✕); unter lg schließt Escape das Vollbild wie heute",
  { skip },
  async (t) => {
    const keys = captureWindowKeys(t);
    await workspaceServer(t, { rows: [row(1), row(2)] });

    stubWidth(t, true);
    const wide = await mountList(t);
    await wide.act();
    assert.ok(panelOf(wide.container));
    await keys.fire(wide.act, "Escape");
    await wide.act();
    assert.ok(panelOf(wide.container), "Escape lässt den Verlauf offen");
    assert.equal(stored(), null);
    await wide.act(() => click(one(wide.container, "data-panel-close")));
    await wide.act();
    assert.equal(panelOf(wide.container), null);
    await wide.unmount();

    stubWidth(t, false);
    const narrow = await mountList(t);
    await narrow.act();
    await narrow.act(() => click(rowsOf(narrow.container)[0]));
    await narrow.act();
    assert.ok(panelOf(narrow.container));
    await keys.fire(narrow.act, "Escape");
    await narrow.act();
    assert.equal(panelOf(narrow.container), null, "Escape schließt unter lg");
  }
);

// ---------------------------------------------------------------------------
// AK-5: Nachladen am Ende der Spalte
// ---------------------------------------------------------------------------

test(
  "AK-5: Kommt das Ende der Spalte in Sicht, lädt die Liste nach (Beobachter mit der Spalte als Rahmen) – höchstens AUTO_LOAD_ROUNDS Seiten hintereinander, dann bleibt „Weitere laden“; ein Klick darauf lädt und beginnt die Zählung neu; keine Doppelten",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const observers = stubIntersectionObserver(t);
    const rows = Array.from({ length: 700 }, (_, i) => row(1000 + i));
    const server = await workspaceServer(t, { rows });
    const { container, act } = await mountList(t);
    await act();
    assert.equal(rowsOf(container).length, 20);

    const observer = observers.active();
    assert.ok(observer, "kein Beobachter am Ende der Spalte");
    same(observer.root, one(container, "data-list-scroll"), "Rahmen: die Spalte");
    assert.deepEqual(observer.observed, [one(container, "data-list-end")]);
    assert.ok(
      hasClasses(one(container, "data-list-scroll"), ["lg:overflow-y-auto"])
    );

    // 30 Seiten von selbst (AUTO_LOAD_ROUNDS), je eine Anfrage hinter der
    // letzten Zeile; die Liste bleibt ohne Doppelte
    for (let round = 1; round <= 30; round++) {
      const current = observers.active();
      assert.ok(current, `Runde ${round}: kein Beobachter`);
      await observers.reach(act, current);
      for (let i = 0; i < 3; i++) await act();
      const ids = rowIds(container);
      assert.equal(ids.length, 20 + 20 * round, `Runde ${round}`);
      assert.equal(new Set(ids).size, ids.length, `Runde ${round}: Doppelte`);
    }
    assert.equal(server.lists().length, 31);
    assert.deepEqual(
      server.lists().slice(1, 4).map((call) => [call.start, call.body.limit]),
      [
        [20, 20],
        [40, 20],
        [60, 20],
      ]
    );
    // Grenze erreicht: kein Beobachter mehr, der Knopf bleibt als Rückfall
    assert.equal(observers.active(), null);
    assert.equal(withAttribute(container, "data-load-more").length, 1);
    await act(() => click(one(container, "data-load-more")));
    for (let i = 0; i < 3; i++) await act();
    assert.equal(rowsOf(container).length, 640);
    // und von Hand nachgeladen zählt das automatische Nachladen von vorn
    const again = observers.active();
    assert.ok(again, "nach dem Klick kein Beobachter");
    await observers.reach(act, again);
    for (let i = 0; i < 3; i++) await act();
    assert.equal(rowsOf(container).length, 660);
  }
);

test(
  "AK-5: Bringt eine nachgeladene Seite nur Doppelte (Bestand hat sich verschoben), hält das automatische Nachladen an – die Liste bleibt ohne Doppelte, „Weitere laden“ bleibt; unter lg gibt es keinen Beobachter",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const observers = stubIntersectionObserver(t);
    const rows = Array.from({ length: 60 }, (_, i) => row(500 + i));
    const state = { rows };
    const server = await workspaceServer(t, state);
    const { container, act } = await mountList(t);
    await act();
    assert.equal(rowsOf(container).length, 20);

    // Der Bestand hat sich verschoben: Seite 2 beginnt mit der letzten Zeile
    // der ersten Seite – die Liste zeigt sie nur einmal. Der Wunsch (20 neue
    // Zeilen) ist damit nicht erfüllt: Eine Seite für die fehlende Zeile
    // folgt von selbst, bringt wieder nur die Doppelte – und das
    // automatische Nachladen hält an (eine Seite ohne neue Zeile).
    state.overlap = 1;
    await observers.reach(act, observers.active());
    for (let i = 0; i < 6; i++) await act();
    let ids = rowIds(container);
    assert.equal(ids.length, 39);
    assert.equal(new Set(ids).size, 39);
    assert.deepEqual(
      server.lists().map((call) => [call.start, call.body.limit]),
      [
        [0, 20],
        [19, 20],
        [38, 1],
      ]
    );
    assert.equal(observers.active(), null, "Nachladen hält an");
    assert.equal(withAttribute(container, "data-load-more").length, 1);

    // „Weitere laden“ von Hand: eine volle Seite, wieder ohne Doppelte –
    // danach beobachtet die Liste das Spaltenende erneut
    await act(() => click(one(container, "data-load-more")));
    for (let i = 0; i < 6; i++) await act();
    ids = rowIds(container);
    assert.equal(ids.length, 58);
    assert.equal(new Set(ids).size, 58);
    const next = observers.active();
    assert.ok(next, "kein Beobachter nach dem Nachladen von Hand");

    // Nur Doppelte: Die nächste Seite liegt ganz im schon Geladenen
    state.overlap = 20;
    await observers.reach(act, next);
    for (let i = 0; i < 6; i++) await act();
    ids = rowIds(container);
    assert.equal(ids.length, 58, "keine neue Zeile");
    assert.equal(new Set(ids).size, 58);
    assert.equal(observers.active(), null, "Nachladen hält wieder an");
    assert.equal(withAttribute(container, "data-load-more").length, 1);
    assert.equal(server.lists().length, 5);
  }
);

test(
  "AK-8: Unter lg kein automatisches Nachladen – „Weitere laden“ wie heute",
  { skip },
  async (t) => {
    stubWidth(t, false);
    const observers = stubIntersectionObserver(t);
    const rows = Array.from({ length: 60 }, (_, i) => row(500 + i));
    await workspaceServer(t, { rows });
    const { container, act } = await mountList(t);
    await act();
    assert.equal(rowsOf(container).length, 20);
    assert.equal(observers.all.length, 0);
    await act(() => click(one(container, "data-load-more")));
    await act();
    assert.equal(rowsOf(container).length, 40);
    assert.equal(observers.all.length, 0);
  }
);

// ---------------------------------------------------------------------------
// Wechsel von Filter/Suche bei offenem Verlauf; Leerzustand
// ---------------------------------------------------------------------------

test(
  "Wechsel der Suche bei offenem Verlauf: Steht die Konversation aus der Adresse nicht mehr in der Liste, fällt sie aus der Adresse (ersetzt) und die erste Zeile der neuen Liste ist vorgewählt; leere Liste: Platzhalter „Keine Konversation gewählt“, der Verlauf bleibt offen",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const server = await workspaceServer(t, {
      rows: [
        row(1, { preview: "Yoga am Abend" }),
        row(2, { preview: "Spanisch A1" }),
        row(5, { preview: "Töpfern" }),
      ],
    });
    const view = await mountList(t, { query: "?widget=3&conversation=5" });
    const { container, act } = view;
    await act();
    assert.deepEqual(currentRows(container), [5]);

    // Suche „Spanisch“: 5 steht nicht mehr in der Liste
    await type(view, "Spanisch");
    await act(() => wait(350));
    for (let i = 0; i < 3; i++) await act();
    assert.deepEqual(rowIds(container), [2]);
    assert.deepEqual(currentRows(container), [2]);
    assert.equal(view.search(), "?widget=3&q=Spanisch");
    assert.equal(view.navigationType(), "REPLACE");
    assert.match(panelOf(container).textContent, /Frage 2/);
    assert.deepEqual(server.details(), [5, 2]);

    // Nichts gefunden: Platzhalter, kein Verlauf geladen, offen
    await type(view, "Gibt es nicht");
    await act(() => wait(350));
    for (let i = 0; i < 3; i++) await act();
    assert.deepEqual(rowIds(container), []);
    assert.equal(panelOf(container), null);
    const empty = emptyPanelOf(container);
    assert.ok(empty, "Platzhalter des Verlaufs");
    assert.match(empty.textContent, /Keine Konversation gewählt/);
    assert.deepEqual(server.details(), [5, 2]);
    // ✕ am Platzhalter schließt den Verlauf
    await act(() => click(one(empty, "data-empty-panel-close")));
    await act();
    assert.equal(emptyPanelOf(container), null);
    assert.equal(stored(), "closed");
  }
);

test(
  "Wechsel der Suche bei einer Konversation aus der Adresse, die in der neuen Liste bleibt: Sie bleibt gewählt, die Adresse auch",
  { skip },
  async (t) => {
    stubWidth(t, true);
    await workspaceServer(t, {
      rows: [
        row(1, { preview: "Yoga am Abend" }),
        row(2, { preview: "Spanisch A1" }),
        row(5, { preview: "Spanisch B2" }),
      ],
    });
    const view = await mountList(t, { query: "?widget=3&conversation=5" });
    const { container, act } = view;
    await act();
    await type(view, "Spanisch");
    await act(() => wait(350));
    for (let i = 0; i < 3; i++) await act();
    assert.deepEqual(rowIds(container), [2, 5]);
    assert.deepEqual(currentRows(container), [5]);
    assert.equal(view.search(), "?widget=3&conversation=5&q=Spanisch");
  }
);

// ---------------------------------------------------------------------------
// AK-1, AK-2: Aufbau des Arbeitsbereichs (Klassen; Maße im Browser-Test)
// ---------------------------------------------------------------------------

test(
  "AK-1 / AK-2 (Aufbau): Bereich mit fester Höhe ab lg, Kopf in der linken Spalte, Zeilen in einem eigenen Scrollbereich, Verlauf daneben; die Seite „Konversationen“ ohne die Obergrenze von 1180 px, „Widgets“ behält sie",
  { skip },
  async (t) => {
    const { WORKSPACE } = await renderer.load("/src/utils/conversationView.js");
    stubWidth(t, true);
    await workspaceServer(t, { rows: [row(1), row(2)] });
    const { container, act } = await mountList(t);
    await act();
    const area = one(container, "data-conversation-area");
    assert.ok(hasClasses(area, WORKSPACE.area.split(" ")), WORKSPACE.area);
    assert.ok(classesOf(area).includes("lg:h-[max(560px,calc(100vh-88px))]"));
    const column = one(container, "data-list-column");
    const header = one(container, "data-list-header");
    const scroller = one(container, "data-list-scroll");
    same(column.parentNode, area);
    same(header.parentNode, column, "Kopf in der linken Spalte");
    same(scroller.parentNode, column);
    assert.ok(hasClasses(header, ["lg:shrink-0"]));
    assert.ok(hasClasses(scroller, WORKSPACE.scroller.split(" ")));
    assert.ok(one(container, "data-conversation-list").parentNode === scroller);
    const panel = panelOf(container);
    same(panel.parentNode, area, "Verlauf neben der Spalte");
    assert.ok(hasClasses(panel, ["lg:relative", ...WORKSPACE.panel.split(" ")]));
    // nichts klebt, nichts hat eine Mindesthöhe der Seite
    for (const element of elements(container))
      for (const name of classesOf(element))
        assert.ok(
          !/^lg:(sticky|min-h-\[calc)/.test(name),
          `${element.tagName}: ${name}`
        );

    const conversations = await renderer.render(PAGE, {
      exportName: "ChatbotConversations",
      location: LOCATION,
    });
    assert.ok(conversations.includes('data-chatbot-content="full"'));
    assert.ok(!conversations.includes("max-w-[1180px]"));
    const widgets = await renderer.render(PAGE, {
      exportName: "ChatbotWidgets",
      location: "/settings/chatbot/widgets",
    });
    assert.ok(widgets.includes('data-chatbot-content="capped"'));
    assert.ok(widgets.includes("max-w-[1180px]"));
  }
);

test(
  "Sprachdateien: „Keine Konversation gewählt“ in de und en, in den übrigen Sprachen null",
  { skip },
  async () => {
    const { resources } = await renderer.load("/src/locales/resources.js");
    const text = (lang) =>
      resources[lang].common["embed-analytics"].panel.empty;
    assert.equal(text("de"), "Keine Konversation gewählt");
    assert.equal(text("en"), "No conversation selected");
    for (const lang of Object.keys(resources))
      if (lang !== "de" && lang !== "en") assert.equal(text(lang), null, lang);
    // keine Gedankenstriche in den neuen Texten
    for (const lang of ["de", "en"]) assert.ok(!/[–—]/.test(text(lang)));
  }
);
