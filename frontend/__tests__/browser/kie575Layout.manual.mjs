// Browser-Prüfung KIE-575 (manuell, nicht Teil von `yarn test`): Maße des
// Arbeitsbereichs „Konversationen“ ab lg – volle Breite (AK-1), Liste und
// Verlauf gleich hoch mit je eigener Bildlaufleiste, die Seite endet, wenn
// der Bereich oben anliegt (AK-2), nichts unleserlich breit bei 2.560 px
// (AK-9); Vorwahl ohne Adresse und ohne Fokus (AK-3), ✕/Klick gemerkt
// (AK-4), ↑/↓ ohne Klick (AK-6), Tab aus beiden Spalten (NAK-3); unter lg
// (390 px) das Vollbild wie bisher (AK-8). Screenshots hell und dunkel.
//
// Der Server ist im Browser nachgestellt (page.route): Es läuft nur der
// Vite-Dev-Server des Frontends – kein Container, kein Docker. Playwright
// steuert das installierte Google Chrome (channel "chrome").
//
//   PLAYWRIGHT_MODULE=/pfad/zu/node_modules/playwright \
//     node frontend/__tests__/browser/kie575Layout.manual.mjs [--out DIR] [--port 3175]
//
// Ergebnis: Screenshots und kie575-measurements.json unter DIR (Standard:
// .test-storage/screenshots), eine Zusammenfassung auf der Konsole; Status 1,
// wenn eine Prüfung scheitert.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const OUT = path.resolve(
  arg("--out") ?? path.join(FRONTEND, "..", ".test-storage", "screenshots")
);
const PORT = Number(arg("--port") ?? 3175);
// --only 1440: nur die Szenarien dieser Breite (Diagnose)
const ONLY = arg("--only") ? Number(arg("--only")) : null;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/settings/chatbot/conversations`;

// PLAYWRIGHT_MODULE: Paketname oder Verzeichnis des Pakets (ein Verzeichnis
// lässt sich als ES-Modul nicht direkt laden: dann sein index.mjs).
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? "playwright";
const { chromium, devices } = await import(
  path.isAbsolute(playwrightModule) && !/\.m?js$/.test(playwrightModule)
    ? path.join(playwrightModule, "index.mjs")
    : playwrightModule
);

// ---------------------------------------------------------------------------
// Daten des nachgestellten Servers
// ---------------------------------------------------------------------------

const NOW = Date.now();
const HOUR = 3600e3;
const EMBED = {
  id: 3,
  uuid: "11111111-2222-3333-4444-555555555555",
  enabled: true,
  chat_mode: "chat",
  workspace: { id: 1, name: "VHS Musterstadt", slug: "vhs-musterstadt" },
  chat_retention_days: null,
  createdAt: new Date(NOW - 90 * 24 * HOUR).toISOString(),
};
const PREVIEWS = [
  "Gibt es noch freie Plätze im Spanischkurs A1 am Dienstagabend?",
  "Wann beginnt der nächste Yoga-Kurs für Anfänger und was kostet er?",
  "Ich möchte meinen Kurs stornieren, wie geht das und bekomme ich das Geld zurück?",
  "Welche Unterlagen brauche ich für den Integrationskurs?",
  "Bieten Sie auch Online-Kurse am Wochenende an?",
  "Wo finde ich die Kursräume in der Hauptstelle?",
  "Kann ich eine Ermäßigung als Studentin bekommen?",
  "Gibt es einen Töpferkurs für Kinder in den Herbstferien?",
];
const ROWS = Array.from({ length: 45 }, (_, i) => ({
  conversation_id: `konv-${1000 + i}`,
  session_id: `sitzung-${1000 + i}`,
  embed_id: 3,
  first_chat_id: 1000 + i,
  started_at: NOW - i * 5 * HOUR - 20 * 60e3,
  last_message_at: NOW - i * 5 * HOUR,
  message_count: 3 + (i % 5),
  negative_count: i % 7 === 2 ? 1 : 0,
  positive_count: i % 4 === 1 ? 2 : 0,
  conversation_number: 1000 + i,
  first_negative_reason: i % 7 === 2 ? "Antwort war unvollständig" : null,
  preview: PREVIEWS[i % PREVIEWS.length],
  workspace: "VHS Musterstadt",
}));

function messagesFor(id) {
  const row = ROWS.find((r) => r.first_chat_id === id) ?? ROWS[0];
  return Array.from({ length: 12 }, (_, k) => ({
    id: id * 100 + k,
    prompt:
      k === 0
        ? row.preview
        : `${PREVIEWS[(k + id) % PREVIEWS.length]} (Rückfrage ${k})`,
    response: JSON.stringify({
      text: `Gern helfe ich Ihnen weiter. **Kurs ${k + 1}** beginnt am Dienstag um 18:30 Uhr in Raum 204.\n\n- Dauer: 10 Abende\n- Gebühr: 96,00 Euro\n- Anmeldung über die [Kursseite](https://www.vhs-musterstadt.de/kurs/${id}${k})\n\nHaben Sie noch Fragen zu Terminen oder zur Anmeldung?`,
      sources: [],
    }),
    createdAt: new Date(row.started_at + k * 90e3).toISOString(),
    conversation_id: row.conversation_id,
    session_id: row.session_id,
    feedbackScore: k === 3 ? false : k === 6 ? true : null,
    feedbackReason: k === 3 ? "Antwort war unvollständig" : null,
    feedbackText: k === 3 ? "Es fehlte der Preis." : null,
  }));
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) =>
  dayOf(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n));
function summaryFor({ fromDay, toDay }) {
  const buckets = [];
  for (let day = fromDay, i = 0; day <= toDay && i < 400; day = addDays(day, 1), i++) {
    const messages = i % 3 === 2 ? 0 : 12 + ((i * 7) % 23);
    buckets.push({
      start: day,
      end: day,
      partial: day === dayOf(NOW),
      messages,
      conversations: Math.ceil(messages / 3),
    });
  }
  const sum = (key) => buckets.reduce((total, b) => total + b[key], 0);
  const weekdayHour = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) =>
      h < 7 || h > 21 ? 0 : ((d * 5 + h * 3) % 11) + (h > 9 && h < 13 ? 6 : 0)
    )
  );
  return {
    success: true,
    granularity: "day",
    fromDay,
    toDay,
    firstLedgerDay: addDays(fromDay, -60),
    totals: {
      messages: sum("messages"),
      conversations: sum("conversations"),
      feedbackPositive: 22,
      feedbackNegative: 7,
    },
    buckets,
    weekdayHour,
  };
}

function pageFor({ offset = 0, limit = 20, after, q, feedbackFilter }) {
  let rows = ROWS;
  if (q) rows = rows.filter((r) => r.preview.toLowerCase().includes(q.toLowerCase()));
  if (feedbackFilter === "negative") rows = rows.filter((r) => r.negative_count > 0);
  if (feedbackFilter === "positive") rows = rows.filter((r) => r.positive_count > 0);
  const rest = after
    ? rows.filter(
        (r) =>
          r.last_message_at < after.lastMessageAt ||
          (r.last_message_at === after.lastMessageAt &&
            r.first_chat_id < after.firstChatId)
      )
    : rows;
  const start = after ? 0 : offset;
  return {
    success: true,
    conversations: rest.slice(start, start + limit),
    hasMore: start + limit < rest.length,
    totalCount: rows.length,
    maxId: 99999,
    hasRatings: true,
  };
}

async function mockApi(context) {
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname.replace(/^.*?\/api\//, "/api/");
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const body = () => {
      try {
        return request.postDataJSON() ?? {};
      } catch {
        return {};
      }
    };
    if (pathname === "/api/setup-complete")
      return json({
        results: {
          MultiUserMode: false,
          RequiresAuth: false,
          DisableViewChatHistory: false,
          LLMProvider: "openai",
          VectorDB: "lancedb",
        },
      });
    if (pathname === "/api/onboarding") return json({ onboardingComplete: true });
    if (pathname === "/api/system/check-token") return json({ valid: true });
    if (pathname === "/api/embeds") return json({ embeds: [EMBED] });
    if (pathname === "/api/embeds/last-activity")
      return json({
        success: true,
        lastActivity: [{ embedId: 3, lastMessageAt: ROWS[0].last_message_at }],
      });
    if (pathname === "/api/embed/3/analytics/summary") return json(summaryFor(body()));
    if (pathname === "/api/embed/3/analytics/conversations") return json(pageFor(body()));
    const detail = pathname.match(/^\/api\/embed\/3\/conversation\/(\d+)$/);
    if (detail && request.method() === "GET")
      return json({ success: true, messages: messagesFor(Number(detail[1])) });
    if (pathname.endsWith("/conversation/deletion-preview"))
      return json({ success: true, messageCount: 12, visitor: null });
    return json({});
  });
}

// ---------------------------------------------------------------------------
// Dev-Server
// ---------------------------------------------------------------------------

async function startVite() {
  const child = spawn(
    process.execPath,
    [
      path.join(FRONTEND, "node_modules/vite/bin/vite.js"),
      "--port",
      String(PORT),
      "--strictPort",
      "--host",
      "127.0.0.1",
      "--clearScreen",
      "false",
    ],
    {
      cwd: FRONTEND,
      stdio: ["ignore", "pipe", "pipe"],
      // Gleicher Ursprung für /api: page.route fängt alles ab, bevor der
      // Proxy des Dev-Servers einen Server bräuchte.
      env: { ...process.env, VITE_API_BASE: "/api", BROWSER: "none" },
    }
  );
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    try {
      const response = await fetch(`${BASE}/`);
      if (response.ok) return child;
    } catch {
      // noch nicht da
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill("SIGTERM");
  throw new Error(`Vite-Dev-Server startet nicht:\n${log}`);
}

// ---------------------------------------------------------------------------
// Prüfungen
// ---------------------------------------------------------------------------

const results = [];
const checks = [];
function check(scenario, name, ok, detail) {
  checks.push({ scenario, name, ok: !!ok, detail });
  console.log(`${ok ? "  ok " : "  FEHLER "} [${scenario}] ${name}${detail === undefined ? "" : ` – ${JSON.stringify(detail)}`}`);
}

/** Maße der Ansicht im Browser (läuft in der Seite). */
function measure() {
  const q = (selector) => document.querySelector(selector);
  const content = q("[data-chatbot-content]");
  const scrollContainer = content?.parentElement ?? null;
  const area = q("[data-conversation-area]");
  const column = q("[data-list-column]");
  const scroller = q("[data-list-scroll]");
  const panel = q("[data-conversation-panel]");
  const emptyPanel = q("[data-conversation-panel-empty]");
  const body = q("[data-panel-body]");
  const chart = q("[data-column]")?.closest("svg") ?? null;
  const current = q("[data-conversation-row][aria-current='true']");
  const scrollable = (element) =>
    element
      ? {
          overflowY: getComputedStyle(element).overflowY,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: Math.round(element.scrollTop),
        }
      : null;
  const r = (element) => {
    if (!element) return null;
    const b = element.getBoundingClientRect();
    return {
      top: Math.round(b.top),
      left: Math.round(b.left),
      width: Math.round(b.width),
      height: Math.round(b.height),
      bottom: Math.round(b.bottom),
      right: Math.round(b.right),
    };
  };
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    content: r(content),
    contentAttr: content?.getAttribute("data-chatbot-content") ?? null,
    page: scrollable(scrollContainer),
    pageTop: r(scrollContainer)?.top ?? null,
    area: r(area),
    areaDisplay: area ? getComputedStyle(area).display : null,
    areaHeightStyle: area ? getComputedStyle(area).height : null,
    column: r(column),
    scroller: scrollable(scroller),
    scrollerRect: r(scroller),
    panel: r(panel),
    panelPosition: panel ? getComputedStyle(panel).position : null,
    panelBody: scrollable(body),
    emptyPanel: r(emptyPanel),
    chartWidth: chart ? Math.round(chart.getBoundingClientRect().width) : null,
    rows: document.querySelectorAll("[data-conversation-row]").length,
    currentRow: current ? Number(current.getAttribute("data-conversation-row")) : null,
    currentRowRect: r(current),
    activeElement: document.activeElement?.tagName ?? null,
    // Diagnose: absolut positionierte Elemente, die unter dem Bereich enden
    // (sie verlängern die Seite, wenn kein positionierter Vorfahr sie
    // einschließt – so fiel auf, dass die sr-only-Texte der Marken die
    // Spalte brauchen, Review des Browser-Laufs)
    overhang: area
      ? [...document.querySelectorAll("[data-chatbot-content] *")]
          .filter((element) => {
            const position = getComputedStyle(element).position;
            if (position !== "absolute" && position !== "fixed") return false;
            return element.getBoundingClientRect().bottom > area.getBoundingClientRect().bottom + 1;
          })
          .slice(0, 8)
          .map((element) => ({
            tag: element.tagName,
            cls: (element.getAttribute("class") ?? "").slice(0, 100),
            ...r(element),
          }))
      : null,
    url: location.search,
    theme: document.documentElement.getAttribute("data-theme"),
    stored: localStorage.getItem("kie.conversations.panel"),
  };
}

async function wideScenario(browser, { width, height, theme }) {
  const scenario = `${width}x${height} ${theme}`;
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    locale: "de-DE",
  });
  await context.addInitScript(
    ({ theme }) => {
      localStorage.setItem("theme", theme);
      localStorage.setItem(
        "anythingllm_can_view_chat_history",
        JSON.stringify({ viewable: true, lastFetched: Date.now() })
      );
    },
    { theme }
  );
  await mockApi(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-conversation-panel] [data-message]", { timeout: 30_000 });
  await page.waitForSelector("[data-column]", { timeout: 30_000 });
  await page.waitForTimeout(400);

  const top = await page.evaluate(measure);
  await page.screenshot({ path: path.join(OUT, `kie575-${width}-${theme}-oben.png`) });

  // AK-1: volle Breite bis auf den Seitenabstand
  const rightGap = top.innerWidth - top.content.right;
  check(scenario, "AK-1 Inhalt bis auf den Seitenabstand (rechter Rand ≤ 48 px)", rightGap <= 48, { contentWidth: top.content.width, rightGap });
  check(scenario, "AK-1 Arbeitsbereich so breit wie der Inhalt (Innenabstand 24 px)", Math.abs(top.area.width - (top.content.width - 48)) <= 2, { area: top.area.width, content: top.content.width });
  check(scenario, "AK-1 Seitenrahmen ohne Obergrenze (data-chatbot-content=full)", top.contentAttr === "full" && (width < 1500 || top.content.width > 1180), { contentAttr: top.contentAttr, contentWidth: top.content.width });
  // AK-2: Liste und Verlauf gleich hoch, je eigene Bildlaufleiste
  check(scenario, "AK-2 Liste und Verlauf gleich hoch", Math.abs(top.column.height - top.panel.height) <= 1, { column: top.column.height, panel: top.panel.height, area: top.area.height });
  check(scenario, "AK-2 Bereichshöhe = max(560, 100vh − 88)", Math.abs(top.area.height - Math.max(560, height - 88)) <= 1, { area: top.area.height, expected: Math.max(560, height - 88) });
  check(scenario, "AK-2 Liste scrollt selbst (overflow-y auto, Inhalt höher als Spalte)", top.scroller.overflowY === "auto" && top.scroller.scrollHeight > top.scroller.clientHeight, top.scroller);
  check(scenario, "AK-2 Verlauf scrollt selbst (overflow-y auto, Inhalt höher)", top.panelBody.overflowY === "auto" && top.panelBody.scrollHeight > top.panelBody.clientHeight, top.panelBody);
  check(scenario, "AK-2 Verlauf im Fluss (relative), nicht sticky", top.panelPosition === "relative", { position: top.panelPosition });
  // Breiten der Spalten
  const share = top.panel.width / top.area.width;
  const expectedShare = width >= 1536 ? 0.56 : 0.5;
  check(scenario, `Verlauf ${Math.round(expectedShare * 100)} % der Breite (abzüglich 8 px Spaltenabstand)`, Math.abs(top.panel.width - (top.area.width * expectedShare - 8)) <= 2 || (width >= 1280 && top.panel.width === 480), { panel: top.panel.width, column: top.column.width, share: Number(share.toFixed(3)) });
  check(scenario, "Verlauf mindestens 480 px (ab xl)", width < 1280 || top.panel.width >= 480, { panel: top.panel.width });
  // AK-3: Vorwahl ohne Adresse, ohne Fokus
  check(scenario, "AK-3 neueste Konversation vorgewählt", top.currentRow === ROWS[0].first_chat_id, { currentRow: top.currentRow });
  check(scenario, "AK-3 Adresse ohne conversation", !/conversation=/.test(top.url), { url: top.url });
  check(scenario, "AK-3 Fokus auf <body>", top.activeElement === "BODY", { activeElement: top.activeElement });
  check(scenario, "AK-3 nichts gemerkt durch die Vorwahl", top.stored === null, { stored: top.stored });
  check(scenario, "NAK-1 Seite nicht gescrollt beim Öffnen", top.page.scrollTop === 0, { scrollTop: top.page.scrollTop });
  check(scenario, "Theme", top.theme === theme, { theme: top.theme });
  check(scenario, "keine Fehler der Seite", errors.length === 0, errors);
  // AK-9: Diagrammbreite (Zahl zum Beurteilen)
  results.push({ scenario, phase: "oben", ...top, rightGap });

  // AK-2: Seite bis zum Bereich scrollen – dann steht sie; die Panelhöhe
  // bleibt; danach scrollt nur die Spalte unter der Maus
  const end = await page.evaluate(() => {
    const content = document.querySelector("[data-chatbot-content]");
    const container = content.parentElement;
    container.scrollTop = container.scrollHeight;
    return {
      scrollTop: Math.round(container.scrollTop),
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    };
  });
  await page.waitForTimeout(200);
  const bottom = await page.evaluate(measure);
  await page.screenshot({ path: path.join(OUT, `kie575-${width}-${theme}-unten.png`) });
  check(scenario, "AK-2 Seite zu Ende, wenn der Bereich oben anliegt (Oberkante 24 px, 8 px unter dem Rahmen)", Math.abs(bottom.area.top - 24) <= 2 && end.scrollTop + end.clientHeight >= end.scrollHeight - 1, { areaTop: bottom.area.top, pageTop: bottom.pageTop, ...end });
  check(scenario, "AK-2 Panelhöhe beim Scrollen unverändert", bottom.panel.height === top.panel.height, { before: top.panel.height, after: bottom.panel.height });
  check(scenario, "AK-2 Spalte beim Seitenscroll nicht mitgescrollt", bottom.scroller.scrollTop === 0, { scrollTop: bottom.scroller.scrollTop });
  // Rad über der Liste: nur die Spalte scrollt
  await page.mouse.move(bottom.scrollerRect.left + bottom.scrollerRect.width / 2, bottom.scrollerRect.top + bottom.scrollerRect.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  const wheeled = await page.evaluate(measure);
  check(scenario, "AK-2 Rad über der Liste scrollt nur die Spalte", wheeled.scroller.scrollTop > 0 && wheeled.page.scrollTop === bottom.page.scrollTop, { column: wheeled.scroller.scrollTop, page: wheeled.page.scrollTop });
  // Rad über dem Verlauf: nur der Verlauf
  await page.mouse.move(bottom.panel.left + bottom.panel.width / 2, bottom.panel.top + bottom.panel.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  const wheeledPanel = await page.evaluate(measure);
  check(scenario, "AK-2 Rad über dem Verlauf scrollt nur den Verlauf", wheeledPanel.panelBody.scrollTop > 0 && wheeledPanel.page.scrollTop === bottom.page.scrollTop, { body: wheeledPanel.panelBody.scrollTop, page: wheeledPanel.page.scrollTop });
  results.push({ scenario, phase: "unten", ...bottom });

  // AK-5: Weitere laden am Spaltenende – die Spalte bis unten scrollen
  await page.evaluate(() => {
    const scroller = document.querySelector("[data-list-scroll]");
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.waitForTimeout(1500);
  const loaded = await page.evaluate(measure);
  check(scenario, "AK-5 am Spaltenende nachgeladen (mehr als 20 Zeilen)", loaded.rows > 20, { rows: loaded.rows });

  // AK-6: ↓ ohne Klick (Fokus auf <body>): die zweite Zeile, sichtbar in der Spalte
  await page.evaluate(() => {
    document.querySelector("[data-list-scroll]").scrollTop = 0;
  });
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500);
  const afterDown = await page.evaluate(measure);
  const inColumn =
    afterDown.currentRowRect &&
    afterDown.currentRowRect.top >= afterDown.scrollerRect.top - 1 &&
    afterDown.currentRowRect.bottom <= afterDown.scrollerRect.bottom + 1;
  check(scenario, "AK-6 ↓ ohne Klick wählt die nächste Konversation", afterDown.currentRow === ROWS[1].first_chat_id, { currentRow: afterDown.currentRow, url: afterDown.url });
  check(scenario, "AK-6 Fokus bleibt auf <body>", afterDown.activeElement === "BODY", { activeElement: afterDown.activeElement });
  check(scenario, "AK-6 gewählte Zeile in der Spalte sichtbar", inColumn, { row: afterDown.currentRowRect, column: afterDown.scrollerRect });
  check(scenario, "AK-6 Seite nicht gescrollt durch ↓", afterDown.page.scrollTop === bottom.page.scrollTop, { page: afterDown.page.scrollTop });
  // ↓ mehrfach: die Zeile bleibt sichtbar (Spalte folgt)
  for (let i = 0; i < 14; i++) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(600);
  const deep = await page.evaluate(measure);
  const deepInColumn =
    deep.currentRowRect &&
    deep.currentRowRect.top >= deep.scrollerRect.top - 1 &&
    deep.currentRowRect.bottom <= deep.scrollerRect.bottom + 1;
  check(scenario, "AK-6 nach 15× ↓ bleibt die gewählte Zeile in der Spalte sichtbar", deepInColumn && deep.currentRow === ROWS[15].first_chat_id, { currentRow: deep.currentRow, scrollTop: deep.scroller.scrollTop });

  // NAK-3: Escape schließt nicht; Tab aus dem Verlauf heraus
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check(scenario, "NAK-3 Escape lässt den Verlauf offen", await page.locator("[data-conversation-panel]").count() === 1);
  await page.focus("[data-delete-conversation]");
  await page.keyboard.press("Tab");
  const tabbedOut = await page.evaluate(() => {
    const panel = document.querySelector("[data-conversation-panel]");
    return { inPanel: panel?.contains(document.activeElement) ?? false, tag: document.activeElement?.tagName };
  });
  check(scenario, "NAK-3 Tab verlässt den Verlauf nach dem letzten Element", !tabbedOut.inPanel, tabbedOut);
  await page.locator("[data-conversation-row]").last().focus();
  await page.keyboard.press("Tab");
  const tabbedOutList = await page.evaluate(() => {
    const scroller = document.querySelector("[data-list-scroll]");
    const rows = [...document.querySelectorAll("[data-conversation-row]")];
    return { onRow: rows.includes(document.activeElement), inScroller: scroller?.contains(document.activeElement) ?? false, tag: document.activeElement?.tagName, attr: [...(document.activeElement?.attributes ?? [])].map((a) => a.name).find((n) => n.startsWith("data-")) };
  });
  check(scenario, "NAK-3 Tab verlässt die Zeilen der Liste", !tabbedOutList.onRow, tabbedOutList);

  // AK-4: ✕ schließt (Liste volle Breite), merkt „closed“; Neuladen zu;
  // Klick öffnet, merkt „open“; Neuladen offen
  await page.click("[data-panel-close]");
  await page.waitForTimeout(300);
  const closed = await page.evaluate(measure);
  check(scenario, "AK-4 ✕ schließt: Liste über die volle Breite", closed.panel === null && closed.emptyPanel === null && Math.abs(closed.column.width - closed.area.width) <= 1, { column: closed.column?.width, area: closed.area?.width, stored: closed.stored });
  check(scenario, "AK-4 „closed“ gemerkt", closed.stored === "closed", { stored: closed.stored });
  check(scenario, "AK-4 Adresse nach ✕ ohne conversation", !/conversation=/.test(closed.url), { url: closed.url });
  await page.screenshot({ path: path.join(OUT, `kie575-${width}-${theme}-geschlossen.png`) });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-conversation-row]", { timeout: 30_000 });
  await page.waitForTimeout(600);
  const reloadedClosed = await page.evaluate(measure);
  check(scenario, "AK-4 nach Neuladen weiter zu", reloadedClosed.panel === null && reloadedClosed.emptyPanel === null, { stored: reloadedClosed.stored });
  await page.click("[data-conversation-row]:nth-of-type(1) >> nth=0");
  await page.waitForSelector("[data-conversation-panel] [data-message]", { timeout: 30_000 });
  const opened = await page.evaluate(measure);
  check(scenario, "AK-4 Klick öffnet und merkt „open“", opened.panel !== null && opened.stored === "open", { stored: opened.stored, url: opened.url });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-conversation-panel] [data-message]", { timeout: 30_000 });
  const reloadedOpen = await page.evaluate(measure);
  check(scenario, "AK-4 nach Neuladen wieder offen (Vorwahl ohne Adresse)", reloadedOpen.panel !== null, { url: reloadedOpen.url, currentRow: reloadedOpen.currentRow });

  // AK-7: Deep-Link
  await page.goto(`${PAGE}?widget=3&conversation=${ROWS[7].first_chat_id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-conversation-panel] [data-message]", { timeout: 30_000 });
  await page.waitForTimeout(800);
  const linked = await page.evaluate(measure);
  check(scenario, "AK-7 Deep-Link öffnet die genannte Konversation", linked.currentRow === ROWS[7].first_chat_id, { currentRow: linked.currentRow, url: linked.url });
  await page.screenshot({ path: path.join(OUT, `kie575-${width}-${theme}-link.png`) });

  await context.close();
}

async function narrowScenario(browser, { width, height, theme }) {
  const scenario = `${width}x${height} ${theme}`;
  // Ein Handy, wie es die Ansicht erkennt (react-device-detect liest den
  // User-Agent): Gerät „iPhone 13“, Fenster wie angegeben.
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    viewport: { width, height },
    colorScheme: theme,
    locale: "de-DE",
  });
  await context.addInitScript(
    ({ theme }) => {
      localStorage.setItem("theme", theme);
      localStorage.setItem(
        "anythingllm_can_view_chat_history",
        JSON.stringify({ viewable: true, lastFetched: Date.now() })
      );
    },
    { theme }
  );
  await mockApi(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-conversation-row]", { timeout: 30_000 });
  await page.waitForTimeout(600);
  const top = await page.evaluate(measure);
  await page.screenshot({ path: path.join(OUT, `kie575-${width}-${theme}-liste.png`) });
  check(scenario, "AK-8 kein Panel, kein Platzhalter von selbst", top.panel === null && top.emptyPanel === null, { currentRow: top.currentRow });
  check(scenario, "AK-8 Bereich ohne feste Höhe (block), Liste scrollt mit der Seite", top.areaDisplay === "block" && top.scroller.overflowY === "visible", { display: top.areaDisplay, overflowY: top.scroller.overflowY, areaHeight: top.area.height });
  check(scenario, "AK-8 kein Seitenabstand rechts über 24 px", top.innerWidth - top.content.right <= 24, { gap: top.innerWidth - top.content.right });
  await page.click("[data-conversation-row] >> nth=0");
  await page.waitForSelector("[data-conversation-panel] [data-message]", { timeout: 30_000 });
  await page.waitForTimeout(300);
  const fullscreen = await page.evaluate(measure);
  await page.screenshot({ path: path.join(OUT, `kie575-${width}-${theme}-vollbild.png`) });
  check(scenario, "AK-8 Vollbild-Panel (fixed, so groß wie das Fenster)", fullscreen.panelPosition === "fixed" && fullscreen.panel.width === width && fullscreen.panel.height === height, { position: fullscreen.panelPosition, panel: fullscreen.panel });
  check(scenario, "AK-8 Fokus auf „‹ Konversationen“", await page.evaluate(() => document.activeElement?.hasAttribute("data-panel-back")));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(scenario, "AK-8 Escape schließt das Vollbild", (await page.locator("[data-conversation-panel]").count()) === 0);
  check(scenario, "keine Fehler der Seite", errors.length === 0, errors);
  results.push({ scenario, phase: "mobil", ...top });
  await context.close();
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const vite = await startVite();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const wanted = (width) => ONLY === null || ONLY === width;
  for (const theme of ["dark", "light"]) {
    if (wanted(1440)) await wideScenario(browser, { width: 1440, height: 900, theme });
    if (wanted(1920)) await wideScenario(browser, { width: 1920, height: 1080, theme });
    if (wanted(2560)) await wideScenario(browser, { width: 2560, height: 1440, theme });
    if (wanted(390)) await narrowScenario(browser, { width: 390, height: 844, theme });
  }
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}

writeFileSync(
  path.join(OUT, "kie575-measurements.json"),
  JSON.stringify({ checks, results }, null, 2)
);
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length} von ${checks.length} Prüfungen ok; Screenshots und Maße unter ${OUT}`);
for (const c of failed) console.log(`FEHLER [${c.scenario}] ${c.name} ${JSON.stringify(c.detail)}`);
process.exit(failed.length > 0 ? 1 : 0);
