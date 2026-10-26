// Wo die Oberfläche ein Widget nennt, steht dieselbe Bezeichnung
// (utils/embedLabel.js): Auswahl der Ansicht „Konversationen", Widget-Liste,
// Dialog „Einbettung aktualisieren", Kopfzeile des Design Centers. Die
// Komponenten sind mit React DOM in ein Dokument ohne Browser eingehängt
// (helpers/renderSettingsPage.mjs, mount); die reine Funktion prüft
// embedLabel.test.mjs.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements } from "./helpers/testDom.mjs";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets";
const CONVERSATIONS = `${DIR}/EmbedAnalytics/index.jsx`;
const WIDGET_LIST = `${DIR}/EmbedConfigs/index.jsx`;
const EDIT_MODAL = `${DIR}/EmbedConfigs/EmbedRow/EditEmbedModal/index.jsx`;
const DESIGN_CENTER = `${DIR}/EmbedAppearance/index.jsx`;
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

/** Ein Widget, wie GET /embeds es liefert (soweit die Ansichten es lesen). */
const widget = (id, name, workspaceId = 100 + id) => ({
  id,
  uuid: `uuid-${id}`,
  enabled: true,
  chat_mode: "query",
  allowlist_domains: null,
  chat_retention_days: null,
  visual_config: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  workspace: {
    id: workspaceId,
    name,
    slug: `workspace-${workspaceId}`,
  },
  _count: { embed_chats: 0 },
});

// Reihenfolge des Servers: zuletzt angelegt zuerst. „KuferMedia" hat zwei
// Widgets in einem Workspace.
const ELBE = widget(5, "Chatbot Elbe");
const MEDIA_3 = widget(3, "KuferMedia", 40);
const MEDIA_2 = widget(2, "KuferMedia", 40);
const AERZTE = widget(8, "Ärztehaus");
const EMBEDS = [ELBE, MEDIA_3, AERZTE, MEDIA_2];

/**
 * Ersetzt fetch für die Dauer eines Tests: GET /embeds liefert die Widgets,
 * die Auswertung antwortet ohne Zählwerte, das Design Center bekommt leere
 * Standardtexte, alles andere ein leeres Objekt. Merkt sich jede Anfrage.
 */
function stubServer(t, embeds = EMBEDS) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, body });
    let answer = {};
    if (url.endsWith("/embeds")) answer = { embeds };
    else if (url.includes("/embed/defaults")) answer = { defaults: {} };
    else if (url.endsWith("/analytics/summary"))
      answer = {
        success: true,
        granularity: "day",
        fromDay: body.fromDay,
        toDay: body.toDay,
        firstLedgerDay: null,
        totals: {
          messages: 0,
          conversations: 0,
          feedbackPositive: 0,
          feedbackNegative: 0,
        },
        buckets: [],
        weekdayHour: Array.from({ length: 7 }, () => Array(24).fill(0)),
      };
    else if (url.endsWith("/analytics/conversations"))
      answer = {
        success: true,
        conversations: [],
        hasMore: false,
        totalCount: 0,
      };
    return { ok: true, status: 200, json: async () => answer };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** Hängt eine Komponente ein und räumt nach dem Test wieder ab. */
async function mount(t, modulePath, options) {
  const mounted = await renderer.mount(modulePath, options);
  t.after(() => mounted.unmount());
  return mounted;
}

const visibleText = (node) => node.textContent.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Ansicht „Konversationen": Auswahl des Widgets
// ---------------------------------------------------------------------------

/** Die Ansicht mit einer Liste von Widgets. */
async function mountConversations(t, embeds) {
  const calls = stubServer(t, embeds);
  const mounted = await mount(t, CONVERSATIONS, {
    location: "/settings/chatbot/conversations",
    exportName: "AnalyticsScreen",
    props: { embedsLoaded: true, embeds },
  });
  const { container } = mounted;
  const dropdown = () =>
    elements(
      container,
      (element) => element.getAttribute("aria-haspopup") === "listbox"
    )[0];
  const options = () =>
    elements(container, (element) => element.getAttribute("role") === "option");
  /** Widget-Nummern, deren Zählwerte die Ansicht angefragt hat. */
  const summaryIds = () =>
    calls
      .map(({ url }) => url.match(/\/embed\/(\d+)\/analytics\/summary$/)?.[1])
      .filter(Boolean)
      .map(Number);
  return { ...mounted, calls, dropdown, options, summaryIds };
}

test(
  "Auswahl „Konversationen“: Jedes Widget heißt wie sein Workspace – ohne „Embed“, ohne „#“; nur mehrdeutige Einträge tragen die Widget-Nummer",
  { skip },
  async (t) => {
    const view = await mountConversations(t, EMBEDS);
    const { act, dropdown, options } = view;

    assert.equal(dropdown().getAttribute("aria-label"), "Widget");
    assert.equal(dropdown().textContent, "Chatbot Elbe");
    assert.equal(options().length, 0);

    await act(() => click(dropdown()));
    assert.deepEqual(
      options().map((option) => option.textContent),
      [
        "Ärztehaus",
        "Chatbot Elbe",
        "KuferMedia · Widget 2",
        "KuferMedia · Widget 3",
      ]
    );
    for (const option of options()) {
      assert.doesNotMatch(option.textContent, /embed/i);
      assert.doesNotMatch(option.textContent, /#/);
    }
    assert.deepEqual(
      options().map((option) => option.getAttribute("aria-selected")),
      ["false", "true", "false", "false"]
    );

    // Die Wahl eines mehrdeutigen Eintrags: Er steht mit Zusatz in der
    // Schaltfläche, und die Ansicht fragt die Zählwerte dieses Widgets an.
    await act(() => click(options()[2]));
    assert.equal(options().length, 0);
    assert.equal(dropdown().textContent, "KuferMedia · Widget 2");
    assert.equal(view.summaryIds().at(-1), MEDIA_2.id);

    await act(() => click(dropdown()));
    assert.deepEqual(
      options().map((option) => option.getAttribute("aria-selected")),
      ["false", "false", "true", "false"]
    );
  }
);

test(
  "Auswahl „Konversationen“: Vorauswahl bleibt das erste Widget in der Reihenfolge des Servers, auch wenn die Auswahl alphabetisch ordnet",
  { skip },
  async (t) => {
    // Alphabetisch stünde „Ärztehaus" vorn – vorausgewählt ist das zuletzt
    // angelegte Widget (erstes der Antwort von GET /embeds).
    const view = await mountConversations(t, [MEDIA_3, AERZTE, ELBE]);
    assert.equal(view.dropdown().textContent, "KuferMedia");
    assert.deepEqual([...new Set(view.summaryIds())], [MEDIA_3.id]);

    await view.act(() => click(view.dropdown()));
    assert.deepEqual(
      view.options().map((option) => option.textContent),
      ["Ärztehaus", "Chatbot Elbe", "KuferMedia"]
    );
  }
);

test(
  "Auswahl „Konversationen“ (AK-17): mit genau einem Widget weiterhin keine Auswahl; ohne Workspace-Namen „Widget <Nummer>“",
  { skip },
  async (t) => {
    const one = await mountConversations(t, [ELBE]);
    assert.equal(one.dropdown(), undefined);
    assert.doesNotMatch(visibleText(one.container), /Chatbot Elbe|Embed/);
    assert.deepEqual([...new Set(one.summaryIds())], [ELBE.id]);
    await one.unmount();

    const unnamed = await mountConversations(t, [
      { ...widget(7, ""), workspace: null },
      ELBE,
    ]);
    assert.equal(unnamed.dropdown().textContent, "Widget 7");
    await unnamed.act(() => click(unnamed.dropdown()));
    assert.deepEqual(
      unnamed.options().map((option) => option.textContent),
      ["Chatbot Elbe", "Widget 7"]
    );
  }
);

// ---------------------------------------------------------------------------
// Widget-Liste
// ---------------------------------------------------------------------------

/** Die Zeilen der Widget-Liste: Text der ersten Spalte und der Zusatz darin. */
function widgetRows(container) {
  return elements(
    container,
    (element) =>
      element.tagName === "TR" && element.parentNode.tagName === "TBODY"
  ).map((row) => {
    const [cell] = elements(row, (element) => element.tagName === "TH");
    const [link] = elements(cell, (element) => element.tagName === "A");
    const suffixes = elements(cell, (element) =>
      element.hasAttribute("data-widget-suffix")
    );
    assert.ok(suffixes.length <= 1, "mehr als ein Zusatz in einer Zeile");
    return {
      name: link.textContent,
      href: link.getAttribute("href"),
      suffix: suffixes[0]?.textContent ?? null,
      suffixClass: suffixes[0]?.getAttribute("class") ?? null,
      text: cell.textContent,
    };
  });
}

test(
  "Widget-Liste: Der Zusatz „· Widget <Nummer>“ steht nur an mehrdeutigen Einträgen – gedämpft neben dem Namen",
  { skip },
  async (t) => {
    stubServer(t, EMBEDS);
    const { container } = await mount(t, WIDGET_LIST, {
      location: "/settings/chatbot/widgets",
    });
    const rows = widgetRows(container);

    // Die Liste bleibt in der Reihenfolge des Servers.
    assert.deepEqual(
      rows.map(({ name, suffix }) => [name, suffix]),
      [
        ["Chatbot Elbe", null],
        ["KuferMedia", "· Widget 3"],
        ["Ärztehaus", null],
        ["KuferMedia", "· Widget 2"],
      ]
    );
    // Name (Link zum Workspace) und Zusatz sind zwei Elemente.
    assert.deepEqual(
      rows.map(({ text }) => text),
      [
        "Chatbot Elbe",
        "KuferMedia· Widget 3",
        "Ärztehaus",
        "KuferMedia· Widget 2",
      ]
    );
    assert.deepEqual(
      rows.map(({ href }) => href),
      [
        "/workspace/workspace-105",
        "/workspace/workspace-40",
        "/workspace/workspace-108",
        "/workspace/workspace-40",
      ]
    );
    for (const { suffixClass } of rows.filter((row) => row.suffix))
      assert.match(suffixClass, /\btext-theme-text-secondary\b/);
    assert.doesNotMatch(visibleText(container), /Embed|#/);
  }
);

test(
  "Widget-Liste: Bei eindeutigen Einträgen ändert sich nichts – kein Zusatz, keine Nummer",
  { skip },
  async (t) => {
    stubServer(t, [ELBE, MEDIA_3, AERZTE]);
    const { container } = await mount(t, WIDGET_LIST, {
      location: "/settings/chatbot/widgets",
    });
    assert.deepEqual(
      widgetRows(container).map(({ text, suffix }) => [text, suffix]),
      [
        ["Chatbot Elbe", null],
        ["KuferMedia", null],
        ["Ärztehaus", null],
      ]
    );
    assert.doesNotMatch(visibleText(container), /Widget \d/);
  }
);

// ---------------------------------------------------------------------------
// Dialog „Einbettung aktualisieren" und Kopfzeile des Design Centers
// ---------------------------------------------------------------------------

/** Überschrift eines Dialogs bzw. einer Seite. */
const headingOf = (container, tagName) =>
  elements(container, (element) => element.tagName === tagName)[0];

test(
  "Dialog „Einbettung aktualisieren“: Der Titel nennt das Widget wie die Liste – nicht mehr „#<Nummer>“",
  { skip },
  async (t) => {
    stubServer(t);
    const mountModal = (props) =>
      mount(t, EDIT_MODAL, {
        location: "/settings/chatbot/widgets",
        props: { closeModal() {}, ...props },
      });

    const ambiguous = await mountModal({
      embed: MEDIA_3,
      label: "KuferMedia · Widget 3",
    });
    assert.equal(
      headingOf(ambiguous.container, "H3").textContent,
      "Einbettung aktualisieren: KuferMedia · Widget 3"
    );
    await ambiguous.unmount();

    // Ohne Angabe der Liste: der Name des Workspaces.
    const plain = await mountModal({ embed: ELBE });
    assert.equal(
      headingOf(plain.container, "H3").textContent,
      "Einbettung aktualisieren: Chatbot Elbe"
    );
  }
);

test(
  "Design Center: Die Kopfzeile nennt das Widget wie die Liste – mit Zusatz nur bei Mehrdeutigkeit",
  { skip },
  async (t) => {
    const subtitleOf = async (embeds, id) => {
      stubServer(t, embeds);
      const mounted = await mount(t, DESIGN_CENTER, {
        location: "/settings/chatbot/design",
        props: { embedId: id },
      });
      const heading = headingOf(mounted.container, "H1");
      // KB-2: die Seite heißt wie ihr Menüpunkt
      assert.equal(heading.textContent, "Design Center");
      const subtitle = heading.nextSibling.textContent;
      await mounted.unmount();
      return subtitle;
    };

    assert.equal(await subtitleOf(EMBEDS, 2), "KuferMedia · Widget 2");
    assert.equal(await subtitleOf(EMBEDS, 5), "Chatbot Elbe");
    assert.equal(await subtitleOf([MEDIA_2, ELBE], 2), "KuferMedia");
    assert.equal(
      await subtitleOf([{ ...widget(7, ""), workspace: null }, ELBE], 7),
      "Widget 7"
    );
  }
);
