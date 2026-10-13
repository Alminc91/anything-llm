// KIE-538: Ansicht „Konversationen" – „Exportieren" in der Kopfzeile der
// Liste, „Konversation löschen" am Fuß einer aufgeklappten Konversation.
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
const PERIOD = {
  startDate: "2026-08-31T22:00:00.000Z",
  endDate: "2026-09-30T21:59:59.999Z",
};
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
 * Die Liste blättert wie der echte Server (offset, limit, hasMore), und die
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
      const { offset = 0, limit = 20 } = call.body ?? {};
      const total = state.conversations.length;
      return json({
        success: true,
        conversations: state.conversations.slice(offset, offset + limit),
        hasMore: offset + limit < total,
        totalCount: state.totalCount ?? total,
      });
    }
    if (is(ROUTES.export, exportUrl)) {
      if (state.exportStatus) return json(null, state.exportStatus);
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
const cardIdsOf = (container) =>
  elements(container, (element) =>
    (element.getAttribute("class") ?? "").includes("font-mono")
  ).map((element) => element.textContent);
/** Klappt die Konversation auf (Klick auf ihre Kopfzeile). */
async function expand(mounted, index = 0) {
  const headers = elements(
    mounted.container,
    (element) =>
      element.tagName === "DIV" &&
      (element.getAttribute("class") ?? "")
        .split(" ")
        .includes("cursor-pointer")
  );
  await mounted.act(() => click(headers[index]));
  await mounted.act();
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
      // „Gesamt": kein Zeitraum (undefined geht nicht über die Leitung)
      {
        method: ROUTES.export.method,
        url: server.exportUrl,
        body: { format: "csv", feedbackFilter: "all" },
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

    // Kopfzeile: erst die beiden Bewertungsfilter, dann „Exportieren"
    // (Bewertungsfilter mit kurzem und ausgeschriebenem Text, je nach Breite
    // ist einer sichtbar)
    const [menu] = withAttribute(container, "data-export-menu");
    const headerRight = menu.parentNode;
    assert.deepEqual(
      buttonsOf(headerRight).map((button) => button.textContent),
      ["PositivPositiv bewertet", "NegativNegativ bewertet", "Exportieren"]
    );
    assert.deepEqual(
      headerRight.childNodes.map((child) => child.tagName),
      ["BUTTON", "BUTTON", "DIV"]
    );
    assert.equal(headerRight.lastChild, menu);

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
    // die Zählabfrage ohne Bewertungsfilter für „N von M einsehbar".
    assert.deepEqual(server.lists(), [
      {
        method: ROUTES.conversations.method,
        url: server.listUrl,
        body: conversationsBody({ ...PERIOD, limit: 1, bucket }),
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

// ---------------------------------------------------------------------------
// „Konversation löschen" am Fuß der aufgeklappten Konversation
// ---------------------------------------------------------------------------

test(
  "Konversation löschen (AK-6): erst aufgeklappt zu sehen; die Rückfrage nennt die erste Frage (gekürzt) und die Zahl der Nachrichten; Abbrechen löscht nichts",
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
    assert.deepEqual(server.calls.slice(1), [
      {
        method: "GET",
        url: server.detailUrl(chatIdOf("k-1")),
        body: undefined,
      },
      {
        method: ROUTES.deletionPreview.method,
        url: await urlOf(ROUTES.deletionPreview),
        body: conversationBody(chatIdOf("k-1")),
      },
    ]);

    const [remove] = withAttribute(container, "data-delete-conversation");
    assert.equal(remove.textContent, "Konversation löschen");
    // am Fuß: nach den Nachrichten der Konversation
    const actions = withAttribute(container, "data-conversation-actions")[0];
    assert.equal(actions.parentNode.lastChild, actions);
    // nur eine Konversation dieses Besuchers: kein zweites Angebot
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
      const [remove] = withAttribute(container, "data-delete-conversation");
      await act(() => click(remove));
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
    assert.deepEqual(server.calls.slice(1), [
      { method: "GET", url: server.detailUrl(12), body: undefined },
      {
        method: ROUTES.deletionPreview.method,
        url: await urlOf(ROUTES.deletionPreview),
        body: conversationBody(12),
      },
    ]);
    // nur die zweite Karte ist aufgeklappt, ihr Besucher hat nur diese eine
    assert.equal(
      withAttribute(container, "data-delete-conversation").length,
      1
    );
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
    // Die Karte der ersten Sitzung steht noch da – zugeklappt, mit ihrer Frage.
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
    await act(() => click(withAttribute(container, "data-delete-visitor")[0]));
    await act(() =>
      click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
    );
    await act();
    assert.deepEqual(server.deletes()[1], {
      method: ROUTES.deleteVisitor.method,
      url: await urlOf(ROUTES.deleteVisitor),
      body: conversationBody(11),
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
  "Konversation löschen (AK-6): Wird die letzte Konversation einer hinteren Seite gelöscht, zeigt die Liste die letzte vorhandene Seite – nicht „keine Konversationen“",
  { skip },
  async (t) => {
    const ids = (from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => `k-${from + i}`);
    // drei Seiten: 20 + 20 + 1
    const state = { conversations: ids(1, 41).map((id) => conversation(id)) };
    const server = await listServer(t, state);
    const mounted = await mountList(t);
    const { container, document, act } = mounted;
    const offsets = () => server.lists().map((call) => call.body.offset);
    const pageButton = (number) =>
      buttonsOf(container).find(
        (button) => button.textContent === String(number)
      );

    assert.deepEqual(cardIdsOf(container), ids(1, 20));
    await act(() => click(pageButton(3)));
    await act();
    assert.deepEqual(offsets(), [0, 40]);
    assert.deepEqual(cardIdsOf(container), ["k-41"]);

    await expand(mounted, 0);
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
    // neu geladen: Seite 3 ist leer → Seite 2, die letzte vorhandene
    assert.deepEqual(offsets(), [0, 40, 40, 20]);
    assert.deepEqual(cardIdsOf(container), ids(21, 40));
    // nicht im Ladezustand, nicht leer
    const [count] = withAttribute(container, "data-viewable-count");
    assert.equal(count.textContent, "40 einsehbar");
    assert.doesNotMatch(container.textContent, /Keine Konversationen/);
    assert.equal(pageButton(3), undefined);
    assert.ok(pageButton(2));

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
    assert.deepEqual(offsets(), [0]);
    assert.deepEqual(cardIdsOf(single.container), []);
    assert.equal(
      withAttribute(single.container, "data-viewable-count")[0].textContent,
      "0 einsehbar"
    );
  }
);

test(
  "Konversation löschen: Nennt der Zähler zu einer leeren Seite keine frühere Seite (Liste und Zähler sind zwei Abfragen), endet das Laden im leeren Zustand – kein „Laden…“ auf Dauer, keine weitere Anfrage",
  { skip },
  async (t) => {
    const ids = (from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => `k-${from + i}`);
    // 21 und 61: Der Zähler nennt die leere Seite selbst bzw. eine dahinter.
    for (const counted of [21, 61]) {
      // zwei Seiten: 20 + 1
      const state = { conversations: ids(1, 21).map((id) => conversation(id)) };
      const server = await listServer(t, state);
      const mounted = await mountList(t);
      const { container, document, act } = mounted;
      const offsets = () => server.lists().map((call) => call.body.offset);

      await act(() =>
        click(buttonsOf(container).find((button) => button.textContent === "2"))
      );
      await act();
      assert.deepEqual(offsets(), [0, 20], String(counted));
      assert.deepEqual(cardIdsOf(container), ["k-21"]);

      // Zwischen den beiden Abfragen des Servers beginnt eine Konversation:
      // Die Liste hat sie noch nicht, der Zähler schon.
      state.totalCount = counted;
      await expand(mounted, 0);
      await act(() =>
        click(withAttribute(container, "data-delete-conversation")[0])
      );
      await act(() =>
        click(withAttribute(dialogOf(document), "data-confirm-delete")[0])
      );
      for (let i = 0; i < 5; i++) await act();

      // neu geladen: Seite 2 ist leer – und dabei bleibt es
      assert.deepEqual(offsets(), [0, 20, 20], String(counted));
      assert.doesNotMatch(container.textContent, /Laden/, String(counted));
      assert.match(container.textContent, /Keine Konversationen vorhanden\./);
      assert.deepEqual(cardIdsOf(container), []);
      assert.equal(
        withAttribute(container, "data-viewable-count")[0].textContent,
        `${counted} einsehbar`
      );
      // „Exportieren" ist nicht länger gesperrt.
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
    assert.equal(withAttribute(container, "data-delete-visitor").length, 0);

    // k-1: drei weitere Konversationen desselben Browsers
    await expand(mounted, 0);
    const [all] = withAttribute(container, "data-delete-visitor");
    assert.equal(
      all.textContent,
      "Alle Konversationen dieses Besuchers löschen"
    );
    assert.equal(
      withAttribute(container, "data-delete-conversation").length,
      2
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
        body: conversationBody(chatIdOf("k-1")),
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
