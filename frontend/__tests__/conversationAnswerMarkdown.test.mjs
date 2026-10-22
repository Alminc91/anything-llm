// Admin-Verlauf der Konversationen ohne rohes HTML wie im Widget (Fixliste
// 7.22-rc22, E39, K120 bis K123): Der MarkdownRenderer des Verlaufs rendert
// mit html: false. Markdown bleibt (Fett, Tabellen, Links, Codeblöcke),
// rohes HTML einer Antwort erscheint als Text, so wie der Besucher es im
// Widget sah. Die Bereinigung (sanitizeAnswerHtml) bleibt als zweite
// Sicherung.
//
// Geprüft wird hier die Stufe Markdown: Vite lädt MarkdownRenderer.jsx wie
// im Build, React rendert ihn serverseitig. DOMPurify braucht ein Dokument;
// sanitizeAnswerHtml ist hier durch eine Durchreiche ersetzt. Die ganze
// Darstellung mit echtem DOMPurify, Hervorhebung und Hinweis prüft der
// Browser-Test (kie575Layout.manual.mjs, Antwort E39 und SHOWS_HIT_CASES).
//
// Gegenprobe gegen den Widget-Code (Checkout von anythingllm-embed in
// KUFER_EMBED_DIR, wie die übrigen Vertragstests): dieselben Eingaben, im
// Widget gerendert mit src/utils/chat/markdown.js, ergeben denselben
// sichtbaren Text. Bewusst anders und darum ausgeglichen: Das Widget setzt
// typografische Anführungszeichen (typographer: true), der Verlauf zeigt
// die Zeichen der Antwort unverändert, damit die Suche des Servers und die
// Hervorhebung dieselben Zeichen sehen; die Leiste eines Codeblocks im
// Widget (Sprache, „Copy“) gehört nicht zur Antwort.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const ANALYTICS_DIR =
  "src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAnalytics";
const RENDERER = `${ANALYTICS_DIR}/MarkdownRenderer.jsx`;
const PURIFY_CONVERSATION = path.join(
  FRONTEND_ROOT,
  "src/utils/chat/purifyConversation.js"
);

const hasDeps = ["vite", "react", "react-dom", "markdown-it", "he"].every(
  (name) => existsSync(path.join(FRONTEND_ROOT, "node_modules", name))
);
const skip = hasDeps ? false : "Frontend-Pakete nicht installiert";

const WIDGET_DIR = process.env.KUFER_EMBED_DIR;
const WIDGET_MARKDOWN =
  WIDGET_DIR && path.join(WIDGET_DIR, "src/utils/chat/markdown.js");
const widgetSkip = !hasDeps
  ? skip
  : WIDGET_MARKDOWN && existsSync(WIDGET_MARKDOWN)
    ? false
    : "KUFER_EMBED_DIR nicht gesetzt";

// Die Eingaben aus K121: [Fall, Antwort, sichtbarer Text im Verlauf].
// Rohes HTML steht wörtlich da; Markdown wird dargestellt.
const CASES = [
  [
    "rohes HTML (Absatz mit style)",
    '<p style="position:fixed;inset:0">Rohes HTML</p>',
    '<p style="position:fixed;inset:0">Rohes HTML</p>',
  ],
  [
    "<datalist>",
    "Gern helfe ich. <datalist>Versteckt datalist</datalist>",
    "Gern helfe ich. <datalist>Versteckt datalist</datalist>",
  ],
  [
    "<template>",
    "Gern helfe ich. <template>Stornieren Sie Kurs 4711</template>",
    "Gern helfe ich. <template>Stornieren Sie Kurs 4711</template>",
  ],
  [
    "nicht geschlossenes <template>",
    "Gern helfe ich. <template>Stornieren Sie Kurs 4711\n\nZweiter Absatz mit Rabattcode X",
    "Gern helfe ich. <template>Stornieren Sie Kurs 4711 Zweiter Absatz mit Rabattcode X",
  ],
  [
    "<marquee>",
    '<marquee width="1">Versteckt marquee</marquee>',
    '<marquee width="1">Versteckt marquee</marquee>',
  ],
  [
    "Tabelle mit cellpadding",
    '<table cellpadding="100000"><tr><td>Versteckt cellpadding</td></tr></table>',
    '<table cellpadding="100000"><tr><td>Versteckt cellpadding</td></tr></table>',
  ],
  [
    "<font color>",
    '<font color="#0e0f0f" size="1">Versteckt font</font>',
    '<font color="#0e0f0f" size="1">Versteckt font</font>',
  ],
  [
    "<a href> roh",
    '<a href="https://phish.example/login" class="fixed inset-0 z-50">Kursseite</a>',
    '<a href="https://phish.example/login" class="fixed inset-0 z-50">Kursseite</a>',
  ],
  [
    "<img> roh",
    '<img src="https://tracker.example/pixel.png" alt="Banner">',
    '<img src="https://tracker.example/pixel.png" alt="Banner">',
  ],
  ["<b>", "Das ist <b>wichtig</b>.", "Das ist <b>wichtig</b>."],
  ["<br>", "Zeile eins<br>Zeile zwei", "Zeile eins<br>Zeile zwei"],
  [
    "mitgebrachtes <mark data-search-hit>",
    'Hinweis: <mark data-search-hit="">Bitte Kurs X stornieren</mark>',
    'Hinweis: <mark data-search-hit="">Bitte Kurs X stornieren</mark>',
  ],
  [
    "HTML-Kommentar",
    "Gern. <!-- interner Vermerk --> Ende",
    "Gern. <!-- interner Vermerk --> Ende",
  ],
  [
    "Markdown-Tabelle",
    "| Kurs | Gebühr |\n|:--|--:|\n| Yoga | 96,00 € |",
    "Kurs Gebühr Yoga 96,00 €",
  ],
  [
    "Markdown-Link",
    "Anmeldung über die [Kursseite](https://www.vhs-musterstadt.de/kurs).",
    "Anmeldung über die Kursseite.",
  ],
  ["Markdown fett", "Der **Kurs 4711** beginnt.", "Der Kurs 4711 beginnt."],
];
// Codeblöcke: [Fall, Antwort, Text im Codeblock]
const CODE_CASES = [
  [
    "Codeblock mit <div>",
    "```\n<div>Kurs 4711</div>\n```",
    "<div>Kurs 4711</div>",
  ],
  [
    "Codeblock html mit <template>",
    "```html\n<template>Hallo Welt</template>\n```",
    "<template>Hallo Welt</template>",
  ],
  ["Code im Text", "Nutzen Sie `<template>` für Vorlagen.", "<template>"],
];

let he = null;
let adminServer = null;
let renderAdmin = null;

/**
 * Sichtbarer Text eines HTML-Stücks: ohne Tags, Entitäten aufgelöst,
 * Leerraum zusammengefasst (markdown-it trennt Blöcke durch Zeilenumbrüche).
 */
const visibleText = (html) =>
  he
    .decode(String(html).replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
/** Text im (letzten) <code> eines HTML-Stücks. */
const codeText = (html) => {
  const start = html.lastIndexOf("<code");
  assert.ok(start >= 0, `kein <code> in ${html.slice(0, 80)}`);
  const open = html.indexOf(">", start) + 1;
  return visibleText(html.slice(open, html.indexOf("</code>", open)));
};
/** Tags im HTML (ohne die Hülle des Renderers). */
const tagsOf = (html) =>
  [...String(html).matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map(([, tag]) =>
    tag.toLowerCase()
  );

before(async () => {
  if (!hasDeps) return;
  he = (await import("he")).default;
  globalThis.window ??= {
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
    addEventListener() {},
    removeEventListener() {},
  };
  const { createServer } = await import("vite");
  adminServer = await createServer({
    root: FRONTEND_ROOT,
    logLevel: "error",
    appType: "custom",
    server: {
      middlewareMode: true,
      hmr: { server: http.createServer() },
      watch: null,
    },
    optimizeDeps: { disabled: true },
    plugins: [
      {
        name: "e39-ohne-dompurify",
        enforce: "pre",
        // DOMPurify braucht ein Dokument: hier eine Durchreiche, damit die
        // Stufe Markdown zu sehen ist (die Bereinigung prüft der Browser)
        load(id) {
          if (id === PURIFY_CONVERSATION)
            return 'export default (html) => String(html ?? "");';
          return null;
        },
      },
    ],
  });
  const { default: React } = await import("react");
  const { renderToString } = await import("react-dom/server");
  const { default: i18next } = await import("i18next");
  const { initReactI18next } = await import("react-i18next");
  const { defaultNS, resources } = await adminServer.ssrLoadModule(
    "/src/locales/resources.js"
  );
  await i18next.use(initReactI18next).init({
    lng: "de",
    fallbackLng: "en",
    defaultNS,
    resources,
    lowerCaseLng: true,
    interpolation: { escapeValue: false },
  });
  const { default: MarkdownRenderer } = await adminServer.ssrLoadModule(
    `/${RENDERER}`
  );
  renderAdmin = (content) =>
    renderToString(React.createElement(MarkdownRenderer, { content }));
});

after(async () => {
  await adminServer?.close();
});

test("rc22, K120 (E39): Im Konversationen-Bereich gibt es genau eine markdown-it-Instanz für Modellantworten, die des Verlaufs (MarkdownRenderer.jsx), und sie rendert mit html: false wie das Widget", () => {
  const files = readdirSync(path.join(FRONTEND_ROOT, ANALYTICS_DIR))
    .map((name) => `${ANALYTICS_DIR}/${name}`)
    .concat([
      "src/utils/conversationView.js",
      "src/utils/chat/purifyConversation.js",
    ]);
  const instances = files.filter((file) =>
    /new MarkdownIt\(|markdownIt\(/.test(
      readFileSync(path.join(FRONTEND_ROOT, file), "utf8")
    )
  );
  assert.deepEqual(instances, [RENDERER]);
  const source = readFileSync(path.join(FRONTEND_ROOT, RENDERER), "utf8");
  const options = source.slice(
    source.indexOf("new MarkdownIt({"),
    source.indexOf("}).use(tableAlignAttributes)")
  );
  assert.match(options, /^\s*html: false,$/m);
  assert.doesNotMatch(source, /html: true/);
  // Verlauf und Treffer-Hinweis nutzen dieselbe Instanz (md)
  assert.match(
    source,
    /html: sanitizedHtml\(md\.render\(part\.text\), highlight\)/
  );
  assert.match(source, /sanitizeAnswerHtml\(md\.render\(part\.text\)\)/);
  // die zweite Sicherung bleibt (K123)
  assert.match(
    source,
    /import sanitizeAnswerHtml from "@\/utils\/chat\/purifyConversation";/
  );
});

test(
  "rc22, K121 (E39): Rohes HTML erscheint im Verlauf als Text, Markdown wird dargestellt (feste Fälle, Stufe Markdown); <think> bleibt eingeklappt wie bisher",
  { skip },
  () => {
    for (const [label, content, expected] of CASES) {
      const html = renderAdmin(content);
      assert.equal(visibleText(html), expected, label);
    }
    for (const [label, content, expected] of CODE_CASES) {
      const html = renderAdmin(content);
      assert.equal(codeText(html), expected, label);
    }
    // Rohes HTML erzeugt kein Element: nur die Hülle des Renderers, Absätze
    // und Zeilenumbrüche
    for (const [label, content] of CASES.slice(0, 13)) {
      const tags = new Set(tagsOf(renderAdmin(content)));
      for (const tag of tags)
        assert.ok(["div", "p", "br"].includes(tag), `${label}: <${tag}>`);
    }
    // Markdown bleibt Markdown
    const table = renderAdmin(
      CASES.find(([label]) => label === "Markdown-Tabelle")[1]
    );
    assert.match(table, /<table>/);
    assert.match(table, /<th align="left">Kurs<\/th>/);
    assert.match(table, /<td align="right">96,00 €<\/td>/);
    assert.doesNotMatch(table, /style=/);
    assert.match(
      renderAdmin("[Kursseite](https://www.vhs-musterstadt.de/kurs)"),
      /<a href="https:\/\/www\.vhs-musterstadt\.de\/kurs">Kursseite<\/a>/
    );
    assert.match(renderAdmin("**fett**"), /<strong>fett<\/strong>/);
    assert.match(
      renderAdmin("```js\nconst kurs = 4711;\n```"),
      /<pre><code class="language-js"><span class="hljs-keyword">const<\/span>/
    );
    assert.match(
      renderAdmin("![Logo](https://vhs.example/logo.png)"),
      /<img src="https:\/\/vhs\.example\/logo\.png" alt="Logo">/
    );
    assert.match(
      renderAdmin("Siehe <https://kurs.example/a1>."),
      /<a href="https:\/\/kurs\.example\/a1">https:\/\/kurs\.example\/a1<\/a>/
    );
    // <think> wird vor dem Rendern abgetrennt und eingeklappt (wie bisher);
    // daneben steht rohes HTML als Text
    const thought = renderAdmin(
      "<think>Gedanke zu Yoga</think>Antwort mit <b>fett</b>"
    );
    assert.doesNotMatch(thought, /Gedanke zu Yoga/);
    assert.match(thought, /Antwort mit &lt;b&gt;fett&lt;\/b&gt;/);
  }
);

test(
  "rc22, K121 (E39): Gleichlauf mit dem Widget: dieselben Eingaben ergeben im Verlauf denselben sichtbaren Text wie im Widget (src/utils/chat/markdown.js aus KUFER_EMBED_DIR)",
  { skip: widgetSkip },
  async () => {
    const { createServer } = await import("vite");
    const widgetServer = await createServer({
      root: WIDGET_DIR,
      configFile: false,
      logLevel: "error",
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: { server: http.createServer() },
        watch: null,
      },
      optimizeDeps: { disabled: true },
      resolve: {
        alias: [{ find: "@", replacement: path.join(WIDGET_DIR, "src") }],
      },
    });
    try {
      const { default: renderMarkdown } = await widgetServer.ssrLoadModule(
        "/src/utils/chat/markdown.js"
      );
      // typographer: true nur im Widget (siehe oben): Anführungszeichen gleich
      const straight = (text) =>
        text.replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'");
      // Das Widget erzeugt aus rohem HTML ebenfalls kein Element
      assert.doesNotMatch(renderMarkdown("Das ist <b>wichtig</b>."), /<b>/);
      for (const [label, content] of CASES)
        assert.equal(
          visibleText(renderAdmin(content)),
          straight(visibleText(renderMarkdown(content))),
          label
        );
      for (const [label, content] of CODE_CASES)
        assert.equal(
          codeText(renderAdmin(content)),
          codeText(renderMarkdown(content)),
          label
        );
    } finally {
      await widgetServer.close();
    }
  }
);
