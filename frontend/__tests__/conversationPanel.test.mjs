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
      let rows = state.rows;
      if (q)
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
  };
}

/** Meldungen (react-toastify) abfangen. */
async function toasts(t) {
  const { toast } = await import("react-toastify");
  const shown = [];
  const original = { success: toast.success, error: toast.error };
  toast.success = (text) => shown.push(["success", text]);
  toast.error = (text) => shown.push(["error", text]);
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
  "AK-2: Gruppen nach dem Tag der letzten Nachricht – K1 (begonnen 9. Okt.) unter „Heute“ über K2; je Gruppe die Zahl, außer die Gruppe geht auf der nächsten Seite weiter",
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
      one(group, "data-day-count").textContent,
      rowsOf(group).map((r) => Number(r.getAttribute("data-conversation-row"))),
    ]);
    assert.deepEqual(groups, [
      ["2026-10-13", "Heute · Dienstag, 13. Oktober", "1 Konversation", [1]],
      [
        "2026-10-12",
        "Gestern · Montag, 12. Oktober",
        "2 Konversationen",
        [2, 3],
      ],
      ["2026-10-11", "Sonntag, 11. Oktober", "1 Konversation", [4]],
    ]);
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
  "AK-1: Die letzte Gruppe einer unvollständigen Liste nennt keine Zahl; „Weitere Konversationen laden“ hängt an",
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
    assert.equal(
      one(container, "data-day-count").textContent,
      "25 Konversationen"
    );
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
    assert.match(
      one(head, "data-panel-meta").textContent,
      /3 Fragen · 07:47–07:48 Uhr.*· 1 Antwort negativ bewertet.*· 1 Antwort positiv bewertet/
    );
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
    assert.deepEqual(written, [
      "3f311a2b-e8cd-4b30-9627-2758deb20006",
      `${LOCATION}?widget=3&conversation=1&q=frage`,
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
