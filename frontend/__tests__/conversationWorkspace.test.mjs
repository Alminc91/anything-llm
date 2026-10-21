// KIE-575: Konversationen als Arbeitsbereich auf dem Desktop (ab xl,
// 1.280 px; Fixliste 7.22-rc13, E15) – volle Breite, Liste und Verlauf je
// mit eigener Bildlaufleiste, der Verlauf von sich aus offen (neueste
// Konversation vorgewählt), ✕ schließt und merkt sich das, ↑/↓ blättern
// auch ohne Klick, Nachladen am Ende der Spalte. Tablet und Smartphone
// (unter xl) wie bisher unter lg.
//
// Die Liste ist mit React DOM in ein Dokument ohne Browser eingehängt
// (helpers/renderSettingsPage.mjs, mount) – hinter einer Sonde für die
// Adresse (helpers/ConversationListProbe.jsx). Breite: Ohne matchMedia gilt
// die Ansicht als schmal; stubWidth(t, true) stellt „Desktop“ nach.
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
  keyboardClick,
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
 * anderes sagt. state.holdMore: Folgeseiten (after) warten auf dieses
 * Promise (Fokus während des Nachladens, K15); state.holdFirst ebenso die
 * ersten Seiten eines Zuschnitts (Liste lädt, rc12 K06/K10). Löschen
 * (DELETE …/conversation) nimmt die Zeile aus dem Bestand; mit
 * state.deleteFails scheitert es.
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
      if (after && state.holdMore) await state.holdMore;
      if (!after && state.holdFirst) await state.holdFirst;
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
    if (call.method === "DELETE" && /\/embed\/\d+\/conversation$/.test(url)) {
      if (state.deleteFails)
        return json({ success: false, error: "kaputt" }, 500);
      state.rows = state.rows.filter(
        (r) => r.first_chat_id !== call.body.chatId
      );
      return json({ success: true, deletedCount: 1 });
    }
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

/** window.matchMedia für eine Breite (Desktop = ab 1.280 px, xl; Fixliste 7.22-rc13 E15). */
function stubWidth(t, wide) {
  const original = globalThis.window.matchMedia;
  globalThis.window.matchMedia = (query) => ({
    matches: query.includes("1280") ? wide : false,
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
    /** extra: etwa { shiftKey: true } (Modifikatortasten, rc12 K01) */
    fire: async (act, key, extra = {}) => {
      const document = globalThis.document;
      const event = {
        key,
        ...extra,
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
  "AK-6: ↑/↓ blättern direkt nach dem Öffnen der Seite (Fokus auf <body>) und im Kopf des Panels – der Fokus bleibt, die gewählte Zeile kommt in der Spalte in Sicht (Scrollposition der Spalte gerechnet, kein scrollIntoView); nicht im Suchfeld, nicht über den Anfang hinaus",
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
    // die gewählte Zeile in der Spalte in Sicht: Die Liste stellt die
    // Scrollposition der Spalte selbst ein (rc11, K11; ohne Maße 0) – kein
    // scrollIntoView, das scrollte die Seite mit
    assert.deepEqual(scrolled, [], "kein scrollIntoView");
    assert.equal(one(container, "data-list-scroll").scrollTop, 0);
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
      hasClasses(one(container, "data-list-scroll"), ["xl:overflow-y-auto"])
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
  "AK-1 / AK-2 (Aufbau) / E15: Bereich mit fester Höhe auf dem Desktop (xl), Kopf in der linken Spalte, Zeilen in einem eigenen Scrollbereich, Verlauf daneben; nichts davon schon ab lg (Tablet); die Seite „Konversationen“ ohne die Obergrenze von 1180 px, „Widgets“ behält sie",
  { skip },
  async (t) => {
    const { WORKSPACE } = await renderer.load("/src/utils/conversationView.js");
    stubWidth(t, true);
    await workspaceServer(t, { rows: [row(1), row(2)] });
    const { container, act } = await mountList(t);
    await act();
    const area = one(container, "data-conversation-area");
    assert.ok(hasClasses(area, WORKSPACE.area.split(" ")), WORKSPACE.area);
    assert.ok(classesOf(area).includes("xl:h-[max(480px,calc(100vh-88px))]"));
    const column = one(container, "data-list-column");
    const header = one(container, "data-list-header");
    const scroller = one(container, "data-list-scroll");
    same(column.parentNode, area);
    same(header.parentNode, column, "Kopf in der linken Spalte");
    same(scroller.parentNode, column);
    assert.ok(hasClasses(header, ["xl:shrink-0"]));
    assert.ok(hasClasses(scroller, WORKSPACE.scroller.split(" ")));
    assert.ok(one(container, "data-conversation-list").parentNode === scroller);
    const panel = panelOf(container);
    same(panel.parentNode, area, "Verlauf neben der Spalte");
    assert.ok(hasClasses(panel, ["xl:relative", ...WORKSPACE.panel.split(" ")]));
    // nichts klebt, nichts hat eine Mindesthöhe der Seite; Arbeitsbereich
    // und Verlauf haben keine lg:-Klassen mehr (das Tablet bekommt das
    // Vollbild, E15)
    for (const element of [area, column, header, scroller, panel])
      assert.ok(
        !classesOf(element).some((name) => name.startsWith("lg:")),
        `${element.tagName}: ${element.getAttribute("class")}`
      );
    for (const element of elements(container))
      for (const name of classesOf(element))
        assert.ok(
          !/^(lg|xl):(sticky|min-h-\[calc)/.test(name),
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

// ---------------------------------------------------------------------------
// Fixliste 7.22-rc11 (Abnahme rc9): K11 Pfeiltasten, K15 Fokus am Listenende
// ---------------------------------------------------------------------------

/**
 * Maße für die Spalte (K11): 300 px hoch ab y 100, Zeilen je 54 px, die
 * erste bei y 100 abzüglich der Scrollposition der Spalte. Alles andere
 * misst 0 (die Seite kennt kein Layout).
 */
function stubColumnLayout(t, container) {
  const ROW = 54;
  const VIEW = 300;
  const TOP = 100;
  const scroller = one(container, "data-list-scroll");
  const prototype = Object.getPrototypeOf(scroller);
  const original = prototype.getBoundingClientRect;
  prototype.getBoundingClientRect = function () {
    if (this === scroller) return { top: TOP, bottom: TOP + VIEW, height: VIEW };
    if (this.hasAttribute("data-conversation-row")) {
      const index = rowsOf(container).indexOf(this);
      const top = TOP + index * ROW - (scroller.scrollTop || 0);
      return { top, bottom: top + ROW, height: ROW };
    }
    return original.call(this);
  };
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: VIEW,
  });
  t.after(() => {
    prototype.getBoundingClientRect = original;
  });
  /** Scrollposition, bei der Zeile index mit 8 px Rand unten steht */
  const bottomOf = (index) => (index + 1) * ROW + 8 - VIEW;
  /** Scrollposition, bei der Zeile index mit 32 px Rand oben steht */
  const topOf = (index) => Math.max(0, index * ROW - 32);
  return { scroller, bottomOf, topOf };
}

test(
  "rc11, K11: ↑/↓ und die Panel-Pfeile halten die gewählte Zeile nur in der Spalte sichtbar – scrollTop der Spalte gerechnet (nearestScrollTop, 32 px Rand oben, 8 px unten), kein scrollIntoView (das scrollte die Seite mit); auch ↑/↓ auf einer Zeile: Fokus ohne Seitenscroll (preventScroll), die Spalte folgt",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const keys = captureWindowKeys(t);
    const scrolled = captureScrolls(t);
    const rows = Array.from({ length: 20 }, (_, i) => row(100 + i));
    await workspaceServer(t, { rows });
    const view = await mountList(t);
    const { container, document, act } = view;
    await act();
    const { scroller, bottomOf, topOf } = stubColumnLayout(t, container);

    // 5× ↓ (Fokus auf <body>): Zeile 6 (Index 5) endet bei 100 + 6 · 54 =
    // 424, unter dem Rand 400 – die Spalte scrollt sie mit 8 px Rand nach
    // unten (6 · 54 + 8 − 300 = 32); vorher (Zeile 5, Unterkante 370)
    // bleibt sie stehen
    for (let i = 0; i < 4; i++) {
      await keys.fire(act, "ArrowDown");
      await act();
    }
    assert.deepEqual(currentRows(container), [104]);
    assert.equal(scroller.scrollTop, 0, "Zeile 5 ist im Bild: nichts bewegt");
    await keys.fire(act, "ArrowDown");
    await act();
    assert.deepEqual(currentRows(container), [105]);
    assert.equal(scroller.scrollTop, bottomOf(5));
    assert.deepEqual(scrolled, [], "kein scrollIntoView");
    same(document.activeElement, document.body, "Fokus bleibt");
    // weiter ↓: die Spalte folgt Zeile für Zeile
    await keys.fire(act, "ArrowDown");
    await act();
    assert.equal(scroller.scrollTop, bottomOf(6));
    // 5× ↑ bis Zeile 2 (Index 1): Sie liegt oben aus dem Bild (Oberkante
    // 100 + 54 − 86 = 68 < 100) – ihr Anfang kommt mit 32 px Rand nach oben
    for (let i = 0; i < 5; i++) {
      await keys.fire(act, "ArrowUp");
      await act();
    }
    assert.deepEqual(currentRows(container), [101]);
    assert.equal(scroller.scrollTop, topOf(1));
    // ↑ zur ersten Zeile: nie unter 0
    await keys.fire(act, "ArrowUp");
    await act();
    assert.deepEqual(currentRows(container), [100]);
    assert.equal(scroller.scrollTop, 0);
    assert.deepEqual(scrolled, []);

    // Panel-Pfeile ▾ (Fokus im Kopf): derselbe Weg – 6× bis Zeile 7
    for (let i = 0; i < 6; i++) {
      await act(() => click(one(container, "data-panel-next")));
      await act();
    }
    assert.deepEqual(currentRows(container), [106]);
    assert.equal(scroller.scrollTop, bottomOf(6));
    same(document.activeElement, one(container, "data-panel-next"));
    // ▴ zurück bis Zeile 1: der Anfang nach oben
    for (let i = 0; i < 6; i++) {
      await act(() => click(one(container, "data-panel-previous")));
      await act();
    }
    assert.deepEqual(currentRows(container), [100]);
    assert.equal(scroller.scrollTop, 0);
    assert.deepEqual(scrolled, []);

    // Fokus auf einer Zeile, ↓ (Handler der Zeile): Die nächste Zeile
    // bekommt den Fokus ohne Scrollen der Seite (preventScroll), die Spalte
    // folgt – 7× von Zeile 1 bis Zeile 8 (Index 7)
    rowsOf(container)[0].focus();
    for (let i = 0; i < 7; i++) {
      await act(() =>
        handlersOf(document.activeElement).onKeyDown({
          key: "ArrowDown",
          preventDefault() {},
        })
      );
      await act();
    }
    same(document.activeElement, rowsOf(container)[7]);
    assert.deepEqual(rowsOf(container)[7].lastFocusOptions, {
      preventScroll: true,
    });
    assert.deepEqual(currentRows(container), [107]);
    assert.equal(scroller.scrollTop, bottomOf(7));
    assert.deepEqual(scrolled, []);
  }
);

test(
  "rc11, K11: Unter lg scrollt die Spalte nicht – ↑/↓ auf einer Zeile fokussieren wie heute (ohne preventScroll, die Seite folgt dem Fokus)",
  { skip },
  async (t) => {
    stubWidth(t, false);
    const scrolled = captureScrolls(t);
    await workspaceServer(t, { rows: [row(1), row(2)] });
    const { container, document, act } = await mountList(t);
    await act();
    rowsOf(container)[0].focus();
    await act(() =>
      handlersOf(rowsOf(container)[0]).onKeyDown({
        key: "ArrowDown",
        preventDefault() {},
      })
    );
    await act();
    same(document.activeElement, rowsOf(container)[1]);
    assert.equal(rowsOf(container)[1].lastFocusOptions, null);
    assert.equal(one(container, "data-list-scroll").scrollTop, undefined);
    assert.deepEqual(scrolled, []);
  }
);

test(
  "rc11, K15: „Weitere laden“ mit Fokus – während des Nachladens nicht gesperrt (aria-disabled statt disabled: der Fokus bleibt, ein zweiter Klick lädt nicht noch einmal); danach steht der Fokus auf der ersten neuen Zeile (ohne Seitenscroll, in der Spalte); verschwindet der Knopf mit der letzten Seite, ebenso; bringt die Seite nichts Neues oder scheitert sie, bleibt er auf dem Knopf",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const observers = stubIntersectionObserver(t);
    const scrolled = captureScrolls(t);
    const state = {
      rows: Array.from({ length: 50 }, (_, i) => row(300 + i)),
    };
    const server = await workspaceServer(t, state);
    const first = await mountList(t);
    const { container, document, act } = first;
    await act();
    assert.equal(rowsOf(container).length, 20);

    // Klick (der Knopf hat damit den Fokus); die Seite wartet
    let release;
    state.holdMore = new Promise((resolve) => (release = resolve));
    const button = one(container, "data-load-more");
    await act(() => click(button));
    await act();
    assert.equal(
      button.hasAttribute("disabled"),
      false,
      "nicht gesperrt (disabled nähme den Fokus an <body>)"
    );
    assert.equal(button.getAttribute("aria-disabled"), "true");
    same(document.activeElement, button, "Fokus bleibt während des Ladens");
    assert.equal(rowsOf(container).length, 20);
    assert.equal(server.lists().length, 2);
    // ein zweiter Klick während des Ladens: keine zweite Anfrage
    await act(() => handlersOf(button).onClick());
    await act();
    assert.equal(server.lists().length, 2);
    // die Seite kommt: Fokus auf der ersten neuen Zeile (21), ohne die
    // Seite zu scrollen, die Spalte stellt sie ein
    await act(() => release());
    for (let i = 0; i < 3; i++) await act();
    assert.equal(rowsOf(container).length, 40);
    same(document.activeElement, rowsOf(container)[20], "erste neue Zeile");
    assert.deepEqual(rowsOf(container)[20].lastFocusOptions, {
      preventScroll: true,
    });
    assert.deepEqual(scrolled, []);
    assert.equal(
      one(container, "data-load-more").getAttribute("aria-disabled"),
      null
    );

    // Von selbst am Spaltenende (Tab auf den Knopf, das Ende in Sicht): die
    // letzte Seite – der Knopf verschwindet, der Fokus geht auf die erste
    // neue Zeile (41) statt ins Leere
    const again = one(container, "data-load-more");
    again.focus();
    state.holdMore = new Promise((resolve) => (release = resolve));
    await observers.reach(act, observers.active());
    await act();
    same(document.activeElement, again);
    assert.equal(again.hasAttribute("disabled"), false);
    await act(() => release());
    for (let i = 0; i < 3; i++) await act();
    assert.equal(rowsOf(container).length, 50);
    assert.equal(withAttribute(container, "data-load-more").length, 0);
    same(document.activeElement, rowsOf(container)[40]);
    assert.deepEqual(scrolled, []);
    await first.unmount();

    // Nichts Neues (Bestand verschoben: nur Doppelte) – der Fokus bleibt
    // auf dem Knopf
    state.rows = Array.from({ length: 60 }, (_, i) => row(500 + i));
    state.holdMore = null;
    state.overlap = 20;
    const second = await mountList(t);
    await second.act();
    assert.equal(rowsOf(second.container).length, 20);
    const button2 = one(second.container, "data-load-more");
    await second.act(() => click(button2));
    for (let i = 0; i < 3; i++) await second.act();
    assert.equal(rowsOf(second.container).length, 20);
    same(one(second.container, "data-load-more"), button2, "Knopf bleibt");
    same(second.document.activeElement, button2, "Fokus bleibt auf dem Knopf");
    // Nachladen scheitert – ebenso („Erneut versuchen“ hat den Fokus)
    state.overlap = 0;
    state.failList = (body) => !!body.after;
    await second.act(() => click(button2));
    for (let i = 0; i < 3; i++) await second.act();
    assert.equal(withAttribute(second.container, "data-load-more-error").length, 1);
    same(second.document.activeElement, one(second.container, "data-load-more"));
    assert.equal(one(second.container, "data-load-more").hasAttribute("disabled"), false);
  }
);

test(
  "rc11, K15: Ohne Fokus auf dem Knopf (Nachladen von selbst, Fokus auf <body> oder im Suchfeld) ändert das Nachladen den Fokus nicht",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const observers = stubIntersectionObserver(t);
    await workspaceServer(t, {
      rows: Array.from({ length: 60 }, (_, i) => row(700 + i)),
    });
    const { container, document, act } = await mountList(t);
    await act();
    same(document.activeElement, document.body);
    await observers.reach(act, observers.active());
    for (let i = 0; i < 3; i++) await act();
    assert.equal(rowsOf(container).length, 40);
    same(document.activeElement, document.body, "Fokus bleibt auf <body>");
    const input = one(container, "data-search-input");
    input.focus();
    await act(() => click(one(container, "data-load-more")));
    for (let i = 0; i < 3; i++) await act();
    assert.equal(rowsOf(container).length, 60);
    // click() setzt den Fokus auf den Knopf (wie der Browser) – danach
    // steht er auf der ersten neuen Zeile; das Suchfeld war vorher nicht mehr
    // fokussiert, nichts zieht ihn aus einem Feld
    same(document.activeElement, rowsOf(container)[40]);
  }
);

// ---------------------------------------------------------------------------
// Fixliste 7.22-rc13 (Nachreview rc12): K01 bis K13, E15 Geräteklassen
// ---------------------------------------------------------------------------

/**
 * window.matchMedia wie im Browser für eine Fensterbreite: Eine Abfrage
 * „(min-width: N px)“ trifft zu, wenn N höchstens so breit ist (E15).
 */
function stubViewport(t, width) {
  const original = globalThis.window.matchMedia;
  globalThis.window.matchMedia = (query) => ({
    matches:
      Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity) <= width,
    addEventListener() {},
    removeEventListener() {},
  });
  t.after(() => {
    globalThis.window.matchMedia = original;
  });
}

/**
 * Mausklick in nicht fokussierbaren Inhalt: Der Browser setzt den Fokus auf
 * den nächsten fokussierbaren Vorfahren (tabindex, Schaltfläche) – gibt es
 * keinen, bleibt er auf <body>.
 */
function clickInto(element) {
  const document = element.ownerDocument;
  for (let node = element; node && node !== document.body; node = node.parentNode)
    if (node.hasAttribute?.("tabindex") || node.tagName === "BUTTON") {
      node.focus();
      return node;
    }
  document.activeElement?.blur?.();
  return null;
}

/** Ein Promise mit Auslöser (für state.holdMore / state.holdFirst). */
function gate() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

/** Einige Durchläufe, bis Anfragen und Effekte zur Ruhe kommen. */
async function settle(act, rounds = 4) {
  for (let i = 0; i < rounds; i++) await act();
}

test(
  "rc13, E15: Tablet (1.024 px) wie bisher unter lg – keine Vorwahl, kein Platzhalter, kein Verlauf geladen; ein Klick öffnet das Vollbild (Dialog, neuer Eintrag), Escape schließt; ab 1.280 px (Desktop) der Arbeitsbereich mit Vorwahl",
  { skip },
  async (t) => {
    const keys = captureWindowKeys(t);
    const server = await workspaceServer(t, { rows: [row(1), row(2)] });

    stubViewport(t, 1024);
    const tablet = await mountList(t);
    await tablet.act();
    assert.equal(panelOf(tablet.container), null, "kein Verlauf von selbst");
    assert.equal(emptyPanelOf(tablet.container), null);
    assert.deepEqual(server.details(), []);
    await tablet.act(() => click(rowsOf(tablet.container)[1]));
    await tablet.act();
    assert.equal(panelOf(tablet.container).getAttribute("role"), "dialog");
    assert.equal(panelOf(tablet.container).getAttribute("aria-modal"), "true");
    assert.equal(tablet.navigationType(), "PUSH");
    await keys.fire(tablet.act, "Escape");
    await tablet.act();
    assert.equal(panelOf(tablet.container), null, "Escape schließt");
    await tablet.unmount();

    stubViewport(t, 1280);
    const desktop = await mountList(t);
    await desktop.act();
    assert.ok(panelOf(desktop.container), "Desktop: Verlauf offen");
    assert.equal(panelOf(desktop.container).hasAttribute("role"), false);
    assert.deepEqual(currentRows(desktop.container), [1]);
  }
);

test(
  "rc12, K01: Klick in den Text des Verlaufs, dann ↓ – der Verlauf hat den Fokus (tabIndex 0) und scrollt, die Konversation bleibt; mit Umschalt-, Alt-, Strg- oder Befehlstaste wechselt ↓ auch bei Fokus auf <body> nicht",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const keys = captureWindowKeys(t);
    const server = await workspaceServer(t, { rows: [row(1), row(2), row(3)] });
    const view = await mountList(t);
    const { container, document, act } = view;
    await act();
    assert.deepEqual(currentRows(container), [1]);
    const body = one(container, "data-panel-body");
    assert.equal(body.getAttribute("tabindex"), "0", "Verlauf fokussierbar");

    // Klick in die Frage (nicht fokussierbar): Fokus auf den Verlauf
    const focused = clickInto(one(body, "data-question"));
    same(focused, body);
    same(document.activeElement, body);
    const down = await keys.fire(act, "ArrowDown");
    await act();
    assert.equal(down.defaultPrevented, false, "↓ gehört dem Verlauf");
    assert.deepEqual(currentRows(container), [1]);
    assert.equal(view.search(), "");

    // Fokus auf <body>, aber mit Modifikatortaste: nichts
    document.activeElement = document.body;
    for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) {
      const event = await keys.fire(act, "ArrowDown", { [modifier]: true });
      await act();
      assert.equal(event.defaultPrevented, false, modifier);
      assert.deepEqual(currentRows(container), [1], modifier);
    }
    // ohne: blättert wie bisher (AK-6)
    await keys.fire(act, "ArrowDown");
    await act();
    assert.deepEqual(currentRows(container), [2]);
    assert.deepEqual(server.details(), [1, 2]);
  }
);

test(
  "rc12, K05: Bei offener Lösch-Rückfrage wechselt ↓ die Konversation nicht – auch wenn ihr Fokus auf <body> gefallen ist",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const keys = captureWindowKeys(t);
    await workspaceServer(t, { rows: [row(1), row(2)] });
    const view = await mountList(t);
    const { container, document, act } = view;
    await settle(act);
    await act(() => click(one(container, "data-delete-conversation")));
    await settle(act);
    const dialog = elements(document.body, (e) =>
      e.hasAttribute("data-confirm-dialog")
    )[0];
    assert.ok(dialog, "Rückfrage offen");
    // Klick auf den Text der Rückfrage: Fokus auf <body>
    document.activeElement = document.body;
    const event = await keys.fire(act, "ArrowDown");
    await act();
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(currentRows(container), [1]);
    assert.ok(
      elements(document.body, (e) => e.hasAttribute("data-confirm-dialog"))[0],
      "die Rückfrage bleibt"
    );
  }
);

test(
  "rc12, K02 (a): Filterwechsel mit einer nachgeladenen Konversation (Zeile 45) – die Liste sucht sie in der neuen Liste wie beim Link, sie bleibt gewählt und in der Adresse, ihr Verlauf wird nicht neu geladen",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const rows = Array.from({ length: 60 }, (_, i) => row(100 + i));
    const server = await workspaceServer(t, { rows });
    const view = await mountList(t);
    const { container, act } = view;
    await act();
    for (let i = 0; i < 2; i++) {
      await act(() => click(one(container, "data-load-more")));
      await settle(act, 3);
    }
    assert.equal(rowsOf(container).length, 60);
    await act(() => click(rowsOf(container)[44]));
    await act();
    assert.deepEqual(currentRows(container), [144]);
    assert.equal(view.search(), "?widget=3&conversation=144");

    // Suche „Frage“: alle 60 passen, die erste Seite hat 20 – 144 steht auf
    // Position 45
    await type(view, "Frage");
    await act(() => wait(350));
    await settle(act, 6);
    assert.ok(rowsOf(container).length >= 45, `${rowsOf(container).length}`);
    assert.deepEqual(currentRows(container), [144]);
    assert.equal(view.search(), "?widget=3&conversation=144&q=Frage");
    assert.deepEqual(server.details(), [100, 144], "kein Neuladen des Verlaufs");
  }
);

test(
  "rc12, K02 (b): Ohne Wechsel des Zuschnitts fällt die Konversation nie aus der Adresse – auch nicht, während die Liste nach einem gescheiterten Löschen neu lädt (erst 100 Zeilen, dann der Rest)",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const state = {
      rows: Array.from({ length: 160 }, (_, i) => row(100 + i)),
      deleteFails: true,
    };
    await workspaceServer(t, state);
    const view = await mountList(t);
    const { container, act } = view;
    await act();
    for (let i = 0; i < 6; i++) {
      await act(() => click(one(container, "data-load-more")));
      await settle(act, 3);
    }
    assert.equal(rowsOf(container).length, 140);
    await act(() => click(rowsOf(container)[129]));
    await settle(act);
    assert.equal(view.search(), "?widget=3&conversation=229");
    await act(() => click(one(container, "data-delete-conversation")));
    await settle(act);
    const confirm = elements(view.document.body, (e) =>
      e.hasAttribute("data-confirm-delete")
    )[0];
    await act(() => click(confirm));
    await settle(act, 8);
    assert.equal(rowsOf(container).length, 140, "aufgefüllt");
    assert.equal(view.search(), "?widget=3&conversation=229");
    assert.deepEqual(currentRows(container), [229]);
  }
);

test(
  "rc12, K03: „Weitere laden“ geklickt, danach ins Suchfeld – nach dem Nachladen bleibt der Fokus im Suchfeld",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const state = { rows: Array.from({ length: 60 }, (_, i) => row(300 + i)) };
    await workspaceServer(t, state);
    const { container, document, act } = await mountList(t);
    await act();
    const hold = gate();
    state.holdMore = hold.promise;
    await act(() => click(one(container, "data-load-more")));
    await act();
    const input = one(container, "data-search-input");
    input.focus();
    await act(() => hold.release());
    await settle(act, 3);
    assert.equal(rowsOf(container).length, 40);
    same(document.activeElement, input, "Fokus bleibt im Suchfeld");
  }
);

test(
  "rc12, K09: Tab auf „Weitere laden“, das Spaltenende kommt in Sicht und die Liste lädt von selbst – der Fokus bleibt auf dem Knopf (keine Bewegung ohne Aktivierung), solange es ihn gibt",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const observers = stubIntersectionObserver(t);
    const state = { rows: Array.from({ length: 80 }, (_, i) => row(300 + i)) };
    await workspaceServer(t, state);
    const { container, document, act } = await mountList(t);
    await act();
    const button = one(container, "data-load-more");
    button.focus();
    const hold = gate();
    state.holdMore = hold.promise;
    await observers.reach(act, observers.active());
    await act();
    await act(() => hold.release());
    await settle(act, 3);
    assert.equal(rowsOf(container).length, 40);
    same(one(container, "data-load-more"), button, "Knopf bleibt");
    same(document.activeElement, button, "Fokus bleibt auf dem Knopf");
  }
);

test(
  "rc12, K08: Link-Suche über mehrere Seiten, Fokus auf „Weitere laden“ – verschwindet der Knopf mit der letzten Seite, steht der Fokus auf deren erster Zeile statt im Leeren",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const hold = gate();
    const state = {
      rows: Array.from({ length: 220 }, (_, i) => row(300 + i)),
      holdMore: hold.promise,
    };
    await workspaceServer(t, state);
    const { container, document, act } = await mountList(t, {
      query: "?widget=3&conversation=510",
    });
    await settle(act, 3);
    assert.equal(rowsOf(container).length, 20, "die Link-Suche wartet");
    one(container, "data-load-more").focus();
    await act(() => hold.release());
    await settle(act, 8);
    assert.equal(rowsOf(container).length, 220);
    assert.deepEqual(currentRows(container), [510]);
    assert.equal(withAttribute(container, "data-load-more").length, 0);
    same(document.activeElement, rowsOf(container)[120], "erste Zeile der letzten Seite");
  }
);

test(
  "rc12, K10: Wechsel der Suche bei Vorwahl – die vorgewählte Konversation bleibt während des Ladens gewählt (kein Platzhalter, kein Neuladen des Verlaufs) und danach, solange sie in der Liste steht, auch wenn die neue Liste mit einer anderen beginnt",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const state = { rows: [row(1), row(2), row(3)] };
    const server = await workspaceServer(t, state);
    const view = await mountList(t);
    const { container, act } = view;
    await act();
    assert.deepEqual(currentRows(container), [1]);
    // Inzwischen kam eine neue Konversation dazu (steht vorn)
    state.rows = [row(0), row(1), row(2), row(3)];
    const hold = gate();
    state.holdFirst = hold.promise;
    await type(view, "Frage");
    await act(() => wait(350));
    await act();
    // die Liste lädt: Verlauf bleibt (keine Lücke, kein Platzhalter)
    assert.ok(panelOf(container), "Verlauf bleibt während des Ladens");
    assert.equal(emptyPanelOf(container), null);
    await act(() => hold.release());
    await settle(act);
    assert.deepEqual(rowIds(container), [0, 1, 2, 3]);
    assert.deepEqual(currentRows(container), [1], "die Wahl bleibt");
    assert.deepEqual(server.details(), [1], "kein Neuladen des Verlaufs");
    assert.equal(server.previews(), 1);
    assert.equal(view.search(), "?q=Frage");
    // fällt sie heraus: die erste Zeile der neuen Liste
    await type(view, "Frage 3");
    await act(() => wait(350));
    await settle(act);
    assert.deepEqual(rowIds(container), [3]);
    assert.deepEqual(currentRows(container), [3]);
  }
);

test(
  "rc12, K06: Vorgewählte Konversation gelöscht – bis die neue Liste da ist, ist sie nicht wieder gewählt; der Verlauf zeigt gleich die nächste und lädt die gelöschte nicht neu",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const state = { rows: [row(1), row(2), row(3)] };
    const server = await workspaceServer(t, state);
    const view = await mountList(t);
    const { container, act, document } = view;
    await settle(act);
    assert.deepEqual(currentRows(container), [1]);
    await act(() => click(one(container, "data-delete-conversation")));
    await settle(act);
    const hold = gate();
    state.holdFirst = hold.promise;
    const confirm = elements(document.body, (e) =>
      e.hasAttribute("data-confirm-delete")
    )[0];
    await act(() => click(confirm));
    await settle(act);
    // Die alte Liste steht noch (1 darin), gewählt ist 2
    assert.deepEqual(rowIds(container), [1, 2, 3]);
    assert.deepEqual(currentRows(container), [2]);
    assert.match(panelOf(container).textContent, /Frage 2/);
    await act(() => hold.release());
    await settle(act);
    assert.deepEqual(rowIds(container), [2, 3]);
    assert.deepEqual(currentRows(container), [2]);
    assert.deepEqual(server.details(), [1, 2]);
    assert.equal(view.search(), "");
  }
);

test(
  "rc12, K07: Gemerkt „geschlossen“, per Link geöffnet, dann fällt die Konversation durch die Suche heraus – der Verlauf bleibt für diese Sitzung offen: die erste Zeile ist vorgewählt bzw. der Platzhalter zu sehen; ✕ schließt ihn wieder",
  { skip },
  async (t) => {
    stubWidth(t, true);
    await workspaceServer(t, {
      rows: [
        row(1, { preview: "Yoga am Abend" }),
        row(2, { preview: "Spanisch A1" }),
        row(7, { preview: "Töpfern" }),
      ],
    });
    const view = await mountList(t, {
      query: "?widget=3&conversation=7",
      stored: { [PANEL_KEY]: "closed" },
    });
    const { container, act } = view;
    await settle(act);
    assert.deepEqual(currentRows(container), [7]);
    await type(view, "Spanisch");
    await act(() => wait(350));
    await settle(act);
    assert.equal(view.search(), "?widget=3&q=Spanisch");
    assert.deepEqual(currentRows(container), [2], "erste Zeile vorgewählt");
    assert.ok(panelOf(container));
    assert.equal(stored(), "closed", "das Gemerkte bleibt");
    await type(view, "Gibt es nicht");
    await act(() => wait(350));
    await settle(act);
    assert.ok(emptyPanelOf(container), "Platzhalter");
    await act(() => click(one(container, "data-empty-panel-close")));
    await act();
    assert.equal(emptyPanelOf(container), null);
    assert.equal(panelOf(container), null);
  }
);

test(
  "rc12, K12 / K13: „Weitere laden“ ohne Hover-Ton im gesperrten Zustand auch im hellen Theme; der Beobachtungsanker steht nur auf dem Desktop und außerhalb der umbrechenden Leiste (keine 8 px mehr)",
  { skip },
  async (t) => {
    const rows = Array.from({ length: 40 }, (_, i) => row(100 + i));
    await workspaceServer(t, { rows });

    stubWidth(t, false);
    const narrow = await mountList(t);
    await narrow.act();
    const button = one(narrow.container, "data-load-more");
    assert.ok(
      hasClasses(button, [
        "aria-disabled:hover:bg-transparent",
        "light:aria-disabled:hover:bg-transparent",
      ])
    );
    assert.equal(
      withAttribute(narrow.container, "data-list-end").length,
      0,
      "kein Anker unter xl"
    );
    await narrow.unmount();

    stubWidth(t, true);
    const wide = await mountList(t);
    await wide.act();
    const end = one(wide.container, "data-list-end");
    const bar = one(wide.container, "data-load-more").parentNode;
    assert.ok(end.parentNode !== bar, "nicht in der Leiste");
    assert.ok(
      end.parentNode === one(wide.container, "data-conversation-list"),
      "am Ende der Zeilen"
    );
    assert.equal(end.getAttribute("class"), null, "ohne Maße");
  }
);

test(
  "rc13, E15: Steht der Verlauf daneben (Desktop, Liste 44 %), hat der Kopf der Liste die kompakte Form – Werkzeugleiste in eigener Zeile ohne Abstand zum Benutzermenü, kurze Filternamen, „Exportieren“ ohne Pfeil; mit geschlossenem Verlauf die volle Form",
  { skip },
  async (t) => {
    stubWidth(t, true);
    await workspaceServer(t, { rows: [row(1), row(2)] });
    const { container, act } = await mountList(t);
    await act();
    assert.ok(panelOf(container), "Verlauf daneben");
    const wideClasses = [
      "xl:grow",
      "xl:basis-auto",
      "sm:pr-11",
      "xl:w-60",
      "xl:flex-auto",
      "xl:grow-[999]",
      "xl:px-3",
      "xl:px-3.5",
      "xl:block",
      "xl:hidden",
      "hidden xl:inline-flex",
    ];
    const header = one(container, "data-list-header");
    const used = () =>
      elements(header).flatMap((element) => classesOf(element));
    for (const name of wideClasses.filter((n) => !n.includes(" ")))
      assert.ok(!used().includes(name), `kompakt ohne ${name}`);
    const labels = withAttribute(header, "data-stable-label").map((e) =>
      e.getAttribute("data-stable-label")
    );
    assert.ok(labels.includes("Positiv"), labels.join(", "));
    assert.ok(!labels.includes("Positiv bewertet"), labels.join(", "));

    // ✕: Die Liste hat die volle Breite – die volle Form
    await act(() => click(one(container, "data-panel-close")));
    await act();
    assert.equal(panelOf(container), null);
    for (const name of ["xl:grow", "xl:basis-auto", "sm:pr-11", "xl:w-60", "xl:grow-[999]", "xl:block"])
      assert.ok(used().includes(name), `voll mit ${name}`);
    const fullLabels = withAttribute(header, "data-stable-label").map((e) =>
      e.getAttribute("data-stable-label")
    );
    assert.ok(fullLabels.includes("Positiv bewertet"), fullLabels.join(", "));
  }
);

test(
  "rc12, K09 / K15: Tab auf „Weitere laden“ (Fokus bleibt nach dem Nachladen von selbst dort), danach ein Mausklick darauf – zählt als Zeiger: der Fokus bleibt auf dem Knopf; Enter darauf (click ohne detail) wie bisher auf die erste neue Zeile",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const state = { rows: Array.from({ length: 80 }, (_, i) => row(300 + i)) };
    await workspaceServer(t, state);
    const { container, document, act } = await mountList(t);
    await act();
    const button = one(container, "data-load-more");
    button.focus();
    // Mausklick: detail 1
    await act(() => handlersOf(button).onClick({ detail: 1 }));
    await settle(act, 3);
    assert.equal(rowsOf(container).length, 40);
    same(document.activeElement, button, "Zeiger: Fokus bleibt auf dem Knopf");
    // Enter: click mit detail 0
    await act(() => handlersOf(button).onClick({ detail: 0 }));
    await settle(act, 3);
    assert.equal(rowsOf(container).length, 60);
    same(document.activeElement, rowsOf(container)[40], "Tastatur: erste neue Zeile");
  }
);

// ---------------------------------------------------------------------------
// Fixliste 7.22-rc14 (Nutzer 21.10.: Weg zurück nach oben)
// ---------------------------------------------------------------------------

const ANALYTICS_VIEW = `${DIR}/index.jsx`;

/**
 * Hängt die ganze Ansicht ein (Kopfzeile, Kennzahlen, Diagramme, Liste mit
 * Verlauf) – mit einem Widget.
 */
async function mountView(t, { stored = {} } = {}) {
  const mounted = await renderer.mount(ANALYTICS_VIEW, {
    location: LOCATION,
    route: LOCATION,
    exportName: "AnalyticsScreen",
    props: {
      embedsLoaded: true,
      embeds: [
        { id: EMBED_ID, chat_retention_days: null, workspace: { name: "VHS" } },
      ],
    },
    stored,
  });
  const { document } = mounted;
  if (!document.getElementById("root")) {
    const root = document.createElement("div");
    root.setAttribute("id", "root");
    document.body.appendChild(root);
  }
  if (!document.body.contains(document.activeElement))
    document.activeElement = document.body;
  t.after(() => mounted.unmount());
  await settle(mounted.act);
  return mounted;
}

test(
  "rc14, K20: Liste und Verlauf geben den Bildlauf am Rand an die Seite weiter – die Spalte der Liste ohne overscroll, der Verlauf auf dem Desktop overscroll-auto (xl:overscroll-auto); als Vollbild auf Tablet und Smartphone hält er ihn wie bisher (overscroll-contain)",
  { skip },
  async (t) => {
    stubWidth(t, true);
    await workspaceServer(t, { rows: [row(1), row(2)] });
    const { container, act } = await mountList(t);
    await act();
    const scroller = one(container, "data-list-scroll");
    assert.ok(
      !classesOf(scroller).some((name) => name.includes("overscroll")),
      scroller.getAttribute("class")
    );
    assert.ok(hasClasses(scroller, ["xl:overflow-y-auto"]));
    const body = one(container, "data-panel-body");
    assert.ok(
      hasClasses(body, ["overflow-y-auto", "overscroll-contain", "xl:overscroll-auto"]),
      body.getAttribute("class")
    );
    // nichts anderes im Arbeitsbereich hält den Bildlauf auf dem Desktop
    for (const element of elements(one(container, "data-conversation-area")))
      for (const name of classesOf(element))
        assert.ok(
          !/^xl:overscroll-(contain|none)$/.test(name),
          `${element.tagName}: ${name}`
        );
  }
);

/** Das Element davor unter demselben Elternelement (oder null). */
const previousOf = (node) => {
  const siblings = node.parentNode?.childNodes ?? [];
  return siblings[siblings.indexOf(node) - 1] ?? null;
};

/** Sprungziel „Übersicht“: der Anfang der Ansicht (genau ein Element). */
function overviewTargetOf(container, className) {
  const found = elements(container, (element) =>
    classesOf(element).includes(className)
  );
  assert.equal(found.length, 1, `ein Element mit ${className}`);
  return found[0];
}

test(
  "rc14, K21: Button „Zur Übersicht ↑“ im Kopf der Konversationen, nur auf dem Desktop (hidden xl:inline-flex), Fokusring der Seite – kompakt (Verlauf daneben) rechts in der Zeile der Überschrift, in voller Form (Verlauf zu) rechts neben den Steuerelementen (nach „Exportieren“); der Klick springt weich an den Anfang der Ansicht (Zeitraum, Kennzahlen) und setzt den Fokus ohne zweites Scrollen auf ihre Überschrift (tabIndex −1); nichts wird neu geladen, die Konversation bleibt; die Liste allein (ohne Sprungziel) zeigt ihn nicht",
  { skip },
  async (t) => {
    const { FOCUS_RING, OVERVIEW_TARGET } = await renderer.load(
      "/src/utils/conversationView.js"
    );
    stubWidth(t, true);
    const server = await workspaceServer(t, { rows: [row(1), row(2)] });
    const view = await mountView(t);
    const { container, document, act } = view;
    assert.ok(panelOf(container), "Verlauf daneben (Vorwahl)");

    const header = one(container, "data-list-header");
    const button = one(container, "data-jump-to-overview");
    assert.ok(header.contains(button), "im Kopf der Konversationen");
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.getAttribute("type"), "button");
    assert.equal(button.textContent, "Zur Übersicht ↑");
    const arrow = button.lastChild;
    assert.equal(arrow.textContent.trim(), "↑");
    assert.equal(arrow.getAttribute("aria-hidden"), "true");
    // kompakt (Verlauf daneben): in der Zeile der Überschrift rechts neben
    // dem Titelblock (gleiche Reihenfolge order-1), vor der Werkzeugleiste
    // in eigener Zeile – die ist voll
    const title = one(container, "data-list-title");
    same(button.parentNode, title.parentNode, "in der Zeile der Überschrift");
    same(previousOf(button), title, "rechts neben dem Titelblock");
    same(button.nextSibling, one(container, "data-list-tools"));
    assert.ok(hasClasses(button, ["order-1"]));
    assert.ok(hasClasses(title, ["order-1", "flex-1"]));
    // nur auf dem Desktop, Fokusring wie die übrigen Buttons der Ansicht
    assert.ok(hasClasses(button, ["hidden", "xl:inline-flex"]));
    assert.ok(hasClasses(button, FOCUS_RING.split(" ")), button.getAttribute("class"));

    // Überschrift der Ansicht: per Programm fokussierbar
    const heading = one(container, "data-overview-heading");
    assert.equal(heading.tagName, "H2");
    assert.equal(heading.textContent, "Konversationen");
    assert.equal(heading.getAttribute("tabindex"), "-1");
    const target = overviewTargetOf(container, OVERVIEW_TARGET);
    assert.ok(target.contains(heading), "das Ziel enthält die Kopfzeile");
    assert.ok(target.contains(header), "und die Konversationen");

    const scrolls = captureScrolls(t);
    const current = currentRows(container);
    const before = server.calls.length;
    await act(() => click(button));
    await act();
    assert.equal(scrolls.length, 1, "genau ein Sprung");
    same(scrolls[0][0], target, "an den Anfang der Ansicht");
    assert.deepEqual(scrolls[0][1], { behavior: "smooth", block: "start" });
    same(document.activeElement, heading, "Fokus auf der Überschrift");
    // per Maus ohne Fokusring (rc15, K31)
    assert.deepEqual(heading.lastFocusOptions, {
      preventScroll: true,
      focusVisible: false,
    });
    assert.equal(server.calls.length, before, "nichts neu geladen");
    assert.deepEqual(currentRows(container), current);
    assert.ok(panelOf(container), "der Verlauf bleibt offen");

    // ✕: Kopf in voller Form – rechts neben den Steuerelementen, nach Suche,
    // Filtern und „Exportieren“
    await act(() => click(one(container, "data-panel-close")));
    await act();
    assert.equal(panelOf(container), null);
    const full = one(container, "data-jump-to-overview");
    same(full.parentNode, one(container, "data-list-tools"));
    same(previousOf(full), one(container, "data-list-actions"));
    const order = elements(one(container, "data-list-header"));
    const exportButton = one(container, "data-export-menu").firstChild;
    assert.ok(order.indexOf(full) > order.indexOf(exportButton), "nach „Exportieren“");
    assert.ok(hasClasses(full, ["hidden", "xl:inline-flex"]));
    assert.ok(!classesOf(full).includes("order-1"));
    assert.ok(hasClasses(full, FOCUS_RING.split(" ")));
    await view.unmount();

    // Die Liste allein (ohne Sprungziel der Ansicht): kein Button
    const list = await mountList(t);
    await list.act();
    assert.equal(withAttribute(list.container, "data-jump-to-overview").length, 0);
  }
);

test(
  "rc14, K21: Bei „reduzierte Bewegung“ springt „Zur Übersicht“ ohne Animation (behavior auto)",
  { skip },
  async (t) => {
    const { OVERVIEW_TARGET } = await renderer.load(
      "/src/utils/conversationView.js"
    );
    const original = globalThis.window.matchMedia;
    globalThis.window.matchMedia = (query) => ({
      matches: query.includes("1280") || query.includes("reduce"),
      addEventListener() {},
      removeEventListener() {},
    });
    t.after(() => {
      globalThis.window.matchMedia = original;
    });
    await workspaceServer(t, { rows: [row(1), row(2)] });
    const { container, document, act } = await mountView(t);
    const scrolls = captureScrolls(t);
    await act(() => click(one(container, "data-jump-to-overview")));
    await act();
    assert.equal(scrolls.length, 1);
    same(scrolls[0][0], overviewTargetOf(container, OVERVIEW_TARGET));
    assert.deepEqual(scrolls[0][1], { behavior: "auto", block: "start" });
    same(document.activeElement, one(container, "data-overview-heading"));
  }
);

test(
  "rc15, K31: „Zur Übersicht“ per Enter oder Leertaste: Die Überschrift „Konversationen“ bekommt den Fokus mit sichtbarem Ring (Merker data-keyboard-focus, focusVisible: true); per Maus ohne Ring; der Merker fällt mit dem Fokus weg, ein Mausklick danach zeigt keinen Ring",
  { skip },
  async (t) => {
    const { HEADING_FOCUS_RING, KEYBOARD_FOCUS_ATTRIBUTE, OVERVIEW_TARGET } =
      await renderer.load("/src/utils/conversationView.js");
    assert.equal(KEYBOARD_FOCUS_ATTRIBUTE, "data-keyboard-focus");
    stubWidth(t, true);
    await workspaceServer(t, { rows: [row(1), row(2)] });
    const { container, document, act } = await mountView(t);
    const heading = one(container, "data-overview-heading");
    assert.equal(heading.textContent, "Konversationen");
    // Ring der Überschrift: nur mit dem Merker, sonst keiner
    assert.ok(
      hasClasses(heading, HEADING_FOCUS_RING.split(" ")),
      heading.getAttribute("class")
    );
    const target = overviewTargetOf(container, OVERVIEW_TARGET);
    const button = one(container, "data-jump-to-overview");

    for (const key of ["Enter", " "]) {
      const scrolls = captureScrolls(t);
      await act(() => keyboardClick(button, key));
      await act();
      assert.equal(scrolls.length, 1, `${JSON.stringify(key)}: ein Sprung`);
      same(scrolls[0][0], target);
      same(document.activeElement, heading, "Fokus auf der Überschrift");
      assert.equal(
        heading.getAttribute("data-keyboard-focus"),
        "",
        `${JSON.stringify(key)}: Ring nach Tastatur`
      );
      assert.deepEqual(heading.lastFocusOptions, {
        preventScroll: true,
        focusVisible: true,
      });
      // Tab weiter (der Fokus geht woandershin): der Merker fällt weg
      await act(() => button.focus());
      assert.equal(heading.hasAttribute("data-keyboard-focus"), false);
    }

    // per Maus: kein Ring
    await act(() => click(button));
    await act();
    same(document.activeElement, heading);
    assert.equal(heading.hasAttribute("data-keyboard-focus"), false);
    assert.deepEqual(heading.lastFocusOptions, {
      preventScroll: true,
      focusVisible: false,
    });

    // Tastatur, danach ein Mausklick auf die Überschrift selbst (sie hat den
    // Fokus schon): Der Ring bleibt, bis der Fokus geht; nach dem Wegklicken
    // und erneutem Mausklick auf die Überschrift keiner
    await act(() => keyboardClick(button));
    await act();
    assert.equal(heading.getAttribute("data-keyboard-focus"), "");
    await act(() => heading.blur());
    assert.equal(heading.hasAttribute("data-keyboard-focus"), false);
    same(document.activeElement, document.body);
    await act(() => click(heading));
    same(document.activeElement, heading);
    assert.equal(heading.hasAttribute("data-keyboard-focus"), false);
  }
);

test(
  "rc14, K21: Sprachdateien – „Zur Übersicht“ (de) und „To overview“ (en), in den übrigen Sprachen null; keine Gedankenstriche",
  { skip },
  async () => {
    const { resources } = await renderer.load("/src/locales/resources.js");
    const text = (lang) =>
      resources[lang].common["embed-analytics"].list["to-overview"];
    assert.equal(text("de"), "Zur Übersicht");
    assert.equal(text("en"), "To overview");
    for (const lang of Object.keys(resources))
      if (lang !== "de" && lang !== "en") assert.equal(text(lang), null, lang);
    for (const lang of ["de", "en"]) assert.ok(!/[–—]/.test(text(lang)));
  }
);
