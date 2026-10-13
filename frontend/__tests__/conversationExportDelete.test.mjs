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

const { ROUTES, conversationsBody, exportBody } = requests;

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

function conversation(id, extra = {}) {
  return {
    conversation_id: id,
    session_id: `sitzung-${id}`,
    embed_id: EMBED_ID,
    first_chat_id: 1,
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
async function urlOf(route, conversationId = null) {
  const { API_BASE } = await renderer.load("/src/utils/constants.js");
  return `${API_BASE}${route.path
    .replace(":embedId", EMBED_ID)
    .replace(":conversationId", encodeURIComponent(conversationId))}`;
}

/**
 * Der Server der Liste. `state.conversations` ist der Bestand; Löschen
 * entfernt daraus. Jede Anfrage wird mit Methode, Adresse und Rumpf gemerkt.
 */
async function listServer(t, state) {
  const { API_BASE } = await renderer.load("/src/utils/constants.js");
  const listUrl = await urlOf(ROUTES.conversations);
  const exportUrl = await urlOf(ROUTES.export);
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

    if (url === listUrl)
      return json({
        success: true,
        conversations: state.conversations,
        hasMore: false,
        totalCount: state.conversations.length,
      });
    if (url === exportUrl) {
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

    const match = new RegExp(
      `^${API_BASE}/embed/${EMBED_ID}/conversation/([^/]+)(/deletion-preview|/visitor)?$`
    ).exec(url);
    if (!match) return json({ success: false, error: "unbekannt" }, 404);
    const id = decodeURIComponent(match[1]);
    // Ohne Nachrichten: Deren Darstellung (MarkdownRenderer) braucht
    // DOMPurify und damit einen Browser.
    if (call.method === "GET" && !match[2])
      return json({ success: true, messages: [] });
    if (match[2] === "/deletion-preview")
      return json(
        state.preview?.[id] ?? { success: true, messageCount: 4, visitor: null }
      );
    if (call.method !== "DELETE") return json({ success: false }, 405);
    if (state.deleteFails)
      return json({ success: false, error: "Conversation not found." }, 404);
    if (match[2] === "/visitor") {
      const session = state.conversations.find(
        (c) => c.conversation_id === id
      )?.session_id;
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
    state.conversations = state.conversations.filter(
      (c) => c.conversation_id !== id
    );
    return json({ success: true, deletedCount: 4 });
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
  };
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
  "Anfrage (AK-6, AK-12): Vorschau, Löschen einer Konversation und aller Konversationen eines Besuchers – Methode und Adresse, Kennung kodiert, ohne Rumpf",
  { skip },
  async (t) => {
    const server = await listServer(t, { conversations: [] });
    const { default: Embed } = await renderer.load("/src/models/embed.js");
    const id = "konv/1 ä?#%";

    await Embed.getConversationDeletionPreview(EMBED_ID, id);
    await Embed.deleteConversation(EMBED_ID, id);
    await Embed.deleteVisitorConversations(EMBED_ID, id);

    assert.deepEqual(server.calls, [
      {
        method: ROUTES.deletionPreview.method,
        url: await urlOf(ROUTES.deletionPreview, id),
        body: undefined,
      },
      {
        method: ROUTES.deleteConversation.method,
        url: await urlOf(ROUTES.deleteConversation, id),
        body: undefined,
      },
      {
        method: ROUTES.deleteVisitor.method,
        url: await urlOf(ROUTES.deleteVisitor, id),
        body: undefined,
      },
    ]);
    assert.match(
      server.calls[1].url,
      /\/embed\/3\/conversation\/konv%2F1%20%C3%A4%3F%23%25$/
    );
    assert.match(server.calls[2].url, /%25\/visitor$/);
    assert.match(server.calls[0].url, /%25\/deletion-preview$/);
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
    const [menu] = withAttribute(container, "data-export-menu");
    const headerRight = menu.parentNode;
    assert.deepEqual(
      buttonsOf(headerRight).map((button) => button.textContent),
      ["Nur mit 👍", "Nur mit 👎", "Exportieren"]
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

    // Die Liste selbst hat mit genau dieser Auswahl geladen.
    assert.deepEqual(server.lists(), [
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
    assert.equal(server.lists().length, 1);
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
    assert.deepEqual(
      server.calls.slice(1).map((call) => [call.method, call.url]),
      [
        [
          "GET",
          (await urlOf(ROUTES.deleteConversation, "k-1")).replace(/$/, ""),
        ],
        ["GET", await urlOf(ROUTES.deletionPreview, "k-1")],
      ]
    );

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
        url: await urlOf(ROUTES.deleteConversation, "k-2"),
        body: undefined,
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
        url: await urlOf(ROUTES.deleteVisitor, "k-1"),
        body: undefined,
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
