// Konversationen-Ansicht: kompakte Liste, Seitenpanel, Suche und eigene
// Adresse je Konversation. Die Liste ist mit React DOM in ein Dokument ohne
// Browser eingehängt (helpers/renderSettingsPage.mjs, mount) – unter einer
// Adresse mit ?q=…&conversation=…; Eingaben werden über die Handler der
// Elemente nachgestellt (helpers/testDom.mjs).
//
// Layout (Breite, Scrollen, Sticky-Kopf), Themes, Escape, Zurück-Knopf und
// das Kopieren in die echte Zwischenablage bleiben Sache des Browser-Tests.
// Antworten bleiben hier leer: Ihre Darstellung (MarkdownRenderer) braucht
// DOMPurify und damit einen Browser.
import test, { after, before } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements, handlersOf, pressKey } from "./helpers/testDom.mjs";
import { fixClock } from "./helpers/fixedClock.mjs";
import requests from "../../server/__tests__/endpoints/support/embedAnalyticsRequests.js";

const { ROUTES, conversationsBody, exportBody } = requests;

// file-saver übernimmt beim Laden ein vorhandenes globales saveAs: So ist zu
// sehen, was die Ansicht speichern würde.
const saved = [];
globalThis.saveAs = (blob, filename) => saved.push({ blob, filename });

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const LIST = `${DIR}/ConversationList.jsx`;
const VIEW = `${DIR}/index.jsx`;
const LOCATION = "/settings/chatbot/conversations";
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
const PERIOD = {
  startDate: "2026-09-12T22:00:00.000Z",
  endDate: "2026-10-13T21:59:59.999Z",
};
const TODAY = "2026-10-13T10:00:00Z";

/** Zeitpunkt zu einer Berliner Wanduhrzeit (Oktober 2026: UTC+2). */
const berlin = (day, time) => Date.parse(`${day}T${time}:00+02:00`);

/** Eine Zeile der Liste, wie der Server sie liefert. */
function row(id, extra = {}) {
  return {
    conversation_id: `konv-${id}`,
    session_id: `sitzung-${id}`,
    embed_id: EMBED_ID,
    first_chat_id: id,
    started_at: berlin("2026-10-12", "12:00"),
    last_message_at: berlin("2026-10-12", "12:05"),
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

/** Eine Nachricht der Einzelansicht (Antwort leer, siehe oben). */
function message(id, conversation, extra = {}) {
  return {
    id,
    prompt: `Frage ${id}`,
    response: JSON.stringify({ text: "", sources: [{ text: "Quelle" }] }),
    createdAt: new Date(berlin("2026-10-12", "12:05")).toISOString(),
    conversation_id: conversation,
    session_id: `sitzung-${conversation}`,
    feedbackScore: null,
    feedbackText: null,
    feedbackReason: null,
    ...extra,
  };
}

/**
 * Der Server der Liste: `state.rows` ist der Bestand (letzte Nachricht
 * absteigend). Mit q trifft eine Zeile, wenn ihre Vorschau den Begriff enthält
 * (Groß/klein egal) – die echte Suche prüft server/__tests__. Einzelansicht
 * aus `state.details` je chatId: { status, messages }. Jede Anfrage wird
 * gemerkt.
 */
async function panelServer(t, state) {
  const { API_BASE } = await renderer.load("/src/utils/constants.js");
  // die Liste jedes Widgets (Pfad wie ROUTES.conversations)
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
      const { offset = 0, limit = 20, q, feedbackFilter } = call.body;
      // state.holdMore: Nachladen (offset > 0) wartet auf dieses Versprechen
      if (offset > 0 && state.holdMore) await state.holdMore;
      // state.failList(body): diese Anfrage scheitert (500)
      if (state.failList?.(call.body))
        return json({ success: false, error: "kaputt" }, 500);
      let rows = state.rows;
      // state.searchAll: jede Suche trifft alle Zeilen (Treffer, die das
      // Panel nicht sieht – Link-Adressen, Quelltext)
      if (q && !state.searchAll)
        rows = rows.filter((r) =>
          r.preview.toLowerCase().includes(q.toLowerCase())
        );
      if (feedbackFilter === "negative")
        rows = rows.filter((r) => r.negative_count > 0);
      return json({
        success: true,
        conversations: rows.slice(offset, offset + limit),
        hasMore: offset + limit < rows.length,
        totalCount: rows.length,
      });
    }
    if (url.endsWith("/analytics/summary")) {
      state.summaries = (state.summaries ?? 0) + 1;
      return json({
        success: true,
        granularity: "day",
        fromDay: call.body.fromDay,
        toDay: call.body.toDay,
        firstLedgerDay: "2026-01-01",
        totals: {
          messages: 885,
          conversations: 60,
          feedbackPositive: 9,
          feedbackNegative: 3,
        },
        buckets: [],
      });
    }
    const detail = url.match(/\/conversation\/(\d+)$/);
    if (call.method === "GET" && detail) {
      const answer = state.details?.[detail[1]];
      if (!answer) return json({ success: true, messages: [] });
      // answer.hold: Die Antwort wartet auf dieses Versprechen
      if (answer.hold) await answer.hold;
      if (answer.network) throw new TypeError("Failed to fetch");
      if (answer.status && answer.status >= 400)
        return {
          ok: false,
          status: answer.status,
          headers: { get: () => null },
          json: async () => {
            throw new SyntaxError("Unexpected token 'F'");
          },
        };
      return json({ success: true, messages: answer.messages });
    }
    if (url.endsWith("/analytics/export"))
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) =>
            name.toLowerCase() === "content-disposition"
              ? 'attachment; filename="konversationen_vhs-3_2026-09-13_2026-10-13.csv"'
              : null,
        },
        blob: async () => new Blob(["Konversation;…"]),
      };
    if (url.endsWith("/conversation/deletion-preview")) {
      // state.holdPreview: Die Vorschau wartet auf dieses Versprechen;
      // state.preview: ihre Antwort (sonst eine Nachricht, kein Besucher)
      if (state.holdPreview) await state.holdPreview;
      return json(
        state.preview ?? { success: true, messageCount: 1, visitor: null }
      );
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
  };
}

/** Meldungen (react-toastify) abfangen. */
async function toasts(t) {
  const { toast } = await import("react-toastify");
  const shown = [];
  const original = {
    success: toast.success,
    error: toast.error,
    info: toast.info,
  };
  toast.success = (text) => shown.push(["success", text]);
  toast.error = (text) => shown.push(["error", text]);
  toast.info = (text) => shown.push(["info", text]);
  t.after(() => Object.assign(toast, original));
  return shown;
}

/** Hängt die Liste unter einer Adresse ein (Suche, Konversation). */
async function mountList(t, { query = "", props = {} } = {}) {
  const mounted = await renderer.mount(LIST, {
    location: `${LOCATION}${query}`,
    route: LOCATION,
    props: { embedId: EMBED_ID, ...PERIOD, ...props },
  });
  const { document } = mounted;
  if (!document.getElementById("root")) {
    const root = document.createElement("div");
    root.setAttribute("id", "root");
    document.body.appendChild(root);
  }
  t.after(() => mounted.unmount());
  await mounted.act();
  return mounted;
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
const panelOf = (container) =>
  withAttribute(container, "data-conversation-panel")[0] ?? null;
const currentRows = (container) =>
  rowsOf(container)
    .filter((r) => r.getAttribute("aria-current") === "true")
    .map((r) => Number(r.getAttribute("data-conversation-row")));
const wait = (ms) => delay(ms);
/** Teile der Zeile unter der Frage im Panel (Trenner „·“ per CSS). */
const metaItems = (root) =>
  withAttribute(one(root, "data-panel-meta"), "data-meta-item").map(
    (item) => item.textContent
  );
/** Tippt in das Suchfeld (Handler des Elements). */
async function type({ container, act }, value) {
  const input = one(container, "data-search-input");
  await act(() => handlersOf(input).onChange({ target: { value } }));
}

// ---------------------------------------------------------------------------
// AK-1 / AK-2: kompakte Zeilen, Tagesgruppen
// ---------------------------------------------------------------------------

test(
  "AK-1: Zeile – Uhrzeit der letzten Nachricht, erste Frage, „N Fragen“, Marken mit Anzahl und „Grund: …“; keine Nummer, keine Kennung",
  { skip },
  async (t) => {
    fixClock(t, TODAY);
    await panelServer(t, {
      rows: [
        row(101, {
          preview: "welche kurse finden heute statt",
          last_message_at: berlin("2026-10-13", "07:48"),
          started_at: berlin("2026-10-13", "07:47"),
          message_count: 3,
          positive_count: 1,
          negative_count: 2,
          first_negative_reason: "Unvollständig",
        }),
        row(102, { preview: "Gibt es Kinderkurse?" }),
      ],
    });
    const { container } = await mountList(t);
    const [first, second] = rowsOf(container);

    assert.equal(first.tagName, "BUTTON");
    assert.equal(one(first, "data-row-time").textContent, "07:48");
    assert.equal(
      one(first, "data-row-question").textContent,
      "welche kurse finden heute statt"
    );
    // eine Zeile, abgeschnitten mit „…" (CSS)
    assert.match(
      one(first, "data-row-question").getAttribute("class"),
      /\btruncate\b/
    );
    assert.equal(
      one(first, "data-row-meta").textContent,
      "07:48 · 3 Fragen · Grund: Unvollständig"
    );
    const badges = withAttribute(first, "data-rating-badge").map((badge) => [
      badge.getAttribute("data-rating-badge"),
      badge.getAttribute("title"),
    ]);
    assert.deepEqual(badges, [
      ["positive", "1 positive Bewertung"],
      ["negative", "2 negative Bewertungen"],
    ]);
    assert.equal(one(second, "data-row-meta").textContent, "12:05 · 1 Frage");
    assert.equal(withAttribute(second, "data-rating-badge").length, 0);

    assert.doesNotMatch(
      container.textContent,
      /Konversation #|konv-10|sitzung-/
    );
    assert.deepEqual(currentRows(container), []);
  }
);

test(
  "AK-2: Gruppen nach dem Tag der letzten Nachricht – K1 (begonnen 9. Okt.) unter „Heute“ über K2; Tagesüberschriften ohne Anzahl (Fixliste 2, B10)",
  { skip },
  async (t) => {
    fixClock(t, TODAY);
    await panelServer(t, {
      rows: [
        row(1, {
          started_at: berlin("2026-10-09", "08:25"),
          last_message_at: berlin("2026-10-13", "07:47"),
          message_count: 4,
        }),
        row(2, {
          started_at: berlin("2026-10-12", "12:03"),
          last_message_at: berlin("2026-10-12", "12:10"),
        }),
        row(3, { last_message_at: berlin("2026-10-12", "11:48") }),
        row(4, { last_message_at: berlin("2026-10-11", "17:54") }),
      ],
    });
    const { container } = await mountList(t);
    const groups = withAttribute(container, "data-day-group").map((group) => [
      group.getAttribute("data-day-group"),
      one(group, "data-day-label").textContent,
      elements(group, (e) => e.tagName === "H4")[0].textContent,
      rowsOf(group).map((r) => Number(r.getAttribute("data-conversation-row"))),
    ]);
    // die Überschrift ist nur der Tag – keine Zahl der Konversationen
    assert.deepEqual(groups, [
      [
        "2026-10-13",
        "Heute · Dienstag, 13. Oktober",
        "Heute · Dienstag, 13. Oktober",
        [1],
      ],
      [
        "2026-10-12",
        "Gestern · Montag, 12. Oktober",
        "Gestern · Montag, 12. Oktober",
        [2, 3],
      ],
      ["2026-10-11", "Sonntag, 11. Oktober", "Sonntag, 11. Oktober", [4]],
    ]);
    assert.equal(withAttribute(container, "data-day-count").length, 0);
    assert.equal(
      one(rowsOf(container)[0], "data-row-meta").textContent,
      "07:47 · 4 Fragen · begonnen am 9. Okt."
    );
    assert.equal(
      one(rowsOf(container)[1], "data-row-meta").textContent,
      "12:10 · 1 Frage"
    );
  }
);

test(
  "AK-1: Auch eine nur teilweise geladene Gruppe nennt keine Zahl – einheitlich ohne Anzahl (Fixliste 2, B10); „Weitere Konversationen laden“ hängt an",
  { skip },
  async (t) => {
    fixClock(t, TODAY);
    const rows = Array.from({ length: 25 }, (_, i) =>
      row(200 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
      })
    );
    const server = await panelServer(t, { rows });
    const { container, act } = await mountList(t);
    assert.equal(rowsOf(container).length, 20);
    assert.equal(withAttribute(container, "data-day-count").length, 0);
    await act(() => click(one(container, "data-load-more")));
    assert.deepEqual(
      server.lists().map((call) => [call.body.offset, call.body.limit]),
      [
        [0, 20],
        [20, 20],
      ]
    );
    assert.equal(rowsOf(container).length, 25);
    assert.equal(withAttribute(container, "data-day-count").length, 0);
    assert.equal(withAttribute(container, "data-load-more").length, 0);
  }
);

// ---------------------------------------------------------------------------
// AK-4 / AK-5: Seitenpanel mit Gesprächsverlauf
// ---------------------------------------------------------------------------

const RATED = [
  message(11, "konv-11", {
    prompt: "welche kurse finden heute statt",
    createdAt: new Date(berlin("2026-10-13", "07:47")).toISOString(),
    session_id: "sitzung-11",
  }),
  message(12, "konv-11", {
    prompt: "ich will eine neue sprache lernen",
    createdAt: new Date(berlin("2026-10-13", "07:47")).toISOString(),
    session_id: "sitzung-11",
    feedbackScore: false,
    feedbackReason: "Unvollständig",
    feedbackText: "Es fehlt der Preis „pro Abend“.",
  }),
  message(13, "konv-11", {
    prompt: "Spanischkurse finden",
    createdAt: new Date(berlin("2026-10-13", "07:48")).toISOString(),
    session_id: "sitzung-11",
    feedbackScore: true,
  }),
];

test(
  "AK-4/AK-5: Klick auf eine Zeile öffnet das Panel – Zeile markiert (aria-current), Kopf mit Frage, Datum, Zeitspanne, Zahl und Bewertung; Fragen als Sprechblase, Bewertung unter genau der bewerteten Antwort",
  { skip },
  async (t) => {
    fixClock(t, TODAY);
    const server = await panelServer(t, {
      rows: [
        row(11, {
          preview: "welche kurse finden heute statt",
          started_at: berlin("2026-10-13", "07:47"),
          last_message_at: berlin("2026-10-13", "07:48"),
          message_count: 3,
          negative_count: 1,
          positive_count: 1,
        }),
        row(20),
      ],
      details: { 11: { messages: RATED } },
    });
    const { container, act } = await mountList(t);
    assert.equal(panelOf(container), null);

    await act(() => click(rowsOf(container)[0]));
    await act();
    assert.deepEqual(server.details(), [11]);
    assert.deepEqual(currentRows(container), [11]);
    // Die Liste wird dafür nicht neu geladen.
    assert.equal(server.lists().length, 1);

    const panel = panelOf(container);
    assert.equal(panel.tagName, "ASIDE");
    assert.equal(panel.getAttribute("aria-label"), "Ausgewählte Konversation");
    const head = one(panel, "data-panel-head");
    assert.equal(head.tagName, "HEADER");
    assert.equal(
      one(head, "data-panel-question").textContent,
      "welche kurse finden heute statt"
    );
    assert.equal(
      one(head, "data-panel-date").textContent,
      "Dienstag, 13.10.2026"
    );
    assert.deepEqual(metaItems(head), [
      "Dienstag, 13.10.2026",
      "3 Fragen",
      "07:47–07:48 Uhr",
      "1 Antwort negativ bewertet",
      "1 Antwort positiv bewertet",
    ]);
    for (const name of [
      "data-panel-previous",
      "data-panel-next",
      "data-panel-menu-button",
      "data-panel-close",
    ])
      assert.ok(one(head, name), name);

    const items = withAttribute(panel, "data-message");
    assert.equal(items.length, 3);
    assert.deepEqual(
      items.map((item) => one(item, "data-question").textContent),
      [
        "welche kurse finden heute statt",
        "ich will eine neue sprache lernen",
        "Spanischkurse finden",
      ]
    );
    assert.match(items[0].textContent, /^Besucher · 07:47/);
    assert.match(items[2].textContent, /^Besucher · 07:48/);
    // Bewertung unter genau der bewerteten Antwort
    assert.deepEqual(
      items.map((item) =>
        withAttribute(item, "data-rating").map((r) =>
          r.getAttribute("data-rating")
        )
      ),
      [[], ["negative"], ["positive"]]
    );
    const negative = one(items[1], "data-rating");
    assert.match(negative.textContent, /^Negativ bewertet · Unvollständig/);
    assert.equal(
      one(negative, "data-rating-comment").textContent,
      "„Es fehlt der Preis „pro Abend“.“"
    );
    assert.equal(one(items[2], "data-rating").textContent, "Positiv bewertet");
    // die Antwort steht neben der Frage (MarkdownRenderer)
    assert.equal(withAttribute(items[0], "data-answer").length, 1);

    // keine Überschriften ANFRAGE/ANTWORT, keine farbigen Randbalken
    assert.doesNotMatch(panel.textContent, /ANFRAGE|ANTWORT|Anfrage|Antwort:/);
    const classes = elements(panel).map((e) => e.getAttribute("class") ?? "");
    assert.equal(classes.filter((c) => /\bborder-l-4\b/.test(c)).length, 0);

    // Fußzeile mit gekürzter Kennung
    assert.equal(one(panel, "data-panel-id").textContent, "ID konv-11");
  }
);

test(
  "AK-4: ✕ schließt das Panel – die Liste bleibt, wie sie ist (keine neue Anfrage)",
  { skip },
  async (t) => {
    const server = await panelServer(t, { rows: [row(1), row(2)] });
    const { container, act } = await mountList(t);
    await act(() => click(rowsOf(container)[1]));
    assert.ok(panelOf(container));
    await act(() => click(one(container, "data-panel-close")));
    assert.equal(panelOf(container), null);
    assert.deepEqual(currentRows(container), []);
    assert.equal(server.lists().length, 1);
  }
);

// ---------------------------------------------------------------------------
// AK-6 / AK-18: vorherige/nächste, Tastatur
// ---------------------------------------------------------------------------

test(
  "AK-6: vorherige/nächste folgen der gefilterten Liste; am Anfang/Ende gesperrt; über das Ende der geladenen Seite hinaus wird nachgeladen",
  { skip },
  async (t) => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      row(300 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
        negative_count: i % 2 === 0 ? 1 : 0,
      })
    );
    const server = await panelServer(t, { rows });
    const { container, act } = await mountList(t, {
      props: { feedbackFilter: "negative" },
    });
    // 11 negativ bewertete: 300, 302, …, 320 – davon 11 auf Seite 1
    assert.deepEqual(
      rowsOf(container).map((r) =>
        Number(r.getAttribute("data-conversation-row"))
      ),
      [300, 302, 304, 306, 308, 310, 312, 314, 316, 318, 320]
    );
    await act(() => click(rowsOf(container)[0]));
    const previous = () => one(container, "data-panel-previous");
    const next = () => one(container, "data-panel-next");
    assert.equal(previous().hasAttribute("disabled"), true);
    assert.equal(next().hasAttribute("disabled"), false);

    await act(() => click(next()));
    await act();
    assert.deepEqual(currentRows(container), [302]);
    assert.equal(previous().hasAttribute("disabled"), false);
    await act(() => click(previous()));
    await act();
    assert.deepEqual(currentRows(container), [300]);
    assert.deepEqual(server.details(), [300, 302, 300]);

    // an das Ende
    await act(() => click(rowsOf(container).at(-1)));
    await act();
    assert.deepEqual(currentRows(container), [320]);
    assert.equal(next().hasAttribute("disabled"), true);
  }
);

test(
  "AK-6: „Nächste“ an der letzten geladenen Zeile lädt nach und öffnet die folgende",
  { skip },
  async (t) => {
    const rows = Array.from({ length: 22 }, (_, i) =>
      row(400 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
      })
    );
    const server = await panelServer(t, { rows });
    const { container, act } = await mountList(t);
    await act(() => click(rowsOf(container)[19]));
    await act();
    assert.deepEqual(currentRows(container), [419]);
    const next = one(container, "data-panel-next");
    assert.equal(next.hasAttribute("disabled"), false);

    await act(() => click(next));
    await act();
    await act();
    assert.deepEqual(server.lists().at(-1).body.offset, 20);
    assert.equal(rowsOf(container).length, 22);
    assert.deepEqual(currentRows(container), [420]);
    assert.deepEqual(server.details().at(-1), 420);
  }
);

test(
  "AK-18: ↑/↓ auf einer Zeile wechseln den Fokus; bei offenem Panel folgt es – ohne Panel öffnet nichts",
  { skip },
  async (t) => {
    const server = await panelServer(t, { rows: [row(1), row(2), row(3)] });
    const { container, document, act } = await mountList(t);
    const rows = () => rowsOf(container);

    rows()[0].focus();
    await act(() => pressKey(document, "ArrowDown"));
    assert.equal(document.activeElement, rows()[1]);
    assert.equal(panelOf(container), null);
    assert.deepEqual(server.details(), []);

    await act(() => click(rows()[1]));
    await act(() => pressKey(document, "ArrowDown"));
    await act();
    assert.equal(document.activeElement, rows()[2]);
    assert.deepEqual(currentRows(container), [3]);
    await act(() => pressKey(document, "ArrowUp"));
    await act();
    assert.deepEqual(currentRows(container), [2]);
    // über den Anfang hinaus: nichts
    await act(() => pressKey(document, "ArrowUp"));
    await act(() => pressKey(document, "ArrowUp"));
    assert.equal(document.activeElement, rows()[0]);
  }
);

// ---------------------------------------------------------------------------
// AK-10 / AK-14 / AK-19: Suche
// ---------------------------------------------------------------------------

test(
  "AK-10: Suche ab 2 Zeichen, verzögert – Markierung „Suche: …“ mit ✕, „N von M einsehbar“; ✕ gibt die volle Liste zurück",
  { skip },
  async (t) => {
    const server = await panelServer(t, {
      rows: [
        row(1, { preview: "Spanischkurs am Abend?" }),
        row(2, { preview: "Gibt es Yoga?" }),
        row(3, { preview: "spanisch für Anfänger" }),
      ],
    });
    const view = await mountList(t);
    const { container, act } = view;
    const viewable = () => one(container, "data-viewable-count").textContent;
    assert.equal(viewable(), "3 einsehbar");

    // 1 Zeichen: keine Suche
    await type(view, "s");
    await act(() => wait(350));
    assert.equal(server.lists().length, 1);

    // „spanisch": erst nach der Pause
    await type(view, "spanisch");
    assert.equal(server.lists().length, 1);
    await act(() => wait(350));
    await act();
    assert.deepEqual(server.lists().at(-1).body, {
      ...conversationsBody({ ...PERIOD }),
      q: "spanisch",
    });
    assert.deepEqual(
      rowsOf(container).map((r) =>
        Number(r.getAttribute("data-conversation-row"))
      ),
      [1, 3]
    );
    assert.equal(viewable(), "2 von 3 einsehbar");
    const mark = one(container, "data-search-filter-mark");
    assert.equal(mark.textContent, "Suche: spanisch");
    const [clear] = elements(mark, (e) => e.tagName === "BUTTON");
    assert.equal(clear.getAttribute("aria-label"), "Suche „spanisch“ aufheben");

    await act(() => click(clear));
    await act();
    assert.deepEqual(
      server.lists().at(-1).body,
      conversationsBody({ ...PERIOD })
    );
    assert.equal(rowsOf(container).length, 3);
    assert.equal(withAttribute(container, "data-search-filter-mark").length, 0);
    assert.equal(one(container, "data-search-input").value, "");
    assert.equal(viewable(), "3 einsehbar");
  }
);

test(
  "AK-14: Suche und offene Konversation aus der Adresse – nach dem Neuladen wiederhergestellt; die Zählabfrage ohne Suche läuft daneben",
  { skip },
  async (t) => {
    const server = await panelServer(t, {
      rows: [
        row(1, { preview: "Spanischkurs?" }),
        row(2, { preview: "Yoga?" }),
      ],
      details: {
        1: {
          messages: [
            message(1, "konv-1", {
              prompt: "Spanischkurs?",
              session_id: "sitzung-1",
            }),
          ],
        },
      },
    });
    const { container } = await mountList(t, {
      query: "?widget=3&conversation=1&q=spanisch",
    });
    assert.deepEqual(
      server.lists().map((call) => call.body),
      [
        conversationsBody({ ...PERIOD, limit: 1 }),
        { ...conversationsBody({ ...PERIOD }), q: "spanisch" },
      ]
    );
    assert.equal(one(container, "data-search-input").value, "spanisch");
    assert.equal(
      one(container, "data-search-filter-mark").textContent,
      "Suche: spanisch"
    );
    assert.ok(panelOf(container));
    assert.deepEqual(currentRows(container), [1]);
    assert.deepEqual(server.details(), [1]);
  }
);

test(
  "AK-19: Suche ohne Treffer – schmaler Leerzustand „Keine Konversationen mit „…“ im gewählten Zeitraum“",
  { skip },
  async (t) => {
    await panelServer(t, { rows: [row(1)] });
    const { container } = await mountList(t, { query: "?q=klingonisch" });
    assert.equal(
      one(container, "data-empty-search").textContent,
      "Keine Konversationen mit „klingonisch“ im gewählten Zeitraum"
    );
    assert.equal(rowsOf(container).length, 0);
  }
);

// ---------------------------------------------------------------------------
// AK-13 / NAK-5: Hervorhebung ohne HTML aus Nutzertext
// ---------------------------------------------------------------------------

test(
  "AK-13/NAK-5: Treffer in Frage, Grund und Kommentar als <mark> – <img src=x onerror=alert(1)> aus Frage und Kommentar bleibt Text",
  { skip },
  async (t) => {
    const evil = "<img src=x onerror=alert(1)>";
    await panelServer(t, {
      rows: [row(7, { preview: `${evil} Frage` })],
      details: {
        7: {
          messages: [
            message(7, "konv-7", {
              prompt: `${evil} Frage`,
              session_id: "sitzung-7",
              feedbackScore: false,
              feedbackReason: "img fehlt",
              feedbackText: `Kommentar ${evil}`,
            }),
          ],
        },
      },
    });
    const { container } = await mountList(t, {
      query: "?conversation=7&q=img",
    });
    const panel = panelOf(container);
    assert.equal(elements(container, (e) => e.tagName === "IMG").length, 0);
    const marks = elements(panel, (e) => e.tagName === "MARK");
    // Kopf (erste Frage), Sprechblase, Grund, Kommentar
    assert.deepEqual(
      marks.map((m) => [m.getAttribute("data-search-hit"), m.textContent]),
      [
        ["", "img"],
        ["", "img"],
        ["", "img"],
        ["", "img"],
      ]
    );
    for (const m of marks)
      assert.ok(m.childNodes.every((child) => child.nodeType === 3));
    assert.equal(one(panel, "data-question").textContent, `${evil} Frage`);
    assert.equal(
      one(panel, "data-rating-comment").textContent,
      `„Kommentar ${evil}“`
    );
  }
);

// ---------------------------------------------------------------------------
// AK-7 / NAK-1: Öffnen per Link
// ---------------------------------------------------------------------------

test(
  "AK-7: per Link außerhalb des Zeitraums – das Panel zeigt sie mit dem Hinweis; vorherige/nächste gesperrt, keine Zeile markiert",
  { skip },
  async (t) => {
    const server = await panelServer(t, {
      rows: [row(1), row(2)],
      details: {
        999: {
          messages: [
            message(999, "alt", {
              prompt: "Alte Frage aus dem August",
              session_id: "sitzung-alt",
              createdAt: "2026-08-01T10:00:00.000Z",
            }),
          ],
        },
      },
    });
    const { container } = await mountList(t, {
      query: "?widget=3&conversation=999",
    });
    assert.deepEqual(server.details(), [999]);
    const panel = panelOf(container);
    assert.equal(
      one(panel, "data-panel-outside").textContent,
      "Diese Konversation liegt außerhalb des gewählten Zeitraums"
    );
    assert.equal(
      one(panel, "data-panel-question").textContent,
      "Alte Frage aus dem August"
    );
    assert.equal(
      one(panel, "data-panel-previous").hasAttribute("disabled"),
      true
    );
    assert.equal(one(panel, "data-panel-next").hasAttribute("disabled"), true);
    assert.deepEqual(currentRows(container), []);
  }
);

test(
  "AK-7: per Link auf eine Konversation der Liste, deren erste Zeile im Zeitraum eine andere ist – die Zeile ist markiert",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [row(50, { conversation_id: "k-50", session_id: "s-50" }), row(2)],
      details: {
        41: {
          messages: [
            message(41, "k-50", {
              session_id: "s-50",
              createdAt: "2026-08-01T10:00:00.000Z",
            }),
            message(50, "k-50", { session_id: "s-50" }),
          ],
        },
      },
    });
    const { container } = await mountList(t, { query: "?conversation=41" });
    assert.deepEqual(currentRows(container), [50]);
    assert.equal(withAttribute(container, "data-panel-outside").length, 0);
  }
);

test(
  "NAK-1: ohne Recht (403) – keine Inhalte, keine Aktionen, nur der Hinweis",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [row(1)],
      details: { 77: { status: 403 } },
    });
    const { container } = await mountList(t, { query: "?conversation=77" });
    const panel = panelOf(container);
    assert.equal(
      one(panel, "data-panel-not-found").textContent,
      "Diese Konversation wurde nicht gefunden, oder Sie haben keinen Zugriff darauf."
    );
    assert.equal(withAttribute(panel, "data-message").length, 0);
    assert.equal(withAttribute(panel, "data-conversation-actions").length, 0);
    assert.equal(withAttribute(panel, "data-panel-question").length, 0);
    assert.equal(
      one(panel, "data-panel-menu-button").hasAttribute("disabled"),
      true
    );
  }
);

// ---------------------------------------------------------------------------
// AK-15: Aktionen im Panel
// ---------------------------------------------------------------------------

function stubClipboard(t) {
  const written = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (text) => written.push(text) } },
    configurable: true,
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  });
  return written;
}

test(
  "AK-15: „⋯“ – Kennung kopieren („Kennung kopiert“), Link kopieren (Adresse mit Widget und Konversation), Konversation löschen (Rückfrage aus KIE-538)",
  { skip },
  async (t) => {
    const written = stubClipboard(t);
    const shown = await toasts(t);
    await panelServer(t, {
      rows: [
        row(1, { conversation_id: "3f311a2b-e8cd-4b30-9627-2758deb20006" }),
      ],
    });
    const { container, document, act } = await mountList(t, {
      query: "?q=frage",
    });
    await act(() => click(rowsOf(container)[0]));
    const menuButton = one(container, "data-panel-menu-button");
    assert.equal(menuButton.getAttribute("aria-haspopup"), "menu");
    await act(() => click(menuButton));
    const menu = one(container, "data-panel-menu");
    assert.equal(menu.getAttribute("role"), "menu");
    assert.deepEqual(
      elements(menu, (e) => e.getAttribute("role") === "menuitem").map(
        (e) => e.textContent
      ),
      ["Kennung kopieren", "Link kopieren", "Konversation löschen"]
    );

    await act(() => click(one(container, "data-menu-copy-id")));
    assert.equal(withAttribute(container, "data-panel-menu").length, 0);
    await act(() => click(menuButton));
    await act(() => click(one(container, "data-menu-copy-link")));
    // Der kopierte Link nennt Widget und Konversation – nicht den
    // Suchbegriff (Fixliste Punkt 23: oft ein Name oder eine E-Mail-Adresse).
    assert.deepEqual(written, [
      "3f311a2b-e8cd-4b30-9627-2758deb20006",
      `${LOCATION}?widget=3&conversation=1`,
    ]);
    assert.deepEqual(shown, [
      ["success", "Kennung kopiert"],
      ["success", "Link kopiert"],
    ]);
    // gekürzte Kennung in der Fußzeile, ebenfalls zum Kopieren
    assert.equal(one(container, "data-panel-id").textContent, "ID 3f311a2b…");

    await act(() => click(menuButton));
    await act(() => click(one(container, "data-menu-delete")));
    const [dialog] = withAttribute(document.body, "data-confirm-dialog");
    assert.equal(dialog.getAttribute("aria-label"), "Konversation löschen?");
  }
);

// ---------------------------------------------------------------------------
// AK-9: mobil als Vollbild
// ---------------------------------------------------------------------------

test(
  "AK-9: Unter lg ist das Panel ein Vollbild mit „‹ Konversationen“; Schaltflächen 44 px hoch; „‹ Konversationen“ kehrt zur Liste zurück",
  { skip },
  async (t) => {
    const server = await panelServer(t, { rows: [row(1), row(2)] });
    const { container, act } = await mountList(t);
    await act(() => click(rowsOf(container)[0]));
    const panel = panelOf(container);
    const classes = (element) =>
      (element.getAttribute("class") ?? "").split(/\s+/);
    // Vollbild bis lg, ab lg Seitenpanel neben der Liste
    for (const name of ["fixed", "inset-0", "lg:sticky", "lg:inset-auto"])
      assert.ok(classes(panel).includes(name), name);
    const back = one(panel, "data-panel-back");
    assert.equal(back.textContent, "Konversationen");
    assert.ok(classes(back).includes("h-11"));
    assert.ok(classes(back).includes("lg:hidden"));
    for (const name of [
      "data-panel-previous",
      "data-panel-next",
      "data-panel-menu-button",
      "data-panel-close",
    ]) {
      const button = one(panel, name);
      assert.ok(classes(button).includes("h-11"), name);
      assert.ok(classes(button).includes("w-11"), name);
    }
    // ✕ nur ab lg
    assert.ok(classes(one(panel, "data-panel-close")).includes("hidden"));
    // Zeilen mindestens 44 px: zwei Textzeilen (20 + 18 px) und py-2
    const [first] = rowsOf(container);
    assert.ok(classes(first).includes("py-2"));

    await act(() => click(back));
    assert.equal(panelOf(container), null);
    assert.equal(server.lists().length, 1);
  }
);

// ---------------------------------------------------------------------------
// NAK-6: Suche und Panel ändern Kennzahlen und Diagramm nicht
// ---------------------------------------------------------------------------

test(
  "NAK-6: Suche und geöffnete Konversation laden Kennzahlen, Diagramm und Uhrzeit-Karte nicht neu",
  { skip },
  async (t) => {
    const state = {
      rows: [row(1, { preview: "Spanisch?" }), row(2, { preview: "Yoga?" })],
    };
    const server = await panelServer(t, state);
    const mounted = await renderer.mount(VIEW, {
      location: LOCATION,
      exportName: "AnalyticsScreen",
      props: {
        embedsLoaded: true,
        embeds: [
          {
            id: EMBED_ID,
            chat_retention_days: null,
            workspace: { name: "VHS" },
          },
        ],
      },
    });
    t.after(() => mounted.unmount());
    const { container, act } = mounted;
    await act();
    const kpis = () =>
      withAttribute(container, "data-kpi").map((e) => e.textContent);
    const before = kpis();
    assert.equal(state.summaries, 1);
    assert.ok(before.length > 0);

    await type(mounted, "spanisch");
    await act(() => wait(350));
    await act();
    assert.equal(rowsOf(container).length, 1);
    await act(() => click(rowsOf(container)[0]));
    await act();
    assert.ok(panelOf(container));

    assert.equal(state.summaries, 1);
    assert.deepEqual(kpis(), before);
    assert.equal(
      server.calls.filter((call) => call.url.endsWith("/analytics/summary"))
        .length,
      1
    );
    // Der Verweis in der Kopfzeile nennt die Suche.
    assert.equal(
      one(container, "data-jump-to-list").textContent,
      "1 Konversation mit „spanisch“ ansehen ↓"
    );
  }
);

// ---------------------------------------------------------------------------
// AK-7 / NAK-1: Widget aus der Adresse
// ---------------------------------------------------------------------------

test(
  "AK-7: Der Link wählt sein Widget und öffnet die Konversation darin; NAK-1: ein Widget, das der Nutzer nicht sehen kann, öffnet nichts",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const state = {
      rows: [row(1)],
      details: { 5: { messages: [message(5, "k-5", { session_id: "s-5" })] } },
    };
    const server = await panelServer(t, state);
    const embeds = [
      {
        id: 7,
        chat_retention_days: null,
        workspace: { name: "VHS Beispielstadt" },
      },
      { id: EMBED_ID, chat_retention_days: null, workspace: { name: "VHS" } },
    ];
    const mountView = async (query) => {
      const mounted = await renderer.mount(VIEW, {
        location: `${LOCATION}${query}`,
        route: LOCATION,
        exportName: "AnalyticsScreen",
        props: { embedsLoaded: true, embeds },
      });
      t.after(() => mounted.unmount());
      await mounted.act();
      return mounted;
    };

    // Widget 3 aus der Adresse (sonst wäre 7, das erste, gewählt)
    const linked = await mountView("?widget=3&conversation=5");
    assert.ok(
      server.lists().every((call) => call.url.includes(`/embed/${EMBED_ID}/`))
    );
    assert.deepEqual(server.details(), [5]);
    assert.ok(
      server.calls.some((call) =>
        call.url.endsWith(`/embed/${EMBED_ID}/conversation/5`)
      )
    );
    assert.ok(panelOf(linked.container));
    await linked.unmount();

    // fremdes Widget 99: Hinweis, keine Einzelansicht, Liste des ersten Widgets
    server.calls.length = 0;
    const foreign = await mountView("?widget=99&conversation=5");
    await foreign.act();
    assert.deepEqual(server.details(), []);
    assert.equal(panelOf(foreign.container), null);
    assert.ok(server.lists().length > 0);
    assert.ok(server.lists().every((call) => call.url.includes("/embed/7/")));
    assert.deepEqual(shown, [
      [
        "error",
        "Diese Konversation wurde nicht gefunden, oder Sie haben keinen Zugriff darauf.",
      ],
    ]);
  }
);

test(
  "AK-12: „Exportieren“ nimmt den Suchbegriff mit – der Dateiname kommt wie bisher vom Server",
  { skip },
  async (t) => {
    const server = await panelServer(t, {
      rows: [
        row(1, { preview: "Spanischkurs?", negative_count: 1 }),
        row(2, { preview: "Yoga?" }),
      ],
    });
    const { container, act } = await mountList(t, {
      query: "?q=spanisch",
      props: { feedbackFilter: "negative" },
    });
    saved.length = 0;
    const [menu] = withAttribute(container, "data-export-menu");
    const [exportButton] = elements(menu, (e) => e.tagName === "BUTTON");
    assert.equal(exportButton.hasAttribute("disabled"), false);
    await act(() => click(elements(menu, (e) => e.tagName === "BUTTON")[0]));
    await act(() => click(withAttribute(container, "data-export-format")[0]));
    await act();
    const exports = server.calls.filter((call) =>
      call.url.endsWith("/analytics/export")
    );
    assert.deepEqual(
      exports.map((call) => call.body),
      [
        {
          ...exportBody("csv", { ...PERIOD, feedbackFilter: "negative" }),
          q: "spanisch",
        },
      ]
    );
    assert.deepEqual(
      saved.map((file) => file.filename),
      ["konversationen_vhs-3_2026-09-13_2026-10-13.csv"]
    );
  }
);

// ---------------------------------------------------------------------------
// Fixliste nach den Reviews (13.10.2026) – Frontend
// ---------------------------------------------------------------------------

/**
 * Tastatur-Lauscher am Dokument und am Fenster mitschneiden (das Test-
 * Dokument löst selbst keine Ereignisse aus). escape() spielt Escape so ab
 * wie ein Browser: erst die Lauscher am Dokument (Menüs, Rückfrage), dann
 * die am Fenster (Panel) – mit einem gemeinsamen defaultPrevented.
 */
function captureKeys(t, document) {
  const lists = { document: [], window: [] };
  const targets = { document, window: globalThis.window };
  const originals = {};
  for (const [name, target] of Object.entries(targets)) {
    originals[name] = {
      add: Object.getOwnPropertyDescriptor(target, "addEventListener"),
      remove: Object.getOwnPropertyDescriptor(target, "removeEventListener"),
    };
    target.addEventListener = (type, listener) => {
      if (type === "keydown") lists[name].push(listener);
    };
    target.removeEventListener = (type, listener) => {
      const index = lists[name].indexOf(listener);
      if (index >= 0) lists[name].splice(index, 1);
    };
  }
  t.after(() => {
    for (const [name, target] of Object.entries(targets))
      for (const [key, descriptor] of [
        ["addEventListener", originals[name].add],
        ["removeEventListener", originals[name].remove],
      ])
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
  });
  return (act, key = "Escape") =>
    act(() => {
      const event = {
        key,
        target: document.activeElement ?? document.body,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const listener of [...lists.document]) listener(event);
      for (const listener of [...lists.window]) listener(event);
    });
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

const rowIds = (container) =>
  rowsOf(container).map((r) => Number(r.getAttribute("data-conversation-row")));

test(
  "Fixliste 12: Escape in Lösch-Rückfrage (aus Menü und Fußzeile), Menü „⋯“ und Exportmenü schließt nur diese – erst ein weiteres Escape das Panel",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [row(1), row(2)],
      details: {
        1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
      },
    });
    const view = await mountList(t);
    const { container, document, act } = view;
    const escape = captureKeys(t, document);
    await act(() => click(rowsOf(container)[0]));
    await act();
    const dialog = () => withAttribute(document.body, "data-confirm-dialog");

    // Rückfrage aus dem Menü
    await act(() => click(one(container, "data-panel-menu-button")));
    await act(() => click(one(container, "data-menu-delete")));
    assert.equal(dialog().length, 1);
    await escape(act);
    assert.equal(dialog().length, 0);
    assert.ok(
      panelOf(container),
      "Panel bleibt nach Escape in der Rückfrage (Menü)"
    );

    // Rückfrage aus der Fußzeile
    await act(() => click(one(container, "data-delete-conversation")));
    assert.equal(dialog().length, 1);
    await escape(act);
    assert.equal(dialog().length, 0);
    assert.ok(
      panelOf(container),
      "Panel bleibt nach Escape in der Rückfrage (Fußzeile)"
    );

    // Menü „⋯": Escape schließt es, der Fokus kehrt auf die Schaltfläche
    const menuButton = one(container, "data-panel-menu-button");
    await act(() => click(menuButton));
    assert.equal(withAttribute(container, "data-panel-menu").length, 1);
    await escape(act);
    assert.equal(withAttribute(container, "data-panel-menu").length, 0);
    assert.equal(document.activeElement, menuButton);
    assert.ok(panelOf(container), "Panel bleibt nach Escape im Menü");

    // Exportmenü
    const exportButton = elements(
      one(container, "data-export-menu"),
      (e) => e.tagName === "BUTTON"
    )[0];
    await act(() => click(exportButton));
    assert.equal(exportButton.getAttribute("aria-expanded"), "true");
    await escape(act);
    assert.equal(exportButton.getAttribute("aria-expanded"), "false");
    assert.ok(panelOf(container), "Panel bleibt nach Escape im Exportmenü");

    // ohne offenes Menü: Escape schließt das Panel
    await escape(act);
    assert.equal(panelOf(container), null);
  }
);

test(
  "Fixliste 13: Sprung zum ersten Treffer scrollt nur den Verlauf (scrollTop), nicht die Seite (kein scrollIntoView)",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [row(1, { preview: "Frage zum Kurs" })],
      details: {
        1: {
          messages: [
            message(1, "konv-1", {
              session_id: "sitzung-1",
              prompt: "Frage zum Kurs",
            }),
          ],
        },
      },
    });
    const view = await mountList(t, { query: "?q=kurs" });
    const { container, act } = view;
    const prototype = Object.getPrototypeOf(rowsOf(container)[0]);
    const scrolled = [];
    const originals = {
      scrollIntoView: prototype.scrollIntoView,
      getBoundingClientRect: prototype.getBoundingClientRect,
    };
    prototype.scrollIntoView = function () {
      scrolled.push(this);
    };
    prototype.getBoundingClientRect = function () {
      if (this.hasAttribute("data-search-hit")) return { top: 700, height: 20 };
      return { top: 100, height: 400 };
    };
    Object.defineProperty(prototype, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
    t.after(() => {
      Object.assign(prototype, originals);
      delete prototype.clientHeight;
    });
    await act(() => click(rowsOf(container)[0]));
    await act();
    const body = one(container, "data-panel-body");
    assert.ok(withAttribute(body, "data-search-hit").length > 0);
    // 700 − 100 vom Anfang des Verlaufs; mittig: 600 − (400 − 20) / 2
    assert.equal(body.scrollTop, 410);
    assert.deepEqual(scrolled, []);
  }
);

test(
  "Fixliste 14: „Vorherige“ ohne Ziel setzt kein Folgen – ein späterer Klick in die Liste verschiebt sie nicht",
  { skip },
  async (t) => {
    stubWidth(t, true);
    await panelServer(t, { rows: [row(1), row(2), row(3)] });
    const { container, act } = await mountList(t);
    const prototype = Object.getPrototypeOf(rowsOf(container)[0]);
    const scrolled = [];
    const original = prototype.scrollIntoView;
    prototype.scrollIntoView = function () {
      scrolled.push(this);
    };
    t.after(() => {
      prototype.scrollIntoView = original;
    });
    await act(() => click(rowsOf(container)[0]));
    await act();
    // am Anfang: nichts zu öffnen (Handler direkt, die Schaltfläche ist gesperrt)
    await act(() =>
      handlersOf(one(container, "data-panel-previous")).onClick()
    );
    assert.deepEqual(currentRows(container), [1]);
    await act(() => click(rowsOf(container)[2]));
    await act();
    assert.deepEqual(currentRows(container), [3]);
    assert.deepEqual(scrolled, []);
    // Blättern im Panel folgt weiterhin
    await act(() => click(one(container, "data-panel-previous")));
    await act();
    assert.deepEqual(currentRows(container), [2]);
    assert.equal(scrolled.length, 1);
  }
);

test(
  "Fixliste 15: „Nächste“ am Seitenende, dann eine andere Zeile geöffnet – nach dem Nachladen springt das Panel nicht weiter",
  { skip },
  async (t) => {
    let release;
    const rows = Array.from({ length: 25 }, (_, i) =>
      row(500 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
      })
    );
    const state = {
      rows,
      holdMore: new Promise((resolve) => {
        release = resolve;
      }),
    };
    const server = await panelServer(t, state);
    const { container, act } = await mountList(t);
    await act(() => click(rowsOf(container)[19]));
    await act();
    await act(() => click(one(container, "data-panel-next")));
    assert.equal(server.lists().at(-1).body.offset, 20);
    // noch beim Laden: eine andere Zeile öffnen
    await act(() => click(rowsOf(container)[4]));
    await act();
    assert.deepEqual(currentRows(container), [504]);
    await act(() => release());
    await act();
    await act();
    assert.equal(rowsOf(container).length, 25);
    assert.deepEqual(currentRows(container), [504]);
    assert.equal(server.details().at(-1), 504);
  }
);

test(
  "Fixliste 16: Ladefehler im Verlauf (500, Netzfehler) – Meldung mit „Erneut versuchen“, kein Löschen, aber Link und Kennung kopierbar (Fixliste 2, S4); 403 bleibt „nicht gefunden“",
  { skip },
  async (t) => {
    const state = {
      rows: [row(1), row(2)],
      details: { 1: { status: 500 }, 2: { network: true } },
    };
    const server = await panelServer(t, state);
    const { container, act } = await mountList(t);
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    t.after(() => {
      console.error = original;
    });

    for (const index of [0, 1]) {
      await act(() => click(rowsOf(container)[index]));
      await act();
      const panel = panelOf(container);
      assert.equal(
        one(panel, "data-panel-load-error").textContent.startsWith(
          "Die Konversation konnte nicht geladen werden."
        ),
        true
      );
      assert.equal(withAttribute(panel, "data-panel-not-found").length, 0);
      assert.equal(withAttribute(panel, "data-conversation-actions").length, 0);
      // „⋯" bleibt bedienbar: kopieren ja, löschen nein
      const menuButton = one(panel, "data-panel-menu-button");
      assert.equal(menuButton.hasAttribute("disabled"), false);
      await act(() => click(menuButton));
      const menu = one(panel, "data-panel-menu");
      assert.deepEqual(
        elements(menu, (e) => e.getAttribute("role") === "menuitem").map(
          (e) => e.textContent
        ),
        ["Kennung kopieren", "Link kopieren"]
      );
      await act(() => click(menuButton));
    }
    // erneut versuchen: diesmal klappt es
    state.details[2] = {
      messages: [message(2, "konv-2", { session_id: "sitzung-2" })],
    };
    const before = server.details().length;
    await act(() => click(one(container, "data-panel-retry")));
    await act();
    assert.equal(server.details().length, before + 1);
    const panel = panelOf(container);
    assert.equal(withAttribute(panel, "data-panel-load-error").length, 0);
    assert.equal(withAttribute(panel, "data-message").length, 1);
    assert.equal(withAttribute(panel, "data-conversation-actions").length, 1);
  }
);

test(
  "Fixliste 17 / Fixliste 4 V6: Scheitert das Laden der Liste, steht keine alte Zählung – Fehlermeldung mit „Erneut versuchen“, Export gesperrt; gescheitertes Nachladen behält den Stand, meldet sich am Knopf „Weitere Konversationen laden“; in beiden Fällen kein Toast",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const rows = Array.from({ length: 25 }, (_, i) =>
      row(600 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
      })
    );
    let fail = () => false;
    await panelServer(t, { rows, failList: (body) => fail(body) });
    const counts = [];
    const view = await mountList(t, {
      props: { onViewableCountChange: (count) => counts.push(count) },
    });
    const { container, act } = view;
    assert.equal(rowsOf(container).length, 20);
    const exportButton = () =>
      elements(
        one(container, "data-export-menu"),
        (e) => e.tagName === "BUTTON"
      )[0];
    assert.equal(exportButton().hasAttribute("disabled"), false);

    // Nachladen scheitert: Zeilen, Zählung und „Weitere laden" bleiben
    fail = (body) => body.offset > 0;
    await act(() => click(one(container, "data-load-more")));
    await act();
    assert.equal(rowsOf(container).length, 20);
    assert.equal(withAttribute(container, "data-load-more").length, 1);
    assert.equal(
      one(container, "data-viewable-count").textContent,
      "25 einsehbar"
    );
    assert.equal(withAttribute(container, "data-list-load-error").length, 0);
    // Fixliste 4, V6: kein Toast (er verdeckte den Knopf) – die Meldung
    // steht am Knopf, der es erneut versucht
    assert.deepEqual(shown, []);
    assert.equal(
      one(container, "data-load-more-error").textContent,
      "Weitere Konversationen konnten nicht geladen werden."
    );
    assert.equal(
      one(container, "data-load-more").textContent,
      "Erneut versuchen"
    );

    // Erste Seite einer neuen Auswahl scheitert: keine (alte) Zählung,
    // kein Export, Meldung mit „Erneut versuchen"
    fail = (body) => body.q === "frage";
    await type(view, "frage");
    await act(() => wait(350));
    await act();
    assert.equal(withAttribute(container, "data-list-load-error").length, 1);
    assert.equal(withAttribute(container, "data-viewable-count").length, 0);
    assert.equal(rowsOf(container).length, 0);
    assert.equal(exportButton().hasAttribute("disabled"), true);
    assert.equal(counts.at(-1), null);
    // Fixliste 4, V6: nur die Meldung in der Liste, kein Toast daneben
    assert.deepEqual(shown, []);

    fail = () => false;
    await act(() => click(one(container, "data-list-retry")));
    await act();
    assert.equal(withAttribute(container, "data-list-load-error").length, 0);
    assert.equal(rowsOf(container).length, 20);
    assert.equal(counts.at(-1), 25);
    assert.equal(exportButton().hasAttribute("disabled"), false);
  }
);

test(
  "Fixliste 18: ?q= aus einem Link länger als 200 Zeichen – gekürzt angefragt, mit Hinweis; ungültiges q verworfen – kein 400-Leerzustand",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const server = await panelServer(t, {
      rows: [row(1, { preview: "x".repeat(300) })],
    });
    const long = "x".repeat(250);
    const { container } = await mountList(t, { query: `?q=${long}` });
    const sent = server.lists().map((call) => call.body.q);
    assert.ok(sent.length > 0);
    for (const q of sent)
      assert.equal(q === undefined || [...q].length <= 200, true);
    assert.equal(sent.at(-1), "x".repeat(200));
    assert.deepEqual(rowIds(container), [1]);
    // dieselbe Grenze im Feld (gemeinsame Konstante)
    assert.equal(
      handlersOf(one(container, "data-search-input")).maxLength,
      200
    );
    assert.deepEqual(shown, [
      [
        "info",
        "Der Suchbegriff aus dem Link war länger als 200 Zeichen und wurde gekürzt.",
      ],
    ]);
  }
);

test(
  "Fixliste 18: ?q= mit Steuerzeichen aus einem Link – verworfen mit Hinweis, die Liste ohne Suche",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const server = await panelServer(t, { rows: [row(1), row(2)] });
    const { container } = await mountList(t, { query: "?q=ab%00cd" });
    for (const call of server.lists()) assert.equal(call.body.q, undefined);
    assert.deepEqual(rowIds(container), [1, 2]);
    assert.deepEqual(shown, [
      [
        "info",
        "Der Suchbegriff aus dem Link enthielt ungültige Zeichen und wurde verworfen.",
      ],
    ]);
  }
);

test(
  "Fixliste 19: per Link geöffnet, Konversation auf Seite 3 – die Liste lädt nach, bis sie gefunden ist; dann markiert, vorherige/nächste frei",
  { skip },
  async (t) => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(700 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
      })
    );
    const server = await panelServer(t, {
      rows,
      details: {
        745: {
          messages: [message(745, "konv-745", { session_id: "sitzung-745" })],
        },
      },
    });
    const { container, act } = await mountList(t, {
      query: "?widget=3&conversation=745",
    });
    await act();
    await act();
    // nachgeladen in großen Seiten (Fixliste 3, S2): eine Anfrage statt zwei
    assert.deepEqual(
      server.lists().map((call) => [call.body.offset, call.body.limit]),
      [
        [0, 20],
        [20, 100],
      ]
    );
    assert.deepEqual(currentRows(container), [745]);
    const panel = panelOf(container);
    assert.equal(
      one(panel, "data-panel-previous").hasAttribute("disabled"),
      false
    );
    assert.equal(one(panel, "data-panel-next").hasAttribute("disabled"), false);
    assert.equal(withAttribute(panel, "data-panel-navigation-hint").length, 0);
  }
);

test(
  "Fixliste 19: per Link geöffnet, nicht in der Liste (Filter) – höchstens 500 Zeilen in Seiten zu 100 nachgeladen (Fixliste 3, S2), dann Hinweis; vorherige/nächste gesperrt",
  { skip },
  async (t) => {
    const rows = Array.from({ length: 700 }, (_, i) =>
      row(1000 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 1000,
      })
    );
    const server = await panelServer(t, {
      rows,
      details: {
        5: { messages: [message(5, "nirgends", { session_id: "sitzung-n" })] },
      },
    });
    const { container, act } = await mountList(t, {
      query: "?widget=3&conversation=5",
    });
    for (let i = 0; i < 12; i++) await act();
    assert.deepEqual(
      server.lists().map((call) => [call.body.offset, call.body.limit]),
      [
        [0, 20],
        [20, 100],
        [120, 100],
        [220, 100],
        [320, 100],
        [420, 80],
      ]
    );
    assert.equal(rowsOf(container).length, 500);
    const panel = panelOf(container);
    assert.equal(
      one(panel, "data-panel-navigation-hint").textContent,
      "Diese Konversation steht nicht in der geladenen Liste – vorherige und nächste sind nicht verfügbar."
    );
    assert.equal(
      one(panel, "data-panel-previous").hasAttribute("disabled"),
      true
    );
    assert.equal(one(panel, "data-panel-next").hasAttribute("disabled"), true);
    assert.deepEqual(currentRows(container), []);
  }
);

test(
  "Fixliste 20: Leerzustand mit Suche und weiterem Filter nennt alle Filter",
  { skip },
  async (t) => {
    await panelServer(t, { rows: [row(1, { preview: "Yoga" })] });
    const { container } = await mountList(t, {
      query: "?q=spanisch",
      props: {
        feedbackFilter: "negative",
        bucket: { start: "2026-10-12", end: "2026-10-12", label: "12.10.2026" },
      },
    });
    assert.equal(
      one(container, "data-empty-search").textContent,
      "Keine Konversationen mit „spanisch“ und Filter „Negativ bewertet“, „12.10.2026“ im gewählten Zeitraum"
    );
  }
);

test(
  "Fixliste 21: Ein Zeichen, das getippt wird, während die Adresse die Suche übernimmt, bleibt im Feld; ✕ leert es weiterhin",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [row(1, { preview: "Spanischkurs" }), row(2, { preview: "Yoga" })],
    });
    const view = await mountList(t);
    const { container, act } = view;
    const input = () => one(container, "data-search-input");
    await type(view, "spanis");
    // Die Suche geht in die Adresse (Enter), im selben Augenblick kommt „c"
    await act(() => {
      handlersOf(input()).onKeyDown({ key: "Enter" });
      handlersOf(input()).onChange({ target: { value: "spanisc" } });
    });
    await act();
    assert.equal(input().value, "spanisc");
    assert.equal(
      one(container, "data-search-filter-mark").textContent,
      "Suche: spanis"
    );
    // von außen (✕): das Feld folgt
    const [clear] = elements(
      one(container, "data-search-filter-mark"),
      (e) => e.tagName === "BUTTON"
    );
    await act(() => click(clear));
    await act();
    assert.equal(input().value, "");
  }
);

test(
  "Fixliste 25: Vollbild unter lg – Fokus in den Kopf, Hintergrund inert/aria-hidden; beim Schließen zurück auf die Zeile und alles wieder bedienbar",
  { skip },
  async (t) => {
    stubWidth(t, false);
    await panelServer(t, {
      rows: [row(1), row(2)],
      details: {
        2: { messages: [message(2, "konv-2", { session_id: "sitzung-2" })] },
      },
    });
    const { container, document, act } = await mountList(t);
    const rowTwo = rowsOf(container)[1];
    await act(() => click(rowTwo));
    await act();
    const panel = panelOf(container);
    assert.ok(
      document.activeElement === one(panel, "data-panel-back"),
      "Fokus im Kopf des Vollbilds"
    );
    assert.equal(panel.getAttribute("role"), "dialog");
    assert.equal(panel.getAttribute("aria-modal"), "true");
    const list = one(container, "data-conversation-list");
    const inertAncestor = (element) => {
      for (let node = element; node; node = node.parentNode)
        if (node.hasAttribute?.("inert")) return node;
      return null;
    };
    assert.ok(inertAncestor(list), "Liste liegt hinter dem Vollbild (inert)");
    assert.equal(inertAncestor(list).getAttribute("aria-hidden"), "true");
    assert.equal(inertAncestor(panel), null);

    await act(() => click(one(panel, "data-panel-back")));
    await act();
    assert.equal(panelOf(container), null);
    assert.equal(inertAncestor(list), null);
    assert.equal(
      elements(
        document.body,
        (e) => e.hasAttribute("aria-hidden") && e.hasAttribute("inert")
      ).length,
      0
    );
    assert.ok(
      document.activeElement === rowsOf(container)[1],
      "Fokus zurück auf der Zeile"
    );
  }
);

test(
  "Fixliste 25: ab lg kein Vollbild – kein inert, der Fokus bleibt in der Liste (↑/↓)",
  { skip },
  async (t) => {
    stubWidth(t, true);
    await panelServer(t, { rows: [row(1), row(2)] });
    const { container, document, act } = await mountList(t);
    await act(() => click(rowsOf(container)[0]));
    await act();
    assert.equal(document.activeElement, rowsOf(container)[0]);
    assert.equal(
      elements(document.body, (e) => e.hasAttribute("inert")).length,
      0
    );
    assert.equal(panelOf(container).hasAttribute("role"), false);
  }
);

test(
  "Fixliste 26: Menü „⋯“ mit der Tastatur – Fokus auf dem ersten Eintrag, ↑/↓ wechseln (rundum), Pos1/Ende, Escape zurück auf die Schaltfläche",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [row(1)],
      details: {
        1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
      },
    });
    const { container, document, act } = await mountList(t);
    const escape = captureKeys(t, document);
    await act(() => click(rowsOf(container)[0]));
    await act();
    const button = one(container, "data-panel-menu-button");
    await act(() => click(button));
    const menu = one(container, "data-panel-menu");
    const items = elements(menu, (e) => e.getAttribute("role") === "menuitem");
    assert.equal(items.length, 3);
    assert.equal(document.activeElement, items[0]);
    const key = (name) =>
      act(() =>
        handlersOf(menu).onKeyDown({
          key: name,
          target: document.activeElement,
          preventDefault() {},
        })
      );
    await key("ArrowDown");
    assert.equal(document.activeElement, items[1]);
    await key("ArrowDown");
    await key("ArrowDown");
    assert.equal(document.activeElement, items[0]);
    await key("ArrowUp");
    assert.equal(document.activeElement, items[2]);
    await key("Home");
    assert.equal(document.activeElement, items[0]);
    await key("End");
    assert.equal(document.activeElement, items[2]);
    await escape(act);
    assert.equal(withAttribute(container, "data-panel-menu").length, 0);
    assert.equal(document.activeElement, button);
  }
);

test(
  "Fixliste 27: mobil 44 px – Bewertungs-Umschalter h-11 (ab sm h-9), ✕ der Filtermarkierungen mit 44 × 44 px Trefferfläche",
  { skip },
  async (t) => {
    await panelServer(t, { rows: [row(1, { preview: "Spanisch" })] });
    const { container } = await mountList(t, {
      query: "?q=spanisch",
      props: { feedbackFilter: "negative" },
    });
    const classes = (element) =>
      (element.getAttribute("class") ?? "").split(/\s+/);
    const segments = elements(
      one(container, "data-feedback-filters"),
      (e) => e.tagName === "BUTTON"
    );
    assert.equal(segments.length, 3);
    for (const segment of segments) {
      assert.ok(classes(segment).includes("h-11"));
      assert.ok(classes(segment).includes("sm:h-9"));
    }
    // Fixliste 2, B11: die Schaltfläche selbst misst 44 × 44 px (kein
    // Pseudo-Element) – negativer Rand oben/unten statt höherer Markierung
    const clears = withAttribute(container, "data-filter-clear");
    assert.equal(clears.length, 2);
    for (const clear of clears) {
      assert.equal(clear.tagName, "BUTTON");
      for (const name of ["h-11", "w-11", "-my-[9px]", "shrink-0"])
        assert.ok(classes(clear).includes(name), name);
      assert.ok(
        !classes(clear).some((name) => name.startsWith("before:")),
        "kein Pseudo-Element"
      );
      assert.ok(!classes(clear).some((name) => /^sm:[hw]-/.test(name)));
    }
  }
);

test(
  "Fixliste 11: Treffer nur außerhalb des sichtbaren Texts (Link-Adresse, Quelltext) – das Panel weist darauf hin",
  { skip },
  async (t) => {
    await panelServer(t, {
      searchAll: true,
      rows: [row(1, { preview: "Wo melde ich mich an?" })],
      details: {
        1: {
          messages: [
            message(1, "konv-1", {
              session_id: "sitzung-1",
              prompt: "Wo melde ich mich an?",
            }),
          ],
        },
      },
    });
    const { container, act } = await mountList(t, { query: "?q=vhs-lingen" });
    await act(() => click(rowsOf(container)[0]));
    await act();
    assert.equal(
      one(panelOf(container), "data-panel-hidden-hit").textContent,
      "„vhs-lingen“ steht in dieser Konversation nur in Link-Adressen, im Quelltext oder in ausgeblendeten Gedanken einer Antwort."
    );
  }
);

test(
  "Fixliste 5: Steht die Konversation in der Liste, zählt der Kopf dieselben Zeilen wie ihre Zeile – nicht die Nachrichten außerhalb des Zeitraums",
  { skip },
  async (t) => {
    fixClock(t, TODAY);
    await panelServer(t, {
      rows: [
        row(1, {
          message_count: 2,
          negative_count: 1,
          started_at: berlin("2026-10-12", "12:00"),
          last_message_at: berlin("2026-10-12", "12:05"),
        }),
      ],
      details: {
        1: {
          messages: [
            message(0, "konv-1", {
              session_id: "sitzung-1",
              prompt: "Vor dem Zeitraum",
              createdAt: "2026-08-01T10:00:00.000Z",
              feedbackScore: false,
            }),
            message(1, "konv-1", {
              session_id: "sitzung-1",
              prompt: "Erste Frage im Zeitraum",
              createdAt: new Date(berlin("2026-10-12", "12:00")).toISOString(),
              feedbackScore: false,
            }),
            message(2, "konv-1", {
              session_id: "sitzung-1",
              prompt: "Zweite Frage",
              createdAt: new Date(berlin("2026-10-12", "12:05")).toISOString(),
            }),
          ],
        },
      },
    });
    const { container, act } = await mountList(t);
    await act(() => click(rowsOf(container)[0]));
    await act();
    const panel = panelOf(container);
    assert.equal(
      one(panel, "data-panel-question").textContent,
      "Erste Frage im Zeitraum"
    );
    assert.deepEqual(metaItems(panel), [
      "Montag, 12.10.2026",
      "2 Fragen",
      "12:00–12:05 Uhr",
      "1 Antwort negativ bewertet",
    ]);
    // angezeigt werden alle einsehbaren Nachrichten
    assert.equal(withAttribute(panel, "data-message").length, 3);
  }
);

// ---------------------------------------------------------------------------
// Fixliste 2 (Browser-Abnahme rc14 und Kontroll-Review)
// ---------------------------------------------------------------------------

const classesOf = (element) =>
  (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
/** Zeile aus Titelblock und Werkzeugleiste im Listenkopf. */
const toolbarRowOf = (container) =>
  one(container, "data-list-header").childNodes[0];
const hasClasses = (element, names) =>
  names.every((name) => classesOf(element).includes(name));

test(
  "Fixliste 2 B1/B6/B7, Fixliste 3 V1/V7: Kopfzeile – „N einsehbar“ bzw. „X von Y einsehbar“ neben der Überschrift, Werkzeugleiste fest daneben (schmaler: darunter); eine Zeile für Markierungen nur mit Filter; mobil Export als Symbol neben der Überschrift, Suche und Filter je volle Breite",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [row(1, { preview: "Spanisch", negative_count: 1 }), row(2)],
    });
    const plain = await mountList(t);
    const shape = (container) => {
      const header = one(container, "data-list-header");
      const [toolbarRow] = header.childNodes;
      const tools = one(container, "data-list-tools");
      return {
        toolbarRow: [
          toolbarRow.childNodes.map((c) =>
            ["data-list-title", "data-list-tools"].find((name) =>
              c.hasAttribute(name)
            )
          ),
          classesOf(toolbarRow),
        ],
        title: classesOf(one(container, "data-list-title")),
        tools: classesOf(tools),
        toolsChildren: tools.childNodes.map((c) => classesOf(c).join(" ")),
      };
    };
    const before = shape(plain.container);
    // ohne Filter: keine eigene Zeile für Markierungen (AK-1: Dichte), die
    // Zahl steht neben der Überschrift
    assert.equal(one(plain.container, "data-list-header").childNodes.length, 1);
    assert.equal(withAttribute(plain.container, "data-list-status").length, 0);
    assert.deepEqual(
      one(plain.container, "data-list-title").childNodes.map((c) =>
        ["data-list-heading", "data-viewable-count"].find((name) =>
          c.hasAttribute(name)
        )
      ),
      ["data-list-heading", "data-viewable-count"]
    );
    assert.equal(
      one(plain.container, "data-viewable-count").textContent,
      "2 einsehbar"
    );
    await plain.unmount();

    // mit Suche und Bewertungsfilter: „X von Y“ weiter neben der Überschrift,
    // die Markierungen in einer Zeile darunter – die Leiste steht unverändert
    // (B7); ob sie neben die Überschrift passt, hängt nicht an der Zahl
    // (basis-40)
    const filtered = await mountList(t, {
      query: "?q=spanisch",
      props: { feedbackFilter: "negative" },
    });
    const { container } = filtered;
    await filtered.act();
    assert.deepEqual(shape(container), before);
    assert.ok(
      hasClasses(one(container, "data-list-title"), ["flex-1", "basis-40"])
    );
    assert.match(
      one(one(container, "data-list-title"), "data-viewable-count").textContent,
      /^1 von \d+ einsehbar$/
    );
    const status = one(container, "data-list-status");
    assert.equal(status.parentNode, one(container, "data-list-header"));
    assert.deepEqual(
      status.childNodes.map((c) =>
        ["data-feedback-filter-mark", "data-search-filter-mark"].find((name) =>
          c.hasAttribute(name)
        )
      ),
      ["data-feedback-filter-mark", "data-search-filter-mark"]
    );
    // S1: Die 44-px-Flächen der ✕ ragen je 9 px über die Markierung – 18 px
    // Zeilenabstand, damit sie sich bei umbrochenen Markierungen nicht
    // überlappen
    assert.ok(hasClasses(status, ["flex-wrap", "gap-y-[18px]"]));
    assert.ok(
      withAttribute(status, "data-filter-clear").every((button) =>
        hasClasses(button, ["-my-[9px]", "h-11", "w-11"])
      )
    );
    assert.equal(
      elements(one(container, "data-list-tools"), (e) =>
        e.hasAttribute("data-search-filter-mark")
      ).length,
      0
    );

    // mobil (unter sm): Überschrift und Export in Zeile 1 (order-1/order-2),
    // Suche und Filtergruppe je volle Breite darunter (B1)
    assert.ok(hasClasses(one(container, "data-list-title"), ["order-1"]));
    const tools = one(container, "data-list-tools");
    assert.ok(
      hasClasses(tools, [
        "contents",
        "sm:flex",
        "sm:order-2",
        // V7: von sm bis xl eine eigene Zeile, ab xl neben der Überschrift
        "sm:basis-full",
        "xl:basis-auto",
      ])
    );
    const field = one(container, "data-search-field");
    assert.ok(
      hasClasses(field, [
        "order-3",
        "basis-full",
        "sm:order-none",
        "w-full",
        // V7: von sm bis xl so breit wie möglich (mindestens 240 px), ab xl
        // mit der Basis 240 px (Fixliste 4, V2: Platz für den Abstand zum
        // Benutzermenü); wächst, wenn die Leiste allein in ihrer Zeile steht
        // (Fixliste 5, S4)
        "sm:flex-1",
        "sm:min-w-[240px]",
        "xl:w-60",
        "xl:flex-auto",
      ])
    );
    assert.ok(!classesOf(field).includes("xl:flex-none"));
    // Fixliste 4, V5: von sm bis xl Basis 0 (sm:flex-1) – nicht die volle
    // Zeile über w-full (sm:basis-auto); Filter und Export stehen daneben,
    // sobald sie hineinpassen
    assert.ok(!classesOf(field).includes("sm:basis-auto"));
    assert.ok(!classesOf(field).includes("xl:w-72"));
    // Fixliste 4, V2: die Leiste endet links vom Benutzermenü (rechter
    // Abstand 44 px ab sm: 35 px Menü + 9 px Luft), in jeder Scrollstellung
    assert.ok(hasClasses(tools, ["sm:pr-11"]));
    // Fixliste 4, V1/S3: Die Überschrift hat eine feste Zeile so hoch wie
    // die Leiste; der Titelblock wächst nur nach unten – bricht „X von Y“
    // um, bleiben Überschrift und Leiste stehen (gleiche Klassen mit und
    // ohne Filter: shape oben)
    assert.ok(
      hasClasses(one(container, "data-list-title"), [
        "content-start",
        "items-center",
      ])
    );
    assert.ok(
      !classesOf(one(container, "data-list-title")).some((name) =>
        /min-h-/.test(name)
      )
    );
    assert.ok(
      hasClasses(one(container, "data-list-heading"), [
        "flex",
        "items-center",
        "min-h-11",
        "sm:min-h-10",
      ])
    );
    assert.ok(hasClasses(toolbarRowOf(container), ["items-start"]));
    // Fixliste 4, V5: von sm bis xl etwas schmalere Filter und Export
    for (const segment of elements(
      one(container, "data-feedback-filters"),
      (e) => e.tagName === "BUTTON"
    ))
      assert.ok(hasClasses(segment, ["px-3", "sm:px-2.5", "xl:px-3"]));
    // V7: Filter und Export brechen nur gemeinsam um; mobil ordnen sie sich
    // einzeln ein (contents)
    const actions = one(container, "data-list-actions");
    assert.ok(hasClasses(actions, ["contents", "sm:flex"]));
    const filters = one(container, "data-feedback-filters");
    assert.equal(filters.parentNode, actions);
    assert.ok(hasClasses(filters, ["order-4", "basis-full", "sm:order-none"]));
    const exportMenu = one(container, "data-export-menu");
    assert.equal(exportMenu.parentNode, actions);
    assert.ok(hasClasses(exportMenu, ["order-2", "sm:order-none"]));
    const [exportButton] = elements(exportMenu, (e) => e.tagName === "BUTTON");
    assert.ok(
      hasClasses(exportButton, [
        "h-11",
        "w-11",
        "sm:w-auto",
        "sm:h-10",
        "sm:px-2.5",
        "xl:px-3.5",
      ])
    );
    // der Name „Exportieren“ bleibt für Screenreader, sichtbar erst ab sm;
    // der Pfeil erst ab xl (kompakt, V7)
    const [label] = elements(exportButton, (e) => e.tagName === "SPAN");
    assert.equal(label.textContent, "Exportieren");
    assert.ok(hasClasses(label, ["sr-only", "sm:not-sr-only"]));
    const [caret] = elements(exportButton, (e) => e.tagName === "svg").slice(
      -1
    );
    assert.ok(hasClasses(caret, ["hidden", "xl:block"]));

    // B6: voller Platzhalter, Name des Felds ausführlich (Fixliste 5, V1:
    // kürzer, damit er bei 240 px Rahmen ganz zu lesen ist)
    const input = one(container, "data-search-input");
    assert.equal(
      input.getAttribute("placeholder"),
      "Fragen & Antworten suchen"
    );
    assert.equal(
      input.getAttribute("aria-label"),
      "In Fragen, Antworten und Bewertungen suchen"
    );
  }
);

test(
  "Fixliste 2, B2: im hellen Theme gedämpfte Schrift #5f6368 (Variable --theme-analytics-text-muted) für inaktive Filter, Platzhalter, Menüeinträge und „Konversation löschen“",
  { skip },
  async (t) => {
    const MUTED = "text-[color:var(--theme-analytics-text-muted)]";
    await panelServer(t, {
      rows: [row(1)],
      details: {
        1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
      },
    });
    const { container, act } = await mountList(t);
    const segments = elements(
      one(container, "data-feedback-filters"),
      (e) => e.tagName === "BUTTON"
    );
    for (const segment of segments.filter(
      (s) => s.getAttribute("aria-pressed") === "false"
    )) {
      assert.ok(classesOf(segment).includes(MUTED), segment.textContent);
      assert.ok(!classesOf(segment).includes("text-theme-text-secondary"));
    }
    assert.ok(
      classesOf(one(container, "data-search-input")).includes(
        "light:placeholder:text-[color:var(--theme-analytics-text-muted)]"
      )
    );
    await act(() => click(rowsOf(container)[0]));
    await act();
    await act(() => click(one(container, "data-panel-menu-button")));
    for (const item of elements(
      one(container, "data-panel-menu"),
      (e) => e.getAttribute("role") === "menuitem"
    )) {
      assert.ok(classesOf(item).includes(MUTED), item.textContent);
      assert.ok(!classesOf(item).includes("text-theme-text-secondary"));
    }
    const footerDelete = one(container, "data-delete-conversation");
    assert.ok(classesOf(footerDelete).includes(MUTED));
    assert.ok(!classesOf(footerDelete).includes("text-theme-text-secondary"));
  }
);

test(
  "Fixliste 2, B4: Das Panel klebt ab lg 64 px unter dem oberen Rand – sein Kopf liegt unter dem Benutzermenü oben rechts",
  { skip },
  async (t) => {
    await panelServer(t, { rows: [row(1)] });
    const { container, act } = await mountList(t);
    await act(() => click(rowsOf(container)[0]));
    const panel = panelOf(container);
    assert.ok(
      hasClasses(panel, [
        "lg:sticky",
        "lg:top-16",
        "lg:max-h-[calc(100vh-112px)]",
      ])
    );
    assert.ok(!classesOf(panel).includes("lg:top-4"));
  }
);

test(
  "Fixliste 2, B8: eigenes ✕ im Suchfeld (≥ 44 px mobil, mit Namen) statt des blauen des Browsers – leert Feld und Suche",
  { skip },
  async (t) => {
    const server = await panelServer(t, {
      rows: [row(1, { preview: "Spanisch" }), row(2, { preview: "Yoga" })],
    });
    const view = await mountList(t);
    const { container, act } = view;
    const input = one(container, "data-search-input");
    assert.ok(
      classesOf(input).includes("[&::-webkit-search-cancel-button]:hidden")
    );
    assert.equal(withAttribute(container, "data-search-clear").length, 0);
    await type(view, "spanisch");
    await act(() => wait(350));
    await act();
    assert.equal(rowsOf(container).length, 1);
    const clear = one(container, "data-search-clear");
    assert.equal(clear.tagName, "BUTTON");
    assert.equal(clear.getAttribute("aria-label"), "Suchfeld leeren");
    assert.ok(hasClasses(clear, ["h-11", "w-11"]));
    await act(() => click(clear));
    await act();
    assert.equal(input.value ?? input.getAttribute("value"), "");
    assert.equal(rowsOf(container).length, 2);
    assert.equal(server.lists().at(-1).body.q, undefined);
    assert.equal(withAttribute(container, "data-search-clear").length, 0);
  }
);

test(
  "Fixliste 2 B9 / Fixliste 3 V5: Zeile unter der Frage als Teile – der Trenner „·“ steht vor jedem Teil (CSS) und wird am Zeilenanfang abgeschnitten: keine Zeile beginnt oder endet mit „·“",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [
        row(1, {
          message_count: 3,
          negative_count: 1,
          positive_count: 1,
        }),
      ],
    });
    const { container, act } = await mountList(t);
    await act(() => click(rowsOf(container)[0]));
    const items = withAttribute(
      one(container, "data-panel-meta"),
      "data-meta-item"
    );
    assert.ok(items.length >= 4);
    for (const item of items) {
      assert.doesNotMatch(item.textContent, /^\s*·|·\s*$/);
      // der Trenner als 16 px breites Kästchen VOR dem Teil – kein Trenner
      // dahinter, der am Zeilenende stehen bliebe
      assert.ok(
        hasClasses(item, [
          "whitespace-nowrap",
          "before:inline-block",
          "before:w-4",
          "before:content-['·']",
        ])
      );
      assert.ok(!classesOf(item).some((name) => name.includes("after:")));
    }
    // die Zeile um genau dieses Kästchen nach links verschoben, der Rahmen
    // schneidet ab: Am Anfang jeder (auch umbrochenen) Zeile ist der Trenner
    // nicht zu sehen
    const meta = one(container, "data-panel-meta");
    assert.ok(hasClasses(meta, ["flex", "flex-wrap", "-ml-4"]));
    assert.ok(hasClasses(meta.parentNode, ["overflow-hidden"]));
  }
);

test(
  "Fixliste 2, R3: „Nächste“ am Seitenende, dann Escape – wird dieselbe Zeile später wieder geöffnet, springt das Panel nicht weiter",
  { skip },
  async (t) => {
    let release;
    const rows = Array.from({ length: 25 }, (_, i) =>
      row(500 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
      })
    );
    const state = {
      rows,
      holdMore: new Promise((resolve) => {
        release = resolve;
      }),
    };
    const server = await panelServer(t, state);
    const view = await mountList(t);
    const { container, document, act } = view;
    const escape = captureKeys(t, document);
    await act(() => click(rowsOf(container)[19]));
    await act();
    await act(() => click(one(container, "data-panel-next")));
    assert.equal(server.lists().at(-1).body.offset, 20);
    await escape(act);
    assert.equal(panelOf(container), null);
    await act(() => release());
    await act();
    await act();
    assert.equal(rowsOf(container).length, 25);
    // dieselbe Zeile wieder öffnen
    await act(() => click(rowsOf(container)[19]));
    await act();
    await act();
    assert.deepEqual(currentRows(container), [519]);
    assert.equal(server.details().at(-1), 519);
  }
);

test(
  "Fixliste 2, R4: Per Link geöffnet, das Nachladen scheitert – die Suche bricht ab: eine Meldung, keine weiteren Anfragen, Hinweis „konnte nicht weiter geladen werden“",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(700 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
      })
    );
    const server = await panelServer(t, {
      rows,
      failList: (body) => body.offset > 0,
      details: {
        745: {
          messages: [message(745, "konv-745", { session_id: "sitzung-745" })],
        },
      },
    });
    const { container, act } = await mountList(t, {
      query: "?widget=3&conversation=745",
    });
    for (let i = 0; i < 12; i++) await act();
    assert.deepEqual(
      server.lists().map((call) => call.body.offset),
      [0, 20]
    );
    // eine Meldung – seit Fixliste 4, V6 am Knopf „Weitere Konversationen
    // laden“ statt als Toast, der ihn verdeckte
    assert.deepEqual(shown, []);
    assert.equal(withAttribute(container, "data-load-more-error").length, 1);
    const panel = panelOf(container);
    assert.equal(
      one(panel, "data-panel-navigation-hint").textContent,
      "Die Liste konnte nicht weiter geladen werden – vorherige und nächste sind nicht verfügbar."
    );
    assert.equal(
      one(panel, "data-panel-previous").hasAttribute("disabled"),
      true
    );
    assert.equal(one(panel, "data-panel-next").hasAttribute("disabled"), true);
    // der bisherige Stand der Liste bleibt
    assert.equal(rowsOf(container).length, 20);
  }
);

test(
  "Fixliste 2, R5: Aus der Liste geöffnet, dann eine Suche, die die Zeile ausschließt – kein Nachladen von bis zu 10 Seiten, gleich der Hinweis",
  { skip },
  async (t) => {
    const rows = [
      row(700, { preview: "Yoga am Morgen" }),
      ...Array.from({ length: 59 }, (_, i) =>
        row(701 + i, {
          preview: `Frage ${701 + i}`,
          last_message_at: berlin("2026-10-12", "12:00") - (i + 1) * 60000,
        })
      ),
    ];
    const server = await panelServer(t, {
      rows,
      details: {
        700: {
          messages: [message(700, "konv-700", { session_id: "sitzung-700" })],
        },
      },
    });
    const view = await mountList(t);
    const { container, act } = view;
    await act(() => click(rowsOf(container)[0]));
    await act();
    assert.deepEqual(currentRows(container), [700]);
    await type(view, "frage");
    await act(() => wait(350));
    for (let i = 0; i < 6; i++) await act();
    const searched = server.lists().filter((call) => call.body.q === "frage");
    assert.deepEqual(
      searched.map((call) => call.body.offset),
      [0]
    );
    assert.equal(rowsOf(container).length, 20);
    const panel = panelOf(container);
    assert.ok(panel, "Panel bleibt offen");
    assert.equal(
      one(panel, "data-panel-navigation-hint").textContent,
      "Diese Konversation steht nicht in der geladenen Liste – vorherige und nächste sind nicht verfügbar."
    );
  }
);

test(
  "Fixliste 2, R7/S5: Die Lösch-Rückfrage erscheint sofort (Ladehinweis, „Löschen“ gesperrt, Escape schließt nur sie); scheitert die Vorschau, nennt sie keine Zahl",
  { skip },
  async (t) => {
    let release;
    const state = {
      rows: [row(1, { message_count: 3 })],
      details: {
        1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
      },
      holdPreview: new Promise((resolve) => {
        release = resolve;
      }),
      preview: { success: false, error: "kaputt" },
    };
    await panelServer(t, state);
    const view = await mountList(t);
    const { container, document, act } = view;
    const escape = captureKeys(t, document);
    await act(() => click(rowsOf(container)[0]));
    await act();
    const dialogs = () => withAttribute(document.body, "data-confirm-dialog");

    // Vorschau lädt noch: Rückfrage mit Ladehinweis, „Löschen“ gesperrt
    await act(() => click(one(container, "data-delete-conversation")));
    assert.equal(dialogs().length, 1);
    assert.equal(
      one(dialogs()[0], "data-confirm-count").textContent,
      "Laden …"
    );
    assert.equal(
      one(dialogs()[0], "data-confirm-delete").hasAttribute("disabled"),
      true
    );
    // Escape während des Ladens: nur die Rückfrage schließt
    await escape(act);
    assert.equal(dialogs().length, 0);
    assert.ok(panelOf(container), "Panel bleibt offen");

    // Vorschau gescheitert: keine (falsche) Zahl
    await act(() => release());
    await act();
    await act(() => click(one(container, "data-delete-conversation")));
    await act();
    const [dialog] = dialogs();
    assert.equal(
      one(dialog, "data-confirm-count").textContent,
      "Die Konversation wird endgültig gelöscht."
    );
    assert.doesNotMatch(dialog.textContent, /\d+ Nachricht/);
    assert.equal(
      one(dialog, "data-confirm-delete").hasAttribute("disabled"),
      false
    );
  }
);

test(
  "Fixliste 2, R8: Menü „⋯“ – „Konversation löschen“ steht immer vor „Alle Konversationen dieses Besuchers löschen“; dieser Eintrag ist gesperrt, bis die Vorschau da ist, und schiebt sich nicht davor",
  { skip },
  async (t) => {
    const menuState = (container) =>
      elements(
        one(container, "data-panel-menu"),
        (e) => e.getAttribute("role") === "menuitem"
      ).map((e) => [e.textContent, e.getAttribute("aria-disabled") ?? ""]);
    for (const visitor of [{ conversationCount: 3, messageCount: 7 }, null]) {
      let release;
      await panelServer(t, {
        rows: [row(1)],
        details: {
          1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
        },
        holdPreview: new Promise((resolve) => {
          release = resolve;
        }),
        preview: { success: true, messageCount: 2, visitor },
      });
      const view = await mountList(t);
      const { container, document, act } = view;
      await act(() => click(rowsOf(container)[0]));
      await act();
      await act(() => click(one(container, "data-panel-menu-button")));
      assert.deepEqual(menuState(container), [
        ["Kennung kopieren", ""],
        ["Link kopieren", ""],
        ["Konversation löschen", ""],
        ["Alle Konversationen dieses Besuchers löschen", "true"],
      ]);
      // gesperrt: Klick öffnet nichts
      await act(() => click(one(container, "data-delete-visitor")));
      assert.equal(
        withAttribute(document.body, "data-confirm-dialog").length,
        0
      );

      await act(() => release());
      await act();
      if (!withAttribute(container, "data-panel-menu").length)
        await act(() => click(one(container, "data-panel-menu-button")));
      assert.deepEqual(
        menuState(container),
        visitor
          ? [
              ["Kennung kopieren", ""],
              ["Link kopieren", ""],
              ["Konversation löschen", ""],
              ["Alle Konversationen dieses Besuchers löschen", ""],
            ]
          : [
              ["Kennung kopieren", ""],
              ["Link kopieren", ""],
              ["Konversation löschen", ""],
            ]
      );
      await view.unmount();
    }
  }
);

test(
  "Fixliste 2, R9: Wird „Exportieren“ gesperrt (Suche ohne Treffer), schließt die offene Auswahl",
  { skip },
  async (t) => {
    await panelServer(t, { rows: [row(1, { preview: "Spanisch" })] });
    const view = await mountList(t);
    const { container, act } = view;
    const exportButton = elements(
      one(container, "data-export-menu"),
      (e) => e.tagName === "BUTTON"
    )[0];
    await act(() => click(exportButton));
    assert.equal(withAttribute(container, "data-export-format").length, 2);
    await type(view, "xyzkeintreffer");
    await act(() => wait(350));
    await act();
    await act();
    assert.equal(exportButton.hasAttribute("disabled"), true);
    assert.equal(withAttribute(container, "data-export-format").length, 0);
    assert.equal(exportButton.getAttribute("aria-expanded"), "false");
  }
);

test(
  "Fixliste 2, S1: Tooltips mit dem vollen Zeitpunkt in Berliner Zeit – wie Uhrzeit und Tagesgruppe, unabhängig von der Zeitzone des Browsers",
  { skip },
  async (t) => {
    fixClock(t, TODAY);
    await panelServer(t, {
      rows: [
        row(1, {
          started_at: berlin("2026-10-13", "07:47"),
          last_message_at: berlin("2026-10-13", "07:48"),
        }),
      ],
      details: {
        1: {
          messages: [
            message(1, "konv-1", {
              session_id: "sitzung-1",
              createdAt: new Date(berlin("2026-10-13", "07:47")).toISOString(),
            }),
          ],
        },
      },
    });
    const { container, act } = await mountList(t);
    assert.equal(
      one(rowsOf(container)[0], "data-row-time").getAttribute("title"),
      "13.10.2026, 07:48:00 Uhr"
    );
    await act(() => click(rowsOf(container)[0]));
    await act();
    const [, span] = withAttribute(
      one(container, "data-panel-meta"),
      "data-meta-item"
    );
    assert.equal(
      span.getAttribute("title"),
      "13.10.2026, 07:47:00 Uhr – 13.10.2026, 07:48:00 Uhr"
    );
    const [visitor] = elements(
      one(container, "data-panel-body"),
      (e) => /^Besucher/.test(e.textContent) && e.tagName === "SPAN"
    );
    assert.equal(visitor.getAttribute("title"), "13.10.2026, 07:47:00 Uhr");
  }
);

test(
  "Fixliste 2, S3: Vollbild unter lg – Meldungen (Toastify) und Dialog-Portale bleiben bedienbar, der übrige Hintergrund ist inert",
  { skip },
  async (t) => {
    stubWidth(t, false);
    await panelServer(t, {
      rows: [row(1)],
      details: {
        1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
      },
    });
    const { container, document, act } = await mountList(t);
    const add = (attributes) => {
      const element = document.createElement("div");
      for (const [name, value] of Object.entries(attributes))
        element.setAttribute(name, value);
      document.body.appendChild(element);
      return element;
    };
    const toastify = add({ class: "Toastify" });
    const portal = add({ class: "fixed" });
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    portal.appendChild(dialog);
    const other = add({ "data-anderes": "" });
    t.after(() => {
      for (const element of [toastify, portal, other])
        element.parentNode?.removeChild(element);
    });
    await act(() => click(rowsOf(container)[0]));
    await act();
    assert.equal(toastify.hasAttribute("inert"), false);
    assert.equal(toastify.hasAttribute("aria-hidden"), false);
    assert.equal(portal.hasAttribute("inert"), false);
    assert.equal(other.hasAttribute("inert"), true);
    assert.equal(other.getAttribute("aria-hidden"), "true");
  }
);

test(
  "Fixliste 2, B5: Per Link oder nach dem Neuladen geöffnet – die Seite springt einmal zur Liste (ab lg), sobald Kennzahlen und Liste stehen; mobil und ohne Konversation nicht",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [row(1), row(5)],
      details: {
        5: { messages: [message(5, "konv-5", { session_id: "sitzung-5" })] },
      },
    });
    // Prototyp der Elemente, um scrollIntoView vor dem Einhängen zu belauschen
    const probe = await mountList(t);
    const prototype = Object.getPrototypeOf(rowsOf(probe.container)[0]);
    await probe.unmount();
    const scrolled = [];
    const original = prototype.scrollIntoView;
    prototype.scrollIntoView = function (options) {
      scrolled.push([classesOf(this).includes("scroll-mt-20"), options]);
    };
    t.after(() => {
      prototype.scrollIntoView = original;
    });
    const mountView = async (query, wide) => {
      const restore = globalThis.window.matchMedia;
      globalThis.window.matchMedia = (q) => ({
        matches: q.includes("1024") ? wide : false,
        addEventListener() {},
        removeEventListener() {},
      });
      const mounted = await renderer.mount(VIEW, {
        location: `${LOCATION}${query}`,
        route: LOCATION,
        exportName: "AnalyticsScreen",
        props: {
          embedsLoaded: true,
          embeds: [
            {
              id: EMBED_ID,
              chat_retention_days: null,
              workspace: { name: "VHS" },
            },
          ],
        },
      });
      for (let i = 0; i < 4; i++) await mounted.act();
      await mounted.unmount();
      globalThis.window.matchMedia = restore;
    };

    await mountView("?widget=3&conversation=5", true);
    assert.deepEqual(scrolled, [[true, { block: "start" }]]);
    scrolled.length = 0;
    await mountView("?widget=3&conversation=5", false);
    assert.deepEqual(scrolled, []);
    await mountView("?widget=3", true);
    assert.deepEqual(scrolled, []);
  }
);

// ---------------------------------------------------------------------------
// Fixliste 3 (Kontroll-Review 2): Zustand der Link-Suche abgeleitet
// ---------------------------------------------------------------------------

test(
  "Fixliste 3, C4: Per Link geöffnet, ein Nachladen scheitert – der Hinweis „konnte nicht weiter geladen werden“ verschwindet, sobald ein Nachladen wieder gelingt; die Suche findet die Konversation dann doch",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const rows = Array.from({ length: 160 }, (_, i) =>
      row(700 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
      })
    );
    let failures = 1;
    const server = await panelServer(t, {
      rows,
      // genau das erste Nachladen scheitert
      failList: (body) => body.offset > 0 && failures-- > 0,
      details: {
        845: {
          messages: [message(845, "konv-845", { session_id: "sitzung-845" })],
        },
      },
    });
    const { container, act } = await mountList(t, {
      query: "?widget=3&conversation=845",
    });
    for (let i = 0; i < 6; i++) await act();
    assert.deepEqual(
      server.lists().map((call) => [call.body.offset, call.body.limit]),
      [
        [0, 20],
        [20, 100],
      ]
    );
    // Fixliste 4, V6: die Meldung am Knopf, kein Toast
    assert.deepEqual(shown, []);
    assert.equal(withAttribute(container, "data-load-more-error").length, 1);
    const hint = () =>
      withAttribute(panelOf(container), "data-panel-navigation-hint").map(
        (element) => element.textContent
      );
    assert.deepEqual(hint(), [
      "Die Liste konnte nicht weiter geladen werden – vorherige und nächste sind nicht verfügbar.",
    ]);

    // „Weitere laden“ gelingt: Der Hinweis ist fort, die Suche läuft weiter
    await act(() => click(one(container, "data-load-more")));
    for (let i = 0; i < 6; i++) await act();
    assert.deepEqual(
      server.lists().map((call) => [call.body.offset, call.body.limit]),
      [
        [0, 20],
        [20, 100],
        [20, 20],
        [40, 100],
        [140, 100],
      ]
    );
    assert.deepEqual(hint(), []);
    assert.equal(withAttribute(container, "data-load-more-error").length, 0);
    assert.deepEqual(currentRows(container), [845]);
    assert.equal(
      one(panelOf(container), "data-panel-next").hasAttribute("disabled"),
      false
    );
  }
);

test(
  "Fixliste 3, C6: Hat der gesperrte Eintrag „Alle Konversationen dieses Besuchers löschen“ den Fokus und verschwindet (kein weiterer Besuch), geht der Fokus auf den letzten verbliebenen Eintrag",
  { skip },
  async (t) => {
    let release;
    await panelServer(t, {
      rows: [row(1)],
      details: {
        1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
      },
      holdPreview: new Promise((resolve) => {
        release = resolve;
      }),
      preview: { success: true, messageCount: 1, visitor: null },
    });
    const { container, document, act } = await mountList(t);
    await act(() => click(rowsOf(container)[0]));
    await act();
    await act(() => click(one(container, "data-panel-menu-button")));
    const menu = one(container, "data-panel-menu");
    // Ende: der gesperrte Eintrag (mit den Pfeiltasten erreichbar)
    await act(() =>
      handlersOf(menu).onKeyDown({
        key: "End",
        target: document.activeElement,
        preventDefault() {},
      })
    );
    assert.equal(document.activeElement, one(container, "data-delete-visitor"));

    await act(() => release());
    await act();
    assert.equal(withAttribute(container, "data-delete-visitor").length, 0);
    assert.equal(document.activeElement, one(container, "data-menu-delete"));
    // die Pfeiltasten gehen von dort aus weiter
    await act(() =>
      handlersOf(one(container, "data-panel-menu")).onKeyDown({
        key: "ArrowUp",
        target: document.activeElement,
        preventDefault() {},
      })
    );
    assert.equal(document.activeElement, one(container, "data-menu-copy-link"));
  }
);

/**
 * Maße für das Panel (Fixliste 3, V3/V8): Oberkante im Fenster und
 * Fensterhöhe; scrollIntoView des Panels wird gemerkt.
 */
/**
 * Maße des Panels im Fenster. top und containerBottom (Unterkante des
 * Bereichs aus Liste und Panel) sind Zahlen oder Funktionen – so lässt sich
 * eine Verschiebung ohne Scrollen nachstellen.
 */
function panelGeometry(
  t,
  document,
  { top, viewportHeight = 900, containerBottom }
) {
  const valueOf = (value) => (typeof value === "function" ? value() : value);
  // die Klasse, die getBoundingClientRect und scrollIntoView liefert
  let proto = Object.getPrototypeOf(document.body);
  while (!Object.prototype.hasOwnProperty.call(proto, "getBoundingClientRect"))
    proto = Object.getPrototypeOf(proto);
  const original = {
    rect: proto.getBoundingClientRect,
    scroll: proto.scrollIntoView,
    height: globalThis.window.innerHeight,
  };
  const scrolled = [];
  const isPanel = (node) => node?.hasAttribute?.("data-conversation-panel");
  proto.getBoundingClientRect = function () {
    if (isPanel(this)) {
      const y = valueOf(top);
      return { x: 0, y, top: y, left: 0, width: 520, height: 600 };
    }
    const bottom = valueOf(containerBottom);
    if (bottom !== undefined && (this.childNodes ?? []).some(isPanel))
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: 1000,
        height: bottom,
        bottom,
      };
    return original.rect.call(this);
  };
  proto.scrollIntoView = function (options) {
    if (this.hasAttribute?.("data-conversation-panel")) scrolled.push(options);
    return original.scroll.call(this, options);
  };
  globalThis.window.innerHeight = viewportHeight;
  t.after(() => {
    proto.getBoundingClientRect = original.rect;
    proto.scrollIntoView = original.scroll;
    globalThis.window.innerHeight = original.height;
  });
  return scrolled;
}

test(
  "Fixliste 3, V3/V8: ab lg endet das Panel über dem unteren Fensterrand; steht es beim Öffnen so tief, dass kaum etwas zu sehen ist, wird es weich nach oben geholt – sonst bleibt die Seite stehen; per Link nicht (die Seite springt zur Liste)",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const details = {
      1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
    };
    for (const [top, maxHeight, reveal] of [
      [700, "240px", true],
      [300, "568px", false],
      [124, "744px", false],
    ]) {
      await panelServer(t, { rows: [row(1), row(2)], details });
      const view = await mountList(t);
      const scrolled = panelGeometry(t, view.document, { top });
      await view.act(() => click(rowsOf(view.container)[0]));
      await view.act();
      const panel = panelOf(view.container);
      assert.equal(panel.style.maxHeight, maxHeight, String(top));
      assert.deepEqual(
        scrolled,
        reveal ? [{ block: "start", behavior: "smooth" }] : [],
        String(top)
      );
      await view.unmount();
    }
    // die Klasse dazu: scroll-mt-16 – scrollIntoView bringt das Panel an
    // seine Klebekante unter dem Benutzermenü
    await panelServer(t, { rows: [row(1)], details });
    // Maße schon vor dem Einhängen: Das Panel öffnet mit der Seite
    const scrolled = panelGeometry(t, globalThis.document, { top: 700 });
    const linked = await mountList(t, { query: "?widget=3&conversation=1" });
    await linked.act();
    assert.equal(panelOf(linked.container).style.maxHeight, "240px");
    assert.ok(
      hasClasses(panelOf(linked.container), ["lg:scroll-mt-16", "lg:sticky"])
    );
    // per Link geöffnet: kein Holen (die Ansicht springt zur Liste)
    assert.deepEqual(scrolled, []);
    // die Liste ist ab lg mindestens so hoch wie das Panel werden kann –
    // die Seite lässt sich immer weit genug scrollen
    assert.ok(
      hasClasses(panelOf(linked.container).parentNode, [
        "lg:min-h-[calc(100vh-112px)]",
      ])
    );
  }
);

test(
  "Fixliste 3, V3: unter lg (Vollbild) keine angepasste Höhe",
  { skip },
  async (t) => {
    stubWidth(t, false);
    await panelServer(t, {
      rows: [row(1)],
      details: {
        1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
      },
    });
    const view = await mountList(t);
    const scrolled = panelGeometry(t, view.document, { top: 700 });
    await view.act(() => click(rowsOf(view.container)[0]));
    await view.act();
    assert.equal(panelOf(view.container).style.maxHeight, undefined);
    assert.deepEqual(scrolled, []);
  }
);

test(
  "Fixliste 3, V9/V11: ✕ im Suchfeld – der Fokus bleibt im Feld (das ✕ nimmt ihn beim Drücken nicht); ✕ einer Markierung gibt ihn ins Suchfeld bzw. auf „Alle“; ein Klick auf die Lupe fokussiert das Feld",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [
        row(1, { preview: "Spanisch", negative_count: 1 }),
        row(2, { preview: "Yoga" }),
      ],
    });
    const view = await mountList(t);
    const { container, document, act } = view;
    const input = one(container, "data-search-input");

    // V11: Lupe bzw. Rand des Rahmens
    const field = one(container, "data-search-field");
    const [icon] = elements(field, (e) => e.tagName === "svg");
    await act(() => handlersOf(field).onClick({ target: icon }));
    assert.equal(document.activeElement, input);
    input.blur();
    await act(() => handlersOf(field).onClick({ target: field }));
    assert.equal(document.activeElement, input);

    // V9: das ✕ des Felds
    await type(view, "spanisch");
    await act(() => wait(350));
    await act();
    const clear = one(container, "data-search-clear");
    let prevented = false;
    handlersOf(clear).onMouseDown({
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    await act(() => click(clear));
    await act();
    assert.equal(document.activeElement, input);
    assert.equal(withAttribute(container, "data-search-clear").length, 0);

    // V9: das ✕ der Markierung „Suche: …“ verschwindet mit der Suche
    await type(view, "spanisch");
    await act(() => wait(350));
    await act();
    const markClear = one(
      one(container, "data-search-filter-mark"),
      "data-filter-clear"
    );
    await act(() => click(markClear));
    await act();
    assert.equal(withAttribute(container, "data-search-filter-mark").length, 0);
    assert.equal(document.activeElement, input);
    await view.unmount();

    // ✕ der Markierung „Filter: Negativ bewertet“ → „Alle“
    await panelServer(t, { rows: [row(1, { negative_count: 1 })] });
    let filter = "negative";
    const filtered = await mountList(t, {
      props: {
        feedbackFilter: "negative",
        onFeedbackFilterChange: (next) => {
          filter = next;
        },
      },
    });
    await filtered.act(() =>
      click(
        one(
          one(filtered.container, "data-feedback-filter-mark"),
          "data-filter-clear"
        )
      )
    );
    assert.equal(filter, "all");
    const [all] = elements(
      one(filtered.container, "data-feedback-filters"),
      (e) => e.tagName === "BUTTON"
    );
    assert.equal(filtered.document.activeElement, all);
  }
);

test(
  "Fixliste 3, V10: Lädt der Verlauf noch, ist weder „⋯“ noch „Konversation löschen“ bedienbar – Escape schließt das Panel (keine Rückfrage, kein Menü offen)",
  { skip },
  async (t) => {
    let release;
    await panelServer(t, {
      rows: [row(1)],
      details: {
        1: {
          hold: new Promise((resolve) => {
            release = resolve;
          }),
          messages: [message(1, "konv-1", { session_id: "sitzung-1" })],
        },
      },
    });
    const view = await mountList(t);
    const { container, document, act } = view;
    const escape = captureKeys(t, document);
    await act(() => click(rowsOf(container)[0]));
    const panel = panelOf(container);
    assert.ok(panel);
    assert.match(panel.textContent, /Laden …/);
    assert.equal(
      one(panel, "data-panel-menu-button").hasAttribute("disabled"),
      true
    );
    assert.equal(withAttribute(panel, "data-delete-conversation").length, 0);
    await escape(act);
    assert.equal(panelOf(container), null);
    await act(() => release());
    await act();
    assert.equal(panelOf(container), null);
  }
);

// ---------------------------------------------------------------------------
// Fixliste 4 (Browser-Nachprüfung rc16, Kontroll-Review 3)
// ---------------------------------------------------------------------------

/** ResizeObserver der Ansicht abfangen: je Beobachter Rückruf und Ziele. */
function stubResizeObserver(t) {
  const observers = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
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
    globalThis.ResizeObserver = original;
  });
  return observers;
}

/** Lauscher am Dokument abfangen (je Ereignistyp der zuletzt angemeldete). */
function captureDocumentListeners(t, document) {
  const listeners = new Map();
  const original = {
    add: Object.getOwnPropertyDescriptor(document, "addEventListener"),
    remove: Object.getOwnPropertyDescriptor(document, "removeEventListener"),
  };
  document.addEventListener = (type, listener) => {
    const list = listeners.get(type) ?? [];
    list.push(listener);
    listeners.set(type, list);
  };
  document.removeEventListener = (type, listener) => {
    const list = listeners.get(type) ?? [];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  };
  t.after(() => {
    for (const [key, descriptor] of [
      ["addEventListener", original.add],
      ["removeEventListener", original.remove],
    ])
      if (descriptor) Object.defineProperty(document, key, descriptor);
      else delete document[key];
  });
  return {
    fire: (type) =>
      [...(listeners.get(type) ?? [])].forEach((listener) =>
        listener({ type, target: document.body })
      ),
    count: (type) => (listeners.get(type) ?? []).length,
  };
}

test(
  "Fixliste 4, V4: Verschiebt sich das Panel ohne Scrollen (Zeile der Filtermarkierungen erscheint/verschwindet), passt sich seine Höhe an – ResizeObserver auf den Vorfahren",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const observers = stubResizeObserver(t);
    await panelServer(t, {
      rows: [row(1, { preview: "Spanisch" }), row(2)],
      details: {
        1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
      },
    });
    const view = await mountList(t);
    const { container, act } = view;
    let top = 300;
    panelGeometry(t, view.document, { top: () => top });
    await act(() => click(rowsOf(container)[0]));
    await act();
    const panel = panelOf(container);
    assert.equal(panel.style.maxHeight, "568px");

    // Beobachtet werden die Vorfahren des Panels: der Bereich aus Liste
    // und Panel und die Liste mit ihrem Kopf (darin erscheint die Zeile)
    const observer = observers.find((o) =>
      o.observed.includes(panel.parentNode)
    );
    assert.ok(observer, "kein ResizeObserver auf dem Bereich des Panels");
    assert.ok(
      observer.observed.includes(one(container, "data-list-header").parentNode)
    );

    // Suche: Die Zeile „Suche: …“ erscheint, das Panel rutscht 38 px tiefer
    // – kein Scroll-Ereignis, nur die Größe der Liste ändert sich
    await type(view, "spanisch");
    await act(() => wait(350));
    await act();
    assert.equal(withAttribute(container, "data-list-status").length, 1);
    top = 338;
    await act(() => observer.callback([]));
    await act(() => wait(20));
    assert.equal(panel.style.maxHeight, "530px");
    // Die Zeile verschwindet wieder (✕): keine Lücke
    await act(() => click(one(container, "data-filter-clear")));
    await act(() => wait(350));
    top = 300;
    await act(() => observer.callback([]));
    await act(() => wait(20));
    assert.equal(panel.style.maxHeight, "568px");

    // Schließen trennt den Beobachter
    await act(() => click(one(container, "data-panel-close")));
    await act();
    assert.equal(observer.disconnected, true);
  }
);

test(
  "Fixliste 4, V3: Am Seitenende (kurze Liste) endet das Panel über der Unterkante seines Bereichs – es bleibt bei 80 px unter dem Benutzermenü statt nach oben geschoben zu werden",
  { skip },
  async (t) => {
    stubWidth(t, true);
    await panelServer(t, {
      rows: [row(1), row(2)],
      details: {
        1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
      },
    });
    const view = await mountList(t);
    // ganz unten gescrollt: Der Bereich endet 64 px über dem Fensterrand
    // (836 bei 900), das Panel stand mit 788 px Höhe bei 47
    const scrolled = panelGeometry(t, view.document, {
      top: 47,
      containerBottom: 836,
    });
    await view.act(() => click(rowsOf(view.container)[0]));
    await view.act();
    assert.equal(panelOf(view.container).style.maxHeight, "756px");
    assert.ok(80 + 756 <= 836);
    assert.deepEqual(scrolled, []);
  }
);

test(
  "Fixliste 4, V7: Per Link geöffnet – der Sprung zur Liste hält bei Layoutänderungen (ResizeObserver) und fremdem Scrollen, bis der Nutzer selbst scrollt",
  { skip },
  async (t) => {
    await panelServer(t, {
      rows: [row(1), row(5)],
      details: {
        5: { messages: [message(5, "konv-5", { session_id: "sitzung-5" })] },
      },
    });
    const observers = stubResizeObserver(t);
    const probe = await mountList(t);
    const prototype = Object.getPrototypeOf(rowsOf(probe.container)[0]);
    const document = probe.document;
    await probe.unmount();
    const events = captureDocumentListeners(t, document);
    // Sprünge zum Ziel „Liste“ (scroll-mt-20); die Liste steht danach bei 96
    const jumps = [];
    let listTop = 900;
    const original = {
      scroll: prototype.scrollIntoView,
      rect: prototype.getBoundingClientRect,
    };
    const isTarget = (element) => classesOf(element).includes("scroll-mt-20");
    prototype.scrollIntoView = function (options) {
      if (isTarget(this)) {
        jumps.push(options);
        listTop = 96;
      }
    };
    prototype.getBoundingClientRect = function () {
      return isTarget(this)
        ? { x: 0, y: listTop, top: listTop, left: 0, width: 1000, height: 900 }
        : original.rect.call(this);
    };
    t.after(() => {
      prototype.scrollIntoView = original.scroll;
      prototype.getBoundingClientRect = original.rect;
    });
    stubWidth(t, true);
    const mounted = await renderer.mount(VIEW, {
      location: `${LOCATION}?widget=3&conversation=5`,
      route: LOCATION,
      exportName: "AnalyticsScreen",
      props: {
        embedsLoaded: true,
        embeds: [
          {
            id: EMBED_ID,
            chat_retention_days: null,
            workspace: { name: "VHS" },
          },
        ],
      },
    });
    t.after(() => mounted.unmount());
    for (let i = 0; i < 4; i++) await mounted.act();
    assert.deepEqual(jumps, [{ block: "start" }]);
    // der Beobachter des Sprungs: zuerst der Elternknoten der Liste (das
    // Panel beobachtet seine eigenen Vorfahren)
    const hold = observers.find((o) =>
      (o.observed[0]?.childNodes ?? []).some((child) => isTarget(child))
    );
    assert.ok(hold, "kein ResizeObserver auf den Vorfahren der Liste");

    // Über der Liste wird etwas höher (Layout nach dem Sprung): erneut
    listTop = 140;
    await mounted.act(() => hold.callback([]));
    assert.equal(jumps.length, 2);
    // Der Browser setzt die Scrollposition (Wiederherstellen): erneut
    listTop = 400;
    await mounted.act(() => events.fire("scroll"));
    assert.equal(jumps.length, 3);
    // Scrollen ohne Verschiebung des Ziels: nichts
    await mounted.act(() => events.fire("scroll"));
    assert.equal(jumps.length, 3);

    // Der Nutzer scrollt selbst: Schluss – kein weiterer Sprung
    await mounted.act(() => events.fire("wheel"));
    assert.equal(hold.disconnected, true);
    listTop = 700;
    await mounted.act(() => hold.callback([]));
    await mounted.act(() => events.fire("scroll"));
    assert.equal(jumps.length, 3);
  }
);

test(
  "Fixliste 4, S2: berlinDateTime liegt in utils/conversationView und liefert dasselbe wie formatDateTimeDE mit Berliner Zeit",
  { skip },
  async () => {
    const view = await renderer.load("/src/utils/conversationView.js");
    const { formatDateTimeDE } = await renderer.load(
      "/src/utils/directories.js"
    );
    for (const instant of [
      berlin("2026-10-13", "07:48"),
      "2026-12-31T23:30:05.000Z",
      new Date("2026-03-29T01:30:00Z"),
      null,
      "kein Datum",
    ])
      assert.equal(
        view.berlinDateTime(instant),
        formatDateTimeDE(instant, { timeZone: view.BERLIN }),
        String(instant)
      );
    // nicht mehr aus der Komponente des Panels
    const detail = await renderer.load(`${DIR}/ConversationDetail.jsx`);
    assert.equal(detail.berlinDateTime, undefined);
  }
);

// ---------------------------------------------------------------------------
// Fixliste 5 (Browser-Nachprüfung rc17, Kontroll-Review 4)
// ---------------------------------------------------------------------------

// Breiten in Plus Jakarta Sans 14 px (wght 400), gerechnet aus den Metriken
// der Schrift (frontend/public/fonts/PlusJakartaSans.ttf, mit Unterschneidung)
// und im Browser bestätigt am alten Text (209/210 bzw. 200 px, BO4).
const PLACEHOLDER_WIDTH = {
  "In Fragen und Antworten suchen": 210.3,
  "Search questions and answers": 199.7,
  "Fragen & Antworten suchen": 181.3,
  "Search questions & answers": 184.6,
};
// Tailwind-Klassen des Rahmens → Pixel (Abstände im Rahmen um das Feld)
const FRAME_SPACING = {
  "pl-2.5": 10,
  "pl-3": 12,
  "gap-1.5": 6,
  "gap-2": 8,
};

test(
  "Fixliste 5, V1/S4: Platzhalter ganz lesbar bei 240 px Rahmen (de und en); ab xl neben der Überschrift Suche 240 px, umgebrochen füllt die Leiste ihre Zeile links bündig",
  { skip },
  async (t) => {
    await panelServer(t, { rows: [row(1)] });
    const { container } = await mountList(t);
    const field = one(container, "data-search-field");
    const input = one(container, "data-search-input");
    const de = (await renderer.load("/src/locales/de/common.js")).default;
    const en = (await renderer.load("/src/locales/en/common.js")).default;
    const placeholders = [
      de["embed-analytics"].search.placeholder,
      en["embed-analytics"].search.placeholder,
    ];
    assert.equal(input.getAttribute("placeholder"), placeholders[0]);
    assert.deepEqual(placeholders, [
      "Fragen & Antworten suchen",
      "Search questions & answers",
    ]);
    // Rechnung: Rahmen 2 + Innenabstand links + Lupe 16 + zwei Lücken +
    // Platzhalter-Ersatz w-1 (4) – der Rest bleibt dem Feld
    const classes = classesOf(field);
    const padding = classes
      .filter((name) => /^pl-/.test(name))
      .map((name) => FRAME_SPACING[name]);
    const gap = classes
      .filter((name) => /^gap-/.test(name))
      .map((name) => FRAME_SPACING[name]);
    assert.deepEqual([padding.length, gap.length], [1, 1]);
    const spacer = elements(
      field,
      (e) => e.tagName === "SPAN" && e.getAttribute("aria-hidden") === "true"
    ).find((e) => classesOf(e).includes("w-1"));
    assert.ok(spacer, "Platzhalter-Ersatz w-1 fehlt");
    const overhead = 2 + padding[0] + 16 + 2 * gap[0] + 4;
    assert.equal(overhead, 44);
    // kleinste Breite des Rahmens ab sm: 240 px (ab xl neben der
    // Überschrift genau 240, bei 1024 px 253); darunter volle Breite ≥ 328
    assert.ok(hasClasses(field, ["sm:min-w-[240px]", "xl:w-60"]));
    for (const text of placeholders)
      assert.ok(
        PLACEHOLDER_WIDTH[text] <= 240 - overhead - 8,
        `${text}: ${PLACEHOLDER_WIDTH[text]} px > ${240 - overhead - 8} px`
      );
    // der alte Text passte nicht (V1)
    assert.ok(PLACEHOLDER_WIDTH["In Fragen und Antworten suchen"] > 196);
    // voller Name für Screenreader
    assert.equal(
      input.getAttribute("aria-label"),
      "In Fragen, Antworten und Bewertungen suchen"
    );

    // S4: ab xl Basis 240 px (Breite, nicht flex-basis 0) – ob die Leiste
    // neben die Überschrift passt, hängt nicht an der Fensterbreite; daneben
    // geht der freie Platz an den Titel (999 : 1), allein in ihrer Zeile
    // füllt die Leiste sie (grow) und die Suche wächst
    assert.ok(hasClasses(field, ["sm:flex-1", "xl:flex-auto"]));
    assert.ok(!classes.includes("xl:flex-none"));
    const tools = one(container, "data-list-tools");
    assert.ok(hasClasses(tools, ["sm:basis-full", "xl:basis-auto", "xl:grow"]));
    const title = one(container, "data-list-title");
    assert.ok(hasClasses(title, ["flex-1", "basis-40", "xl:grow-[999]"]));
  }
);

test(
  "Fixliste 5, V2: Mobil (unter sm) Marken kompakt ohne Pille, „Grund: …“ in eigener Zeile – ab sm unverändert am Ende der Metazeile",
  { skip },
  async (t) => {
    fixClock(t, TODAY);
    await panelServer(t, {
      rows: [
        row(201, {
          preview: "Welche Kurse gibt es?",
          last_message_at: berlin("2026-10-13", "23:42"),
          started_at: berlin("2026-10-13", "23:40"),
          message_count: 3,
          positive_count: 1,
          negative_count: 1,
          first_negative_reason: "Unvollständig",
        }),
        row(202, { negative_count: 1, first_negative_reason: null }),
      ],
    });
    const { container } = await mountList(t);
    const [first, second] = rowsOf(container);
    // Grund mobil eigene Zeile, ab sm ausgeblendet
    const reason = one(first, "data-row-reason");
    assert.equal(reason.textContent, "Grund: Unvollständig");
    assert.ok(hasClasses(reason, ["truncate", "sm:hidden"]));
    // ab sm am Ende der Metazeile (AK-1), mobil dort ausgeblendet
    const meta = one(first, "data-row-meta");
    assert.equal(meta.textContent, "23:42 · 3 Fragen · Grund: Unvollständig");
    const desktopReason = elements(meta, (e) =>
      classesOf(e).includes("sm:inline")
    );
    assert.equal(desktopReason.length, 1);
    assert.ok(hasClasses(desktopReason[0], ["hidden", "sm:inline"]));
    assert.equal(desktopReason[0].textContent, " · Grund: Unvollständig");
    // ohne Grund keine eigene Zeile
    assert.equal(withAttribute(second, "data-row-reason").length, 0);

    // Marken: mobil nur Daumen und Zahl (keine Pille, kein Innenabstand),
    // ab sm die Pille wie bisher
    for (const badge of withAttribute(first, "data-rating-badge")) {
      const names = classesOf(badge);
      assert.ok(hasClasses(badge, ["sm:px-2", "gap-0.5", "sm:gap-1"]));
      assert.ok(!names.includes("px-2"));
      assert.ok(!names.some((name) => /^bg-/.test(name)));
      assert.ok(names.some((name) => /^sm:bg-/.test(name)));
      assert.ok(names.some((name) => /^light:sm:bg-/.test(name)));
    }
    // Rechnung bei 360 px (Zeileninhalt 277 px): Spalten Text | Marken |
    // Pfeil 16 mit zwei Lücken 12 – Marken kompakt 2 × (13 + 2 + 5) + 8 =
    // 48 px statt zwei Pillen 2 × 38 + 6 = 82 px. Die Textspalte hat so
    // 189 statt 155 px: „Welche Kurse gibt es?“ (15 px, 157) und „Grund:
    // Unvollständig“ (13 px, 129) passen ganz.
    assert.ok(277 - 2 * 12 - 16 - 48 >= 157);
    assert.ok(277 - 2 * 12 - 16 - 82 < 157);
  }
);

test(
  "Fixliste 5, C1: Größenänderung des Fensters mit offenem Panel – das Ereignis „resize“ (Ziel: das Fenster) wirft nicht und setzt die Höhe neu",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const windowListeners = new Map();
    const original = {
      add: globalThis.window.addEventListener,
      remove: globalThis.window.removeEventListener,
    };
    globalThis.window.addEventListener = (type, listener) => {
      windowListeners.set(type, [
        ...(windowListeners.get(type) ?? []),
        listener,
      ]);
    };
    globalThis.window.removeEventListener = (type, listener) =>
      windowListeners.set(
        type,
        (windowListeners.get(type) ?? []).filter((l) => l !== listener)
      );
    t.after(() => {
      globalThis.window.addEventListener = original.add;
      globalThis.window.removeEventListener = original.remove;
    });
    await panelServer(t, {
      rows: [row(1), row(2)],
      details: {
        1: { messages: [message(1, "konv-1", { session_id: "sitzung-1" })] },
      },
    });
    const view = await mountList(t);
    panelGeometry(t, view.document, { top: 300 });
    await view.act(() => click(rowsOf(view.container)[0]));
    await view.act();
    const panel = panelOf(view.container);
    assert.equal(panel.style.maxHeight, "568px");
    // wie im Browser: contains() wirft bei einem Ziel, das kein Knoten ist
    const contains = panel.contains.bind(panel);
    panel.contains = (node) => {
      if (typeof node?.nodeType !== "number")
        throw new TypeError(
          "Failed to execute 'contains' on 'Node': parameter 1 is not of type 'Node'."
        );
      return contains(node);
    };
    const resize = windowListeners.get("resize") ?? [];
    assert.ok(resize.length > 0, "kein Lauscher für resize");
    for (const height of [700, 800, 900, 1000]) {
      globalThis.window.innerHeight = height;
      await view.act(() =>
        resize.forEach((listener) =>
          listener({ type: "resize", target: globalThis.window })
        )
      );
      await view.act(() => wait(20));
      assert.equal(panel.style.maxHeight, `${height - 32 - 300}px`);
    }
  }
);

test(
  "Fixliste 5, C2: „Nächste“ an der letzten geladenen Zeile, das Nachladen scheitert – Hinweis im Panel, kein Toast; ein erneutes „Nächste“ lädt nach und öffnet die nächste, der Hinweis ist fort",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const rows = Array.from({ length: 30 }, (_, i) =>
      row(300 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
      })
    );
    let failing = true;
    const server = await panelServer(t, {
      rows,
      failList: (body) => failing && body.offset > 0,
      details: Object.fromEntries(
        [319, 320].map((id) => [
          id,
          {
            messages: [
              message(id, `konv-${id}`, { session_id: `sitzung-${id}` }),
            ],
          },
        ])
      ),
    });
    const { container, act } = await mountList(t);
    await act(() => click(rowsOf(container)[19]));
    await act();
    const panel = () => panelOf(container);
    const hint = () =>
      withAttribute(panel(), "data-panel-navigation-hint").map(
        (element) => element.textContent
      );
    assert.deepEqual(currentRows(container), [319]);
    assert.deepEqual(hint(), []);

    // „Nächste“ über das Seitenende: Nachladen scheitert
    await act(() => click(one(panel(), "data-panel-next")));
    for (let i = 0; i < 4; i++) await act();
    assert.deepEqual(
      server.lists().map((call) => call.body.offset),
      [0, 20]
    );
    assert.deepEqual(currentRows(container), [319]);
    assert.deepEqual(hint(), [
      "Die nächste Konversation konnte nicht geladen werden – bitte erneut versuchen.",
    ]);
    // Fixliste 6, K1: eigener Text für „Nächste“ (der Link-Fall sagt, dass
    // vorherige/nächste fehlen); als Statusmeldung angesagt
    assert.equal(
      one(panel(), "data-panel-navigation-hint").getAttribute("role"),
      "status"
    );
    assert.deepEqual(shown, []);
    // „Nächste“ bleibt bedienbar – er versucht es erneut
    assert.equal(
      one(panel(), "data-panel-next").hasAttribute("disabled"),
      false
    );

    // erneut, jetzt gelingt es: nächste Konversation offen, Hinweis fort
    failing = false;
    await act(() => click(one(panel(), "data-panel-next")));
    for (let i = 0; i < 6; i++) await act();
    assert.deepEqual(
      server.lists().map((call) => call.body.offset),
      [0, 20, 20]
    );
    assert.deepEqual(currentRows(container), [320]);
    assert.deepEqual(hint(), []);
    assert.equal(withAttribute(container, "data-load-more-error").length, 0);
    assert.deepEqual(shown, []);
  }
);

test(
  "Fixliste 5, C2: Der Hinweis nach gescheitertem „Nächste“ verschwindet beim Zeilenwechsel und nach gelungenem „Weitere laden“",
  { skip },
  async (t) => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row(400 + i, {
        last_message_at: berlin("2026-10-12", "12:00") - i * 60000,
      })
    );
    let failing = true;
    await panelServer(t, {
      rows,
      failList: (body) => failing && body.offset > 0,
      details: Object.fromEntries(
        [418, 419].map((id) => [
          id,
          {
            messages: [
              message(id, `konv-${id}`, { session_id: `sitzung-${id}` }),
            ],
          },
        ])
      ),
    });
    const { container, act } = await mountList(t);
    const hint = () =>
      withAttribute(panelOf(container), "data-panel-navigation-hint").length;
    await act(() => click(rowsOf(container)[19]));
    await act();
    await act(() => click(one(panelOf(container), "data-panel-next")));
    for (let i = 0; i < 4; i++) await act();
    assert.equal(hint(), 1);
    // Zeilenwechsel: fort – auch zurück auf derselben Zeile kein Hinweis
    await act(() => click(rowsOf(container)[18]));
    await act();
    assert.equal(hint(), 0);
    await act(() => click(rowsOf(container)[19]));
    await act();
    assert.equal(hint(), 0);

    // erneut scheitern, dann gelingt „Weitere laden“: fort
    await act(() => click(one(panelOf(container), "data-panel-next")));
    for (let i = 0; i < 4; i++) await act();
    assert.equal(hint(), 1);
    failing = false;
    await act(() => click(one(container, "data-load-more")));
    for (let i = 0; i < 4; i++) await act();
    assert.equal(hint(), 0);
  }
);

test(
  "Fixliste 5, S5: Schmales Panel – Datum einzeilig (von lg bis xl in der Zeile unter der Frage), Fußzeile eine Zeile mit gekürzter Kennung; nie niedriger als Kopf und Fußzeile",
  { skip },
  async (t) => {
    stubWidth(t, true);
    const observers = stubResizeObserver(t);
    await panelServer(t, {
      rows: [row(1), row(2)],
      details: {
        1: {
          messages: [
            message(1, "3f311a2b-1111-2222", { session_id: "sitzung-1" }),
          ],
        },
      },
    });
    const view = await mountList(t);
    panelGeometry(t, view.document, { top: 700 });
    await view.act(() => click(rowsOf(view.container)[0]));
    await view.act();
    const panel = panelOf(view.container);

    // Kopf: Datum neben den Schaltflächen erst ab xl, bis dahin einzeilig
    // in der Zeile unter der Frage; die Schaltflächen rechts
    const date = one(panel, "data-panel-date");
    assert.ok(hasClasses(date, ["hidden", "xl:block", "whitespace-nowrap"]));
    const metaDate = one(panel, "data-meta-date");
    assert.ok(hasClasses(metaDate, ["xl:hidden", "whitespace-nowrap"]));
    assert.equal(metaDate.textContent, date.textContent);
    assert.ok(
      hasClasses(one(panel, "data-panel-previous").parentNode, ["ml-auto"])
    );
    // Fußzeile: eine Zeile, die Kennung kürzt, „Konversation löschen“ ganz
    const footer = one(panel, "data-conversation-actions");
    assert.ok(hasClasses(footer, ["flex", "shrink-0"]));
    assert.ok(!classesOf(footer).includes("flex-wrap"));
    const id = one(panel, "data-panel-id");
    assert.ok(hasClasses(id, ["min-w-0"]));
    assert.ok(
      elements(id, (e) => classesOf(e).includes("truncate")).length === 1
    );
    assert.ok(
      hasClasses(one(panel, "data-delete-conversation"), [
        "shrink-0",
        "whitespace-nowrap",
      ])
    );
    assert.ok(hasClasses(one(panel, "data-panel-head"), ["shrink-0"]));
    assert.ok(hasClasses(one(panel, "data-panel-body"), ["min-h-0", "flex-1"]));

    // Mindesthöhe: weit unten 240 px – Kopf 196 + Fußzeile 49 brauchen mehr
    assert.equal(panel.style.maxHeight, "240px");
    const head = one(panel, "data-panel-head");
    const observer = observers.find((o) => o.observed.includes(head));
    assert.ok(observer, "Kopf des Panels wird nicht beobachtet");
    assert.ok(observer.observed.includes(one(panel, "data-panel-body")));
    head.getBoundingClientRect = () => ({ top: 700, height: 196 });
    footer.getBoundingClientRect = () => ({ top: 1011, height: 49 });
    await view.act(() => observer.callback([]));
    await view.act(() => wait(20));
    assert.equal(panel.style.maxHeight, `${196 + 49 + 64 + 2}px`);
  }
);

// ---------------------------------------------------------------------------
// Fixliste 6, N1: gezählt (Zählerbuch) vs. einsehbar (Liste)
// ---------------------------------------------------------------------------

const GAP_TAIL =
  "Inhalte können gelöscht worden sein (Aufbewahrungsfrist, vom Besucher geleert oder hier gelöscht) – die Kennzahlen zählen weiter.";

test(
  "Fixliste 6, N1: leere Liste, aber Konversationen gezählt – der Hinweis ersetzt „Keine Konversationen vorhanden.“, ohne zweiten Hinweis auf die Aufbewahrungsfrist",
  { skip },
  async (t) => {
    await panelServer(t, { rows: [] });
    const { container } = await mountList(t, {
      props: { countedConversations: 916, showDeletedHint: true },
    });
    assert.equal(
      one(container, "data-content-gap").textContent,
      `916 Konversationen gezählt, 0 davon einsehbar. ${GAP_TAIL}`
    );
    assert.doesNotMatch(
      container.textContent,
      /Keine Konversationen vorhanden/
    );
    assert.equal(withAttribute(container, "data-deleted-hint").length, 0);
    // die Zahl neben der Überschrift heißt weiter „0 einsehbar“
    assert.equal(
      one(container, "data-viewable-count").textContent,
      "0 einsehbar"
    );
    // Einzahl
    const single = await mountList(t, { props: { countedConversations: 1 } });
    assert.equal(
      one(single.container, "data-content-gap").textContent,
      `1 Konversation gezählt, 0 davon einsehbar. ${GAP_TAIL}`
    );
  }
);

test(
  "Fixliste 6, N1: teilweise Lücke – eine Zeile unter der Liste, Zahlen deutsch formatiert; der Aufbewahrungs-Hinweis geht darin auf",
  { skip },
  async (t) => {
    await panelServer(t, { rows: [row(1), row(2), row(3)] });
    const { container } = await mountList(t, {
      props: { countedConversations: 1234, showDeletedHint: true },
    });
    assert.equal(rowsOf(container).length, 3);
    const [gap] = withAttribute(container, "data-content-gap");
    assert.equal(
      gap.textContent,
      `1.234 Konversationen gezählt, 3 davon einsehbar. ${GAP_TAIL}`
    );
    // dezent wie bisher der Hinweis auf die Aufbewahrungsfrist
    assert.match(gap.getAttribute("class"), /\btext-xs\b/);
    // unter der Liste, nicht darin
    const list = one(container, "data-conversation-list");
    assert.equal(withAttribute(list, "data-content-gap").length, 0);
    const order = elements(container, () => true);
    assert.ok(
      order.indexOf(gap) > order.indexOf(list),
      "Hinweis steht nach der Liste"
    );
    assert.equal(withAttribute(container, "data-deleted-hint").length, 0);
    assert.equal(withAttribute(container, "data-content-gap").length, 1);
  }
);

test(
  "Fixliste 6, N1: kein Hinweis bei vollständigem Bestand (einsehbar ≥ gezählt), ohne passende Kennzahl, bei Filter, Suche oder Säule",
  { skip },
  async (t) => {
    const state = {
      rows: [
        row(1, { negative_count: 1 }),
        row(2, { preview: "Spanisch?" }),
        row(3),
      ],
    };
    await panelServer(t, state);
    const gaps = (container) =>
      withAttribute(container, "data-content-gap").length;

    // gleich viele und mehr einsehbar als gezählt (weitergeführte ältere
    // Konversationen): kein Hinweis, der Aufbewahrungs-Hinweis wie bisher
    for (const countedConversations of [3, 2, 0, null]) {
      const { container } = await mountList(t, {
        props: { countedConversations, showDeletedHint: true },
      });
      assert.equal(gaps(container), 0, String(countedConversations));
      assert.equal(
        withAttribute(container, "data-deleted-hint").length,
        1,
        String(countedConversations)
      );
    }

    // Bewertungsfilter, Suche, Säule: dort gilt „X von Y einsehbar“
    const negative = await mountList(t, {
      props: { countedConversations: 50, feedbackFilter: "negative" },
    });
    assert.equal(gaps(negative.container), 0);
    const searched = await mountList(t, {
      query: "?q=spanisch",
      props: { countedConversations: 50 },
    });
    assert.equal(rowsOf(searched.container).length, 1);
    assert.equal(gaps(searched.container), 0);
    const bucketed = await mountList(t, {
      props: {
        countedConversations: 50,
        bucket: {
          start: "2026-10-12",
          end: "2026-10-12",
          label: "Mo., 12.10.2026",
        },
      },
    });
    assert.equal(gaps(bucketed.container), 0);

    // leere Liste mit Filter: der Leerzustand des Filters, kein Hinweis
    state.rows = [];
    const emptyNegative = await mountList(t, {
      props: { countedConversations: 50, feedbackFilter: "negative" },
    });
    assert.equal(gaps(emptyNegative.container), 0);
    assert.match(
      emptyNegative.container.textContent,
      /Keine Konversationen mit negativer Bewertung\./
    );
    // ohne Kennzahl der leere Zustand wie bisher
    const plain = await mountList(t, { props: { countedConversations: 0 } });
    assert.equal(gaps(plain.container), 0);
    assert.match(plain.container.textContent, /Keine Konversationen vorhanden/);
  }
);

test(
  "Fixliste 6, N1: Ansicht – die Kennzahl „Konversationen“ des Zeitraums geht an die Liste; nur bei Berliner Tagesgrenzen des Browsers, nicht mit Bewertungsfilter",
  { skip },
  async (t) => {
    // Zählerbuch (panelServer): 60 Konversationen gezählt; Liste: 2
    await panelServer(t, { rows: [row(1), row(2)] });
    const mounted = await renderer.mount(VIEW, {
      location: LOCATION,
      exportName: "AnalyticsScreen",
      props: {
        embedsLoaded: true,
        embeds: [
          { id: EMBED_ID, chat_retention_days: 30, workspace: { name: "VHS" } },
        ],
      },
    });
    t.after(() => mounted.unmount());
    const { container, act } = mounted;
    for (let i = 0; i < 4; i++) await act();
    assert.equal(rowsOf(container).length, 2);
    // Der Browser rechnet in Berliner Zeit, wenn seine Tagesgrenzen die
    // Berliner sind (Winter UTC+1, Sommer UTC+2) – sonst zählen Liste und
    // Zählerbuch verschiedene Stunden, und der Hinweis entfällt.
    const berlinBrowser =
      new Date(2026, 0, 15).getTimezoneOffset() === -60 &&
      new Date(2026, 6, 15).getTimezoneOffset() === -120;
    const gaps = () =>
      withAttribute(container, "data-content-gap").map((e) => e.textContent);
    assert.deepEqual(
      gaps(),
      berlinBrowser
        ? [`60 Konversationen gezählt, 2 davon einsehbar. ${GAP_TAIL}`]
        : []
    );
    // nie zusammen mit dem Hinweis auf die Aufbewahrungsfrist
    assert.ok(
      gaps().length + withAttribute(container, "data-deleted-hint").length <= 1
    );

    // Bewertungsfilter: kein Hinweis (dort „X von Y einsehbar“)
    const [negative] = elements(
      one(container, "data-feedback-filters"),
      (e) => e.tagName === "BUTTON" && /Negativ/.test(e.textContent)
    );
    await act(() => click(negative));
    for (let i = 0; i < 4; i++) await act();
    assert.deepEqual(gaps(), []);
  }
);
