// KIE-536: Ansicht „Konversationen" – Maus, Tastatur und das Laden. Die
// Komponenten sind mit React DOM in ein Dokument ohne Browser eingehängt
// (helpers/renderSettingsPage.mjs, mount): Effekte laufen, Eingaben werden
// über die Handler der Elemente nachgestellt (helpers/testDom.mjs).
//
// Was ein Browser bei einer Eingabe auslöst (ein Klick fokussiert den
// Säulenplatz, Layout, Themes), bleibt Sache des Browser-Tests.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import {
  click,
  elements,
  leaveWindow,
  movePointer,
  pressKey,
  returnToWindow,
  tap,
} from "./helpers/testDom.mjs";
import {
  DEFAULT_RANGE_DAYS,
  addDays,
  formatDate,
  lastDaysRange,
  rangeFromDates,
} from "../src/utils/analyticsTimeline.js";
// Adressen und Rümpfe der Anfragen – dieselben, mit denen der Server-Test die
// echten Routen aufruft (embedAnalyticsSummary.test.js).
import requests from "../../server/__tests__/endpoints/support/embedAnalyticsRequests.js";

const { ROUTES, summaryBody, conversationsBody } = requests;

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const CHART = `${DIR}/TimelineChart.jsx`;
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

/** Hängt eine Komponente ein und räumt nach dem Test wieder ab. */
async function mount(t, modulePath, props, options = {}) {
  const mounted = await renderer.mount(modulePath, {
    location: LOCATION,
    props,
    ...options,
  });
  t.after(() => mounted.unmount());
  return mounted;
}

const columnsOf = (container) =>
  elements(container, (element) => element.hasAttribute("data-column"));
/** Text des Tooltips; null, wenn keiner zu sehen ist. */
function tooltipOf(container) {
  const [tooltip, ...more] = elements(container, (element) =>
    (element.getAttribute("class") ?? "").includes("pointer-events-none")
  );
  assert.equal(more.length, 0, "mehr als ein Tooltip");
  return tooltip?.textContent ?? null;
}
/** Säulenplätze mit Fokusrahmen (Index). */
const ringsOf = (container) =>
  columnsOf(container)
    .map((column, i) => [column.firstChild.getAttribute("stroke"), i])
    .filter(([stroke]) => stroke !== "none")
    .map(([, i]) => i);

/** Säulenplätze mit Hervorhebung (Index). */
const highlightsOf = (container) =>
  columnsOf(container)
    .map((column, i) => [column.firstChild.getAttribute("fill-opacity"), i])
    .filter(([opacity]) => opacity !== "0")
    .map(([, i]) => i);

// 30 Tage ab 13.09.2026: der 06.10. ist Platz 23, der 07.10. Platz 24.
const FROM = "2026-09-13";
const THIRTY_DAYS = {
  success: true,
  granularity: "day",
  fromDay: FROM,
  toDay: addDays(FROM, 29),
  firstLedgerDay: "2026-01-01",
  totals: {
    messages: 885,
    conversations: 60,
    feedbackPositive: 9,
    feedbackNegative: 3,
  },
  buckets: Array.from({ length: 30 }, (_, i) => ({
    start: addDays(FROM, i),
    end: addDays(FROM, i),
    partial: false,
    messages: 14 + i,
    conversations: 2,
  })),
};
const OCT_06 = 23;
const OCT_07 = 24;

// ---------------------------------------------------------------------------
// Tooltip (AK-6)
// ---------------------------------------------------------------------------

test(
  "Tooltip (AK-6): Der Mauszeiger über einer Säule zeigt Wochentag, Datum und Wert – ohne Zeiger kein Tooltip",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
    });
    const columns = columnsOf(container);
    assert.equal(columns.length, 30);
    assert.equal(tooltipOf(container), null);

    await act(() => movePointer(document, columns[OCT_06]));
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");

    await act(() => movePointer(document, columns[OCT_07]));
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");

    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
  }
);

test(
  "Tooltip (AK-6): Nach einem Klick auf eine Säule folgt der Tooltip weiter dem Mauszeiger",
  { skip },
  async (t) => {
    const selected = [];
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      onSelectBucket: (bucket) => selected.push(bucket),
    });
    const columns = columnsOf(container);

    // Der Klick fokussiert den Säulenplatz – und filtert die Liste (AK-7).
    await act(() => click(columns[OCT_06]));
    assert.equal(document.activeElement, columns[OCT_06]);
    assert.deepEqual(selected, [
      { start: "2026-10-06", end: "2026-10-06", label: "Di., 06.10.2026" },
    ]);
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");

    // Der Fokus bleibt auf dem 06.10., der Zeiger steht auf dem 07.10.
    await act(() => movePointer(document, columns[OCT_07]));
    assert.equal(document.activeElement, columns[OCT_06]);
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");

    await act(() => movePointer(document, columns[2]));
    assert.equal(tooltipOf(container), "Di., 15.09.2026 — 16 Nachrichten");
  }
);

test(
  "Tooltip (AK-6): Tastaturfokus zeigt den Tooltip, die Pfeiltasten nehmen ihn mit – auch wenn der Mauszeiger auf einer anderen Säule ruht",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
    });
    const columns = columnsOf(container);

    // Tab erreicht den einen Tab-Stopp des Diagramms: die letzte Säule.
    const tabStop = columns.filter(
      (column) => column.getAttribute("tabindex") === "0"
    );
    assert.deepEqual(tabStop, [columns[29]]);
    await act(() => columns[29].focus());
    assert.equal(tooltipOf(container), "Mo., 12.10.2026 — 43 Nachrichten");
    assert.deepEqual(ringsOf(container), [29]);

    await act(() => pressKey(document, "ArrowLeft"));
    assert.equal(document.activeElement, columns[28]);
    assert.equal(tooltipOf(container), "So., 11.10.2026 — 42 Nachrichten");
    assert.deepEqual(ringsOf(container), [28]);

    // Der Mauszeiger kommt dazu: Er gewinnt, der Fokusrahmen bleibt.
    await act(() => movePointer(document, columns[OCT_06]));
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");
    assert.deepEqual(ringsOf(container), [28]);

    // Der Zeiger ruht, die Pfeiltaste wechselt die Säule: Der Tooltip folgt ihr.
    await act(() => pressKey(document, "ArrowLeft"));
    assert.equal(document.activeElement, columns[27]);
    assert.equal(tooltipOf(container), "Sa., 10.10.2026 — 41 Nachrichten");
    await act(() => pressKey(document, "Home"));
    assert.equal(tooltipOf(container), "So., 13.09.2026 — 14 Nachrichten");

    // Der Zeiger bewegt sich auf seiner Säule: wieder die Säule unter ihm.
    await act(() => movePointer(document, columns[OCT_06]));
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");

    // Der Zeiger verlässt das Diagramm: zurück zur fokussierten Säule.
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), "So., 13.09.2026 — 14 Nachrichten");

    // Der Fokus verlässt das Diagramm: kein Tooltip, kein Rahmen.
    await act(() => columns[0].blur());
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(ringsOf(container), []);
    // Der zuletzt fokussierte Platz bleibt der Tab-Stopp.
    assert.deepEqual(
      columnsOf(container)
        .map((column, i) => [column.getAttribute("tabindex"), i])
        .filter(([tabindex]) => tabindex === "0"),
      [["0", 0]]
    );
  }
);

test(
  "Tooltip: Tastatur allein – Tab, Pfeiltasten, Pos1/Ende, Eingabe- und Leertaste; Tooltip und Rahmen bleiben auf der fokussierten Säule",
  { skip },
  async (t) => {
    const selected = [];
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      onSelectBucket: (bucket) => selected.push(bucket),
    });
    const columns = columnsOf(container);

    await act(() => columns[29].focus());
    assert.equal(tooltipOf(container), "Mo., 12.10.2026 — 43 Nachrichten");
    assert.deepEqual(ringsOf(container), [29]);
    assert.deepEqual(highlightsOf(container), [29]);

    await act(() => pressKey(document, "Home"));
    assert.equal(document.activeElement, columns[0]);
    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(tooltipOf(container), "Mo., 14.09.2026 — 15 Nachrichten");
    assert.deepEqual(ringsOf(container), [1]);

    await act(() => pressKey(document, "Enter"));
    assert.equal(selected.at(-1).start, "2026-09-14");
    assert.equal(tooltipOf(container), "Mo., 14.09.2026 — 15 Nachrichten");
    assert.deepEqual(ringsOf(container), [1]);

    await act(() => pressKey(document, "End"));
    await act(() => pressKey(document, " "));
    assert.equal(selected.at(-1).start, "2026-10-12");
    assert.equal(selected.length, 2);
    assert.equal(tooltipOf(container), "Mo., 12.10.2026 — 43 Nachrichten");
    assert.deepEqual(ringsOf(container), [29]);

    // Am Rand bleibt der Fokus stehen.
    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(document.activeElement, columns[29]);
    assert.deepEqual(ringsOf(container), [29]);
  }
);

test(
  "Tooltip: Nach einem Mausklick verschwinden Tooltip und Hervorhebung, sobald der Zeiger das Diagramm verlässt – kein Fokusrahmen; der Abschnitts-Filter bleibt",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const { container, document, act, days } = await mountView(t, server);
    const day = addDays(days.fromDay, 23);

    await act(() => click(columnsOf(container)[23]));
    assert.equal(document.activeElement, columnsOf(container)[23]);
    assert.match(tooltipOf(container), / — 37 Nachrichten$/);
    assert.deepEqual(highlightsOf(container), [23]);
    // Der Klick fokussiert den Platz, ein Rahmen erscheint dabei nicht.
    assert.deepEqual(ringsOf(container), []);

    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(highlightsOf(container), []);
    assert.deepEqual(ringsOf(container), []);

    // Die Auswahl bleibt: Säule gedrückt, Liste gefiltert und markiert.
    assert.equal(columnsOf(container)[23].getAttribute("aria-pressed"), "true");
    assert.ok(bucketMarkOf(container).textContent.endsWith(formatDate(day)));
    assert.equal(server.lists().at(-1).body.startedFromDay, day);
    // Der Platz bleibt Tab-Stopp und aktives Element – die Tastatur setzt dort fort.
    assert.equal(document.activeElement, columnsOf(container)[23]);
    assert.equal(columnsOf(container)[23].getAttribute("tabindex"), "0");

    // Ein zweiter Klick hebt den Filter auf, wieder ohne Rahmen.
    await act(() => click(columnsOf(container)[23]));
    assert.equal(bucketMarkOf(container), null);
    assert.deepEqual(ringsOf(container), []);
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
  }
);

test(
  "Tooltip: Nach einem Mausklick übernimmt die Tastatur – Pfeiltasten und Eingabetaste zeigen Rahmen und Tooltip wieder",
  { skip },
  async (t) => {
    const selected = [];
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      onSelectBucket: (bucket) => selected.push(bucket),
    });
    const columns = columnsOf(container);

    await act(() => click(columns[OCT_06]));
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);

    await act(() => pressKey(document, "Enter"));
    assert.equal(selected.length, 2);
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_06]);

    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(document.activeElement, columns[OCT_07]);
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_07]);

    // Klick auf die letzte Säule, Zeiger weg, Pfeil nach rechts: Der Fokus
    // bleibt am Rand stehen und gilt jetzt als Tastaturfokus.
    await act(() => click(columns[29]));
    assert.deepEqual(ringsOf(container), []);
    await act(() => movePointer(document, null));
    assert.equal(tooltipOf(container), null);
    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(tooltipOf(container), "Mo., 12.10.2026 — 43 Nachrichten");
    assert.deepEqual(ringsOf(container), [29]);

    // Tab aus dem Diagramm und zurück: Tastaturfokus mit Rahmen.
    await act(() => columns[29].blur());
    assert.equal(tooltipOf(container), null);
    await act(() => click(columns[OCT_06]));
    await act(() => movePointer(document, null));
    await act(() => columns[OCT_06].blur());
    await act(() => columns[OCT_06].focus());
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_06]);
  }
);

test(
  "Tooltip: Fensterwechsel ist keine Eingabe – nach einem Mausklick bleibt das Diagramm bei der Rückkehr ohne Tooltip, ein Tastaturfokus behält ihn",
  { skip },
  async (t) => {
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
    });
    const columns = columnsOf(container);

    await act(() => click(columns[OCT_06]));
    await act(() => movePointer(document, null));
    await act(() => leaveWindow(document));
    await act(() => returnToWindow(document));
    assert.equal(document.activeElement, columns[OCT_06]);
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(ringsOf(container), []);

    await act(() => pressKey(document, "ArrowRight"));
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");
    await act(() => leaveWindow(document));
    await act(() => returnToWindow(document));
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");
    assert.deepEqual(ringsOf(container), [OCT_07]);

    // Danach verlässt der Fokus das Diagramm wie gewohnt.
    await act(() => columns[OCT_07].blur());
    assert.equal(tooltipOf(container), null);
    assert.deepEqual(ringsOf(container), []);
  }
);

test(
  "Tooltip: Tippen (Touch) zeigt den Tooltip der Säule, auch nachdem der Finger weg ist – ohne Mauszeiger trägt ihn der Fokus",
  { skip },
  async (t) => {
    const selected = [];
    const { container, document, act } = await mount(t, CHART, {
      summary: THIRTY_DAYS,
      loading: false,
      onSelectBucket: (bucket) => selected.push(bucket),
    });
    const columns = columnsOf(container);

    await act(() => tap(columns[OCT_06]));
    assert.equal(selected.length, 1);
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 37 Nachrichten");

    await act(() => tap(columns[OCT_07]));
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 38 Nachrichten");

    await act(() => columns[OCT_07].blur());
    assert.equal(tooltipOf(container), null);
  }
);

test(
  "Tooltip: steht über der hohen Nachbarsäule statt auf ihr – ohne die Karte zu verschieben",
  { skip },
  async (t) => {
    // wie in der Abnahme: 84 Nachrichten am 06.10., eine am 07.10.
    const summary = {
      ...THIRTY_DAYS,
      buckets: THIRTY_DAYS.buckets.map((bucket, i) => ({
        ...bucket,
        messages: { 2: 3, [OCT_06]: 84, [OCT_07]: 1 }[i] ?? 0,
      })),
    };
    const { container, document, act } = await mount(t, CHART, {
      summary,
      loading: false,
    });
    const columns = columnsOf(container);
    const tooltipTop = async (i) => {
      await act(() => movePointer(document, columns[i]));
      const [tooltip] = elements(container, (element) =>
        (element.getAttribute("class") ?? "").includes("pointer-events-none")
      );
      // außerhalb des Textflusses: Die Karte ändert ihre Größe nicht.
      assert.match(tooltip.getAttribute("class"), /(^| )absolute( |$)/);
      return parseFloat(tooltip.style.top);
    };

    const tall = await tooltipTop(OCT_06);
    assert.equal(tooltipOf(container), "Di., 06.10.2026 — 84 Nachrichten");
    assert.equal(await tooltipTop(OCT_07), tall);
    assert.equal(tooltipOf(container), "Mi., 07.10.2026 — 1 Nachricht");
    // Platz ohne Säule rechts daneben: dieselbe Höhe
    assert.equal(await tooltipTop(OCT_07 + 1), tall);
    // weit weg von der hohen Säule: direkt über der eigenen, also viel tiefer
    assert.ok((await tooltipTop(2)) > tall + 100);
    assert.equal(tooltipOf(container), "Di., 15.09.2026 — 3 Nachrichten");
  }
);

// ---------------------------------------------------------------------------
// Anfragen an den Server (Hard Constraint 5, AK-7)
// ---------------------------------------------------------------------------

const EMBED = {
  id: 3,
  chat_retention_days: 30,
  workspace: { name: "VHS Musterstadt" },
};
const TOTALS = {
  messages: 885,
  conversations: 60,
  feedbackPositive: 9,
  feedbackNegative: 3,
};

/** Adresse einer Route für das Widget, wie das Frontend sie aufruft. */
async function urlOf(route, embedId = EMBED.id) {
  const { API_BASE } = await renderer.load("/src/utils/constants.js");
  return `${API_BASE}${route.path.replace(":embedId", embedId)}`;
}

/**
 * Ersetzt fetch für die Dauer eines Tests: merkt sich jede Anfrage (Methode,
 * Adresse, Rumpf) und antwortet mit dem, was respond liefert.
 */
function stubFetch(t, respond) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      method: init.method,
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    return { ok: true, status: 200, json: async () => respond(call) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/**
 * Der Server der Ansicht: analytics/summary antwortet mit den übergebenen
 * Abschnitten (sonst je Tag des angefragten Zeitraums einer), die
 * Konversationsliste ist leer – oder antwortet mit dem, was list liefert.
 * Beide Routen antworten für jedes Widget.
 */
async function analyticsServer(t, { granularity = "day", buckets, list } = {}) {
  const summaryUrl = await urlOf(ROUTES.summary);
  const listUrl = await urlOf(ROUTES.conversations);
  const isSummary = (url) => url.endsWith("/analytics/summary");
  const isList = (url) => url.endsWith("/analytics/conversations");
  const calls = stubFetch(t, (call) => {
    const { url, body } = call;
    if (isList(url))
      return (
        list?.(call) ?? {
          success: true,
          conversations: [],
          hasMore: false,
          totalCount: 0,
        }
      );
    if (!isSummary(url)) return { success: false, error: "unbekannt" };
    const days = [];
    for (let day = body.fromDay; day <= body.toDay; day = addDays(day, 1))
      days.push(day);
    return {
      success: true,
      granularity,
      fromDay: body.fromDay,
      toDay: body.toDay,
      firstLedgerDay: "2026-01-01",
      totals: TOTALS,
      buckets:
        buckets ??
        days.map((day, i) => ({
          start: day,
          end: day,
          partial: false,
          messages: 14 + i,
          conversations: 2,
        })),
    };
  });
  return {
    calls,
    summaries: () => calls.filter((call) => isSummary(call.url)),
    lists: () => calls.filter((call) => isList(call.url)),
    summaryUrl,
    listUrl,
  };
}

/**
 * Die Ansicht im Standard-Zeitraum (letzte 30 Tage) – mit einem Widget, wenn
 * embeds nichts anderes nennt.
 */
async function mountView(t, server, embeds = [EMBED]) {
  const { startDate, endDate } = lastDaysRange(DEFAULT_RANGE_DAYS);
  const mounted = await mount(
    t,
    VIEW,
    { embedsLoaded: true, embeds },
    { exportName: "AnalyticsScreen" }
  );
  return {
    ...mounted,
    days: rangeFromDates(startDate, endDate),
    // Die Liste bekommt denselben Zeitraum als Zeitstempel des Browsers.
    period: {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    },
    listRequest: (request = {}) => ({
      method: ROUTES.conversations.method,
      url: server.listUrl,
      body: conversationsBody({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        ...request,
      }),
    }),
  };
}

/** Markierung „Nur <Abschnitt>" der Liste; null, wenn kein Abschnitt gewählt ist. */
function bucketMarkOf(container) {
  const [mark] = elements(container, (element) =>
    element.hasAttribute("data-bucket-filter")
  );
  return mark ?? null;
}
const kpiTextOf = (container) =>
  elements(container, (element) => element.hasAttribute("data-kpi")).map(
    (element) => element.textContent
  );

test(
  "Anfrage (Hard Constraint 5): getAnalyticsSummary sendet die gewählten Kalendertage als { fromDay, toDay } an analytics/summary",
  { skip },
  async (t) => {
    const calls = stubFetch(t, () => ({ success: true }));
    const { default: Embed } = await renderer.load("/src/models/embed.js");

    const answer = await Embed.getAnalyticsSummary(
      3,
      "2026-09-13",
      "2026-10-12"
    );

    assert.deepEqual(answer, { success: true });
    assert.deepEqual(calls, [
      {
        method: ROUTES.summary.method,
        url: await urlOf(ROUTES.summary, 3),
        body: summaryBody("2026-09-13", "2026-10-12"),
      },
    ]);
    assert.deepEqual(Object.keys(calls[0].body), ["fromDay", "toDay"]);
    assert.match(calls[0].url, /\/embed\/3\/analytics\/summary$/);
  }
);

test(
  "Anfrage (AK-7): getConversations sendet den Abschnitt als startedFromDay/startedToDay – ohne Abschnitt keines der beiden Felder",
  { skip },
  async (t) => {
    const calls = stubFetch(t, () => ({ success: true, conversations: [] }));
    const { default: Embed } = await renderer.load("/src/models/embed.js");
    const period = {
      startDate: "2026-09-12T22:00:00.000Z",
      endDate: "2026-10-12T21:59:59.999Z",
    };

    await Embed.getConversations(
      3,
      20,
      20,
      period.startDate,
      period.endDate,
      "negative",
      { fromDay: "2026-10-05", toDay: "2026-10-11" }
    );
    await Embed.getConversations(
      3,
      0,
      20,
      period.startDate,
      period.endDate,
      "all",
      null
    );
    await Embed.getConversations(3, 0, 20, null, null);

    const url = await urlOf(ROUTES.conversations, 3);
    assert.deepEqual(calls, [
      {
        method: ROUTES.conversations.method,
        url,
        body: conversationsBody({
          ...period,
          offset: 20,
          feedbackFilter: "negative",
          bucket: { start: "2026-10-05", end: "2026-10-11" },
        }),
      },
      {
        method: ROUTES.conversations.method,
        url,
        body: conversationsBody(period),
      },
      { method: ROUTES.conversations.method, url, body: conversationsBody() },
    ]);
    assert.equal(calls[0].body.startedFromDay, "2026-10-05");
    assert.equal(calls[0].body.startedToDay, "2026-10-11");
    for (const { body } of calls.slice(1)) {
      assert.ok(!("startedFromDay" in body));
      assert.ok(!("startedToDay" in body));
    }
    assert.match(url, /\/embed\/3\/analytics\/conversations$/);
  }
);

test(
  "Laden (Hard Constraint 5): Die Ansicht fragt Zählwerte mit den Kalendertagen des Zeitraums ab, die Liste mit den Zeitstempeln des Browsers",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const { container, days, listRequest } = await mountView(t, server);

    assert.equal(addDays(days.fromDay, DEFAULT_RANGE_DAYS - 1), days.toDay);
    assert.deepEqual(server.summaries(), [
      {
        method: ROUTES.summary.method,
        url: server.summaryUrl,
        body: summaryBody(days.fromDay, days.toDay),
      },
    ]);
    assert.deepEqual(server.lists(), [listRequest()]);
    assert.equal(server.calls.length, 2);
    // Die Antwort ist gezeichnet: 30 Säulenplätze, Kennzahlen aus totals.
    assert.equal(columnsOf(container).length, 30);
    assert.match(kpiTextOf(container)[0], /^Nachrichten885/);
    assert.equal(bucketMarkOf(container), null);
  }
);

test(
  "Klick auf eine Säule (AK-7): Die Liste wird mit dem Abschnitt neu geladen und markiert; zweiter Klick oder Schließen hebt den Filter auf; die Kennzahlen bleiben",
  { skip },
  async (t) => {
    const server = await analyticsServer(t);
    const { container, act, days, listRequest } = await mountView(t, server);
    const day = addDays(days.fromDay, 23);
    const bucket = { start: day, end: day };
    const kpis = kpiTextOf(container);
    assert.equal(kpis.length, 4);

    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists(), [listRequest(), listRequest({ bucket })]);
    assert.equal(server.lists().at(-1).body.startedFromDay, day);
    assert.equal(server.lists().at(-1).body.startedToDay, day);
    const mark = bucketMarkOf(container);
    assert.match(mark.textContent, /^Nur \S+, /);
    assert.ok(mark.textContent.endsWith(formatDate(day)), mark.textContent);
    assert.equal(columnsOf(container)[23].getAttribute("aria-pressed"), "true");

    // zweiter Klick auf dieselbe Säule
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().at(-1), listRequest());
    assert.equal(server.lists().length, 3);
    assert.equal(bucketMarkOf(container), null);

    // andere Säule, dann die Schließen-Schaltfläche der Markierung
    const other = addDays(days.fromDay, 5);
    await act(() => click(columnsOf(container)[5]));
    assert.deepEqual(
      server.lists().at(-1),
      listRequest({ bucket: { start: other, end: other } })
    );
    const [close] = elements(bucketMarkOf(container), (element) =>
      (element.getAttribute("aria-label") ?? "").startsWith("Filter „")
    );
    await act(() => click(close));
    assert.deepEqual(server.lists().at(-1), listRequest());
    assert.equal(server.lists().length, 5);
    assert.equal(bucketMarkOf(container), null);

    // Die Kennzahlen wurden nicht neu abgefragt und stehen unverändert da.
    assert.equal(server.summaries().length, 1);
    assert.deepEqual(kpiTextOf(container), kpis);
  }
);

test(
  "Klick auf eine Säule (AK-7): Kalenderwoche, angeschnittene Woche und Monat gehen mit ihrem ersten und letzten Tag an die Liste",
  { skip },
  async (t) => {
    const week = (start, end, partial) => ({
      start,
      end,
      partial,
      messages: 10,
      conversations: 3,
    });
    const weeks = await analyticsServer(t, {
      granularity: "week",
      buckets: [
        week("2026-09-28", "2026-10-04", false),
        week("2026-10-05", "2026-10-11", false),
        week("2026-10-12", "2026-10-12", true),
      ],
    });
    const view = await mountView(t, weeks);
    assert.equal(columnsOf(view.container).length, 3);

    await view.act(() => click(columnsOf(view.container)[1]));
    assert.deepEqual(
      weeks.lists().at(-1),
      view.listRequest({ bucket: { start: "2026-10-05", end: "2026-10-11" } })
    );
    assert.equal(
      bucketMarkOf(view.container).textContent,
      "Nur KW 41 (05.10.–11.10.2026)"
    );

    await view.act(() => click(columnsOf(view.container)[2]));
    assert.deepEqual(
      weeks.lists().at(-1),
      view.listRequest({ bucket: { start: "2026-10-12", end: "2026-10-12" } })
    );
    assert.equal(
      bucketMarkOf(view.container).textContent,
      "Nur KW 42 – bis 12.10."
    );
    await view.unmount();

    const months = await analyticsServer(t, {
      granularity: "month",
      buckets: [
        week("2026-09-01", "2026-09-30", false),
        week("2026-10-01", "2026-10-12", true),
      ],
    });
    const monthly = await mountView(t, months);
    await monthly.act(() => click(columnsOf(monthly.container)[0]));
    assert.deepEqual(
      months.lists().at(-1),
      monthly.listRequest({
        bucket: { start: "2026-09-01", end: "2026-09-30" },
      })
    );
    assert.equal(
      bucketMarkOf(monthly.container).textContent,
      "Nur September 2026"
    );
  }
);

test(
  "Klick auf eine Säule (AK-9): Im Stundendiagramm filtert er die Liste nicht",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, {
      granularity: "hour",
      buckets: Array.from({ length: 24 }, (_, hour) => ({
        start: "2026-10-06",
        end: "2026-10-06",
        partial: false,
        hour,
        messages: hour,
        conversations: 1,
      })),
    });
    const { container, act } = await mountView(t, server);
    assert.equal(columnsOf(container).length, 24);

    await act(() => click(columnsOf(container)[13]));
    assert.equal(
      tooltipOf(container),
      "Di., 06.10.2026, 13–14 Uhr — 13 Nachrichten"
    );
    assert.equal(server.lists().length, 1);
    assert.equal(bucketMarkOf(container), null);
    assert.equal(server.summaries().length, 1);
  }
);

// ---------------------------------------------------------------------------
// Blättern (NAK-5): Jeder Wechsel des Zuschnitts führt auf Seite 1
// ---------------------------------------------------------------------------

const SECOND_EMBED = {
  id: 7,
  chat_retention_days: null,
  workspace: { name: "VHS Beispielstadt" },
};
const PAGE_SIZE = 20;

/** Die Liste hat 45 einsehbare Konversationen – drei Seiten. */
function pagedList({ body }) {
  const total = 45;
  const count = Math.max(0, Math.min(body.limit, total - body.offset));
  return {
    success: true,
    totalCount: total,
    hasMore: body.offset + count < total,
    conversations: Array.from({ length: count }, (_, i) => ({
      conversation_id: `konversation-${body.offset + i + 1}`,
      conversation_number: body.offset + i + 1,
      preview: "Gibt es Sportkurse?",
      started_at: Date.UTC(2026, 9, 6, 10),
      last_message_at: Date.UTC(2026, 9, 6, 11),
      message_count: 2,
      positive_count: 0,
      negative_count: 0,
    })),
  };
}

/** Schaltfläche mit genau dieser Beschriftung. */
function buttonOf(container, label) {
  const [button, ...more] = elements(
    container,
    (element) => element.tagName === "BUTTON" && element.textContent === label
  );
  assert.ok(button, `keine Schaltfläche „${label}“`);
  assert.equal(more.length, 0, `mehrere Schaltflächen „${label}“`);
  return button;
}

/** Blättert auf Seite 2 und prüft, dass die Liste sie anfragt. */
async function openSecondPage({ container, act }, server) {
  await act(() => click(buttonOf(container, "2")));
  assert.equal(server.lists().at(-1).body.offset, PAGE_SIZE);
}

/** Wählt in der Datumsauswahl eine Vorauswahl, z. B. „Letzter Monat". */
async function choosePreset({ container, act }, label) {
  const buttons = () =>
    elements(container, (element) => element.tagName === "BUTTON");
  const trigger = buttons().find((button) =>
    /^(\d{2}\.\d{2}\.\d{4} - \d{2}\.\d{2}\.\d{4}|Gesamt)$/.test(
      button.textContent
    )
  );
  await act(() => click(trigger));
  // erste Schaltfläche des Popovers: das Menü der Vorauswahlen
  await act(() => click(buttons()[buttons().indexOf(trigger) + 1]));
  await act(() => click(buttonOf(container, label)));
}

/** Wählt in der Kopfzeile ein anderes Widget. */
async function chooseWidget({ container, act }, embed) {
  const [dropdown] = elements(
    container,
    (element) => element.getAttribute("aria-haspopup") === "listbox"
  );
  await act(() => click(dropdown));
  const [option] = elements(
    container,
    (element) =>
      element.getAttribute("role") === "option" &&
      element.textContent.startsWith(`Embed #${embed.id} `)
  );
  await act(() => click(option));
}

test(
  "Blättern (NAK-5): Bewertungsfilter an und wieder aus führt auf Seite 1 – die frühere Seite 2 kommt nicht zurück",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const view = await mountView(t, server);
    const { container, act, listRequest } = view;

    for (const [label, feedbackFilter] of [
      ["Nur mit 👍", "positive"],
      ["Nur mit 👎", "negative"],
    ]) {
      await openSecondPage(view, server);
      const before = server.lists().length;

      await act(() => click(buttonOf(container, label)));
      assert.deepEqual(server.lists().at(-1), listRequest({ feedbackFilter }));

      await act(() => click(buttonOf(container, label)));
      assert.deepEqual(server.lists().at(-1), listRequest());
      assert.equal(server.lists().at(-1).body.offset, 0);
      // je Wechsel genau eine Anfrage
      assert.equal(server.lists().length, before + 2);
      // Die Liste zeigt die Einträge 1–20.
      assert.match(container.textContent, /Konversation #1"/);
      assert.doesNotMatch(container.textContent, /Konversation #21"/);
    }
  }
);

test(
  "Blättern (NAK-5): Abschnitts-Filter an und wieder aus (zweiter Klick, Schließen) führt auf Seite 1",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const view = await mountView(t, server);
    const { container, act, days, listRequest } = view;
    const day = addDays(days.fromDay, 23);
    const bucket = { start: day, end: day };

    // an: Klick auf die Säule – aus: zweiter Klick
    await openSecondPage(view, server);
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().at(-1), listRequest({ bucket }));
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().at(-1), listRequest());

    // an – im Abschnitt auf Seite 2 – aus über die Schließen-Schaltfläche
    await openSecondPage(view, server);
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().at(-1), listRequest({ bucket }));
    await openSecondPage(view, server);
    const [close] = elements(bucketMarkOf(container), (element) =>
      (element.getAttribute("aria-label") ?? "").startsWith("Filter „")
    );
    await act(() => click(close));
    assert.deepEqual(server.lists().at(-1), listRequest());

    // Derselbe Abschnitt noch einmal: Seite 1, nicht die frühere Seite 2.
    await act(() => click(columnsOf(container)[23]));
    assert.deepEqual(server.lists().at(-1), listRequest({ bucket }));
  }
);

test(
  "Blättern (NAK-5): Zeitraum gewechselt und zurück führt auf Seite 1",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const view = await mountView(t, server);
    await openSecondPage(view, server);

    await choosePreset(view, "Letzter Monat");
    const other = server.lists().at(-1).body;
    assert.equal(other.offset, 0);
    assert.notEqual(other.startDate, view.period.startDate);

    await choosePreset(view, "Letzte 30 Tage");
    assert.deepEqual(server.lists().at(-1), view.listRequest());
  }
);

test(
  "Blättern (NAK-5): Widget gewechselt und zurück führt auf Seite 1",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const view = await mountView(t, server, [EMBED, SECOND_EMBED]);
    await openSecondPage(view, server);

    await chooseWidget(view, SECOND_EMBED);
    assert.deepEqual(server.lists().at(-1), {
      ...view.listRequest(),
      url: await urlOf(ROUTES.conversations, SECOND_EMBED.id),
    });

    await chooseWidget(view, EMBED);
    assert.deepEqual(server.lists().at(-1), view.listRequest());
  }
);

test(
  "Abschnitts-Filter: Nach einem Wechsel von Zeitraum oder Widget kommt er nicht zurück, wenn der frühere Stand wieder gilt",
  { skip },
  async (t) => {
    const server = await analyticsServer(t, { list: pagedList });
    const view = await mountView(t, server, [EMBED, SECOND_EMBED]);
    const { container, act } = view;

    await act(() => click(columnsOf(container)[23]));
    assert.ok(bucketMarkOf(container));
    await choosePreset(view, "Letzter Monat");
    assert.equal(bucketMarkOf(container)?.textContent, undefined);
    await choosePreset(view, "Letzte 30 Tage");
    assert.equal(bucketMarkOf(container)?.textContent, undefined);
    assert.deepEqual(server.lists().at(-1), view.listRequest());

    await act(() => click(columnsOf(container)[23]));
    assert.ok(bucketMarkOf(container));
    await chooseWidget(view, SECOND_EMBED);
    assert.equal(bucketMarkOf(container)?.textContent, undefined);
    await chooseWidget(view, EMBED);
    assert.equal(bucketMarkOf(container)?.textContent, undefined);
    assert.deepEqual(server.lists().at(-1), view.listRequest());
    assert.deepEqual(
      columnsOf(container).filter(
        (column) => column.getAttribute("aria-pressed") === "true"
      ),
      []
    );
  }
);

// ---------------------------------------------------------------------------
// Laden: Nur die jüngste Anfrage setzt den Zustand
// ---------------------------------------------------------------------------

const LOAD_ERROR = "Die Zählwerte konnten nicht geladen werden.";

/**
 * Ersetzt fetch durch eines, dessen Antworten der Test auslöst: Jede Anfrage
 * bleibt offen, bis answer() (Antwort als JSON) oder fail() (die Anfrage
 * selbst scheitert, z. B. abgebrochen) aufgerufen wird.
 */
function heldFetch(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init = {}) =>
    new Promise((resolve, reject) => {
      calls.push({
        url,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
        answer: (json) =>
          resolve({ ok: true, status: 200, json: async () => json }),
        fail: (error) => reject(error),
      });
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  const open = (suffix, embed) =>
    calls.filter((call) => call.url.endsWith(`/embed/${embed.id}${suffix}`));
  return {
    calls,
    summaries: (embed) => open("/analytics/summary", embed),
    lists: (embed) => open("/analytics/conversations", embed),
  };
}

/** Merkt sich die Meldungen (Toasts), die die Ansicht während des Tests zeigt. */
async function watchToasts(t) {
  const { toast } = await import("react-toastify");
  const shown = [];
  for (const type of ["success", "error", "info", "warn"]) {
    const original = toast[type];
    toast[type] = (message) => shown.push({ type, message });
    t.after(() => {
      toast[type] = original;
    });
  }
  return shown;
}

/** Die Model-Funktionen melden gescheiterte Anfragen auf der Konsole. */
function silenceConsoleError(t) {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
}

const summaryOf = (call, messages) => ({
  success: true,
  granularity: "day",
  fromDay: call.body.fromDay,
  toDay: call.body.toDay,
  firstLedgerDay: "2026-01-01",
  totals: {
    messages,
    conversations: 1,
    feedbackPositive: 0,
    feedbackNegative: 0,
  },
  buckets: [
    {
      start: call.body.fromDay,
      end: call.body.fromDay,
      partial: false,
      messages,
      conversations: 1,
    },
    {
      start: call.body.toDay,
      end: call.body.toDay,
      partial: false,
      messages: 0,
      conversations: 0,
    },
  ],
});
const EMPTY_LIST = {
  success: true,
  conversations: [],
  hasMore: false,
  totalCount: 0,
};

test(
  "Laden: Scheitert die jüngste Anfrage, zeigt die Ansicht die Meldung im Diagramm und einen Toast",
  { skip },
  async (t) => {
    silenceConsoleError(t);
    const toasts = await watchToasts(t);
    const server = heldFetch(t);
    const { container, act } = await mountView(t, server);

    await act(() => server.lists(EMBED)[0].answer(EMPTY_LIST));
    assert.doesNotMatch(container.textContent, new RegExp(LOAD_ERROR));
    await act(() => server.summaries(EMBED)[0].fail(new TypeError("fetch")));

    assert.match(container.textContent, new RegExp(LOAD_ERROR));
    assert.deepEqual(toasts, [
      { type: "error", message: "Fehler beim Laden der Konversationsdaten." },
    ]);
    assert.match(kpiTextOf(container)[0], /^Nachrichten–/);
  }
);

for (const [name, late] of [
  ["mit Erfolg", (call) => call.answer(summaryOf(call, 885))],
  ["mit einem Fehler", (call) => call.answer({ success: false })],
  [
    "abgebrochen",
    (call) => call.fail(new DOMException("aborted", "AbortError")),
  ],
]) {
  test(
    `Laden: Widget gewechselt – die überholte Anfrage des ersten Widgets antwortet danach ${name}: Die Ansicht zeigt die Zählwerte des zweiten, ohne Fehlertext und ohne Toast`,
    { skip },
    async (t) => {
      silenceConsoleError(t);
      const toasts = await watchToasts(t);
      const server = heldFetch(t);
      const view = await mountView(t, server, [EMBED, SECOND_EMBED]);
      const { container, act } = view;
      assert.equal(server.summaries(EMBED).length, 1);

      // Die Anfrage des ersten Widgets ist noch offen.
      await chooseWidget(view, SECOND_EMBED);
      const [second] = server.summaries(SECOND_EMBED);
      await act(() => {
        second.answer(summaryOf(second, 5));
        server.lists(SECOND_EMBED)[0].answer(EMPTY_LIST);
      });
      assert.match(kpiTextOf(container)[0], /^Nachrichten5Ø/);

      // Jetzt erst antworten die Anfragen des ersten Widgets.
      await act(() => {
        late(server.summaries(EMBED)[0]);
        late(server.lists(EMBED)[0]);
      });
      assert.match(kpiTextOf(container)[0], /^Nachrichten5Ø/);
      assert.equal(columnsOf(container).length, 2);
      assert.doesNotMatch(container.textContent, new RegExp(LOAD_ERROR));
      assert.deepEqual(toasts, []);
      assert.equal(server.calls.length, 4);
    }
  );
}

for (const [name, late] of [
  ["mit Erfolg", (call) => call.answer(summaryOf(call, 885))],
  ["mit einem Fehler", (call) => call.answer({ success: false })],
]) {
  test(
    `Laden: „Gesamt“ fragt in zwei Schritten – wird währenddessen ein anderer Zeitraum gewählt, zählt nur dessen Antwort; der erste Schritt antwortet danach ${name} und löst keinen zweiten aus`,
    { skip },
    async (t) => {
      silenceConsoleError(t);
      const toasts = await watchToasts(t);
      const server = heldFetch(t);
      const view = await mountView(t, server);
      const { container, act, days } = view;
      const [first] = server.summaries(EMBED);
      await act(() => first.answer(summaryOf(first, 885)));

      // „Gesamt": erst die Frage nach heute (erster Tag mit Zählwerten) …
      await choosePreset(view, "Gesamt");
      const probe = server.summaries(EMBED)[1];
      assert.equal(probe.body.fromDay, probe.body.toDay);

      // … die noch offen ist, als wieder „Letzte 30 Tage" gewählt wird.
      await choosePreset(view, "Letzte 30 Tage");
      const latest = server.summaries(EMBED)[2];
      assert.deepEqual(latest.body, summaryBody(days.fromDay, days.toDay));
      await act(() => latest.answer(summaryOf(latest, 7)));
      assert.match(kpiTextOf(container)[0], /^Nachrichten7Ø/);

      await act(() => late(probe));
      assert.equal(server.summaries(EMBED).length, 3);
      assert.match(kpiTextOf(container)[0], /^Nachrichten7Ø/);
      assert.doesNotMatch(container.textContent, new RegExp(LOAD_ERROR));
      assert.deepEqual(toasts, []);
    }
  );
}
