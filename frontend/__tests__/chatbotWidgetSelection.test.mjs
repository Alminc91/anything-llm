// KB-2: gemeinsame Widget-Auswahl im Bereich „Chatbot“. Die Seiten sind mit
// React DOM in ein Dokument ohne Browser eingehängt (helpers/
// renderSettingsPage.mjs, mount); die Adresse zeigt eine Sonde daneben
// (helpers/ChatbotPageProbe.jsx). Menü und Routentabelle:
// chatbotMenu.test.mjs.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements, handlersOf } from "./helpers/testDom.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets";
const PAGES = `${DIR}/index.jsx`;
const CONVERSATIONS_VIEW = `${DIR}/EmbedAnalytics/index.jsx`;
const WIDGET_LIST = `${DIR}/EmbedConfigs/index.jsx`;
const MENU_OPTION = "/src/components/SettingsSidebar/MenuOption/index.jsx";
const PROBE = "/__tests__/helpers/ChatbotPageProbe.jsx";
const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src"
);
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const CONVERSATIONS = "/settings/chatbot/conversations";
const DESIGN = "/settings/chatbot/design";
const WIDGETS = "/settings/chatbot/widgets";
const STATUS = "/settings/chatbot/status";
// Browser-Speicher des angemeldeten Testnutzers (id 1)
const REMEMBERED = "kie.chatbot.widget.1";
const NOT_FOUND =
  "Dieses Widget wurde nicht gefunden, oder Sie haben keinen Zugriff darauf.";

let renderer;
let h;
let LocationProbe;
before(async () => {
  if (!hasFrontendDeps) return;
  renderer = await createRenderer();
  const { default: React } = await import("react");
  h = React.createElement;
  ({ LocationProbe } = await renderer.load(PROBE));
});
after(async () => {
  await renderer?.close();
});

/** Ein Widget, wie GET /embeds es liefert (soweit die Ansichten es lesen). */
const widget = (id, name) => ({
  id,
  uuid: `uuid-${id}`,
  enabled: true,
  chat_mode: "query",
  allowlist_domains: null,
  chat_retention_days: null,
  visual_config: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  workspace: { id: 100 + id, name, slug: `workspace-${100 + id}` },
  _count: { embed_chats: 0 },
});

// Reihenfolge des Servers; die jüngste Nachricht hat „KuferMedia“ (3).
const ELBE = widget(5, "Chatbot Elbe");
const MEDIA = widget(3, "KuferMedia");
const AERZTE = widget(8, "Ärztehaus");
const EMBEDS = [ELBE, MEDIA, AERZTE];
const LAST_ACTIVITY = [
  { embedId: 5, lastMessageAt: 1_000 },
  { embedId: 3, lastMessageAt: 9_000 },
  { embedId: 8, lastMessageAt: null },
];

/** fetch für die Dauer eines Tests; merkt sich jede Anfrage. */
function stubServer(t, embeds = EMBEDS) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, body });
    let answer = {};
    if (url.endsWith("/embeds")) answer = { embeds };
    else if (url.endsWith("/embeds/last-activity"))
      answer = { success: true, lastActivity: LAST_ACTIVITY };
    else if (url.includes("/embed/defaults")) answer = { defaults: {} };
    else if (url.includes("/embed/course-status"))
      answer = { state: "nicht_eingerichtet", counts: null, widgets: [] };
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

/** Meldungen (react-toastify) für die Dauer eines Tests. */
async function toasts(t, { withOptions = false } = {}) {
  const { toast } = await import("react-toastify");
  const shown = [];
  const original = { success: toast.success, error: toast.error };
  const record = (type) => (text, options) =>
    shown.push(
      withOptions ? [type, text, options?.toastId ?? null] : [type, text]
    );
  toast.success = record("success");
  toast.error = record("error");
  t.after(() => Object.assign(toast, original));
  return shown;
}

async function mount(t, modulePath, options) {
  const mounted = await renderer.mount(modulePath, options);
  t.after(() => mounted.unmount());
  await mounted.act();
  return mounted;
}

const locationOf = (container) =>
  elements(container, (el) =>
    el.hasAttribute("data-location")
  )[0]?.getAttribute("data-location");
const picker = (container) =>
  elements(
    container,
    (el) => el.getAttribute("aria-haspopup") === "listbox"
  )[0];
/** Die gewählte Bezeichnung in der Auswahl (ohne die unsichtbaren zum Maß). */
const pickerLabel = (container) =>
  elements(picker(container), (el) =>
    el.hasAttribute("data-widget-picker-current")
  )[0]?.textContent.trim();
const option = (container, label) =>
  elements(
    container,
    (el) =>
      el.getAttribute("role") === "option" && el.textContent.trim() === label
  )[0];
/** Bezeichnung des Widgets unter der Überschrift des Design Centers. */
const designCenterWidget = (container) => {
  const heading = elements(container, (el) => el.tagName === "H1")[0];
  return heading?.nextSibling?.textContent ?? null;
};
/** Widgets, für die das Design Center seine Standardtexte geladen hat. */
const designCenterLoads = (calls) =>
  calls
    .filter((call) => call.url.includes("/embed/defaults"))
    .map((call) =>
      Number(new URL(call.url, "http://test").searchParams.get("embedId"))
    );
const remembered = () => globalThis.localStorage.getItem(REMEMBERED);

/** Das Design Center unter einer Adresse, mit der Sonde daneben. */
async function openDesignCenter(t, query = "", { embeds, stored } = {}) {
  const calls = stubServer(t, embeds);
  const mounted = await mount(t, PROBE, {
    location: `${DESIGN}${query}`,
    route: DESIGN,
    stored,
  });
  await mounted.act();
  return { ...mounted, calls };
}

// ---------------------------------------------------------------------------
// AK-1: „Status“ ist seit KB-3 eine eigene Seite
// ---------------------------------------------------------------------------

test(
  "AK-1: /settings/chatbot/status?widget=3 zeigt die Statusseite dieses Widgets (KB-3), keine Weiterleitung",
  { skip },
  async (t) => {
    // Die Seite selbst (ChatbotStatus) hängt die Seitenleiste ein, die sich
    // ohne Browser nicht einhängen lässt: hier die Ansicht darin.
    const calls = stubServer(t);
    const mounted = await mount(t, `${DIR}/CourseStatus/index.jsx`, {
      location: `${STATUS}?widget=3`,
      route: STATUS,
      props: { embeds: EMBEDS, lastActivity: LAST_ACTIVITY },
    });
    await mounted.act();
    assert.ok(
      calls.some((call) => call.url.endsWith("/embed/course-status?widget=3"))
    );
    assert.equal(pickerLabel(mounted.container), "KuferMedia");
    assert.equal(
      elements(mounted.container, (el) => el.tagName === "H2")[0]?.textContent,
      "Status"
    );
    const source = readFileSync(
      path.join(SRC, "pages/GeneralSettings/ChatEmbedWidgets/index.jsx"),
      "utf8"
    );
    const page = source.slice(source.indexOf("export function ChatbotStatus"));
    assert.match(page.slice(0, 800), /<CourseStatusView /);
    assert.doesNotMatch(page.slice(0, 800), /chatbot\.conversations\(\)/);
  }
);

// ---------------------------------------------------------------------------
// AK-2: Design Center unter /settings/chatbot/design?widget=<id>
// ---------------------------------------------------------------------------

test(
  "AK-2: Die frühere Adresse /settings/embed-config/7/appearance leitet auf /settings/chatbot/design?widget=7 weiter",
  { skip },
  async (t) => {
    const mounted = await mount(t, PAGES, {
      exportName: "DesignCenterRedirect",
      location: "/settings/embed-config/7/appearance",
      route: "/settings/embed-config/:embedId/appearance",
      otherRoutes: [{ path: DESIGN, element: h(LocationProbe) }],
    });
    assert.equal(locationOf(mounted.container), `${DESIGN}?widget=7`);
  }
);

test(
  "AK-2: /settings/chatbot/design?widget=5 öffnet das Design Center dieses Widgets",
  { skip },
  async (t) => {
    const { container, calls } = await openDesignCenter(t, "?widget=5");
    assert.equal(designCenterWidget(container), "Chatbot Elbe");
    assert.deepEqual(designCenterLoads(calls), [5]);
    assert.equal(
      elements(container, (el) => el.tagName === "H1")[0].textContent,
      "Design Center"
    );
  }
);

// ---------------------------------------------------------------------------
// AK-3: Merkregel und gemeinsame Auswahl
// ---------------------------------------------------------------------------

test(
  "AK-3: Ohne widget= und ohne gemerktes Widget zeigt das Design Center die Vorauswahl (jüngste Nachricht)",
  { skip },
  async (t) => {
    const { container, calls } = await openDesignCenter(t);
    assert.equal(designCenterWidget(container), "KuferMedia");
    assert.deepEqual(designCenterLoads(calls), [3]);
    // Die Vorauswahl gilt nicht als Wahl: nichts gemerkt, nichts geschrieben
    assert.equal(remembered(), null);
    assert.equal(locationOf(container), DESIGN);
  }
);

test(
  "AK-3: Ohne widget= gilt das zuletzt gewählte Widget; ein Widget in der Adresse geht vor und wird gemerkt",
  { skip },
  async (t) => {
    const stored = { [REMEMBERED]: "8" };
    const last = await openDesignCenter(t, "", { stored });
    assert.equal(designCenterWidget(last.container), "Ärztehaus");
    await last.unmount();

    const linked = await openDesignCenter(t, "?widget=5", { stored });
    assert.equal(designCenterWidget(linked.container), "Chatbot Elbe");
    assert.equal(remembered(), "5");
  }
);

test(
  "AK-3: Ein gemerktes Widget, das es nicht mehr gibt, fällt still auf die Vorauswahl zurück",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const { container } = await openDesignCenter(t, "", {
      stored: { [REMEMBERED]: "42" },
    });
    assert.equal(designCenterWidget(container), "KuferMedia");
    assert.deepEqual(shown, []);
  }
);

test(
  "AK-3: Auswahl oben im Design Center: Wechsel schreibt widget= in die Adresse, merkt es und lädt das Design Center dieses Widgets",
  { skip },
  async (t) => {
    const { container, calls, act } = await openDesignCenter(t, "?widget=5");
    await act(() => click(picker(container)));
    await act(() => click(option(container, "Ärztehaus")));
    await act();
    assert.equal(locationOf(container), `${DESIGN}?widget=8`);
    assert.equal(remembered(), "8");
    assert.equal(designCenterWidget(container), "Ärztehaus");
    assert.deepEqual(designCenterLoads(calls), [5, 8]);
  }
);

test(
  "AK-3: „Konversationen“ wählt nach derselben Merkregel und merkt die Auswahl für Status und Design Center",
  { skip },
  async (t) => {
    stubServer(t);
    const mounted = await mount(t, CONVERSATIONS_VIEW, {
      location: CONVERSATIONS,
      exportName: "AnalyticsScreen",
      props: {
        embedsLoaded: true,
        embeds: EMBEDS,
        lastActivity: LAST_ACTIVITY,
      },
      stored: { [REMEMBERED]: "8" },
    });
    const { container, act } = mounted;
    assert.equal(pickerLabel(container), "Ärztehaus");

    await act(() => click(picker(container)));
    await act(() => click(option(container, "Chatbot Elbe")));
    assert.equal(pickerLabel(container), "Chatbot Elbe");
    assert.equal(remembered(), "5");
  }
);

// ---------------------------------------------------------------------------
// AK-4: genau ein Widget
// ---------------------------------------------------------------------------

test(
  "AK-4: Mit genau einem Widget gibt es keine Auswahl; das Design Center zeigt es direkt, auch wenn ein anderes gemerkt ist",
  { skip },
  async (t) => {
    const { container } = await openDesignCenter(t, "", {
      embeds: [ELBE],
      stored: { [REMEMBERED]: "8" },
    });
    assert.equal(designCenterWidget(container), "Chatbot Elbe");
    assert.equal(picker(container), undefined);
  }
);

// ---------------------------------------------------------------------------
// NAK-1: fremdes oder unbekanntes Widget in der Adresse
// ---------------------------------------------------------------------------

test(
  "NAK-1: Design Center mit fremdem Widget in der Adresse: Hinweis, widget= entfernt, die Vorauswahl wird gezeigt, das fremde nie geladen",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const { container, calls } = await openDesignCenter(t, "?widget=99");
    assert.deepEqual(shown, [["error", NOT_FOUND]]);
    assert.equal(locationOf(container), DESIGN);
    assert.equal(designCenterWidget(container), "KuferMedia");
    assert.ok(!designCenterLoads(calls).includes(99));
    assert.equal(remembered(), null);
  }
);

// Fixliste r4 Nr. 11 (Sonnet L1, L2): Konversationen zeigen bei einem
// unbekannten Widget denselben Hinweis wie Status und Design Center, einmal;
// eine ungültige Kennung gilt wie eine unbekannte.
test(
  "Nr. 11: Konversationen mit fremdem Widget: der Widget-Hinweis, mit fester Kennung (eine Meldung)",
  { skip },
  async (t) => {
    const shown = await toasts(t, { withOptions: true });
    stubServer(t);
    await mount(t, CONVERSATIONS_VIEW, {
      location: `${CONVERSATIONS}?widget=99`,
      route: CONVERSATIONS,
      exportName: "AnalyticsScreen",
      props: {
        embedsLoaded: true,
        embeds: EMBEDS,
        lastActivity: LAST_ACTIVITY,
      },
    });
    assert.deepEqual(shown, [["error", NOT_FOUND, "chatbot-widget-not-found"]]);
  }
);

test(
  "Nr. 11: ?widget=abc gilt wie eine unbekannte Kennung: Hinweis, widget= entfernt, Vorauswahl",
  { skip },
  async (t) => {
    const shown = await toasts(t);
    const { container } = await openDesignCenter(t, "?widget=abc");
    assert.deepEqual(shown, [["error", NOT_FOUND]]);
    assert.equal(locationOf(container), DESIGN);
    assert.equal(designCenterWidget(container), "KuferMedia");
  }
);

// Fixliste r4 Nr. 9 (Opus G5): Die Auswahl ist so breit wie die längste
// Bezeichnung, die Liste darunter zeigt jede in einer Zeile.
test(
  "Nr. 9: Breite der Auswahl nach der längsten Bezeichnung, Einträge ohne Umbruch",
  { skip },
  async (t) => {
    const { container, act } = await openDesignCenter(t, "?widget=5");
    const sizers = elements(
      picker(container),
      (el) =>
        el.getAttribute("aria-hidden") === "true" &&
        /\binvisible\b/.test(el.getAttribute("class") ?? "")
    );
    assert.deepEqual(
      sizers.map((el) => el.textContent).sort(),
      ["Ärztehaus", "Chatbot Elbe", "KuferMedia"].sort()
    );
    for (const el of sizers)
      assert.match(el.getAttribute("class"), /whitespace-nowrap/);
    assert.equal(pickerLabel(container), "Chatbot Elbe");
    await act(() => click(picker(container)));
    const labels = elements(
      container,
      (el) =>
        el.tagName === "SPAN" &&
        el.parentNode?.getAttribute?.("role") === "option"
    );
    assert.equal(labels.length, 3);
    for (const el of labels)
      assert.match(el.getAttribute("class") ?? "", /whitespace-nowrap/);
  }
);

// ---------------------------------------------------------------------------
// AK-5: Widget-Zeile
// ---------------------------------------------------------------------------

/** Die Widget-Liste mit einer Zeile; die Ziele der Abkürzungen als Sonden. */
async function openWidgetList(t, { canViewChatHistory = true } = {}) {
  stubServer(t, [ELBE]);
  return mount(t, WIDGET_LIST, {
    location: WIDGETS,
    canViewChatHistory,
    otherRoutes: [
      { path: DESIGN, element: h(LocationProbe) },
      { path: CONVERSATIONS, element: h(LocationProbe) },
    ],
  });
}
const rowActions = (container) =>
  elements(
    elements(container, (el) => el.tagName === "TD")[0],
    (el) => el.tagName === "BUTTON" || el.tagName === "A"
  ).map((el) => ({
    tag: el.tagName,
    text: el.textContent.trim(),
    href: el.getAttribute("href"),
  }));

test(
  "AK-5: Die Widget-Zeile: Status und Konversationen (mit Widget), Design Center, Code, Deaktivieren, Löschen, Menü; kein „Aussehen“",
  { skip },
  async (t) => {
    const { container } = await openWidgetList(t);
    assert.deepEqual(rowActions(container), [
      { tag: "A", text: "Status", href: `${STATUS}?widget=5` },
      { tag: "A", text: "Konversationen", href: `${CONVERSATIONS}?widget=5` },
      { tag: "BUTTON", text: "Design Center", href: null },
      { tag: "BUTTON", text: "Code", href: null },
      { tag: "BUTTON", text: "Deaktivieren", href: null },
      { tag: "BUTTON", text: "Löschen", href: null },
      { tag: "BUTTON", text: "", href: null },
    ]);
  }
);

test(
  "AK-5: „Design Center“ in der Zeile öffnet /settings/chatbot/design?widget=<id>",
  { skip },
  async (t) => {
    const { container, act } = await openWidgetList(t);
    const button = elements(
      container,
      (el) =>
        el.tagName === "BUTTON" && el.textContent.trim() === "Design Center"
    )[0];
    await act(() => click(button));
    assert.equal(locationOf(container), `${DESIGN}?widget=5`);
  }
);

test(
  "AK-5: Ohne einsehbaren Chat-Verlauf fehlt die Abkürzung „Konversationen“ wie der Menüpunkt",
  { skip },
  async (t) => {
    const { container } = await openWidgetList(t, {
      canViewChatHistory: false,
    });
    assert.deepEqual(
      rowActions(container).map((action) => action.text),
      ["Status", "Design Center", "Code", "Deaktivieren", "Löschen", ""]
    );
  }
);

// ---------------------------------------------------------------------------
// AK-6: Klick auf den Gruppenkopf
// ---------------------------------------------------------------------------

// Die Seitenleiste selbst lässt sich ohne Browser nicht einhängen (Footer,
// react-tooltip); welcher Unterpunkt der erste ist, prüft chatbotMenu.test.mjs
// am gerenderten Kopf. Hier: Der Kopf mit opensFirstChild navigiert beim
// Klick, statt nur auf- und zuzuklappen.
test(
  "AK-6: Ein Klick auf den Kopf „Chatbot“ öffnet den ersten sichtbaren Unterpunkt und klappt die Gruppe auf",
  { skip },
  async (t) => {
    const roles = ["admin", "manager", "default"];
    for (const [hidden, target] of [
      [false, CONVERSATIONS],
      [true, DESIGN],
    ]) {
      const mounted = await renderer.mount(MENU_OPTION, {
        location: "/settings/users",
        route: "/settings/users",
        otherRoutes: [{ path: target, element: h(LocationProbe) }],
        stored: { anything_llm_menu_chatbot_expanded: "false" },
        props: {
          btnText: "Chatbot",
          opensFirstChild: true,
          user: { id: 1, role: "default" },
          childOptions: [
            { hidden: true, btnText: "Status", href: "/x", flex: true, roles },
            {
              hidden,
              btnText: "Konversationen",
              href: CONVERSATIONS,
              flex: true,
              roles,
            },
            { btnText: "Design Center", href: DESIGN, flex: true, roles },
          ],
        },
      });
      t.after(() => mounted.unmount());
      await mounted.act();
      const head = elements(
        mounted.container,
        (el) => el.tagName === "A" && el.textContent.trim() === "Chatbot"
      )[0];
      assert.equal(head.getAttribute("href"), target);
      const event = {
        button: 0,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
        target: head,
        currentTarget: head,
      };
      await mounted.act(() => handlersOf(head).onClick(event));
      assert.equal(locationOf(mounted.container), target);
      assert.equal(
        globalThis.localStorage.getItem("anything_llm_menu_chatbot_expanded"),
        "true"
      );
      await mounted.unmount();
    }
  }
);

// Fixliste r2 Nr. 1 (F1): Der Pfeil klappt die Gruppe „Chatbot“ auf und zu wie
// bei allen anderen Gruppen (KB-2 NAK-3); zugeklappt steht der Punkt am Kopf
// (KB-3 AK-5). Der Browser-Speicher ist nicht vorbelegt: Aufgeklappt ist die
// Gruppe, weil die Adresse zu einem Unterpunkt gehört.
test(
  "F1: Der Pfeil klappt „Chatbot“ zu und wieder auf; zugeklappt zeigt der Kopf den Punkt",
  { skip },
  async (t) => {
    const roles = ["admin", "manager", "default"];
    const dot = { state: "rot", color: "red", label: "Status: Rot" };
    const mounted = await renderer.mount(MENU_OPTION, {
      location: WIDGETS,
      route: WIDGETS,
      props: {
        btnText: "Chatbot",
        opensFirstChild: true,
        dot,
        user: { id: 1, role: "default" },
        childOptions: [
          { btnText: "Status", href: STATUS, flex: true, roles, dot },
          { btnText: "Design Center", href: DESIGN, flex: true, roles },
          { btnText: "Widgets", href: WIDGETS, flex: true, roles },
        ],
      },
    });
    t.after(() => mounted.unmount());
    await mounted.act();
    const { container } = mounted;
    const label = (link) =>
      elements(link, (el) => el.tagName === "P")[0].textContent.trim();
    const links = () =>
      elements(container, (el) => el.tagName === "A").map(label);
    // Menüpunkt mit Punkt und dessen Text für Screenreader
    const dots = () =>
      elements(container, (el) => el.hasAttribute("data-menu-dot")).map(
        (el) => `${label(el.parentNode)}: ${el.textContent}`
      );
    const arrow = () => elements(container, (el) => el.tagName === "BUTTON")[0];
    const stored = () =>
      globalThis.localStorage.getItem("anything_llm_menu_chatbot_expanded");

    assert.equal(stored(), null);
    assert.deepEqual(links(), [
      "Chatbot",
      "Status",
      "Design Center",
      "Widgets",
    ]);
    assert.deepEqual(dots(), ["Status: Status: Rot"]);

    await mounted.act(() => click(arrow()));
    assert.deepEqual(links(), ["Chatbot"]);
    assert.equal(stored(), "false");
    assert.deepEqual(dots(), ["Chatbot: Status: Rot"]);

    await mounted.act(() => click(arrow()));
    assert.deepEqual(links(), [
      "Chatbot",
      "Status",
      "Design Center",
      "Widgets",
    ]);
    assert.equal(stored(), "true");
    assert.deepEqual(dots(), ["Status: Status: Rot"]);
  }
);
