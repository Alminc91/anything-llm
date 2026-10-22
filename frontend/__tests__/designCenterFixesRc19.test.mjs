// Korrekturrunde 7.22-rc19 (Fixliste fixliste-7.22-rc19.md, Abschnitt
// „F · Fork“):
// F70 Warnung im Reiter „Einbau“ bei „In der Seite“ (AK-7 aus
//     issues/inline-platzhalter-in-link.md, Muss): roter Block mit
//     Warndreieck direkt beim Platzhalter-Schnipsel, Text vom Nutzer am
//     21.10.2026 wörtlich freigegeben, englisch sinngemäß, nicht beim
//     Chatfenster. Kontrast und Optik: Browser-Beleg .test-storage/rc19.
// C28 Kommentar an applyEmbedStandards nach E23 und E26.
// E30 (Standardtext Datenschutz ohne Gendersprache): Jest-Test
// server/__tests__/utils/chats/embedDefaults.test.js.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";

const EMBED =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/EmbedTab.jsx";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const LOCALES = path.join(ROOT, "frontend/src/locales");
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

const PLACEHOLDER = '<div id="kufer-assistent"></div>';
// Wortlaut vom Nutzer (design-center-vereinfachen.md, 21.10.2026, Eintrag
// „Warnung im Reiter Einbau“); das ⚠ ist das Warndreieck als Symbol
const TITLE = "Platzhalter nicht in verlinkte Bereiche setzen";
const PLACEMENT = `Setzen Sie ${PLACEHOLDER} in einen normalen Inhaltsbereich Ihrer Seite. Liegt der Platzhalter in einem verlinkten Block, kann die Eingabeleiste nicht zuverlässig geöffnet werden. Ein Klick öffnet dann die verlinkte Seite. Verlinkte Blöcke sind zum Beispiel eine verlinkte Karte, ein Teaser, ein Button oder ein Abschnitt mit Link-Einstellung im Seiten-Builder.`;
const CHECK =
  "Prüfen Sie in Ihrem Seiten-Builder, ob der Block oder die Spalte eine Link-Einstellung hat.";
const RIGHT = `✓ Richtig: <section> … ${PLACEHOLDER} … </section>`;
const WRONG = `✗ Falsch: <a href="/kurse"> … ${PLACEHOLDER} … </a>`;

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

const renderTab = (config) =>
  renderer.render(EMBED, {
    location: "/",
    props: { config, embed: { uuid: "abc-123" } },
  });

// ---------------------------------------------------------------------------
// F70 Warnung bei „In der Seite“
// ---------------------------------------------------------------------------

test(
  "F70: Warnblock bei „In der Seite“ mit dem freigegebenen Text, wörtlich",
  { skip },
  async () => {
    const html = await renderTab({ displayMode: "inline" });
    const block = byTestId(html, "inline-link-warning");
    assert.ok(block, "Warnblock fehlt");
    assert.equal(
      text(block),
      [TITLE, PLACEMENT, CHECK, RIGHT, WRONG].join(" "),
      text(block)
    );
    // Überschrift fett, Warndreieck davor
    const title = /<p class="([^"]*)">([\s\S]*?)<\/p>/.exec(block);
    assert.match(title[1], /\bfont-bold\b/);
    assert.ok(title[2].startsWith("<svg"), title[2]);
    assert.match(title[2], /data-testid="inline-link-warning-icon"/);
    // seit rc20 (F81) ein Bild mit Namen statt aria-hidden, Prüfung in
    // designCenterFixesRc20.test.mjs
    assert.match(title[2], /role="img"/);
    assert.equal(text(title[2]), TITLE);
    // rot, hell und dunkel
    const outer = /^<div class="([^"]*)"/.exec(block)[1].split(/\s+/);
    for (const cls of [
      "border-red-500",
      "light:border-red-600",
      "light:bg-red-50",
      "text-red-100",
      "light:text-red-900",
    ])
      assert.ok(outer.includes(cls), `${cls} fehlt: ${outer.join(" ")}`);
    assert.doesNotMatch(text(block), /[–—]/);
    assert.doesNotMatch(text(block), /Knöpfe|Knopf/);
    assert.doesNotMatch(text(block), /Inline/);
  }
);

test(
  "F70: Code-Beispiele als Code, der Platzhalter wie im Schnipsel",
  { skip },
  async () => {
    const block = byTestId(
      await renderTab({ displayMode: "inline" }),
      "inline-link-warning"
    );
    const codes = [...block.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map(
      (m) => decode(m[1])
    );
    assert.deepEqual(codes, [
      PLACEHOLDER,
      `<section> … ${PLACEHOLDER} … </section>`,
      `<a href="/kurse"> … ${PLACEHOLDER} … </a>`,
    ]);
    for (const m of block.matchAll(/<code class="([^"]*)"/g))
      assert.match(m[1], /\bfont-mono\b/);
    // ✓ und ✗ nur als Zeichen (nicht vorgelesen), Bedeutung im Wort
    for (const id of ["right", "wrong"]) {
      const row = byTestId(block, `inline-link-warning-${id}`);
      assert.match(row, /<span aria-hidden="true">[✓✗]<\/span>/);
    }
    // derselbe Platzhalter wie der kopierbare Schnipsel (constants.js)
    const { EMBED_INLINE_PLACEHOLDER_SNIPPET } = await renderer.load(
      "/src/utils/constants.js"
    );
    assert.equal(EMBED_INLINE_PLACEHOLDER_SNIPPET, PLACEHOLDER);
  }
);

test(
  "F70: Warnung steht in Schritt 2 direkt vor dem Platzhalter-Schnipsel",
  { skip },
  async () => {
    const html = await renderTab({ displayMode: "inline" });
    const step2 = html.indexOf(
      "Platzhalter dort einfügen, wo die Leiste erscheinen soll"
    );
    const block = byTestId(html, "inline-link-warning");
    const warning = html.indexOf(block);
    const pres = [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g)];
    const placeholderPre = pres.find((m) => text(m[1]) === PLACEHOLDER);
    assert.ok(step2 > 0 && placeholderPre, "Schritt 2 fehlt");
    assert.ok(step2 < warning, "Warnung vor Schritt 2");
    assert.ok(warning < placeholderPre.index, "Warnung nach dem Schnipsel");
    // zwischen Warnung und Schnipsel nur dessen Rahmen, kein Text
    const between = html.slice(warning + block.length, placeholderPre.index);
    assert.match(between, /^<div class="[^"]*">$/);
  }
);

test("F70: keine Warnung bei „Chatfenster“", { skip }, async () => {
  for (const config of [{}, { displayMode: "bubble" }, { theme: "dark" }]) {
    const html = await renderTab(config);
    assert.equal(byTestId(html, "inline-link-warning"), null);
    assert.ok(!text(html).includes(TITLE), JSON.stringify(config));
    assert.ok(!text(html).includes("verlinkten Block"), text(html));
  }
});

test(
  "F70: englische Fassung im Reiter, wenn die Oberfläche englisch ist",
  { skip },
  async () => {
    const { default: i18next } = await import("i18next");
    await i18next.changeLanguage("en");
    try {
      const block = byTestId(
        await renderTab({ displayMode: "inline" }),
        "inline-link-warning"
      );
      const shown = text(block);
      assert.ok(
        shown.startsWith("Do not put the placeholder inside linked areas"),
        shown
      );
      assert.ok(shown.includes(`Put ${PLACEHOLDER} in a regular`), shown);
      assert.ok(shown.includes("✓ Correct: <section>"), shown);
      assert.ok(shown.includes("✗ Wrong: <a href"), shown);
      assert.doesNotMatch(shown, /[–—]/);
    } finally {
      await i18next.changeLanguage("de");
    }
  }
);

test("F70: Sprachdateien: de und en gepflegt, übrige Sprachen null", async () => {
  // icon: Name des Warndreiecks (rc20 F81, designCenterFixesRc20.test.mjs)
  const keys = ["title", "placement", "check", "right", "wrong", "icon"];
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
    assert.ok(warning, `${lang}: embed-appearance.inline-link-warning fehlt`);
    assert.deepEqual(Object.keys(warning).sort(), [...keys].sort(), lang);
    for (const key of keys) {
      const value = warning[key];
      if (lang !== "de" && lang !== "en") {
        assert.equal(value, null, `${lang}.${key}`);
        continue;
      }
      assert.equal(typeof value, "string", `${lang}.${key}`);
      assert.doesNotMatch(value, /[–—]/, `${lang}.${key}`);
      // Der Platzhalter kommt aus der Konstante, nicht aus dem Text
      assert.ok(!value.includes("kufer-assistent"), `${lang}.${key}`);
    }
    if (lang === "de" || lang === "en")
      assert.equal(warning.placement.split("{{code}}").length, 2, lang);
  }
  const { default: de } = await import("../src/locales/de/common.js");
  const w = de["embed-appearance"]["inline-link-warning"];
  assert.equal(w.title, TITLE);
  assert.equal(w.placement.replace("{{code}}", PLACEHOLDER), PLACEMENT);
  assert.equal(w.check, CHECK);
  assert.equal(w.right, "Richtig:");
  assert.equal(w.wrong, "Falsch:");
});

// ---------------------------------------------------------------------------
// C28 Kommentar an applyEmbedStandards nach E23 und E26
// ---------------------------------------------------------------------------

test("C28: Kommentar zur Begrüßung in applyEmbedStandards nach E23 und E26", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "server/utils/chats/embedStandards.js"),
    "utf8"
  );
  const start = source.indexOf("function applyEmbedStandards(");
  const end = source.indexOf("const greeting = effectiveGreeting(vc);", start);
  assert.ok(start > 0 && end > start);
  const comment = source
    .slice(start, end)
    .replace(/^\s*\/\/\s?/gm, " ")
    .replace(/\s+/g, " ");
  // vor E23 galt: ein Serverwert verdrängt die Skript-Angaben; seit E23
  // wirken sie nie, auch ohne gespeicherten Text
  assert.doesNotMatch(comment, /verdrängt beide Script-Attribute/);
  assert.match(comment, /Gruppe A \(E23/);
  assert.match(
    comment,
    /data-greeting und data-greeting-bubble-text am Skript wirken nie, auch ohne gespeicherten Text/
  );
  assert.match(
    comment,
    /data-greeting-style="text" wirkt nur bei abgeschaltetem Datenschutz-Hinweis \(E26/
  );
});
