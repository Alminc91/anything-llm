// KIE-538: Ansicht „Konversationen" – „Exportieren" in der Kopfzeile der
// Liste, „Konversation löschen" in der Fußzeile der geöffneten Konversation
// (Seitenpanel, seit der Konversationen-Ansicht; „Alle Konversationen dieses
// Besuchers löschen" im Menü „⋯" des Panels).
// Die Liste ist mit React DOM in ein Dokument ohne Browser eingehängt
// (helpers/renderSettingsPage.mjs, mount): Effekte laufen, Eingaben werden
// über die Handler der Elemente nachgestellt (helpers/testDom.mjs).
//
// Layout, Themes und das Speichern der Datei durch den Browser bleiben Sache
// des Browser-Tests.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements } from "./helpers/testDom.mjs";
// Adressen und Rümpfe der Anfragen – dieselben, mit denen die Server-Tests
// die echten Routen aufrufen (embedConversationExport.test.js,
// embedChatsDeleteConversation.test.js).
import requests from "../../server/__tests__/endpoints/support/embedAnalyticsRequests.js";

const { ROUTES, conversationsBody, exportBody, conversationBody } = requests;

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const LIST = `${DIR}/ConversationList.jsx`;
const LOCATION = "/settings/chatbot/conversations";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

// file-saver übernimmt beim Laden ein vorhandenes globales saveAs: So ist zu
// sehen, was die Ansicht speichern würde.
const saved = [];
globalThis.saveAs = (blob, filename) => saved.push({ blob, filename });

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const EMBED_ID = 3;
// Zeitraum der Liste: Kalendertage (Fixliste 7, F06)
const PERIOD = { fromDay: "2026-09-01", toDay: "2026-09-30" };
const CSV = new Blob(["\uFEFFKonversation;…\r\n"], {
  type: "text/csv; charset=utf-8",
});
const FILE_NAME = "konversationen_vhs-musterstadt-3_2026-09-01_2026-09-30.csv";

// first_chat_id: die id der ersten Zeile einer Konversation – je Karte eine
// andere, wie auf dem Server. Über sie nennt die Ansicht die Konversation.
const firstChatIds = new Map();
function chatIdOf(id) {
  if (!firstChatIds.has(id)) firstChatIds.set(id, 101 + firstChatIds.size);
  return firstChatIds.get(id);
}

function conversation(id, extra = {}) {
  return {
    conversation_id: id,
    session_id: `sitzung-${id}`,
    embed_id: EMBED_ID,
    first_chat_id: chatIdOf(id),
    started_at: Date.parse("2026-09-10T08:00:00Z"),
    last_message_at: Date.parse("2026-09-10T08:05:00Z"),
    message_count: 4,
    negative_count: 0,
    positive_count: 0,
    conversation_number: 1,
    preview: "Wann beginnt der Kurs?",
    workspace: "VHS Musterstadt",
    ...extra,
  };
}

/** Adresse einer Route, wie das Frontend sie aufruft. */
async function urlOf(route) {
  const { API_BASE } = await renderer.load("/src/utils/constants.js");
  return `${API_BASE}${route.path.replace(":embedId", EMBED_ID)}`;
}

/**
 * Die Adresse, wie ein Browser sie sendet: fetch löst "." und ".." vorher als
 * Pfadsegmente auf (WHATWG URL), auch kodiert als %2e.
 */
const sentPath = (url) => new URL(url, "https://kunde.example.org").pathname;

/**
 * Der Server der Liste. `state.conversations` ist der Bestand; Löschen
 * entfernt daraus – die Karte, deren first_chat_id der Rumpf nennt. Jede
 * Anfrage wird mit Methode, Adresse und Rumpf gemerkt. `state.preview` hält
 * Antworten der Vorschau je first_chat_id oder je Kennung der Konversation.
 * Die Liste blättert wie der echte Server (offset bzw. after, limit,
 * hasMore; call.start: Zeilen vor der Seite), und die
 * Anfragen werden der Route zugeordnet, bei der sie nach dem Auflösen der
 * Adresse ankommen – darunter DELETE /embed/:embedId, das Löschen des Widgets
 * (`state.widgetDeleted`). `state.totalCount` ersetzt den Zähler: Der echte
 * Server ermittelt ihn mit einer zweiten Abfrage, er kann von der Liste
 * abweichen.
 */
async function listServer(t, state) {
  const { API_BASE } = await renderer.load("/src/utils/constants.js");
  const listUrl = await urlOf(ROUTES.conversations);
  const exportUrl = await urlOf(ROUTES.export);
  const previewUrl = await urlOf(ROUTES.deletionPreview);
  const deleteUrl = await urlOf(ROUTES.deleteConversation);
  const visitorUrl = await urlOf(ROUTES.deleteVisitor);
  const widgetUrl = `${API_BASE}/embed/${EMBED_ID}`;
  const calls = [];
  const original = globalThis.fetch;
  const json = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => null },
    json: async () => body,
  });
  // Keine Route: Express antwortet mit einer HTML-Seite, kein JSON.
  const notFound = () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError("Unexpected token '<'");
    },
  });

  globalThis.fetch = async (url, init = {}) => {
    const call = {
      method: init.method,
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const path = sentPath(url);
    const is = (route, address) =>
      call.method === route.method && path === address;

    if (is(ROUTES.conversations, listUrl)) {
      const { offset = 0, limit = 20, after = null } = call.body ?? {};
      const appended = offset > 0 || !!after;
      // Blättern über den Schlüssel (Fixliste 7, F14): alles hinter der
      // genannten Zeile, in der Reihenfolge des Bestands (die Karten hier
      // haben dieselbe letzte Nachricht; maßgeblich ist ihr Platz)
      const restOf = () => {
        if (!after) return state.conversations;
        const index = state.conversations.findIndex(
          (c) => c.first_chat_id === after.firstChatId
        );
        return index < 0 ? [] : state.conversations.slice(index + 1);
      };
      // nicht aufzählbar: Prüfungen vergleichen die Anfragen als Ganzes
      Object.defineProperty(call, "start", {
        value: state.conversations.length - restOf().length + offset,
      });
      // state.holdMore: Nachladen wartet auf dieses Versprechen
      if (appended && state.holdMore) await state.holdMore;
      const total = state.conversations.length;
      // state.repeatFirstPage: Nachladen liefert wieder die erste Seite (nur
      // Doppelte, etwa nach Verschiebungen) und meldet weiter hasMore
      if (appended && state.repeatFirstPage)
        return json({
          success: true,
          conversations: state.conversations.slice(0, limit),
          hasMore: true,
          totalCount: total,
        });
      const rest = restOf();
      return json({
        success: true,
        conversations: rest.slice(offset, offset + limit),
        hasMore: offset + limit < rest.length,
        totalCount: state.totalCount ?? total,
      });
    }
    if (is(ROUTES.export, exportUrl)) {
      if (state.exportStatus) return json(null, state.exportStatus);
      if (state.exportAnswer)
        return json(state.exportAnswer.body, state.exportAnswer.status);
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) =>
            name.toLowerCase() === "content-disposition"
              ? `attachment; filename="${FILE_NAME}"`
              : null,
        },
        blob: async () => CSV,
      };
    }
    // DELETE /embed/:embedId (Express ohne strict: auch mit Schrägstrich am
    // Ende) löscht das Widget samt allen Konversationen.
    if (call.method === "DELETE" && path.replace(/\/$/, "") === widgetUrl) {
      state.widgetDeleted = true;
      state.conversations = [];
      return json({ success: true, error: null });
    }

    const chatId = call.body?.chatId;
    const target = state.conversations.find((c) => c.first_chat_id === chatId);
    if (is(ROUTES.deletionPreview, previewUrl))
      return json(
        state.preview?.[chatId] ??
          state.preview?.[target?.conversation_id] ?? {
            success: true,
            messageCount: 4,
            visitor: null,
          }
      );
    if (is(ROUTES.deleteVisitor, visitorUrl)) {
      if (state.deleteAnswer) return json(state.deleteAnswer);
      // state.visitorAnswers: Antworten der Reihe nach ({ status, body })
      const next = state.visitorAnswers?.shift();
      if (next) return json(next.body, next.status);
      const session = target?.session_id;
      const gone = state.conversations.filter((c) => c.session_id === session);
      state.conversations = state.conversations.filter(
        (c) => c.session_id !== session
      );
      return json({
        success: true,
        deletedCount: 11,
        conversationCount: gone.length,
      });
    }
    if (is(ROUTES.deleteConversation, deleteUrl)) {
      if (state.deleteAnswer) return json(state.deleteAnswer);
      if (state.deleteFails)
        return json({ success: false, error: "Conversation not found." }, 404);
      state.conversations = state.conversations.filter((c) => c !== target);
      return json({ success: true, deletedCount: 4 });
    }
    // Einzelansicht: GET /embed/:embedId/conversation/:chatId. Ohne
    // Nachrichten: Deren Darstellung (MarkdownRenderer) braucht DOMPurify und
    // damit einen Browser.
    if (
      call.method === "GET" &&
      new RegExp(`^${API_BASE}/embed/${EMBED_ID}/conversation/[^/]+$`).test(
        path
      )
    )
      return json({ success: true, messages: [] });
    return notFound();
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const to = (url) => calls.filter((call) => call.url === url);
  return {
    calls,
    lists: () => to(listUrl),
    exports: () => to(exportUrl),
    deletes: () => calls.filter((call) => call.method === "DELETE"),
    listUrl,
    exportUrl,
    detailUrl: (chatId) =>
      `${API_BASE}/embed/${EMBED_ID}/conversation/${encodeURIComponent(chatId)}`,
  };
}

/**
 * Fängt die Meldungen ab, die die Ansicht anzeigen würde (react-toastify).
 * @returns {Promise<Array<[string, string]>>} - [Art, Text] in der Reihenfolge des Erscheinens
 */
async function toasts(t) {
  const { toast } = await import("react-toastify");
  const shown = [];
  const original = { success: toast.success, error: toast.error };
  toast.success = (message) => shown.push(["success", message]);
  toast.error = (message) => shown.push(["error", message]);
  t.after(() => Object.assign(toast, original));
  return shown;
}

/** console.error für die Dauer eines Tests stumm (erwartete Fehlschläge). */
function quiet(t) {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
}

/** Hängt die Liste ein; Rückfragen erscheinen im Element mit der id "root". */
async function mountList(t, props = {}) {
  const mounted = await renderer.mount(LIST, {
    location: LOCATION,
    props: { embedId: EMBED_ID, ...PERIOD, ...props },
  });
  const { document } = mounted;
  if (!document.getElementById("root")) {
    const root = document.createElement("div");
    root.setAttribute("id", "root");
    document.body.appendChild(root);
  }
  t.after(() => mounted.unmount());
  return mounted;
}

const withAttribute = (root, name) =>
  elements(root, (element) => element.hasAttribute(name));
const buttonsOf = (root) =>
  elements(root, (element) => element.tagName === "BUTTON");
/** Kennungen der Zeilen der Liste, in ihrer Reihenfolge. */
const cardIdsOf = (container) =>
  withAttribute(container, "data-conversation-row").map((element) =>
    element.getAttribute("data-conversation-id")
  );
/** Öffnet die Konversation im Seitenpanel (Klick auf ihre Zeile). */
async function expand(mounted, index = 0) {
  const rows = withAttribute(mounted.container, "data-conversation-row");
  await mounted.act(() => click(rows[index]));
  await mounted.act();
}
/** Öffnet das Menü „⋯" des Seitenpanels. */
async function openMenu(mounted) {
  const [button] = withAttribute(mounted.container, "data-panel-menu-button");
  if (button.getAttribute("aria-expanded") !== "true")
    await mounted.act(() => click(button));
}
const dialogOf = (document) =>
  withAttribute(document.body, "data-confirm-dialog")[0] ?? null;

// ---------------------------------------------------------------------------
// Anfragen (models/embed.js)
// ---------------------------------------------------------------------------

test(
  "Anfrage (AK-1): exportConversations sendet dieselben Felder wie eine Seite der Liste – ohne Blättern, mit Format – an analytics/export und liefert Datei und Dateinamen des Servers",
  { skip },
  async (t) => {
    const server = await listServer(t, { conversations: [] });
    const { default: Embed } = await renderer.load("/src/models/embed.js");

    const answer = await Embed.exportConversations(EMBED_ID, "csv", {
      ...PERIOD,
      feedbackFilter: "negative",
      startedBetween: { fromDay: "2026-09-07", toDay: "2026-09-13" },
    });
    await Embed.exportConversations(EMBED_ID, "json", PERIOD);
    await Embed.exportConversations(EMBED_ID, "csv");

    assert.deepEqual(answer, {
      success: true,
      blob: CSV,
      filename: FILE_NAME,
      error: null,
    });
    const selection = {
      ...PERIOD,
      feedbackFilter: "negative",
      bucket: { start: "2026-09-07", end: "2026-09-13" },
    };
    assert.deepEqual(server.calls, [
      {
        method: ROUTES.export.method,
        url: server.exportUrl,
        body: exportBody("csv", selection),
      },
      {
        method: ROUTES.export.method,
        url: server.exportUrl,
        body: exportBody("json", PERIOD),
      },
      // „Gesamt": keine Kalendertage
      {
        method: ROUTES.export.method,
        url: server.exportUrl,
        body: {
          format: "csv",
          fromDay: null,
          toDay: null,
          feedbackFilter: "all",
        },
      },
    ]);
    // dieselbe Auswahl wie die Liste: alle ihre Felder außer offset und limit
    const { offset, limit, ...listed } = conversationsBody(selection);
    assert.deepEqual(server.calls[0].body, { format: "csv", ...listed });
    assert.equal(offset, 0);
    assert.equal(limit, 20);
    assert.match(server.exportUrl, /\/embed\/3\/analytics\/export$/);
  }
);

test(
  "Anfrage: Ein abgelehnter oder abgebrochener Export liefert keine Datei",
  { skip },
  async (t) => {
    const state = { conversations: [], exportStatus: 403 };
    await listServer(t, state);
    const { default: Embed } = await renderer.load("/src/models/embed.js");
    const quiet = console.error;
    console.error = () => {};
    t.after(() => {
      console.error = quiet;
    });

    for (const status of [400, 403, 422, 500]) {
      state.exportStatus = status;
      const answer = await Embed.exportConversations(EMBED_ID, "csv", PERIOD);
      assert.deepEqual(answer, {
        success: false,
        blob: null,
        filename: null,
        error: `HTTP ${status}`,
      });
    }

    // Die Verbindung bricht mitten in der Datei ab: blob() scheitert.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => `attachment; filename="${FILE_NAME}"` },
      blob: async () => {
        throw new TypeError("network error");
      },
    });
    const broken = await Embed.exportConversations(EMBED_ID, "csv", PERIOD);
    assert.equal(broken.success, false);
    assert.equal(broken.blob, null);
  }
);

test(
  "Dateiname (AK-10): aus dem Content-Disposition-Header – nur dateinamenssichere Zeichen, sonst der Ersatzname",
  { skip },
  async (t) => {
    const { filenameFromDisposition, default: Embed } = await renderer.load(
      "/src/models/embed.js"
    );
    assert.equal(
      filenameFromDisposition(`attachment; filename="${FILE_NAME}"`),
      FILE_NAME
    );
    for (const header of [
      null,
      "",
      "attachment",
      'attachment; filename="../../etc/passwd"',
      'attachment; filename="a b.csv"',
      'attachment; filename=".verborgen"',
      'attachment; filename="x.csv\r\nSet-Cookie: a=b"',
      'attachment; filename=""',
    ])
      assert.equal(filenameFromDisposition(header), null, String(header));

    const original = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      blob: async () => CSV,
    });
    assert.equal(
      (await Embed.exportConversations(EMBED_ID, "json", PERIOD)).filename,
      "konversationen_widget-3.json"
    );
    assert.equal(
      (await Embed.exportConversations(EMBED_ID, "csv", PERIOD)).filename,
      "konversationen_widget-3.csv"
    );
  }
);

test(
  "Anfrage (AK-6, AK-12): Vorschau, Löschen einer Konversation und aller Konversationen eines Besuchers – der Rumpf nennt die id der ersten Zeile, die Adresse enthält nichts vom Besucher",
  { skip },
  async (t) => {
    const server = await listServer(t, { conversations: [] });
    const { default: Embed } = await renderer.load("/src/models/embed.js");
    const { API_BASE } = await renderer.load("/src/utils/constants.js");

    for (const id of [17, 4711]) {
      server.calls.length = 0;
      await Embed.getConversationDeletionPreview(EMBED_ID, id);
      await Embed.deleteConversation(EMBED_ID, id);
      await Embed.deleteVisitorConversations(EMBED_ID, id);

      assert.deepEqual(
        server.calls,
        [
          ROUTES.deletionPreview,
          ROUTES.deleteConversation,
          ROUTES.deleteVisitor,
        ].map((route) => ({
          method: route.method,
          url: `${API_BASE}${route.path.replace(":embedId", EMBED_ID)}`,
          body: conversationBody(id),
        })),
        id
      );
      // Was der Browser daraus sendet, ist dieselbe Adresse: Es gibt kein
      // Segment, das er auflösen könnte. Der Rumpf nennt nur die Zeile.
      for (const call of server.calls) {
        assert.equal(sentPath(call.url), call.url, id);
        assert.deepEqual(call.body, { chatId: id });
      }
    }
    assert.deepEqual(
      server.calls.map((call) => [call.method, call.url]),
      [
        ["POST", "/api/embed/3/conversation/deletion-preview"],
        ["DELETE", "/api/embed/3/conversation"],
        ["DELETE", "/api/embed/3/conversation/visitor"],
      ]
    );
  }
);

test(
  "Anfrage: Die Einzelansicht nennt die Konversation über die id ihrer ersten Zeile – ein einziges Pfadsegment, was immer übergeben wird",
  { skip },
  async (t) => {
    const server = await listServer(t, { conversations: [] });
    const { default: Embed } = await renderer.load("/src/models/embed.js");

    const answer = await Embed.getConversationDetails(EMBED_ID, 4711);
    assert.deepEqual(answer, { success: true, messages: [] });
    assert.deepEqual(server.calls, [
      {
        method: "GET",
        url: "/api/embed/3/conversation/4711",
        body: undefined,
      },
    ]);
    assert.equal(server.calls[0].url, server.detailUrl(4711));
    assert.equal(sentPath(server.calls[0].url), server.calls[0].url);

    // Auch ein Wert, der aus der Einzelansicht herausführen soll, bleibt
    // darin: „/", „?" und „#" sind kodiert.
    await Embed.getConversationDetails(EMBED_ID, "a/b?c#d ä");
    await Embed.getConversationDetails(EMBED_ID, "../../system/logs");
    assert.deepEqual(
      server.calls.slice(1).map((call) => sentPath(call.url)),
      [
        "/api/embed/3/conversation/a%2Fb%3Fc%23d%20%C3%A4",
        "/api/embed/3/conversation/..%2F..%2Fsystem%2Flogs",
      ]
    );
  }
);

// ---------------------------------------------------------------------------
// „Exportieren" in der Kopfzeile der Liste
// ---------------------------------------------------------------------------

test(
  "Exportieren: Schaltfläche rechts neben den Bewertungsfiltern, Auswahl CSV / JSON",
  { skip },
  async (t) => {
    await listServer(t, { conversations: [conversation("k-1")] });
    const mounted = await mountList(t);
    const { container, act } = mounted;

    // Kopfzeile: Suchfeld, Umschalter „Alle / Positiv / Negativ", dann
    // „Exportieren" (Bewertungsfilter mit kurzem und ausgeschriebenem Text,
    // je nach Breite ist einer sichtbar)
    const [menu] = withAttribute(container, "data-export-menu");
    // Bewertungsfilter und Export stehen zusammen (brechen nur gemeinsam
    // um, Fixliste 3 V7), daneben das Suchfeld
    const actions = menu.parentNode;
    const headerRight = actions.parentNode;
    assert.equal(actions.hasAttribute("data-list-actions"), true);
    assert.deepEqual(
      buttonsOf(headerRight).map((button) => button.textContent),
      [
        "Alle",
        "PositivPositiv bewertet",
        "NegativNegativ bewertet",
        "Exportieren",
      ]
    );
    // Suchfeld, Bewertungsfilter, Export – in dieser Reihenfolge im
    // Dokument; unter sm ordnet CSS (order) Export neben die Überschrift
    // (Fixliste 2, B1)
    assert.equal(headerRight.hasAttribute("data-list-tools"), true);
    const parts = (element) =>
      element.childNodes.map((child) => [
        child.tagName,
        [
          "data-search-field",
          "data-list-actions",
          "data-feedback-filters",
          "data-export-menu",
        ].find((name) => child.hasAttribute(name)),
      ]);
    assert.deepEqual(parts(headerRight), [
      ["DIV", "data-search-field"],
      ["DIV", "data-list-actions"],
    ]);
    assert.deepEqual(parts(actions), [
      ["DIV", "data-feedback-filters"],
      ["DIV", "data-export-menu"],
    ]);
    assert.equal(withAttribute(headerRight, "data-search-input").length, 1);
    assert.equal(actions.lastChild, menu);

    const [button] = buttonsOf(menu);
    assert.equal(button.getAttribute("aria-haspopup"), "menu");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(button.hasAttribute("disabled"), false);
    assert.equal(withAttribute(container, "data-export-format").length, 0);

    await act(() => click(button));
    assert.equal(button.getAttribute("aria-expanded"), "true");
    const items = withAttribute(container, "data-export-format");
    assert.deepEqual(
      items.map((item) => [
        item.getAttribute("data-export-format"),
        item.getAttribute("role"),
        item.textContent,
      ]),
      [
        ["csv", "menuitem", "CSV (für Excel)"],
        ["json", "menuitem", "JSON"],
      ]
    );

    // zweiter Klick schließt die Auswahl wieder
    await act(() => click(button));
    assert.equal(withAttribute(container, "data-export-format").length, 0);
  }
);

test(
  "Exportieren (AK-1, AK-2): exportiert wird die Auswahl der Liste – Zeitraum, Feedback-Filter und Abschnitt – und die Datei unter dem Namen des Servers gespeichert",
  { skip },
  async (t) => {
    const server = await listServer(t, {
      conversations: [conversation("k-1")],
    });
    const bucket = { start: "2026-09-07", end: "2026-09-13", label: "KW 37" };
    const mounted = await mountList(t, { feedbackFilter: "negative", bucket });
    const { container, act } = mounted;
    saved.length = 0;

    // Die Liste selbst hat mit genau dieser Auswahl geladen – daneben einmal
    // die Zählabfrage ohne jeden Filter (auch ohne Säule, Fixliste 7 B7) für
    // „N von M einsehbar".
    assert.deepEqual(server.lists(), [
      {
        method: ROUTES.conversations.method,
        url: server.listUrl,
        body: conversationsBody({ ...PERIOD, limit: 1 }),
      },
      {
        method: ROUTES.conversations.method,
        url: server.listUrl,
        body: conversationsBody({
          ...PERIOD,
          feedbackFilter: "negative",
          bucket,
        }),
      },
    ]);

    const [menu] = withAttribute(container, "data-export-menu");
    await act(() => click(buttonsOf(menu)[0]));
    await act(() => click(withAttribute(container, "data-export-format")[0]));
    await act();

    assert.deepEqual(server.exports(), [
      {
        method: ROUTES.export.method,
        url: server.exportUrl,
        body: exportBody("csv", {
          ...PERIOD,
          feedbackFilter: "negative",
          bucket,
        }),
      },
    ]);
    assert.deepEqual(saved, [{ blob: CSV, filename: FILE_NAME }]);
    // Die Auswahl ist wieder zu, die Schaltfläche wieder bereit.
    assert.equal(withAttribute(container, "data-export-format").length, 0);
    assert.equal(buttonsOf(menu)[0].textContent, "Exportieren");
    assert.equal(buttonsOf(menu)[0].hasAttribute("disabled"), false);

    // JSON: dieselbe Auswahl, anderes Format
    await act(() => click(buttonsOf(menu)[0]));
    await act(() => click(withAttribute(container, "data-export-format")[1]));
    await act();
    assert.deepEqual(
      server.exports()[1].body,
      exportBody("json", { ...PERIOD, feedbackFilter: "negative", bucket })
    );
    // Der Export lädt die Liste nicht neu.
    assert.equal(server.lists().length, 2);
  }
);

test(
  "Exportieren: ohne Konversationen ist die Schaltfläche gesperrt; ein fehlgeschlagener Export speichert nichts",
  { skip },
  async (t) => {
    const state = { conversations: [] };
    const server = await listServer(t, state);
    const empty = await mountList(t);
    const [emptyMenu] = withAttribute(empty.container, "data-export-menu");
    assert.equal(buttonsOf(emptyMenu)[0].hasAttribute("disabled"), true);
    await empty.unmount();

    state.conversations = [conversation("k-1")];
    state.exportStatus = 500;
    const quiet = console.error;
    console.error = () => {};
    t.after(() => {
      console.error = quiet;
    });
    const mounted = await mountList(t);
    const [menu] = withAttribute(mounted.container, "data-export-menu");
    saved.length = 0;
    await mounted.act(() => click(buttonsOf(menu)[0]));
    await mounted.act(() =>
      click(withAttribute(mounted.container, "data-export-format")[0])
    );
    await mounted.act();

    assert.equal(server.exports().length, 1);
    assert.deepEqual(saved, []);
    assert.equal(buttonsOf(menu)[0].hasAttribute("disabled"), false);
  }
);

test(
  "Exportieren (Fixliste 3, C10): Zu viele Treffer (413) – die Meldung nennt die Grenze und was zu tun ist; nichts wird gespeichert",
  { skip },
  async (t) => {
    const state = {
      conversations: [conversation("k-1")],
      exportAnswer: {
        status: 413,
        body: {
          success: false,
          reason: "too-many-hits",
          max: 100000,
          error: "Zu viele Treffer",
        },
      },
    };
    const server = await listServer(t, state);
    const shown = await toasts(t);
    const mounted = await mountList(t);
    const [menu] = withAttribute(mounted.container, "data-export-menu");
    saved.length = 0;
    await mounted.act(() => click(buttonsOf(menu)[0]));
    await mounted.act(() =>
      click(withAttribute(mounted.container, "data-export-format")[0])
    );
    await mounted.act();
    assert.equal(server.exports().length, 1);
    assert.deepEqual(saved, []);
    assert.deepEqual(shown, [
      [
        "error",
        "Zu viele Treffer für den Export – höchstens 100.000 Konversationen. Bitte grenzen Sie Suche, Filter oder Zeitraum ein.",
      ],
    ]);

    // ein anderer Fehlschlag: die allgemeine Meldung
    quiet(t);
    state.exportAnswer = null;
    state.exportStatus = 500;
    shown.length = 0;
    await mounted.act(() => click(buttonsOf(menu)[0]));
    await mounted.act(() =>
      click(withAttribute(mounted.container, "data-export-format")[0])
    );
    await mounted.act();
    assert.deepEqual(shown, [
      [
        "error",
        "Der Export ist fehlgeschlagen. Bitte versuchen Sie es erneut.",
      ],
    ]);
  }
);

// ---------------------------------------------------------------------------
// „Konversation löschen" in der Fußzeile der geöffneten Konversation
// ---------------------------------------------------------------------------

test(
  "Konversation löschen (AK-6): erst in der geöffneten Konversation zu sehen; die Rückfrage nennt die erste Frage (gekürzt) und die Zahl der Nachrichten; Abbrechen löscht nichts",
  { skip },
  async (t) => {
    const long =
      "Guten Tag, ich möchte wissen, wann der Englischkurs für Fortgeschrittene im Herbst beginnt und ob noch Plätze frei sind?";
    const state = {
      conversations: [
        conversation("k-1", { preview: `${long.slice(0, 100)}...` }),
        conversation("k-2"),
      ],
      // Die Liste zählt 4 einsehbare Nachrichten, gelöscht würden 6.
      preview: { "k-1": { success: true, messageCount: 6, visitor: null } },
    };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;

    assert.equal(
      withAttribute(container, "data-delete-conversation").length,
      0
    );
    await expand(mounted, 0);
    // Die Lösch-Vorschau lädt erst, wenn sie gebraucht wird (Menü „⋯" oder
    // Rückfrage) – Öffnen und Blättern fragen sie nicht an.
    assert.deepEqual(server.calls.slice(1), [
      {
        method: "GET",
        url: server.detailUrl(chatIdOf("k-1")),
        body: undefined,
      },
    ]);

    const [remove] = withAttribute(container, "data-delete-conversation");
    assert.equal(remove.textContent, "Konversation löschen");
    // in der Fußzeile: nach den Nachrichten der Konversation
    const actions = withAttribute(container, "data-conversation-actions")[0];
    assert.equal(actions.parentNode.lastChild, actions);
    // nur eine Konversation dieses Besuchers: kein zweites Angebot
    await openMenu(mounted);
    assert.deepEqual(server.calls.slice(2), [
      {
        method: ROUTES.deletionPreview.method,
        url: await urlOf(ROUTES.deletionPreview),
        body: conversationBody(chatIdOf("k-1")),
      },
    ]);
    assert.equal(withAttribute(container, "data-menu-delete").length, 1);
    assert.equal(withAttribute(container, "data-delete-visitor").length, 0);
    assert.equal(dialogOf(document), null);

    await act(() => click(remove));
    const dialog = dialogOf(document);
    assert.equal(dialog.getAttribute("role"), "alertdialog");
    assert.equal(dialog.getAttribute("aria-label"), "Konversation löschen?");
    const [question] = withAttribute(dialog, "data-confirm-question");
    assert.equal(
      question.textContent,
      "„Guten Tag, ich möchte wissen, wann der Englischkurs für Fortgeschrittene im Herb…“"
    );
    assert.match(
      dialog.textContent,
      /Die Konversation mit 6 Nachrichten wird endgültig gelöscht\./
    );
    assert.match(
      dialog.textContent,
      /Kennzahlen, Diagramm und Kontingent bleiben unverändert/
    );
    // Abbrechen ist die Vorgabe.
    const [cancel] = withAttribute(dialog, "data-confirm-cancel");
    assert.equal(document.activeElement, cancel);

    await act(() => click(cancel));
    assert.equal(dialogOf(document), null);
    assert.deepEqual(server.deletes(), []);
    assert.equal(server.lists().length, 1);
    assert.deepEqual(cardIdsOf(container), ["k-1", "k-2"]);
  }
);

test(
  "Konversation löschen (AK-6): Bestätigen löscht genau diese Konversation, die Liste lädt neu und zeigt sie nicht mehr",
  { skip },
  async (t) => {
    const state = {
      conversations: [conversation("k-1"), conversation("k-2")],
    };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;

    await expand(mounted, 1);
    await act(() =>
      click(withAttribute(container, "data-delete-conversation")[0])
    );
    await act(() =>
      click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
    );
    await act();

    assert.deepEqual(server.deletes(), [
      {
        method: ROUTES.deleteConversation.method,
        url: await urlOf(ROUTES.deleteConversation),
        body: conversationBody(chatIdOf("k-2")),
      },
    ]);
    assert.equal(dialogOf(document), null);
    // neu geladen, mit derselben Auswahl
    assert.equal(server.lists().length, 2);
    assert.deepEqual(server.lists()[1], server.lists()[0]);
    assert.deepEqual(cardIdsOf(container), ["k-1"]);
    const [count] = withAttribute(container, "data-viewable-count");
    assert.equal(count.textContent, "1 einsehbar");
  }
);

test(
  "Konversation löschen: Schlägt das Löschen fehl, schließt die Rückfrage und die Liste zeigt den tatsächlichen Stand",
  { skip },
  async (t) => {
    const state = { conversations: [conversation("k-1")], deleteFails: true };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;

    await expand(mounted, 0);
    await act(() =>
      click(withAttribute(container, "data-delete-conversation")[0])
    );
    await act(() =>
      click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
    );
    await act();

    assert.equal(server.deletes().length, 1);
    assert.equal(dialogOf(document), null);
    assert.equal(server.lists().length, 2);
    assert.deepEqual(cardIdsOf(container), ["k-1"]);
  }
);

test(
  "Konversation löschen: Eine vom Besucher vergebene Kennung „..“ oder „.“ löscht genau diese Konversation – nicht das Widget",
  { skip },
  async (t) => {
    quiet(t);
    const shown = await toasts(t);
    const state = { conversations: [] };
    const server = await listServer(t, state);

    for (const id of ["..", ".", "%2e%2e", "../.."]) {
      state.conversations = [
        conversation("k-1"),
        conversation(id, { preview: "Bitte löschen Sie meine Daten (DSGVO)" }),
      ];
      state.widgetDeleted = false;
      server.calls.length = 0;
      shown.length = 0;
      const mounted = await mountList(t);
      const { container, document, act } = mounted;

      // Aufklappen und Vorschau nennen die Zeile, nicht die Kennung: Keine
      // Adresse enthält etwas, das der Browser auflösen könnte.
      await expand(mounted, 1);
      const [remove] = withAttribute(container, "data-delete-conversation");
      await act(() => click(remove));
      assert.deepEqual(
        server.calls.slice(1),
        [
          {
            method: "GET",
            url: server.detailUrl(chatIdOf(id)),
            body: undefined,
          },
          {
            method: ROUTES.deletionPreview.method,
            url: await urlOf(ROUTES.deletionPreview),
            body: conversationBody(chatIdOf(id)),
          },
        ],
        id
      );
      for (const call of server.calls)
        assert.equal(sentPath(call.url), call.url, id);
      assert.match(
        withAttribute(dialogOf(document), "data-confirm-question")[0]
          .textContent,
        /Bitte löschen Sie meine Daten/
      );
      await act(() =>
        click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
      );
      await act();

      assert.deepEqual(
        server.deletes(),
        [
          {
            method: ROUTES.deleteConversation.method,
            url: await urlOf(ROUTES.deleteConversation),
            body: conversationBody(chatIdOf(id)),
          },
        ],
        id
      );
      // Keine Anfrage dieser Ansicht kommt – nach dem Auflösen der Adresse
      // durch den Browser – beim Löschen des Widgets an.
      assert.equal(state.widgetDeleted, false, id);
      assert.deepEqual(cardIdsOf(container), ["k-1"], id);
      assert.deepEqual(
        shown.filter(([type]) => type === "success"),
        [["success", "Konversation gelöscht (4 Nachrichten)."]],
        id
      );
      await mounted.unmount();
    }
  }
);

test(
  "Konversation löschen: Zwei Karten mit derselben Kennung (zwei Browser-Sitzungen) – Einzelansicht, Vorschau und Löschen nennen die Zeile der aufgeklappten Karte, die andere bleibt",
  { skip },
  async (t) => {
    // Die conversation_id vergibt der Besucher: Eine zweite Sitzung hat die
    // Kennung der ersten gesendet.
    const first = conversation("k-1", {
      session_id: "besucher",
      first_chat_id: 11,
      message_count: 3,
      preview: "Wann beginnt der Kurs?",
    });
    const second = conversation("k-1", {
      session_id: "zweiter-besucher",
      first_chat_id: 12,
      message_count: 1,
      preview: "Bitte löschen Sie meine Daten (DSGVO)",
    });
    const state = {
      conversations: [first, second, conversation("k-2")],
      preview: {
        11: {
          success: true,
          messageCount: 3,
          visitor: { conversationCount: 2, messageCount: 7 },
        },
        12: {
          success: true,
          messageCount: 1,
          visitor: { conversationCount: 1, messageCount: 1 },
        },
      },
    };
    const server = await listServer(t, state);
    // React meldet doppelte Schlüssel der Karten über console.error.
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    t.after(() => {
      console.error = original;
    });
    const mounted = await mountList(t);
    const { container, document, act } = mounted;

    assert.deepEqual(cardIdsOf(container), ["k-1", "k-1", "k-2"]);
    await expand(mounted, 1);
    // nur die zweite Konversation ist geöffnet, ihr Besucher hat nur diese
    assert.equal(
      withAttribute(container, "data-delete-conversation").length,
      1
    );
    await openMenu(mounted);
    assert.deepEqual(server.calls.slice(1), [
      { method: "GET", url: server.detailUrl(12), body: undefined },
      {
        method: ROUTES.deletionPreview.method,
        url: await urlOf(ROUTES.deletionPreview),
        body: conversationBody(12),
      },
    ]);
    assert.equal(withAttribute(container, "data-delete-visitor").length, 0);

    await act(() =>
      click(withAttribute(container, "data-delete-conversation")[0])
    );
    const dialog = dialogOf(document);
    assert.match(
      withAttribute(dialog, "data-confirm-question")[0].textContent,
      /Bitte löschen Sie meine Daten/
    );
    assert.match(dialog.textContent, /Die Konversation mit 1 Nachricht wird/);
    await act(() => click(withAttribute(dialog, "data-confirm-delete")[0]));
    await act();

    assert.deepEqual(server.deletes(), [
      {
        method: ROUTES.deleteConversation.method,
        url: await urlOf(ROUTES.deleteConversation),
        body: conversationBody(12),
      },
    ]);
    // Die Zeile der ersten Sitzung steht noch da, mit ihrer Frage; das Panel
    // ist zu.
    assert.equal(state.conversations.includes(first), true);
    assert.equal(state.conversations.includes(second), false);
    assert.deepEqual(cardIdsOf(container), ["k-1", "k-2"]);
    assert.match(container.textContent, /Wann beginnt der Kurs\?/);
    assert.doesNotMatch(container.textContent, /Bitte löschen Sie meine Daten/);
    assert.equal(
      withAttribute(container, "data-delete-conversation").length,
      0
    );

    // Für sie bleibt „alle Konversationen dieses Besuchers" im Angebot.
    await expand(mounted, 0);
    await openMenu(mounted);
    await act(() => click(withAttribute(container, "data-delete-visitor")[0]));
    await act(() =>
      click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
    );
    await act();
    // mit den Zahlen der Rückfrage: gelöscht wird nur dieser Stand
    // (Fixliste 7, F10)
    assert.deepEqual(server.deletes()[1], {
      method: ROUTES.deleteVisitor.method,
      url: await urlOf(ROUTES.deleteVisitor),
      body: conversationBody(11, { conversationCount: 2, messageCount: 7 }),
    });
    assert.deepEqual(cardIdsOf(container), ["k-2"]);
    assert.deepEqual(errors, []);
  }
);

test(
  "Konversation löschen: Als gelöscht gilt nur, was der Server mit der Zahl der Nachrichten belegt – ein bloßes { success: true } wird als Fehlschlag gemeldet",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const state = {
      conversations: [conversation("k-1"), conversation("k-2")],
      // so antwortet etwa DELETE /embed/:embedId (Widget löschen)
      deleteAnswer: { success: true, error: null },
      preview: {
        "k-1": {
          success: true,
          messageCount: 4,
          visitor: { conversationCount: 2, messageCount: 8 },
        },
      },
    };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;
    const confirm = async (attribute) => {
      await expand(mounted, 0);
      if (attribute === "data-delete-visitor") await openMenu(mounted);
      await act(() => click(withAttribute(container, attribute)[0]));
      await act(() =>
        click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
      );
      await act();
    };
    const failed = ["error", "Die Konversation konnte nicht gelöscht werden."];

    await confirm("data-delete-conversation");
    assert.deepEqual(shown, [failed]);
    assert.equal(dialogOf(document), null);
    // Die Liste zeigt den tatsächlichen Stand.
    assert.equal(server.lists().length, 2);
    assert.deepEqual(cardIdsOf(container), ["k-1", "k-2"]);

    // ebenso mit einer Zahl, die keine ist …
    for (const deletedCount of [null, "4", 4.5, NaN]) {
      shown.length = 0;
      state.deleteAnswer = { success: true, deletedCount };
      await confirm("data-delete-conversation");
      assert.deepEqual(shown, [failed], String(deletedCount));
    }
    // … und bei „alle Konversationen dieses Besuchers" ohne deren Anzahl.
    shown.length = 0;
    state.deleteAnswer = { success: true, deletedCount: 8 };
    await confirm("data-delete-visitor");
    assert.deepEqual(shown, [failed]);

    // Gegenprobe: Mit den Zahlen des Servers ist es ein Erfolg.
    shown.length = 0;
    state.deleteAnswer = {
      success: true,
      deletedCount: 8,
      conversationCount: 2,
    };
    await confirm("data-delete-visitor");
    assert.deepEqual(shown, [
      ["success", "2 Konversationen gelöscht (8 Nachrichten)."],
    ]);
    shown.length = 0;
    state.deleteAnswer = { success: true, deletedCount: 0 };
    await confirm("data-delete-conversation");
    assert.deepEqual(shown, [
      ["success", "Konversation gelöscht (0 Nachrichten)."],
    ]);
  }
);

test(
  "Konversation löschen (AK-6): Wird eine nachgeladene Konversation gelöscht, lädt die Liste dieselbe Menge ab vorn neu – das Panel schließt, die Zeile ist fort",
  { skip },
  async (t) => {
    const ids = (from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => `k-${from + i}`);
    // 20 + 20 + 1
    const state = { conversations: ids(1, 41).map((id) => conversation(id)) };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;
    const pages = () =>
      server.lists().map((call) => [call.start, call.body.limit]);
    const loadMore = async () => {
      await act(() => click(withAttribute(container, "data-load-more")[0]));
      await act();
    };

    assert.deepEqual(cardIdsOf(container), ids(1, 20));
    await loadMore();
    await loadMore();
    assert.deepEqual(pages(), [
      [0, 20],
      [20, 20],
      [40, 20],
    ]);
    assert.deepEqual(cardIdsOf(container), ids(1, 41));
    assert.equal(withAttribute(container, "data-load-more").length, 0);

    await expand(mounted, 40);
    await act(() =>
      click(withAttribute(container, "data-delete-conversation")[0])
    );
    await act(() =>
      click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
    );
    await act();
    await act();

    assert.deepEqual(
      server.deletes().map((call) => call.body),
      [conversationBody(chatIdOf("k-41"))]
    );
    // neu geladen: so viele wie geladen waren, ab vorn
    assert.deepEqual(pages().at(-1), [0, 41]);
    assert.deepEqual(cardIdsOf(container), ids(1, 40));
    assert.equal(withAttribute(container, "data-conversation-panel").length, 0);
    const [count] = withAttribute(container, "data-viewable-count");
    assert.equal(count.textContent, "40 einsehbar");
    assert.doesNotMatch(container.textContent, /Keine Konversationen/);

    // Die letzte Konversation überhaupt: leerer Zustand, kein weiteres Laden.
    state.conversations = [conversation("k-1")];
    const single = await mountList(t);
    server.calls.length = 0;
    await expand(single, 0);
    await single.act(() =>
      click(withAttribute(single.container, "data-delete-conversation")[0])
    );
    await single.act(() =>
      click(withAttribute(dialogOf(single.document), "data-confirm-delete")[0])
    );
    await single.act();
    await single.act();
    assert.deepEqual(pages(), [[0, 20]]);
    assert.deepEqual(cardIdsOf(single.container), []);
    assert.equal(
      withAttribute(single.container, "data-viewable-count")[0].textContent,
      "0 einsehbar"
    );
  }
);

test(
  "Konversation löschen (Fixliste 2, S6): Waren mehr als 100 Zeilen geladen, lädt die Liste nach dem Löschen wieder so viele – erst 100, dann den Rest in 100er-Schritten",
  { skip },
  async (t) => {
    const ids = (from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => `k-${from + i}`);
    const state = { conversations: ids(1, 260).map((id) => conversation(id)) };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;
    const pages = () =>
      server.lists().map((call) => [call.start, call.body.limit]);
    // 20 + 11 × 20 = 240 Zeilen geladen
    for (let i = 0; i < 11; i++) {
      await act(() => click(withAttribute(container, "data-load-more")[0]));
      await act();
    }
    assert.equal(cardIdsOf(container).length, 240);
    const before = server.lists().length;

    await expand(mounted, 5);
    await act(() =>
      click(withAttribute(container, "data-delete-conversation")[0])
    );
    await act();
    await act(() =>
      click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
    );
    for (let i = 0; i < 6; i++) await act();

    assert.deepEqual(pages().slice(before), [
      [0, 100],
      [100, 100],
      [200, 40],
    ]);
    // k-6 ist gelöscht; die Liste zeigt wieder 240 Zeilen ab vorn
    assert.equal(cardIdsOf(container).length, 240);
    assert.ok(!cardIdsOf(container).includes("k-6"));
    assert.deepEqual(cardIdsOf(container).slice(0, 6), [
      "k-1",
      "k-2",
      "k-3",
      "k-4",
      "k-5",
      "k-7",
    ]);
  }
);

test(
  "Konversation löschen (Fixliste 3, C1): Bringt eine nachgeladene Seite nur Doppelte, hört das Auffüllen auf – keine Endlosschleife",
  { skip },
  async (t) => {
    const ids = (from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => `k-${from + i}`);
    const state = { conversations: ids(1, 260).map((id) => conversation(id)) };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;
    const pages = () =>
      server.lists().map((call) => [call.start, call.body.limit]);
    for (let i = 0; i < 11; i++) {
      await act(() => click(withAttribute(container, "data-load-more")[0]));
      await act();
    }
    assert.equal(cardIdsOf(container).length, 240);
    const before = server.lists().length;

    state.repeatFirstPage = true;
    await expand(mounted, 5);
    await act(() =>
      click(withAttribute(container, "data-delete-conversation")[0])
    );
    await act();
    await act(() =>
      click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
    );
    for (let i = 0; i < 20; i++) await act();

    // die erste Seite, ein Nachladen ohne neue Zeile – dann Schluss
    assert.deepEqual(pages().slice(before), [
      [0, 100],
      [100, 100],
    ]);
    assert.equal(cardIdsOf(container).length, 100);
    // „Weitere laden“ bleibt für den Nutzer da
    assert.equal(withAttribute(container, "data-load-more").length, 1);
  }
);

test(
  "Konversation löschen (Fixliste 3, C5): Wechselt der Zuschnitt, während die Liste auffüllt, verfällt das Auffüllen – auch wenn der Zuschnitt zurückkehrt",
  { skip },
  async (t) => {
    const ids = (from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => `k-${from + i}`);
    const state = { conversations: ids(1, 260).map((id) => conversation(id)) };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;
    const pages = () =>
      server
        .lists()
        .map((call) => [call.start, call.body.limit, call.body.q ?? ""]);
    for (let i = 0; i < 11; i++) {
      await act(() => click(withAttribute(container, "data-load-more")[0]));
      await act();
    }
    const before = server.lists().length;

    let release;
    state.holdMore = new Promise((resolve) => {
      release = resolve;
    });
    await expand(mounted, 5);
    await act(() =>
      click(withAttribute(container, "data-delete-conversation")[0])
    );
    await act();
    await act(() =>
      click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
    );
    for (let i = 0; i < 4; i++) await act();
    assert.deepEqual(pages().slice(before), [
      [0, 100, ""],
      [100, 100, ""],
    ]);

    // Suche: ein anderer Zuschnitt, während das Nachladen noch wartet
    const input = withAttribute(container, "data-search-input")[0];
    const { handlersOf } = await import("./helpers/testDom.mjs");
    await act(() => handlersOf(input).onChange({ target: { value: "kurs" } }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    await act();
    state.holdMore = null;
    await act(() => release());
    await act();
    // zurück zum alten Zuschnitt (✕ im Suchfeld)
    await act(() => click(withAttribute(container, "data-search-clear")[0]));
    for (let i = 0; i < 8; i++) await act();

    assert.deepEqual(pages().slice(before), [
      [0, 100, ""],
      [100, 100, ""],
      [0, 20, "kurs"],
      [0, 20, ""],
    ]);
    assert.equal(cardIdsOf(container).length, 20);
  }
);

test(
  "Konversation löschen: Weicht der Zähler von der Liste ab (zwei Abfragen auf dem Server), lädt die Liste genau einmal neu – kein „Laden…“ auf Dauer",
  { skip },
  async (t) => {
    const ids = (from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => `k-${from + i}`);
    for (const counted of [21, 61]) {
      const state = { conversations: ids(1, 21).map((id) => conversation(id)) };
      const server = await listServer(t, state);
      const mounted = await mountList(t);
      const { container, document, act } = mounted;
      const offsets = () => server.lists().map((call) => call.start);

      await act(() => click(withAttribute(container, "data-load-more")[0]));
      await act();
      assert.deepEqual(offsets(), [0, 20], String(counted));
      assert.deepEqual(cardIdsOf(container), ids(1, 21));

      // Zwischen den beiden Abfragen des Servers beginnt eine Konversation:
      // Die Liste hat sie noch nicht, der Zähler schon.
      state.totalCount = counted;
      await expand(mounted, 20);
      await act(() =>
        click(withAttribute(container, "data-delete-conversation")[0])
      );
      await act(() =>
        click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
      );
      for (let i = 0; i < 5; i++) await act();

      assert.deepEqual(offsets(), [0, 20, 0], String(counted));
      assert.doesNotMatch(container.textContent, /Laden/, String(counted));
      assert.deepEqual(cardIdsOf(container), ids(1, 20));
      assert.equal(
        withAttribute(container, "data-viewable-count")[0].textContent,
        `${counted} einsehbar`
      );
      // „Exportieren" ist nicht gesperrt.
      const [menu] = withAttribute(container, "data-export-menu");
      assert.equal(buttonsOf(menu)[0].hasAttribute("disabled"), false);
      await mounted.unmount();
    }
  }
);

test(
  "Alle Konversationen dieses Besuchers löschen (AK-12): nur angeboten, wenn derselbe Browser weitere Konversationen hat; die Rückfrage nennt die Anzahl",
  { skip },
  async (t) => {
    const state = {
      conversations: [
        conversation("k-1", { session_id: "besucher" }),
        conversation("k-2", { session_id: "besucher" }),
        conversation("k-3", { session_id: "anderer" }),
      ],
      preview: {
        "k-1": {
          success: true,
          messageCount: 4,
          visitor: { conversationCount: 4, messageCount: 11 },
        },
        "k-3": {
          success: true,
          messageCount: 4,
          visitor: { conversationCount: 1, messageCount: 4 },
        },
      },
    };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;

    // k-3: der Besucher hat nur diese eine Konversation
    await expand(mounted, 2);
    assert.equal(
      withAttribute(container, "data-delete-conversation").length,
      1
    );
    await openMenu(mounted);
    assert.equal(withAttribute(container, "data-delete-visitor").length, 0);

    // k-1: drei weitere Konversationen desselben Browsers – im Menü „⋯"
    await expand(mounted, 0);
    await openMenu(mounted);
    const [all] = withAttribute(container, "data-delete-visitor");
    assert.equal(
      all.textContent,
      "Alle Konversationen dieses Besuchers löschen"
    );
    assert.equal(all.getAttribute("role"), "menuitem");
    assert.equal(
      withAttribute(container, "data-delete-conversation").length,
      1
    );

    await act(() => click(all));
    const dialog = dialogOf(document);
    assert.equal(
      dialog.getAttribute("aria-label"),
      "Alle Konversationen dieses Besuchers löschen?"
    );
    assert.match(
      dialog.textContent,
      /stammen in diesem Widget 4 Konversationen mit zusammen 11 Nachrichten\. Alle werden endgültig gelöscht\./
    );
    assert.match(
      dialog.textContent,
      /Konversationen aus anderen Browsern bleiben erhalten/
    );
    assert.deepEqual(server.deletes(), []);

    await act(() => click(withAttribute(dialog, "data-confirm-delete")[0]));
    await act();

    assert.deepEqual(server.deletes(), [
      {
        method: ROUTES.deleteVisitor.method,
        url: await urlOf(ROUTES.deleteVisitor),
        body: conversationBody(chatIdOf("k-1"), {
          conversationCount: 4,
          messageCount: 11,
        }),
      },
    ]);
    assert.equal(dialogOf(document), null);
    assert.deepEqual(cardIdsOf(container), ["k-3"]);
  }
);

test(
  "Keine Browser-Dialoge: Export und Löschen kommen ohne confirm() und alert() aus",
  { skip },
  async () => {
    for (const file of [
      "ExportMenu.jsx",
      "DeleteConversation.jsx",
      "ConversationList.jsx",
      "ConversationDetail.jsx",
    ]) {
      const source = readFileSync(
        new URL(
          `../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics/${file}`,
          import.meta.url
        ),
        "utf8"
      );
      assert.doesNotMatch(source, /\b(confirm|alert|prompt)\s*\(/, file);
    }
  }
);

// ---------------------------------------------------------------------------
// Fixliste 7
// ---------------------------------------------------------------------------

test(
  "Fixliste 7, F10: Alle Konversationen des Besuchers – die Rückfrage sendet ihre Zahlen mit; hat der Besucher inzwischen weiter geschrieben (409), bleibt sie offen und nennt den neuen Stand, das erneute Bestätigen sendet ihn",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const state = {
      conversations: [
        conversation("k-1", { session_id: "besucher" }),
        conversation("k-2", { session_id: "besucher" }),
      ],
      preview: {
        "k-1": {
          success: true,
          messageCount: 4,
          visitor: { conversationCount: 2, messageCount: 7 },
        },
      },
      visitorAnswers: [
        {
          status: 409,
          body: {
            success: false,
            reason: "changed",
            visitor: { conversationCount: 3, messageCount: 9 },
            error: "The visitor's conversations have changed.",
          },
        },
      ],
    };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;
    await expand(mounted, 0);
    await openMenu(mounted);
    await act(() => click(withAttribute(container, "data-delete-visitor")[0]));
    await act(() =>
      click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
    );
    await act();

    // nichts gelöscht: die Rückfrage bleibt, mit Hinweis und neuen Zahlen
    const dialog = dialogOf(document);
    assert.ok(dialog);
    assert.equal(
      withAttribute(dialog, "data-confirm-changed")[0].textContent,
      "Der Besucher hat inzwischen weiter geschrieben – es wurde nichts gelöscht. Bitte prüfen Sie die neuen Zahlen und bestätigen Sie erneut."
    );
    assert.match(
      withAttribute(dialog, "data-confirm-visitor-count")[0].textContent,
      /3 Konversationen mit zusammen 9 Nachrichten/
    );
    assert.deepEqual(cardIdsOf(container), ["k-1", "k-2"]);
    assert.deepEqual(shown, []);

    // erneut bestätigt: mit dem neuen Stand
    await act(() =>
      click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
    );
    await act();
    assert.deepEqual(
      server.deletes().map((call) => call.body),
      [
        conversationBody(chatIdOf("k-1"), {
          conversationCount: 2,
          messageCount: 7,
        }),
        conversationBody(chatIdOf("k-1"), {
          conversationCount: 3,
          messageCount: 9,
        }),
      ]
    );
    assert.equal(dialogOf(document), null);
    assert.deepEqual(cardIdsOf(container), []);
  }
);

test(
  "Fixliste 7, F08/B4: Lösch-Rückfrage – mobil sind Abbrechen, Löschen und ✕ mindestens 44 px hoch (ab sm kompakter); „Erste Frage“ steht in normaler Schreibung, nicht in Versalien",
  { skip },
  async (t) => {
    await listServer(t, {
      conversations: [conversation("k-1")],
      preview: {
        "k-1": { success: true, messageCount: 4, visitor: null },
      },
    });
    const mounted = await mountList(t);
    const { container, document, act } = mounted;
    await expand(mounted, 0);
    await act(() =>
      click(withAttribute(container, "data-delete-conversation")[0])
    );
    await act();
    const dialog = dialogOf(document);
    const classesOf = (attribute) =>
      withAttribute(dialog, attribute)[0].getAttribute("class").split(/\s+/);
    for (const attribute of ["data-confirm-cancel", "data-confirm-delete"]) {
      const classes = classesOf(attribute);
      assert.ok(classes.includes("min-h-11"), attribute);
      assert.ok(classes.includes("sm:min-h-0"), attribute);
    }
    const close = classesOf("data-confirm-close");
    assert.ok(close.includes("h-11") && close.includes("w-11"));
    assert.ok(close.includes("sm:h-auto") && close.includes("sm:w-auto"));
    // „Erste Frage“: keine Versalien mehr
    const label = withAttribute(dialog, "data-confirm-question-label")[0];
    assert.equal(label.textContent, "Erste Frage");
    assert.ok(!label.getAttribute("class").split(/\s+/).includes("uppercase"));
  }
);
