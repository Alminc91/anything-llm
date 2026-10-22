// Korrekturrunde 7.22-rc20 (Fixliste fixliste-7.22-rc20.md, Abschnitt
// „F · Fork“; Problem und Abhilfe je Punkt im Bericht
// review-7.22-nachreview-rc19.md):
// F80 (E32) Der Dialog „Einbettungscode“ in der Widget-Liste zeigt bei
//     „In der Seite“ denselben Warnblock wie der Reiter Einbau (eine
//     gemeinsame Komponente), beim Chatfenster nicht.
// F81 Das Warndreieck vor der Überschrift ist für Screenreader ein Bild mit
//     dem Namen „Warnung“ bzw. „Warning“.
// F82 (E35) Warndreieck hell in red-700, mindestens 4,5:1 auf der Fläche des
//     Blocks; dunkel unverändert.
// F83 Migrationsdoku: feste Farben der Datenschutz-Blase (E25).
// F84 Migrationsdoku: Prüfpunkt zu gespeicherten Datenschutz-Texten mit dem
//     alten Standardpunkt (E30).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";

const EMBED_TAB =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/EmbedTab.jsx";
const DIALOG =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedConfigs/EmbedRow/CodeSnippetModal/index.jsx";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const LOCALES = path.join(ROOT, "frontend/src/locales");
const MIGRATION = path.join(ROOT, "docs", "design-center-2-migration.md");
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const PLACEHOLDER = '<div id="kufer-assistent"></div>';
const TITLE = "Platzhalter nicht in verlinkte Bereiche setzen";
const DIALOG_LABEL = "Optional: Darstellung „In der Seite“";

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const decode = (html) =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

const text = (html) =>
  decode(html.replace(/<wbr\/?>/g, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

// HTML des Elements mit data-testid (bis zum schließenden Tag gleicher Art)
function byTestId(html, id) {
  const open = new RegExp(`<(\\w+)[^>]*data-testid="${id}"[^>]*>`).exec(html);
  if (!open) return null;
  const tag = open[1];
  const tags = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "g");
  tags.lastIndex = open.index;
  let depth = 0;
  for (let m; (m = tags.exec(html)); ) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open.index, tags.lastIndex);
  }
  throw new Error(`${id}: kein schließendes </${tag}>`);
}

// Attribute eines öffnenden Tags als Objekt
function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])])
  );
}

const renderTab = (config) =>
  renderer.render(EMBED_TAB, {
    location: "/",
    props: { config, embed: { uuid: "abc-123" } },
  });

// Dialog „Einbettungscode“ mit der gespeicherten visual_config des Widgets
// (wie GET /embeds sie liefert: Text oder null)
const renderDialog = (visualConfig) =>
  renderer.render(DIALOG, {
    location: "/",
    props: {
      embed: { uuid: "abc-123", visual_config: visualConfig },
      closeModal: () => {},
    },
  });

// Inhalt des ersten Buttons nach einer Stelle (der kopierbare Schnipsel;
// hljs zerlegt ihn in Spans, deshalb Tags ohne Leerraum entfernen)
function buttonAfter(html, index) {
  const start = html.indexOf("<button", index);
  assert.ok(start > 0, "kein Button nach der Stelle");
  const end = html.indexOf("</button>", start);
  const code = decode(html.slice(start, end).replace(/<[^>]+>/g, "")).trim();
  return { start, text: code };
}

async function withLanguage(lang, run) {
  const { default: i18next } = await import("i18next");
  await i18next.changeLanguage(lang);
  try {
    return await run();
  } finally {
    await i18next.changeLanguage("de");
  }
}

// ---------------------------------------------------------------------------
// F80 (E32) Dialog „Einbettungscode“
// ---------------------------------------------------------------------------

test(
  "F80: Dialog zeigt den Warnblock genau bei „In der Seite“, der Platzhalter bleibt in jeder Darstellung",
  { skip },
  async () => {
    const cases = [
      [JSON.stringify({ displayMode: "inline" }), true],
      // dieselbe Lesart wie das Design Center (widgetKeys.js displayMode)
      [JSON.stringify({ displayMode: " Inline " }), true],
      [JSON.stringify({ displayMode: "bubble" }), false],
      [JSON.stringify({ theme: "dark" }), false],
      ["{}", false],
      [null, false],
      [undefined, false],
      ["", false],
      ["{kaputt", false],
      ["null", false],
      ["[]", false],
      ['"inline"', false],
    ];
    for (const [visualConfig, inline] of cases) {
      const html = await renderDialog(visualConfig);
      const label = String(visualConfig);
      const blocks = html.split('data-testid="inline-link-warning"').length - 1;
      assert.equal(blocks, inline ? 1 : 0, label);
      assert.equal(text(html).includes(TITLE), inline, label);
      // der Platzhalter-Teil des Dialogs bleibt wie bisher
      const at = html.indexOf(DIALOG_LABEL);
      assert.ok(at > 0, `${label}: Platzhalter-Teil fehlt`);
      assert.equal(buttonAfter(html, at).text, PLACEHOLDER, label);
    }
  }
);

test(
  "F80: im Dialog dieselbe Komponente wie im Reiter Einbau, zwischen Hinweis und Platzhalter-Schnipsel",
  { skip },
  async () => {
    const config = { displayMode: "inline" };
    const dialog = await renderDialog(JSON.stringify(config));
    const block = byTestId(dialog, "inline-link-warning");
    assert.ok(block, "Warnblock fehlt im Dialog");
    // dasselbe Markup wie im Reiter Einbau (InlineLinkWarning)
    const tabBlock = byTestId(await renderTab(config), "inline-link-warning");
    assert.equal(block, tabBlock);
    // Reihenfolge: Platzhalter-Teil mit Hinweis, Warnung, Schnipsel
    const label = dialog.indexOf(DIALOG_LABEL);
    const warning = dialog.indexOf(block);
    const hint = dialog.indexOf("wo die Eingabeleiste erscheinen soll", label);
    assert.ok(label > 0 && hint > label, "Hinweis fehlt");
    assert.ok(hint < warning, "Warnung vor dem Hinweis");
    const snippet = buttonAfter(dialog, warning + block.length);
    assert.equal(snippet.text, PLACEHOLDER);
    // zwischen Warnung und Schnipsel kein Text
    assert.equal(text(dialog.slice(warning + block.length, snippet.start)), "");
    // der Skript-Teil davor hat keine Warnung
    assert.ok(
      dialog.indexOf("data-embed-id") < label,
      "Skript-Schnipsel nicht vor dem Platzhalter-Teil"
    );
    // englisch: derselbe englische Block wie im Reiter
    await withLanguage("en", async () => {
      const en = byTestId(
        await renderDialog(JSON.stringify(config)),
        "inline-link-warning"
      );
      assert.ok(
        text(en).startsWith("Do not put the placeholder inside linked areas"),
        text(en)
      );
      assert.equal(
        en,
        byTestId(await renderTab(config), "inline-link-warning")
      );
    });
  }
);

// ---------------------------------------------------------------------------
// F81 Warndreieck für Screenreader
// ---------------------------------------------------------------------------

function warningIcon(html) {
  const block = byTestId(html, "inline-link-warning");
  assert.ok(block, "Warnblock fehlt");
  const svg = /<svg\b[^>]*>/.exec(block);
  assert.ok(svg, "kein Warndreieck");
  return { block, svg: svg[0], attrs: attributes(svg[0]) };
}

test(
  "F81: Warndreieck ist ein Bild mit dem Namen „Warnung“ (de) bzw. „Warning“ (en), nicht versteckt",
  { skip },
  async () => {
    for (const [lang, name] of [
      ["de", "Warnung"],
      ["en", "Warning"],
    ]) {
      await withLanguage(lang, async () => {
        for (const html of [
          await renderTab({ displayMode: "inline" }),
          await renderDialog(JSON.stringify({ displayMode: "inline" })),
        ]) {
          const { svg, attrs } = warningIcon(html);
          assert.equal(attrs["data-testid"], "inline-link-warning-icon", svg);
          assert.equal(attrs.role, "img", svg);
          assert.equal(attrs["aria-label"], name, svg);
          assert.equal(attrs["aria-hidden"], undefined, svg);
          // nicht role="alert": der Block ist statischer Inhalt
          assert.doesNotMatch(html, /role="alert"/);
        }
      });
    }
  }
);

test("F81: Sprachdateien: Name des Warndreiecks de und en, übrige Sprachen null", async () => {
  const langs = fs
    .readdirSync(LOCALES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.ok(langs.length > 20, langs.join(","));
  for (const lang of langs) {
    const { default: locale } = await import(
      `../src/locales/${lang}/common.js`
    );
    const warning = locale["embed-appearance"]?.["inline-link-warning"];
    assert.ok(warning && "icon" in warning, `${lang}: icon fehlt`);
    if (lang === "de") assert.equal(warning.icon, "Warnung");
    else if (lang === "en") assert.equal(warning.icon, "Warning");
    else assert.equal(warning.icon, null, lang);
  }
});

// ---------------------------------------------------------------------------
// F82 (E35) Kontrast des Warndreiecks
// ---------------------------------------------------------------------------

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test(
  "F82: Warndreieck hell red-700, mindestens 4,5:1 auf der Fläche des Blocks; dunkel unverändert",
  { skip },
  async () => {
    const require = createRequire(path.join(ROOT, "frontend", "package.json"));
    const colors = require("tailwindcss/colors");
    const { block, attrs } = warningIcon(
      await renderTab({ displayMode: "inline" })
    );
    const icon = attrs.class.split(/\s+/);
    const outer = attributes(/^<div\b[^>]*>/.exec(block)[0]).class.split(/\s+/);
    const shade = (classes, prefix) => {
      const found = classes
        .filter((c) => c.startsWith(prefix))
        .map((c) => c.slice(prefix.length));
      assert.equal(found.length, 1, `${prefix}: ${classes.join(" ")}`);
      return found[0];
    };
    const fg = shade(icon, "light:text-red-");
    const bg = shade(outer, "light:bg-red-");
    assert.equal(fg, "700");
    const ratio = contrast(colors.red[fg], colors.red[bg]);
    assert.ok(ratio >= 4.5, `red-${fg} auf red-${bg}: ${ratio.toFixed(2)}:1`);
    // dunkel unverändert (E35)
    assert.ok(icon.includes("text-red-400"), icon.join(" "));
    assert.ok(outer.includes("bg-red-950/60"), outer.join(" "));
  }
);

// ---------------------------------------------------------------------------
// F83, F84 Migrationsdoku
// ---------------------------------------------------------------------------

const readDoc = () => fs.readFileSync(MIGRATION, "utf8");

// Prüfliste der Migrationsdoku: Punkt n (bis zum nächsten Punkt)
function checkpoint(doc, n) {
  const match = doc.match(
    new RegExp(`^${n}\\. ([\\s\\S]*?)(?=^\\d+\\. |$(?![\\s\\S]))`, "m")
  );
  assert.ok(match, `Prüfpunkt ${n} fehlt`);
  return match[1].replace(/\s+/g, " ");
}

// Punkt einer Gruppe: vom fett gesetzten Namen bis zum nächsten Punkt
function bullet(doc, name) {
  const start = doc.indexOf(`- **${name}`);
  assert.ok(start >= 0, `Punkt ${name} fehlt`);
  const end = doc.indexOf("\n- **", start + 1);
  const stop = doc.indexOf("\n\n", start);
  const until = [end, stop].filter((i) => i >= 0);
  return doc
    .slice(start, until.length ? Math.min(...until) : undefined)
    .replace(/\s+/g, " ");
}

test("F83: Gruppe B nennt die festen Farben der Datenschutz-Blase (E25)", () => {
  const group = bullet(readDoc(), "Gruppe B");
  assert.match(
    group,
    /Text, Überschrift und Fläche der Datenschutz-Blase sind je Farbschema fest \(E25, 7\.22-rc18\)/
  );
  // die Angaben, die dort nicht wirken, und die Begrüßungsblase, die folgt
  assert.match(group, /`data-assistant-bg-color`/);
  assert.match(group, /`--allm-assistant-bg`/);
  assert.match(group, /Begrüßungsblase darüber folgt/);
  assert.doesNotMatch(group, /[–—]/);
});

test("F84: Prüfpunkt 11 zählt gespeicherte privacyText mit dem alten Standardpunkt (E30)", () => {
  const point = checkpoint(readDoc(), 11);
  assert.match(point, /`privacyText`/);
  for (const container of [
    "ki-helfer",
    "intern",
    "demo-inline",
    "praesentation",
    "entwicklung",
  ])
    assert.ok(point.includes(container), `${container} fehlt: ${point}`);
  assert.match(point, /7\.16 bis 7\.21\.1/);
  assert.match(point, /„Mitarbeitende“/);
  assert.match(point, /\(E30, 7\.22-rc19\)/);
  assert.match(
    point,
    /Mitarbeiter der Einrichtung können Gespräche zur Qualitätssicherung einsehen\./
  );
  assert.match(point, /nur melden/);
  assert.match(point, /gespeicherte Texte der Kunden nicht ändern/);
  assert.doesNotMatch(point, /[–—]/);
});
