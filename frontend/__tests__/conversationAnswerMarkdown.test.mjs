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
//
// Links wie im Widget (Fixliste 7.22-rc22, E40, K130 und K131): Für die
// Links läuft hier zusätzlich hardenAnswerHtml (target und rel an jedem
// <a>, Bilder ohne Abruf) über das HTML des Verlaufs, in einem Dokument
// ohne Browser (helpers/testDom.mjs; das HTML von markdown-it liest
// htmlToDom). Verglichen werden Adresse, Linktext, target und rel jedes
// Links mit dem Widget (link_open in src/utils/chat/markdown.js). Was
// DOMPurify danach an Adressen verwirft (kurs-link:, data: an einem Link),
// prüft der Browser-Test mit echtem DOMPurify (Antwort E40 und
// checkSecondSafety).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hardenAnswerHtml } from "../src/utils/conversationView.js";
import { createDocument, elements } from "./helpers/testDom.mjs";

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

// Fixliste 7.22-rc22, E40 (K131): Links wie im Widget. [Fall, Antwort,
// Links als [Adresse, Linktext], sichtbarer Text]. Jeder Link trägt im
// Verlauf wie im Widget target="_blank" und rel="noopener noreferrer";
// Linktext und Adresse bleiben, wie markdown-it sie erzeugt. Ungültige
// Ziele (validateLink) lässt markdown-it als Text stehen, eine nackte
// Adresse bleibt Text (linkify ist in beiden aus).
const SITE = "https://www.vhs-musterstadt.de";
const LINK_CASES = [
  ["[Kurs](https://…)", `Anmeldung über die [Kurs](${SITE}/kurs/4711).`, [[`${SITE}/kurs/4711`, "Kurs"]], "Anmeldung über die Kurs."],
  ["[](https://…)", `Leer: [](${SITE}/anmeldung) Ende`, [[`${SITE}/anmeldung`, ""]], "Leer: Ende"],
  ["[Kurs](/kurs/1)", "Siehe [Kurs](/kurs/1).", [["/kurs/1", "Kurs"]], "Siehe Kurs."],
  ["[Kurs](javascript:alert(1))", "Siehe [Kurs](javascript:alert(1)).", [], "Siehe [Kurs](javascript:alert(1))."],
  ["[Kurs](kurs-link:4711)", "Siehe [Kurs](kurs-link:4711).", [["kurs-link:4711", "Kurs"]], "Siehe Kurs."],
  ["<https://…>", `Siehe <${SITE}/kurs>.`, [[`${SITE}/kurs`, `${SITE}/kurs`]], `Siehe ${SITE}/kurs.`],
  ["nackte URL", `Mehr unter ${SITE}/kurs und www.vhs-musterstadt.de`, [], `Mehr unter ${SITE}/kurs und www.vhs-musterstadt.de`],
  // bis rc21 umgeschrieben, seit E40 wie im Widget (Bewusste Änderung E40)
  ["[Kursseite](#) (vorher K87, K102: Text)", "Zur [Kursseite](#).", [["#", "Kursseite"]], "Zur Kursseite."],
  ["[](#) (vorher K102: Text)", "Leer: [](#) Ende", [["#", ""]], "Leer: Ende"],
  ["[Text](<>) (vorher K61: Text)", "Siehe [Text ohne Adresse](<>).", [["", "Text ohne Adresse"]], "Siehe Text ohne Adresse."],
  ["[Kursseite](URL) (vorher K87, E37: Text mit Adresse)", "[Kursseite](URL)", [["URL", "Kursseite"]], "Kursseite"],
  ["[Kursseite](/kurs/123) (vorher K102, E37: „Kursseite (/kurs/123)“)", "[Kursseite](/kurs/123)", [["/kurs/123", "Kursseite"]], "Kursseite"],
  ["Linktext nur U+3164 (vorher K89, B70: die Adresse)", `Siehe [\u3164](${SITE}/k89).`, [[`${SITE}/k89`, "\u3164"]], "Siehe \u3164."],
  ["Linktext nur U+200B (vorher K61: die Adresse)", `Siehe [\u200b](${SITE}/k61).`, [[`${SITE}/k61`, "\u200b"]], "Siehe \u200b."],
  ["https:/ ohne // (vorher K104: Text mit Adresse)", "[Anmeldung](https:/www.vhs-musterstadt.de/anmeldung)", [["https:/www.vhs-musterstadt.de/anmeldung", "Anmeldung"]], "Anmeldung"],
  ["Adresse mit Umlaut ohne Linktext (K85)", "[](https://vhs.de/kurs/töpfern)", [["https://vhs.de/kurs/t%C3%B6pfern", ""]], ""],
  ["Adresse mit & und Titel", '[Kurs](https://vhs.de/a?b=1&c=2 "Titel")', [["https://vhs.de/a?b=1&c=2", "Kurs"]], "Kurs"],
];
// Ziele, die kein Link werden dürfen: markdown-it (validateLink) lässt sie
// als Text stehen, im Verlauf wie im Widget. DOMPurify als zweite
// Sicherung: Browser-Test (checkSecondSafety).
const BLOCKED_LINKS = [
  ["javascript:", "[Kurs](javascript:alert(1))"],
  ["JavaScript: groß", "[Kurs](JavaScript:alert(1))"],
  ["javascript: als Entität", "[Kurs](&#106;avascript:alert(1))"],
  ["javascript: mit Leerraum davor", "[Kurs]( javascript:alert(1))"],
  ["javascript: in spitzen Klammern", "[Kurs](<javascript:alert(1)>)"],
  ["javascript: als Referenz", "[Kurs][ref]\n\n[ref]: javascript:alert(1)"],
  ["javascript: als Autolink", "<javascript:alert(1)>"],
  ["vbscript:", "[Kurs](vbscript:msgbox(1))"],
  ["data:text/html", "[Kurs](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
  ["file:", "[Kurs](file:///etc/passwd)"],
  ["Bild mit javascript:", "![Bild](javascript:alert(1))"],
  ["Bild mit file:", "![Bild](file:///etc/passwd)"],
];
// Adressen, die nie an einem Link stehen dürfen (auch mit Steuerzeichen
// oder Leerraum davor, die der Browser überspringt)
const BAD_SCHEME = /^[\x00-\x20]*(?:javascript|vbscript|data|file):/i;

let he = null;
let adminServer = null;
let renderAdmin = null;
let widgetServer = null;

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
// Elemente ohne schließendes Tag in der Ausgabe von markdown-it
const VOID_TAGS = new Set(["br", "hr", "img"]);
/**
 * Liest das HTML von markdown-it (Verlauf und Widget) in ein Dokument ohne
 * Browser (helpers/testDom.mjs): Tags mit Attributen in doppelten
 * Anführungszeichen, Entitäten in Text und Attributen. Kein allgemeiner
 * HTML-Parser; ein schließendes Tag ohne öffnendes lässt den Test
 * scheitern.
 * @param {object} doc - createDocument()
 * @param {string} html
 * @returns {object} - <body> mit dem Inhalt
 */
function htmlToDom(doc, html) {
  const root = doc.createElement("body");
  const stack = [root];
  const source = String(html).replace(/<!--[\s\S]*?-->/g, "");
  const addText = (text) => {
    if (text) stack.at(-1).appendChild(doc.createTextNode(he.decode(text)));
  };
  let last = 0;
  for (const match of source.matchAll(
    /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g
  )) {
    addText(source.slice(last, match.index));
    last = match.index + match[0].length;
    const [, closing, name, attributes] = match;
    const tag = name.toUpperCase();
    if (closing) {
      const open = stack.findLastIndex((element) => element.tagName === tag);
      assert.ok(open > 0, `</${name}> ohne öffnendes Tag`);
      stack.length = open;
      continue;
    }
    const element = stack.at(-1).appendChild(doc.createElement(name));
    for (const [, key, value = ""] of attributes.matchAll(
      /([\w:-]+)(?:="([^"]*)")?/g
    ))
      element.setAttribute(key, he.decode(value));
    if (!VOID_TAGS.has(name.toLowerCase())) stack.push(element);
  }
  addText(source.slice(last));
  return root;
}
/**
 * Links und sichtbarer Text eines HTML-Stücks, nach Wunsch zuvor wie im
 * Verlauf geordnet (hardenAnswerHtml; DOMPurify nur im Browser).
 * @param {string} html
 * @param {{harden?: boolean}} [options]
 */
function linksOf(html, { harden = false } = {}) {
  const doc = createDocument();
  const root = htmlToDom(doc, html);
  if (harden) hardenAnswerHtml(root, doc);
  return {
    links: elements(root, (e) => e.tagName === "A").map((a) => ({
      href: a.getAttribute("href"),
      text: a.textContent,
      target: a.getAttribute("target"),
      rel: a.getAttribute("rel"),
    })),
    images: elements(root, (e) => e.tagName === "IMG").length,
    text: root.textContent.replace(/\s+/g, " ").trim(),
  };
}
/** Der Verlauf: MarkdownRenderer, dann hardenAnswerHtml. */
const adminLinks = (content) => linksOf(renderAdmin(content), { harden: true });
/** renderMarkdown des Widgets (src/utils/chat/markdown.js, KUFER_EMBED_DIR). */
async function widgetMarkdown() {
  if (!widgetServer) {
    const { createServer } = await import("vite");
    widgetServer = await createServer({
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
  }
  return (await widgetServer.ssrLoadModule("/src/utils/chat/markdown.js"))
    .default;
}
// typographer: true nur im Widget (siehe oben): Anführungszeichen gleich
const straight = (text) =>
  text.replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'");
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
  await widgetServer?.close();
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
    const renderMarkdown = await widgetMarkdown();
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
  }
);

test(
  "rc22, K130, K131 (E40): Links im Verlauf wie im Widget (feste Fälle, Markdown und hardenAnswerHtml): Linktext und Adresse unverändert, auch [](https://…), [Kurs](/kurs/1), # und Adressen ohne //, keine Adresse als Text; jeder Link in neuem Tab mit rel=\"noopener noreferrer\"; [Kurs](javascript:alert(1)) und die nackte Adresse bleiben Text",
  { skip },
  () => {
    for (const [label, content, links, text] of LINK_CASES) {
      const shown = adminLinks(content);
      assert.deepEqual(
        shown.links,
        links.map(([href, linkText]) => ({
          href,
          text: linkText,
          target: "_blank",
          rel: "noopener noreferrer",
        })),
        label
      );
      assert.equal(shown.text, text, label);
      // Die Adresse steht nur als Text da, wo sie der Linktext ist
      // (<https://…>): Ein Begriff allein in der Adresse ergibt den Hinweis
      // „nur in Link-Adressen“ (Browser: SHOWS_HIT_CASES)
      for (const link of shown.links)
        if (link.href && link.text !== link.href)
          assert.ok(!shown.text.includes(link.href), `${label}: Adresse sichtbar`);
    }
  }
);

test(
  "rc22, K131 (E40): javascript:, vbscript:, data: und file: werden kein Link (markdown-it validateLink, auch groß, als Entität, mit Leerraum, in spitzen Klammern, als Referenz und als Autolink) und kein Bild: kein <a>, kein <img>, der Text bleibt; DOMPurify als zweite Sicherung prüft der Browser-Test",
  { skip },
  () => {
    for (const [label, content] of BLOCKED_LINKS) {
      const shown = adminLinks(content);
      assert.deepEqual(shown.links, [], label);
      assert.equal(shown.images, 0, label);
      assert.ok(shown.text.length > 0, `${label}: Text bleibt`);
    }
    // Kein Link aus irgendeinem Fall trägt eine solche Adresse
    for (const [label, content] of [...LINK_CASES, ...BLOCKED_LINKS])
      for (const link of adminLinks(content).links)
        assert.doesNotMatch(link.href ?? "", BAD_SCHEME, label);
  }
);

test(
  "rc22, K131 (E40): Gleichlauf mit dem Widget für Links: dieselben Eingaben ergeben im Verlauf dieselben Links (Adresse, Linktext, target, rel) und denselben sichtbaren Text wie im Widget (src/utils/chat/markdown.js aus KUFER_EMBED_DIR), auch für die gesperrten Ziele",
  { skip: widgetSkip },
  async () => {
    const renderMarkdown = await widgetMarkdown();
    for (const [label, content] of [...LINK_CASES, ...BLOCKED_LINKS]) {
      const admin = adminLinks(content);
      const widget = linksOf(renderMarkdown(content));
      assert.deepEqual(admin.links, widget.links, label);
      assert.equal(admin.text, straight(widget.text), label);
      assert.equal(widget.images, 0, label);
    }
    // Gegenprobe: Die festen Erwartungen oben sind die des Widgets
    for (const [label, content, links] of LINK_CASES)
      assert.deepEqual(
        linksOf(renderMarkdown(content)).links.map((l) => [l.href, l.text]),
        links,
        label
      );
  }
);
