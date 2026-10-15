// KIE-565 Nachträge (Nutzer 15.10.2026, Liste nachtraege-7.22-rc6, Punkte
// 1 bis 4, Design Center):
//   1. gewähltes Chat-Icon deutlich hervorgehoben (Rahmen in Akzentfarbe,
//      aria-pressed), auch mit gespeichertem Wert
//   2. „Schrift auf der Kundenfarbe“ Weiß/Schwarz mit Empfehlung nach
//      WCAG-Kontrast und Warnung unter 4,5:1; ohne gespeicherten Wert gilt
//      die Empfehlung (nur angezeigt, Regel D6); Vorschau mit
//      Beispiel-Nutzernachricht in Chatblase und Inline
//   3. „Buttons“ statt „Knöpfe“ in allen sichtbaren Texten
//   4. Startvorschläge in der Vorschau wie die Folgefragen (eine Komponente)
//
// Logik (widgetKeys.js) als reine Funktionen, Darstellung serverseitig
// gerendert, danach Tests mit eingehängter Seite (mount).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements, handlersOf } from "./helpers/testDom.mjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as keys from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/widgetKeys.js";
import * as contrast from "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/contrast.js";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance";
const DESIGN_CENTER = `${DIR}/index.jsx`;
const APPEARANCE = `${DIR}/AppearanceTab.jsx`;
const CONTENT = `${DIR}/ContentTab.jsx`;
const EMBED = `${DIR}/EmbedTab.jsx`;
const PREVIEW = `${DIR}/WidgetPreview.jsx`;
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const require = createRequire(import.meta.url);
const {
  embedDefaultTexts,
} = require("../../server/utils/chats/embedDefaults.js");
const DEFAULTS = embedDefaultTexts("de");

const WHITE = "#FFFFFF";
// Option „Schwarz“: gespeicherter, ausgelieferter und für Empfehlung und
// Warnung gerechneter Wert (Entscheidung E1, Fixliste 7.22-rc7)
const BLACK = "#222628";
// früher gespeichertes reines Schwarz (Server liefert es als #222628 aus)
const PURE_BLACK = "#000000";

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const noop = () => {};
const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// Unabhängige Rechnung nach WCAG 2.x (Formel aus der Norm), nicht aus
// widgetKeys.js übernommen
function luminance(hex) {
  const n = hex.replace("#", "");
  const full =
    n.length === 3
      ? n
          .split("")
          .map((c) => c + c)
          .join("")
      : n;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const s = parseInt(full.slice(i, i + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ---------------------------------------------------------------------------
// Punkt 2: Logik
// ---------------------------------------------------------------------------

test("Kontrast nach WCAG 2.x: Grenzwerte und bekannte Paare", () => {
  assert.equal(contrast.contrastRatio("#FFFFFF", "#000000"), 21);
  assert.equal(contrast.contrastRatio("#000", "#000000"), 1);
  assert.equal(contrast.contrastRatio("#ffffff", "#FFF"), 1);
  // Türkis des Widgets auf Weiß gut 3:1 (zu wenig für Text)
  assert.ok(
    Math.abs(contrast.contrastRatio("#01A5A9", WHITE) - 3.02) < 0.01,
    String(contrast.contrastRatio("#01A5A9", WHITE))
  );
  for (const [a, b] of [
    ["#01A5A9", BLACK],
    ["#FFA102", WHITE],
    ["#123456", "#eceae6"],
    ["#777777", WHITE],
  ])
    assert.ok(Math.abs(contrast.contrastRatio(a, b) - ratio(a, b)) < 1e-9, a);
  assert.equal(contrast.contrastRatio("01A5A9", WHITE), null);
  assert.equal(contrast.contrastRatio("#01A5A", WHITE), null);
  assert.equal(contrast.contrastRatio("red", WHITE), null);
  assert.equal(contrast.contrastRatio(undefined, WHITE), null);
});

test("Empfehlung wie im Widget: höherer Kontrast zu Weiß bzw. Schwarz gewinnt, Gleichstand und ungültiger Code Weiß", () => {
  assert.equal(contrast.recommendedTextColor("#01A5A9"), BLACK);
  assert.equal(contrast.recommendedTextColor("#FFA102"), BLACK);
  assert.equal(contrast.recommendedTextColor("#FFD700"), BLACK);
  assert.equal(contrast.recommendedTextColor("#003366"), WHITE);
  assert.equal(contrast.recommendedTextColor("#E30613"), WHITE);
  // E1: gerechnet mit #222628 statt #000000, mittleres Grau jetzt Weiß
  assert.equal(contrast.recommendedTextColor("#777777"), WHITE);
  assert.equal(contrast.recommendedTextColor("#666666"), WHITE);
  assert.equal(contrast.recommendedTextColor(""), WHITE);
  assert.equal(contrast.recommendedTextColor("nichts"), WHITE);
  // alle Grautöne: die Empfehlung hat nie weniger Kontrast als die andere,
  // bei Gleichstand Weiß
  for (let v = 0; v < 256; v++) {
    const gray = `#${v.toString(16).padStart(2, "0").repeat(3)}`;
    const chosen = contrast.recommendedTextColor(gray);
    const other = chosen === WHITE ? BLACK : WHITE;
    assert.ok(ratio(gray, chosen) >= ratio(gray, other), gray);
    if (ratio(gray, WHITE) === ratio(gray, BLACK))
      assert.equal(chosen, WHITE, gray);
  }
});

// Gegenprobe „wortgleich“: mit KUFER_EMBED_DIR (Checkout von
// anythingllm-embed) gleicher Code wie src/utils/contrast.js, bis auf die
// Kopfzeilen und die Formatierung (Kommas am Zeilenende)
test(
  "contrast.js wortgleich mit dem Widget",
  {
    skip:
      process.env.KUFER_EMBED_DIR &&
      existsSync(
        path.join(process.env.KUFER_EMBED_DIR, "src/utils/contrast.js")
      )
        ? false
        : "KUFER_EMBED_DIR nicht gesetzt",
  },
  () => {
    const strip = (code) => code.replace(/,(\s*[)\]])/g, "$1");
    const widget = readFileSync(
      path.join(process.env.KUFER_EMBED_DIR, "src/utils/contrast.js"),
      "utf8"
    );
    const fork = readFileSync(
      new URL(
        "../src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/contrast.js",
        import.meta.url
      ),
      "utf8"
    )
      .split("\n")
      .slice(4)
      .join("\n");
    assert.equal(strip(fork), strip(widget));
  }
);

test("D6: ohne gespeicherten Wert gilt die Empfehlung, gespeicherte Werte bleiben", () => {
  // neues Widget mit Türkis: Schwarz empfohlen, gezeigt als #222628 (E1)
  assert.equal(keys.userTextColor({}), BLACK);
  assert.equal(keys.lookValue({}, "userTextColor"), BLACK);
  assert.equal(keys.userTextColorChoice({}), BLACK);
  assert.equal(keys.userTextColor({ accentColor: "#003366" }), WHITE);
  assert.equal(keys.userTextColorChoice({ accentColor: "#003366" }), WHITE);
  // gespeichert bleibt gespeichert, auch bei schlechtem Kontrast
  assert.equal(
    keys.userTextColor({ accentColor: "#01A5A9", userTextColor: WHITE }),
    WHITE
  );
  assert.equal(
    keys.userTextColorChoice({ accentColor: "#01A5A9", userTextColor: WHITE }),
    WHITE
  );
  assert.equal(
    keys.userTextColor({ accentColor: "#003366", userTextColor: BLACK }),
    BLACK
  );
  assert.equal(keys.userTextColor({ userTextColor: "#ffffff" }), WHITE);
  // per API gesetzter anderer Wert: gilt, keine Option markiert
  assert.equal(keys.userTextColor({ userTextColor: "#333333" }), "#333333");
  assert.equal(keys.userTextColorChoice({ userTextColor: "#333333" }), null);
  assert.equal(keys.storedUserTextColor({}), null);
  assert.equal(keys.storedUserTextColor({ userTextColor: "  " }), null);
  assert.equal(keys.storedUserTextColor({ userTextColor: 7 }), null);
  // Speichern schreibt keine Empfehlung dazu
  const saved = keys.cleanConfig({ accentColor: "#003366" }, { initial: {} });
  assert.deepEqual(saved, { accentColor: "#003366" });
});

test("Empfehlung und Warnung unter dem Feld", () => {
  const fresh = keys.userTextColorAdvice({});
  assert.equal(fresh.recommendedLabel, "Schwarz");
  assert.equal(fresh.stored, false);
  assert.equal(fresh.warning, null);

  const white = keys.userTextColorAdvice({ userTextColor: WHITE });
  assert.equal(white.stored, true);
  assert.equal(
    white.warning,
    "Kontrast nur 3,0:1: Unter 4,5:1 ist die Schrift auf der Kundenfarbe schwer lesbar."
  );

  // mittleres Grau (E1, gerechnet mit #222628): Empfehlung Weiß, auch sie
  // bleibt knapp unter 4,5:1; die Warnung sagt dann, dass keine Option
  // reicht. Gewähltes Schwarz: die übliche Warnung.
  const gray = keys.userTextColorAdvice({ accentColor: "#777777" });
  assert.equal(gray.recommendedLabel, "Weiß");
  assert.equal(
    gray.warning,
    "Kontrast nur 4,4:1: Weder Weiß noch Schwarz erreicht auf dieser Kundenfarbe 4,5:1. Eine hellere oder dunklere Kundenfarbe ist besser lesbar."
  );
  assert.equal(
    keys.userTextColorAdvice({ accentColor: "#777777", userTextColor: BLACK })
      .warning,
    "Kontrast nur 3,4:1: Unter 4,5:1 ist die Schrift auf der Kundenfarbe schwer lesbar."
  );
  // Warnung genau dann, wenn die gezeigte Schrift unter 4,5:1 bleibt
  for (let v = 0; v < 256; v += 5)
    for (const hex of [
      `#${v.toString(16).padStart(2, "0").repeat(3)}`,
      `#ff${v.toString(16).padStart(2, "0")}00`,
      `#00${v.toString(16).padStart(2, "0")}ff`,
    ]) {
      const best = Math.max(ratio(hex, WHITE), ratio(hex, BLACK));
      const advice = keys.userTextColorAdvice({ accentColor: hex });
      assert.equal(advice.warning !== null, best < 4.5, hex);
    }

  // ab 4,5:1 keine Warnung
  assert.equal(
    keys.userTextColorAdvice({ accentColor: "#003366", userTextColor: WHITE })
      .warning,
    null
  );
  // ungültiger Farbcode (gerade beim Tippen): weder Empfehlung noch Warnung
  const typing = keys.userTextColorAdvice({ accentColor: "#01A5" });
  assert.equal(typing.recommendedLabel, null);
  assert.equal(typing.warning, null);
  assert.equal(keys.contrastLabel(4.4999), "4,4:1");
  assert.equal(keys.contrastLabel(21), "21,0:1");
});

// ---------------------------------------------------------------------------
// Punkt 4: Logik der Startvorschlag-Pillen
// ---------------------------------------------------------------------------

test("Schrift der Pillen: Kundenfarbe, sonst abgedunkelt bzw. aufgehellt bis 4,5:1", () => {
  for (const backgrounds of [["#ffffff"], ["#1d1d21", "#131316"]])
    for (const accent of [
      "#01A5A9",
      "#FFD700",
      "#FFA102",
      "#003366",
      "#E30613",
      "#FFFFFF",
      "#000000",
      "#777777",
    ]) {
      const color = keys.pillTextColor(accent, backgrounds);
      for (const bg of backgrounds)
        assert.ok(ratio(color, bg) >= 4.5, `${accent} auf ${bg}: ${color}`);
      // ausreichender Kontrast: die Kundenfarbe selbst
      if (backgrounds.every((bg) => ratio(accent, bg) >= 4.5))
        assert.equal(color.toLowerCase(), accent.toLowerCase());
    }
  // Türkis auf Weiß wird abgedunkelt, auf Dunkel bleibt es
  const light = keys.pillTextColor("#01A5A9", ["#ffffff"]);
  assert.ok(luminance(light) < luminance("#01A5A9"));
  assert.equal(
    keys.pillTextColor("#01A5A9", ["#1d1d21", "#131316"]),
    "#01A5A9"
  );
  // Dunkelblau auf Dunkel wird aufgehellt
  assert.ok(
    luminance(keys.pillTextColor("#003366", ["#1d1d21"])) > luminance("#003366")
  );
  // nicht auswertbare Kundenfarbe: Ersatz
  assert.equal(keys.pillTextColor("abc", ["#ffffff"], "#1c1917"), "#1c1917");
});

// ---------------------------------------------------------------------------
// Darstellung (serverseitig gerendert)
// ---------------------------------------------------------------------------

async function show(modulePath, props) {
  return renderer.render(modulePath, { location: "/", props });
}
const appearance = (config) =>
  show(APPEARANCE, { config, updateField: noop, logoPreview: null });
const preview = (config) =>
  show(PREVIEW, {
    config,
    logoPreview: null,
    defaults: DEFAULTS,
    greetingKey: "greeting",
  });

// <button …> mit title
function buttonTag(html, title) {
  return html.match(new RegExp(`<button[^>]*title="${title}"[^>]*>`))?.[0];
}

test(
  "Punkt 1: gespeichertes Chat-Icon ist hervorgehoben (Rahmen in Akzentfarbe, aria-pressed), die übrigen nicht",
  { skip },
  async () => {
    const html = await appearance({ chatIcon: "magic" });
    const selected = buttonTag(html, "Magie");
    assert.match(selected, /aria-pressed="true"/);
    assert.match(selected, /border-primary-button/);
    for (const title of [
      "Chat-Blase",
      "Support",
      "Suche",
      "Fernglas",
      "Plus",
    ]) {
      const tag = buttonTag(html, title);
      assert.match(tag, /aria-pressed="false"/, title);
      assert.doesNotMatch(tag, /border-primary-button/, title);
    }
    // ohne gespeicherten Wert: der Standard des Widgets
    const fresh = await appearance({});
    assert.match(buttonTag(fresh, "Chat-Blase"), /aria-pressed="true"/);
    assert.match(buttonTag(fresh, "Chat-Blase"), /border-primary-button/);
  }
);

test(
  "Punkt 2: Feld „Schrift auf der Kundenfarbe“ mit Empfehlung; ohne Wahl ist die Empfehlung aktiv",
  { skip },
  async () => {
    const html = await appearance({});
    const t = text(html);
    assert.ok(t.includes("Schrift auf der Kundenfarbe"));
    assert.ok(!t.includes("Schrift in Nutzer-Nachrichten"));
    assert.ok(
      t.includes(
        "Empfohlen: Schwarz. Solange Sie nichts wählen, gilt automatisch die Empfehlung."
      ),
      t
    );
    assert.doesNotMatch(html, /data-testid="user-text-warning"/);
    // Schwarz ist als wirksamer Wert markiert, Weiß nicht
    const pressed = [
      ...html.matchAll(
        /<button[^>]*aria-pressed="(true|false)"[^>]*>(?:(?!<\/button>).)*?(Weiß|Schwarz)<\/button>/g
      ),
    ].map((m) => [m[2], m[1]]);
    assert.deepEqual(Object.fromEntries(pressed), {
      Weiß: "false",
      Schwarz: "true",
    });

    const blue = text(await appearance({ accentColor: "#003366" }));
    assert.ok(blue.includes("Empfohlen: Weiß."));
  }
);

test(
  "Punkt 2: Warnung bei gewählter Kombination unter 4,5:1, gespeicherter Wert bleibt aktiv",
  { skip },
  async () => {
    const html = await appearance({ userTextColor: WHITE });
    const t = text(html);
    assert.ok(t.includes("Empfohlen: Schwarz"));
    assert.ok(!t.includes("Solange Sie nichts wählen"));
    assert.match(html, /data-testid="user-text-warning"/);
    assert.ok(
      t.includes(
        "Kontrast nur 3,0:1: Unter 4,5:1 ist die Schrift auf der Kundenfarbe schwer lesbar."
      )
    );
    assert.match(html, /aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Weiß/);
    // gute Wahl: keine Warnung
    const ok = await appearance({ userTextColor: BLACK });
    assert.doesNotMatch(ok, /data-testid="user-text-warning"/);
  }
);

test(
  "Punkt 2: Vorschau Chatblase zeigt eine Nutzer-Nachricht in Kundenfarbe mit der Schrift, darunter „Beispiel-Nutzernachricht“",
  { skip },
  async () => {
    // ohne gespeicherten Wert: die Empfehlung wie im Widget (Schwarz auf
    // Türkis)
    const fresh = await preview({});
    assert.match(
      fresh,
      /data-preview="user-message"[^>]*>|style="[^"]*"[^>]*data-preview="user-message"/
    );
    const tag = fresh.match(/<div[^>]*data-preview="user-message"[^>]*>/)[0];
    assert.match(tag, /background-color:#01A5A9/i);
    assert.match(tag, /(^|[;"])color:#222628/i);
    const t = text(fresh);
    assert.ok(t.includes("Beispiel-Nutzernachricht"));
    assert.ok(
      t.indexOf("Gibt es Kurse am Wochenende?") <
        t.indexOf("Beispiel-Nutzernachricht")
    );
    // gespeicherter Wert gilt
    const stored = await preview({
      accentColor: "#FFA102",
      userTextColor: WHITE,
    });
    const storedTag = stored.match(
      /<div[^>]*data-preview="user-message"[^>]*>/
    )[0];
    assert.match(storedTag, /background-color:#FFA102/i);
    assert.match(storedTag, /(^|[;"])color:#FFFFFF/i);
    // Chat-Button der Vorschau: Icon in der Schrift auf der Kundenfarbe
    assert.match(fresh, /<svg[^>]*fill="#222628"/);
  }
);

test(
  "Punkt 2: Inline-Leiste: Senden-Button in der Schrift auf der Kundenfarbe (ohne Wert die Empfehlung)",
  { skip },
  async () => {
    const html = await preview({ displayMode: "inline" });
    assert.match(html, /background-color:#01A5A9;color:#222628[^>]*>Chatten</i);
  }
);

test(
  "Punkt 3: „Buttons“ statt „Knöpfe“ in allen Reitern des Design Centers",
  { skip },
  async () => {
    const contentProps = (config) => ({
      config,
      initialConfig: config,
      errors: {},
      defaults: DEFAULTS,
      defaultsError: false,
      greetingKey: "greeting",
      updateField: noop,
      updateOptionalField: noop,
      resetKeys: noop,
      setPrivacyNotice: noop,
      applySuggestion: noop,
      addListItem: noop,
      updateListItem: noop,
      removeListItem: noop,
    });
    const pages = [];
    for (const mode of ["bubble", "inline"]) {
      const config = { displayMode: mode };
      pages.push(text(await appearance(config)));
      pages.push(text(await show(CONTENT, contentProps(config))));
      pages.push(
        text(await show(EMBED, { config, embed: { uuid: "abc-123" } }))
      );
      pages.push(text(await preview(config)));
    }
    for (const page of pages) assert.doesNotMatch(page, /Knopf|Knöpf/);
    const bubble = pages[0];
    assert.ok(bubble.includes("Startvorschläge als Buttons"));
    assert.ok(bubble.includes("Folgefragen als Buttons"));
    assert.ok(bubble.includes("Buttons, Nutzer-Nachrichten, Links."));
    assert.ok(bubble.includes("Das Icon auf dem Chat-Button."));
    assert.ok(pages[4].includes("Folgefragen als Buttons"));
    assert.ok(
      pages[1].includes(
        "Buttons mit Fragen, die Besucher mit einem Klick stellen können."
      )
    );
    for (const page of pages) assert.doesNotMatch(page, /[–—]/);
  }
);

// Stil eines Elements als Objekt
function styleOf(tag) {
  const style = tag.match(/style="([^"]*)"/)?.[1] || "";
  return Object.fromEntries(
    style
      .split(";")
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(":");
        return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()];
      })
  );
}

test(
  "Punkt 4: Startvorschläge wie Folgefragen: Rand in Kundenfarbe, lesbare Schrift, Füllung beim Darüberfahren; Chatblase und Inline, hell und dunkel",
  { skip },
  async () => {
    const cases = [
      [{ theme: "light" }, "#ffffff"],
      [{ theme: "dark" }, "#1d1d21"],
      [{ theme: "light", displayMode: "inline" }, "#ffffff"],
      [{ theme: "dark", displayMode: "inline" }, "#1d1d21"],
    ];
    for (const accentColor of ["#01A5A9", "#FFD700", "#003366"])
      for (const [look, panel] of cases) {
        const html = await preview({
          ...look,
          accentColor,
          defaultMessages: [
            "Welche Sprachkurse gibt es?",
            "Wie melde ich mich an?",
          ],
        });
        const pills = html.match(/<span[^>]*data-preview="pill"[^>]*>/g) || [];
        assert.equal(pills.length, 2, `${accentColor} ${JSON.stringify(look)}`);
        for (const pill of pills) {
          const style = styleOf(pill);
          assert.equal(
            style["border-color"].toLowerCase(),
            accentColor.toLowerCase()
          );
          assert.equal(
            style["--pill-accent"].toLowerCase(),
            accentColor.toLowerCase()
          );
          assert.equal(style["--pill-bg"].toLowerCase(), panel);
          assert.equal(
            style["--pill-on-accent"],
            contrast.recommendedTextColor(accentColor)
          );
          assert.ok(
            ratio(style["--pill-text"], panel) >= 4.5,
            `${accentColor} auf ${panel}: ${style["--pill-text"]}`
          );
          // gemeinsame Klassen: Schrift und Fläche aus den Variablen,
          // Darüberfahren füllt in Kundenfarbe
          for (const cls of [
            "text-[color:var(--pill-text)]",
            "bg-[color:var(--pill-bg)]",
            "hover:bg-[color:var(--pill-accent)]",
            "hover:text-[color:var(--pill-on-accent)]",
          ])
            assert.ok(pill.includes(cls), cls);
        }
      }
  }
);

// ---------------------------------------------------------------------------
// Mit eingehängter Seite
// ---------------------------------------------------------------------------

test(
  "Punkt 2: Inline-Panel der Vorschau zeigt die Beispiel-Nutzernachricht und Pillen wie Folgefragen",
  { skip },
  async (t) => {
    const mounted = await renderer.mount(PREVIEW, {
      location: "/",
      props: {
        config: { displayMode: "inline", defaultMessages: ["Kurse?"] },
        logoPreview: null,
        defaults: DEFAULTS,
        greetingKey: "greeting",
      },
    });
    t.after(() => mounted.unmount());
    const { container, act } = mounted;
    const bar = elements(
      container,
      (el) => el.getAttribute("data-preview") === "inline-bar"
    )[0];
    // eingeklappt: Pillen unter der Leiste
    assert.equal(
      elements(bar, (el) => el.getAttribute("data-preview") === "pill").length,
      1
    );
    await act(() => click(elements(bar, (el) => el.tagName === "BUTTON")[0]));
    const panel = elements(
      container,
      (el) => el.getAttribute("data-preview") === "inline-panel"
    )[0];
    const message = elements(
      panel,
      (el) => el.getAttribute("data-preview") === "user-message"
    )[0];
    assert.ok(message, "Nutzer-Nachricht im Panel");
    assert.ok(panel.textContent.includes("Beispiel-Nutzernachricht"));
    assert.equal(
      elements(panel, (el) => el.getAttribute("data-preview") === "pill")
        .length,
      1
    );
  }
);

const widget = (id, visualConfig) => ({
  id,
  uuid: `uuid-${id}`,
  enabled: true,
  chat_mode: "query",
  allowlist_domains: null,
  chat_retention_days: null,
  visual_config: visualConfig === null ? null : JSON.stringify(visualConfig),
  createdAt: "2026-10-01T08:00:00.000Z",
  workspace: { id: 100 + id, name: `Workspace ${id}`, slug: `ws-${id}` },
  _count: { embed_chats: 0 },
});

async function open(t, embeds, id) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, body });
    let answer = {};
    if (url.endsWith("/embeds")) answer = { embeds };
    else if (url.includes("/embed/defaults"))
      answer = { lang: "de", defaults: DEFAULTS };
    else if (url.includes("/embed/update/"))
      answer = { success: true, error: null };
    return { ok: true, status: 200, json: async () => answer };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const mounted = await renderer.mount(DESIGN_CENTER, {
    location: `/settings/embed-config/${id}/appearance`,
    route: "/settings/embed-config/:embedId/appearance",
  });
  t.after(() => mounted.unmount());
  await mounted.act();
  return { ...mounted, calls };
}
const buttons = (container, label) =>
  elements(
    container,
    (el) => el.tagName === "BUTTON" && el.textContent.trim() === label
  );
const savedBody = (calls) => {
  const call = calls.find((c) => c.url.includes("/embed/update/"));
  return call ? JSON.parse(call.body.visual_config) : null;
};
const pressed = (container, label) =>
  buttons(container, label)[0].getAttribute("aria-pressed");

test(
  "Punkt 1 und 2: nach dem Laden gespeicherter Werte sind Chat-Icon und Schrift markiert",
  { skip },
  async (t) => {
    const { container } = await open(
      t,
      [widget(3, { chatIcon: "search2", userTextColor: "#000000" })],
      3
    );
    const icon = elements(
      container,
      (el) => el.tagName === "BUTTON" && el.getAttribute("title") === "Fernglas"
    )[0];
    assert.equal(icon.getAttribute("aria-pressed"), "true");
    assert.match(icon.getAttribute("class"), /border-primary-button/);
    // früheres reines Schwarz gilt als Schwarz (#222628, E1), ohne
    // ungespeicherte Änderung
    assert.equal(pressed(container, "Schwarz"), "true");
    assert.equal(pressed(container, "Weiß"), "false");
  }
);

test(
  "D6: neues Widget: Empfehlung sichtbar, aber nicht gespeichert; erst die Wahl speichert",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(9, null)], 9);
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    assert.equal(pressed(container, "Schwarz"), "true");
    assert.ok(container.textContent.includes("Empfohlen: Schwarz"));
    // Kundenfarbe ändern: Empfehlung folgt, gespeichert wird nur die Farbe
    const color = elements(
      container,
      (el) => el.getAttribute("aria-label") === "Kundenfarbe als Farbcode"
    )[0];
    await act(() =>
      handlersOf(color).onChange({ target: { value: "#003366" } })
    );
    assert.equal(pressed(container, "Weiß"), "true");
    assert.ok(container.textContent.includes("Empfohlen: Weiß"));
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), { accentColor: "#003366" });

    // bewusste Wahl wird gespeichert
    calls.length = 0;
    await act(() => click(buttons(container, "Schwarz")[0]));
    assert.ok(container.textContent.includes("Kontrast nur 1,2:1"));
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), {
      accentColor: "#003366",
      userTextColor: BLACK,
    });
  }
);

// ---------------------------------------------------------------------------
// Entscheidung E1 (Fixliste 7.22-rc7, Review 7.22-rc6 F01, Browser B-01):
// „Schwarz“ bleibt #222628; Empfehlung, Markierung und Warnung rechnen mit
// der gezeigten Farbe; ein gespeichertes #000000 wird nicht umgeschrieben;
// ein Klick auf die schon wirksame Option erzeugt keine Änderung.
// ---------------------------------------------------------------------------

test("E1: Empfehlung mit der gezeigten Farbe #222628 gerechnet, Warnung passt zur Empfehlung", () => {
  assert.equal(contrast.SHOWN_BLACK, BLACK);
  // Beispiele aus dem Review: Mit #000000 gerechnet wäre jeweils Schwarz
  // empfohlen worden, gezeigt hätte es nur 3,8:1 bzw. 3,3:1 erreicht
  for (const accent of ["#808080", "#767676", "#E91E63"])
    assert.equal(contrast.recommendedTextColor(accent), WHITE, accent);
  assert.equal(contrast.recommendedTextColor("#3A9D23"), BLACK);
  // die Empfehlung hat nie weniger Kontrast als die andere gezeigte Option
  for (let v = 0; v < 256; v += 3)
    for (const hex of [
      `#${v.toString(16).padStart(2, "0").repeat(3)}`,
      `#${v.toString(16).padStart(2, "0")}9d23`,
      `#e9${v.toString(16).padStart(2, "0")}63`,
    ]) {
      const chosen = contrast.recommendedTextColor(hex);
      const other = chosen === WHITE ? BLACK : WHITE;
      assert.ok(ratio(hex, chosen) >= ratio(hex, other), hex);
    }
  // #767676: Weiß erreicht 4,5:1, also keine Warnung bei der Empfehlung
  const medium = keys.userTextColorAdvice({ accentColor: "#767676" });
  assert.equal(medium.recommendedLabel, "Weiß");
  assert.equal(medium.warning, null);
  // Pillen mischen weiter Richtung reinem Schwarz bzw. Weiß (Farben wie
  // in rc6 gemessen: Türkis auf Weiß #018487)
  assert.equal(contrast.accessibleTextColor("#01A5A9", [WHITE]), "#018487");
  assert.equal(
    contrast.accessibleTextColor("#01A5A9", ["#1d1d21", "#131316"]),
    "#01A5A9"
  );
});

test("E1: früher gespeichertes #000000 gilt als Schwarz (#222628) und bleibt gespeichert", () => {
  const legacy = { accentColor: "#808080", userTextColor: PURE_BLACK };
  assert.equal(keys.storedUserTextColor(legacy), BLACK);
  assert.equal(keys.userTextColor(legacy), BLACK);
  assert.equal(keys.userTextColorChoice(legacy), BLACK);
  assert.equal(
    keys.userTextColorAdvice(legacy).warning,
    "Kontrast nur 3,8:1: Unter 4,5:1 ist die Schrift auf der Kundenfarbe schwer lesbar."
  );
  assert.equal(keys.userTextColorChoice({ userTextColor: " #000000 " }), BLACK);
  // Speichern lässt den Wert stehen
  assert.deepEqual(
    keys.cleanConfig({ ...legacy, accentColor: "#112233" }, { initial: legacy })
      .userTextColor,
    PURE_BLACK
  );
});

test("E1: Klick auf die schon wirksame Option ändert den Bearbeitungsstand nicht", () => {
  // ohne gespeicherten Wert: Empfehlung (Türkis -> Schwarz)
  assert.deepEqual(keys.withUserTextColor({}, {}, BLACK), {});
  assert.deepEqual(keys.withUserTextColor({}, {}, WHITE), {
    userTextColor: WHITE,
  });
  // gewählt und wieder zurück auf die Empfehlung: Schlüssel entfällt
  assert.deepEqual(
    keys.withUserTextColor({ userTextColor: WHITE }, {}, BLACK),
    {}
  );
  // Kundenfarbe geändert, die Empfehlung ist jetzt Weiß: Schwarz muss
  // gespeichert werden, Weiß folgt der Empfehlung
  assert.deepEqual(
    keys.withUserTextColor({ accentColor: "#003366" }, {}, BLACK),
    { accentColor: "#003366", userTextColor: BLACK }
  );
  assert.deepEqual(
    keys.withUserTextColor({ accentColor: "#003366" }, {}, WHITE),
    { accentColor: "#003366" }
  );
  // gespeichertes #000000: Schwarz ist schon wirksam, bleibt #000000
  const legacy = { userTextColor: PURE_BLACK };
  assert.deepEqual(keys.withUserTextColor(legacy, legacy, BLACK), legacy);
  assert.deepEqual(
    keys.withUserTextColor({ userTextColor: WHITE }, legacy, BLACK),
    legacy
  );
  assert.deepEqual(keys.withUserTextColor(legacy, legacy, WHITE), {
    userTextColor: WHITE,
  });
});

test(
  "E1 (Browser B-01): Altwidget mit #000000 speichert eine neue Kundenfarbe, ohne die Schrift umzuschreiben",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(
      t,
      [widget(4, { accentColor: "#01A5A9", userTextColor: PURE_BLACK })],
      4
    );
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    assert.equal(pressed(container, "Schwarz"), "true");
    // Klick auf das schon markierte Schwarz: keine Speicherleiste
    await act(() => click(buttons(container, "Schwarz")[0]));
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    const color = elements(
      container,
      (el) => el.getAttribute("aria-label") === "Kundenfarbe als Farbcode"
    )[0];
    await act(() =>
      handlersOf(color).onChange({ target: { value: "#112233" } })
    );
    // Warnung mit der gezeigten Farbe (#222628 auf #112233)
    assert.ok(container.textContent.includes("Kontrast nur 1,0:1"));
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), {
      accentColor: "#112233",
      userTextColor: PURE_BLACK,
    });
  }
);

test(
  "E1 (Opus DC-3): neues Widget, Klick auf das empfohlene Schwarz erzeugt keine ungespeicherte Änderung",
  { skip },
  async (t) => {
    const { container, act } = await open(t, [widget(5, null)], 5);
    assert.equal(pressed(container, "Schwarz"), "true");
    await act(() => click(buttons(container, "Schwarz")[0]));
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => click(buttons(container, "Weiß")[0]));
    assert.ok(container.textContent.includes("Ungespeicherte Änderungen"));
    await act(() => click(buttons(container, "Schwarz")[0]));
    assert.ok(!container.textContent.includes("Ungespeicherte Änderungen"));
  }
);

test(
  "F06 (Review 7.22-rc6): durchscheinende Kundenfarbe zeigt einen Fehler und wird nicht gespeichert",
  { skip },
  async (t) => {
    const { container, act, calls } = await open(t, [widget(6, null)], 6);
    const color = elements(
      container,
      (el) => el.getAttribute("aria-label") === "Kundenfarbe als Farbcode"
    )[0];
    await act(() =>
      handlersOf(color).onChange({ target: { value: "rgba(0,0,0,0.15)" } })
    );
    assert.ok(
      container.textContent.includes(
        "Bitte eine deckende Farbe ohne Transparenz angeben."
      )
    );
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.equal(savedBody(calls), null);
    await act(() =>
      handlersOf(color).onChange({ target: { value: "#808080" } })
    );
    await act(() => click(buttons(container, "Speichern")[0]));
    assert.deepEqual(savedBody(calls), { accentColor: "#808080" });
  }
);
