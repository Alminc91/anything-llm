// KB-3: Seite „Status“ (Mockup Tafel 3, Ampel nach Nutzerentscheidung vom
// 26.10.2026, fixliste-kb3-r1.md, Wortlaut nach fixliste-kb3-r3-texte.md) mit React DOM in einem Dokument ohne
// Browser (helpers/renderSettingsPage.mjs, mount). Die Antwort des Servers
// (GET /api/embed/course-status) ist ersetzt; die Ampel rechnet der Server
// (server/__tests__/utils/chats/courseStatus.test.js). Dazu der Punkt am
// Menüpunkt (MenuOption, AK-5). Menü und Hilfsfunktionen:
// courseStatusMenu.test.mjs.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { click, elements } from "./helpers/testDom.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VIEW =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/CourseStatus/index.jsx";
const MENU_OPTION = "/src/components/SettingsSidebar/MenuOption/index.jsx";
const STATUS = "/settings/chatbot/status";
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

const widget = (id, name) => ({
  id,
  uuid: `uuid-${id}`,
  workspace: { id: 100, name, slug: "kurse" },
});
// Zwei Widgets am selben Kursprogramm und eines an einem anderen
const EMBEDS = [
  widget(3, "VHS Beispiel"),
  widget(9, "VHS Beispiel"),
  { ...widget(5, "Dokubot"), workspace: { id: 101, name: "Dokubot" } },
];

const missing = (n) =>
  Array.from({ length: n }, (_, i) => ({
    knr: `262-${i + 1}`,
    title: i === 1 ? null : `Kurs ${i + 1}`,
  }));

const HOUR = 60 * 60 * 1000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

/** Antwort des Servers für ein gelbes Kursprogramm, sonst wie angegeben. */
function answer(overrides = {}) {
  return {
    state: "gelb",
    reasons: ["fehlen"],
    counts: { offered: 864, count: 812, missing: 52, hidden: 2 },
    missing: missing(52),
    hidden: [
      {
        knr: "261-7",
        title: "Yoga am Morgen",
        start: "2026-09-02",
        duration: "6 Termine",
      },
      { knr: "261-8", title: "Excel", start: null, duration: null },
    ],
    lastRun: { at: new Date().toISOString(), result: "ok", cause: null },
    syncedAt: new Date().toISOString(),
    estimatedEnd: true,
    workspace: { name: "VHS Beispiel" },
    widgets: [
      { id: 3, name: "VHS Beispiel" },
      { id: 9, name: "VHS Beispiel" },
    ],
    visitors: { count: 812, word: "Kurse" },
    ...overrides,
  };
}

/** fetch für die Dauer eines Tests. */
function stubServer(t, body, status = 200) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return {
      ok: status === 200,
      status,
      json: async () => body,
    };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

async function open(t, body, { status = 200, query = "?widget=3" } = {}) {
  const calls = stubServer(t, body, status);
  const mounted = await renderer.mount(VIEW, {
    location: `${STATUS}${query}`,
    route: STATUS,
    props: { embeds: EMBEDS, lastActivity: null },
  });
  t.after(() => mounted.unmount());
  await mounted.act();
  return { ...mounted, calls, text: mounted.container.textContent };
}

const find = (container, attribute, value = null) =>
  elements(container, (el) =>
    value === null
      ? el.hasAttribute(attribute)
      : el.getAttribute(attribute) === value
  )[0];
const rows = (section) => elements(section, (el) => el.tagName === "LI");
const CONTACT =
  "Wir kümmern uns darum. Bei Fragen kontaktieren Sie uns unter support@kufer.de.";
const CONTACT_UNREACHABLE =
  "Wir kümmern uns darum. Falls sich die Adresse Ihrer Website oder Ihres Kursprogramms geändert hat, kontaktieren Sie uns bitte unter support@kufer.de.";
// „heute, 14:00 Uhr“, „gestern, 14:00 Uhr“ oder „dem 25.10., 14:00 Uhr“
const SINCE = String.raw`(heute|gestern|dem \d\d\.\d\d\.(\d{4})?), \d\d:\d\d Uhr`;
const banner = (container) =>
  find(container, "data-course-status-banner").textContent;
const NOTICE =
  "Seit 26.10.2026: Zurzeit wird das Ausschließen vergangener Kurse optimiert.";

// ---------------------------------------------------------------------------
// AK-3: Aufbau nach Mockup Tafel 3
// ---------------------------------------------------------------------------

test(
  "AK-3: Kopf mit Kursprogramm, den Widgets des Kursprogramms und dem Grundsatz",
  { skip },
  async (t) => {
    const { container, calls } = await open(t, answer());
    assert.ok(calls[0].endsWith("/embed/course-status?widget=3"));
    const heading = elements(container, (el) => el.tagName === "H2")[0];
    assert.equal(heading.textContent, "Status");
    assert.equal(
      find(container, "data-course-status-program").textContent,
      "Kursprogramm: VHS Beispiel · gilt für die Widgets „VHS Beispiel · Widget 3“ und „VHS Beispiel · Widget 9“"
    );
    assert.ok(
      container.textContent.includes(
        "Alle aktuellen Kurse aus Ihrem Kursprogramm (KuferSQL) sind im KI-Berater verfügbar und werden stündlich abgeglichen. Hier stehen nur Abweichungen."
      )
    );
  }
);

test(
  "AK-3: Mit einem Widget am Kursprogramm entfällt „gilt für …“",
  { skip },
  async (t) => {
    const { container } = await open(
      t,
      answer({ widgets: [{ id: 3, name: "VHS Beispiel" }] })
    );
    assert.equal(
      find(container, "data-course-status-program").textContent,
      "Kursprogramm: VHS Beispiel"
    );
  }
);

test(
  "AK-3: Ampel-Meldung, Kennzahlen, Listen und Abgleich",
  { skip },
  async (t) => {
    const { container } = await open(t, answer());
    assert.ok(find(container, "data-course-status-banner", "gelb"));
    assert.equal(
      banner(container),
      `EingeschränktKursprogramm unvollständig52 von 864 Kursen sind derzeit nicht im KI-Berater verfügbar.${CONTACT}`
    );
    const kpi = (key) => find(container, "data-course-kpi", key).textContent;
    assert.equal(kpi("offered"), "Im Kursprogramm864");
    assert.equal(kpi("count"), "Im KI-Berater812");
    assert.equal(kpi("missing"), "Fehlen52(6 %)");
    assert.equal(kpi("hidden"), "Ausgeblendet2");

    const missingList = find(container, "data-course-list", "missing");
    assert.ok(missingList.textContent.startsWith("Fehlende Kurse (52)"));
    assert.equal(rows(missingList).length, 5);
    assert.equal(rows(missingList)[0].textContent, "262-1Kurs 1");
    assert.equal(rows(missingList)[1].textContent, "262-2k. A.");

    const hiddenList = find(container, "data-course-list", "hidden");
    assert.ok(
      hiddenList.textContent.startsWith(
        "Ausgeblendet, da voraussichtlich beendet (2)Geschätzt, nicht garantiert: Ihr Kursprogramm liefert kein Enddatum, wir schätzen es aus Beginn und Dauer. Mit dem Enddatum entfällt die Schätzung."
      )
    );
    assert.equal(
      rows(hiddenList)[0].textContent,
      "261-7Yoga am Morgenab 02.09., 6 Termine"
    );
    assert.equal(rows(hiddenList)[1].textContent, "261-8Excelk. A.");

    const sync = find(container, "data-course-sync");
    assert.match(
      sync.textContent,
      /^AbgleichLetzterheute, \d\d:\d\d UhrNächster(heute|morgen), \d\d:\d\d Uhr/
    );
    assert.ok(sync.textContent.endsWith("Besucher sehenaktuell 812 Kurse"));
  }
);

test(
  "AK-3: „Alle … anzeigen“ klappt die geladenen Einträge auf; über 500 nennt die Seite die Gesamtzahl",
  { skip },
  async (t) => {
    const { container, act } = await open(
      t,
      answer({
        counts: { offered: 900, count: 300, missing: 600, hidden: 0 },
        missing: missing(500),
        hidden: [],
        state: "rot",
      })
    );
    const list = find(container, "data-course-list", "missing");
    const toggle = elements(list, (el) => el.tagName === "BUTTON")[0];
    assert.equal(toggle.textContent, "Alle 600 anzeigen");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await act(() => click(toggle));
    assert.equal(rows(list).length, 500);
    assert.ok(
      list.textContent.includes("Angezeigt werden die ersten 500 von 600.")
    );
    assert.equal(toggle.textContent, "Weniger anzeigen");
    // ohne ausgeblendete Kurse keine zweite Liste
    assert.equal(find(container, "data-course-list", "hidden"), undefined);
  }
);

test(
  "AK-3: Lauf mit Störung: keine Zeile „Ergebnis“ mehr; Besucher ohne Kursanzahl",
  { skip },
  async (t) => {
    const { container } = await open(
      t,
      answer({
        lastRun: {
          at: new Date().toISOString(),
          result: "nicht_geschrieben",
          cause: "feed_unsicher",
        },
        visitors: null,
      })
    );
    const sync = find(container, "data-course-sync").textContent;
    assert.ok(!sync.includes("Ergebnis"));
    assert.ok(!sync.includes("unvollständig"));
    assert.match(
      sync,
      /^AbgleichLetzterheute, \d\d:\d\d UhrNächster(heute|morgen), \d\d:\d\d UhrBesucher sehenkeine Kursanzahl$/
    );
  }
);

// ---------------------------------------------------------------------------
// AK-4: Hinweis „Seit 26.10.2026: …“
// ---------------------------------------------------------------------------

test(
  "AK-4: Der Hinweis steht nur bei geschätztem Ende und ausgeblendeten Kursen",
  { skip },
  async (t) => {
    const withEstimate = await open(t, answer());
    assert.equal(
      find(withEstimate.container, "data-course-notice").textContent,
      NOTICE
    );
    await withEstimate.unmount();

    const withoutEstimate = await open(t, answer({ estimatedEnd: false }));
    assert.equal(
      find(withoutEstimate.container, "data-course-notice"),
      undefined
    );
    assert.equal(
      find(withoutEstimate.container, "data-course-estimated"),
      undefined
    );
    assert.ok(
      withoutEstimate.text.includes("Ausgeblendet, da voraussichtlich")
    );
    await withoutEstimate.unmount();

    const nothingHidden = await open(
      t,
      answer({
        counts: { offered: 864, count: 812, missing: 52, hidden: 0 },
        hidden: [],
      })
    );
    assert.ok(!nothingHidden.text.includes(NOTICE));
  }
);

// ---------------------------------------------------------------------------
// Meldungen der Ampel (Nutzer 26.10.2026, Wortlaut fixliste-kb3-r3-texte.md)
// ---------------------------------------------------------------------------

const green = (overrides = {}) =>
  answer({
    state: "gruen",
    reasons: [],
    counts: { offered: 864, count: 864, missing: 0, hidden: 0 },
    missing: [],
    hidden: [],
    ...overrides,
  });
const unreachableRun = {
  at: new Date().toISOString(),
  result: "nicht_geschrieben",
  cause: "feed_nicht_erreichbar",
};
const level = (container) =>
  find(container, "data-course-status-level")?.textContent;
const title = (container) =>
  elements(
    find(container, "data-course-status-banner"),
    (el) => el.tagName === "H3"
  )[0].textContent;

test(
  "Nr. 1: Statusangabe als Text je Stufe, nicht nur als Farbe; nicht eingerichtet ohne",
  { skip },
  async (t) => {
    for (const [state, text] of [
      ["gruen", "In Ordnung"],
      ["gelb", "Eingeschränkt"],
      ["rot", "Gestört"],
    ]) {
      const page = await open(
        t,
        state === "gruen" ? green() : answer({ state })
      );
      const label = find(page.container, "data-course-status-level", state);
      assert.equal(label.textContent, text, state);
      assert.equal(label.getAttribute("aria-hidden"), null, state);
      await page.unmount();
    }
  }
);

test(
  "Nr. 2: Grün „Kursprogramm aktuell“: alle verfügbar, sonst wie viele in Kürze übernommen werden (Einzahl und Mehrzahl), ohne Kontakt",
  { skip },
  async (t) => {
    const all = await open(t, green());
    assert.ok(find(all.container, "data-course-status-banner", "gruen"));
    assert.equal(
      banner(all.container),
      "In OrdnungKursprogramm aktuellAlle 864 Kurse sind im KI-Berater verfügbar."
    );
    assert.ok(!all.text.includes("kufer.de"));
    assert.equal(find(all.container, "data-course-contact"), undefined);
    await all.unmount();

    const one = await open(
      t,
      green({
        counts: { offered: 864, count: 863, missing: 1, hidden: 0 },
        missing: missing(1),
      })
    );
    assert.equal(
      find(one.container, "data-course-available").textContent,
      "863 von 864 Kursen sind im KI-Berater verfügbar. 1 neuer Kurs wird in Kürze übernommen."
    );
    await one.unmount();

    const many = await open(
      t,
      green({
        counts: { offered: 1864, count: 1834, missing: 30, hidden: 0 },
        missing: missing(30),
      })
    );
    assert.equal(
      banner(many.container),
      "In OrdnungKursprogramm aktuell1.834 von 1.864 Kursen sind im KI-Berater verfügbar. 30 neue Kurse werden in Kürze übernommen."
    );
    await many.unmount();

    // nicht abrufbar ändert Grün nicht
    const fine = await open(t, green({ lastRun: unreachableRun }));
    assert.equal(title(fine.container), "Kursprogramm aktuell");
    assert.ok(!fine.text.includes("abgerufen"));
  }
);

test(
  "Nr. 3 bis 5: Gelb wegen Alter „nicht aktualisiert“ mit Zeitpunkt seit dem letzten erfolgreichen Abgleich und Mail-Link",
  { skip },
  async (t) => {
    const { container } = await open(
      t,
      green({ state: "gelb", reasons: ["alter"], syncedAt: ago(25) })
    );
    assert.equal(level(container), "Eingeschränkt");
    assert.equal(title(container), "Kursprogramm nicht aktualisiert");
    assert.equal(
      find(container, "data-course-detail", "unvollstaendig"),
      undefined
    );
    assert.match(
      find(container, "data-course-detail", "nicht-aktualisiert").textContent,
      new RegExp(`^Das Kursprogramm wurde seit ${SINCE} nicht aktualisiert\\.$`)
    );
    assert.equal(
      find(container, "data-course-contact", "standard").textContent,
      CONTACT
    );
    const link = elements(container, (el) => el.tagName === "A")[0];
    assert.equal(link.getAttribute("href"), "mailto:support@kufer.de");
    assert.equal(link.textContent, "support@kufer.de");
    // keine Zeile von Grün
    assert.equal(find(container, "data-course-available"), undefined);
  }
);

test(
  "Nr. 3 und 4: Rot aus beiden Gründen: Überschrift „nicht aktualisiert“, deren Zeile zuerst, dann die fehlenden Kurse",
  { skip },
  async (t) => {
    const { container } = await open(
      t,
      answer({
        state: "rot",
        reasons: ["fehlen", "alter"],
        syncedAt: ago(80),
      })
    );
    assert.ok(find(container, "data-course-status-banner", "rot"));
    const text = banner(container);
    assert.ok(text.endsWith(CONTACT));
    assert.match(
      text.slice(0, -CONTACT.length),
      new RegExp(
        `^GestörtKursprogramm nicht aktualisiertDas Kursprogramm wurde seit dem \\d\\d\\.\\d\\d\\.(\\d{4})?, \\d\\d:\\d\\d Uhr nicht aktualisiert\\.52 von 864 Kursen sind derzeit nicht im KI-Berater verfügbar\\.$`
      )
    );
  }
);

test(
  "Nr. 3 bis 5: Nicht abrufbar (Alter und Website nicht erreicht): eigene Überschrift, Zeile zuerst, eigener Schlusssatz",
  { skip },
  async (t) => {
    for (const state of ["gelb", "rot"]) {
      const page = await open(
        t,
        answer({
          state,
          reasons: ["fehlen", "alter"],
          syncedAt: ago(30),
          lastRun: unreachableRun,
        })
      );
      assert.equal(title(page.container), "Kursprogramm nicht abrufbar", state);
      const details = elements(page.container, (el) =>
        el.hasAttribute("data-course-detail")
      );
      assert.deepEqual(
        details.map((el) => el.getAttribute("data-course-detail")),
        ["nicht-abrufbar", "unvollstaendig"],
        state
      );
      assert.match(
        details[0].textContent,
        new RegExp(
          `^Ihr Kursprogramm konnte seit ${SINCE} nicht von Ihrer Website abgerufen werden\\.$`
        )
      );
      assert.equal(
        find(page.container, "data-course-contact", "nicht-abrufbar")
          .textContent,
        CONTACT_UNREACHABLE
      );
      assert.ok(!page.text.includes("nicht aktualisiert"), state);
      await page.unmount();
    }
  }
);

test(
  "Nr. 3 und 5: Website nicht erreicht, aber nur fehlende Kurse: „unvollständig“ mit dem Standard-Schlusssatz",
  { skip },
  async (t) => {
    const { container } = await open(
      t,
      answer({ state: "gelb", reasons: ["fehlen"], lastRun: unreachableRun })
    );
    assert.equal(title(container), "Kursprogramm unvollständig");
    assert.equal(
      find(container, "data-course-contact", "standard").textContent,
      CONTACT
    );
  }
);

// ---------------------------------------------------------------------------
// D-KB3-3: nicht eingerichtet; Fehler; nur lesend (NAK-3); Textregeln
// ---------------------------------------------------------------------------

test(
  "D-KB3-3: Ohne Kursliste nur der Satz „nicht eingerichtet“, keine Kennzahlen",
  { skip },
  async (t) => {
    const { container } = await open(
      t,
      answer({
        state: "nicht_eingerichtet",
        reasons: [],
        counts: null,
        missing: [],
        hidden: [],
        lastRun: null,
        syncedAt: null,
        estimatedEnd: false,
        visitors: null,
      })
    );
    assert.equal(
      find(container, "data-course-status-banner", "nicht_eingerichtet")
        .textContent,
      "Abgleich nicht eingerichtetFür dieses Kursprogramm ist der Abgleich nicht eingerichtet."
    );
    assert.equal(find(container, "data-course-kpi"), undefined);
    assert.equal(find(container, "data-course-sync"), undefined);
  }
);

test("Fehler beim Laden: Hinweis statt leerer Seite", { skip }, async (t) => {
  const { container } = await open(t, null, { status: 500 });
  assert.equal(
    elements(container, (el) => el.getAttribute("role") === "alert")[0]
      .textContent,
    "Der Status konnte nicht geladen werden. Bitte versuchen Sie es später erneut."
  );
});

test(
  "NAK-3: nur lesend: keine Eingabefelder, Buttons nur zum Aufklappen und für die Widget-Auswahl",
  { skip },
  async (t) => {
    const { container } = await open(t, answer());
    assert.deepEqual(
      elements(container, (el) =>
        ["INPUT", "SELECT", "TEXTAREA", "FORM"].includes(el.tagName)
      ),
      []
    );
    assert.deepEqual(
      elements(container, (el) => el.tagName === "BUTTON").map(
        (el) => el.getAttribute("aria-haspopup") ?? el.textContent
      ),
      ["listbox", "Alle 52 anzeigen"]
    );
  }
);

test(
  "Textregeln: keine Gedankenstriche, keine internen Begriffe",
  { skip },
  async (t) => {
    for (const body of [
      answer(),
      answer({ state: "rot", reasons: ["fehlen", "alter"], syncedAt: ago(80) }),
      answer({ state: "gelb", reasons: ["alter"], syncedAt: ago(30) }),
      answer({
        state: "rot",
        reasons: ["alter"],
        syncedAt: ago(80),
        lastRun: {
          at: new Date().toISOString(),
          result: "nicht_geschrieben",
          cause: "feed_nicht_erreichbar",
        },
      }),
      answer({
        state: "gruen",
        reasons: [],
        counts: { offered: 864, count: 860, missing: 4, hidden: 2 },
      }),
      answer({
        state: "gruen",
        reasons: [],
        counts: { offered: 864, count: 864, missing: 0, hidden: 2 },
      }),
    ]) {
      const page = await open(t, body);
      assert.doesNotMatch(
        page.text,
        /[–—]|Feed|Workspace|Schätzung\)|eingelernt|Kufer kümmert|Bescheid/
      );
      await page.unmount();
    }
  }
);

// ---------------------------------------------------------------------------
// AK-5: Punkt am Menüpunkt (MenuOption)
// ---------------------------------------------------------------------------

test(
  "AK-5: Punkt an „Status“ und am zugeklappten Kopf „Chatbot“, mit Text für Screenreader; aufgeklappt nur am Unterpunkt",
  { skip },
  async (t) => {
    const roles = ["admin", "manager", "default"];
    const dot = { state: "gelb", color: "#D9961A", label: "Status: Gelb" };
    const props = {
      btnText: "Chatbot",
      dot,
      user: { id: 1, role: "admin" },
      childOptions: [
        { btnText: "Status", href: STATUS, flex: true, roles, dot },
        {
          btnText: "Widgets",
          href: "/settings/chatbot/widgets",
          flex: true,
          roles,
        },
      ],
    };
    const dots = (container) =>
      elements(container, (el) => el.hasAttribute("data-menu-dot")).map(
        (el) => el.parentNode.textContent
      );

    const collapsed = await renderer.mount(MENU_OPTION, {
      location: "/settings/users",
      route: "/settings/users",
      stored: { anything_llm_menu_chatbot_expanded: "false" },
      props,
    });
    t.after(() => collapsed.unmount());
    await collapsed.act();
    assert.deepEqual(dots(collapsed.container), ["ChatbotStatus: Gelb"]);
    await collapsed.unmount();

    const expanded = await renderer.mount(MENU_OPTION, {
      location: "/settings/users",
      route: "/settings/users",
      stored: { anything_llm_menu_chatbot_expanded: "true" },
      props,
    });
    t.after(() => expanded.unmount());
    await expanded.act();
    assert.deepEqual(dots(expanded.container), ["StatusStatus: Gelb"]);
    const sr = elements(
      expanded.container,
      (el) => el.getAttribute("class") === "sr-only"
    );
    assert.deepEqual(
      sr.map((el) => el.textContent),
      ["Status: Gelb"]
    );
  }
);

// Fixliste r2 Nr. 5 (F7): Die Farben der Ampel und des Hinweises kommen aus
// Theme-Variablen mit je einer Variante für das dunkle (:root) und das helle
// Design ([data-theme="light"]), wie die übrigen Farben der Admin-Oberfläche.
test(
  "F7: Farben der Ampel als Theme-Variablen, dunkel und hell verschieden",
  { skip },
  async () => {
    const src = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src"
    );
    const util = await renderer.load("/src/utils/courseStatus.js");
    const used = [
      ...Object.values(util.STATE_COLORS).flatMap(Object.values),
      ...Object.values(util.NOTICE_COLORS),
    ];
    assert.equal(used.length, 18);
    const names = used.map((value) => {
      const match = /^var\((--course-status-[a-z_-]+)\)$/.exec(value);
      assert.ok(match, value);
      return match[1];
    });

    const css = readFileSync(path.join(src, "index.css"), "utf8");
    const blocks = (selector) =>
      [...css.matchAll(/^(:root|\[data-theme="light"\]) \{([^}]*)\}/gm)]
        .filter(([, sel]) => sel === selector)
        .map(([, , body]) => body)
        .join("\n");
    const valueIn = (body, name) =>
      new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(body)?.[1];
    for (const name of names) {
      const dark = valueIn(blocks(":root"), name);
      const light = valueIn(blocks('[data-theme="light"]'), name);
      assert.ok(dark && light, name);
      assert.notEqual(dark, light, name);
    }

    // keine festen Farben mehr auf der Seite
    const page = readFileSync(
      path.join(
        src,
        "pages/GeneralSettings/ChatEmbedWidgets/CourseStatus/index.jsx"
      ),
      "utf8"
    );
    assert.doesNotMatch(page, /#[0-9a-fA-F]{3,8}\b/);
  }
);

// ---------------------------------------------------------------------------
// AK-5: Punkt in der Seitenleiste (Gruppe „Chatbot“, eingehängt). Fixliste r2
// Nr. 8 (F-C3): gemerkt wird nur auf dem Server; jede Seite fragt neu, bis
// zur Antwort steht der zuletzt geladene Zustand da.
// ---------------------------------------------------------------------------

const SIDEBAR = "/src/components/SettingsSidebar/index.jsx";

/** fetch für GET /embeds/course-status; answer() liefert den Zustand. */
function stubDotState(t, answer) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const state = await answer();
    return { ok: true, status: 200, json: async () => ({ state }) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** Die Gruppe „Chatbot“ der Seitenleiste unter einer Adresse. */
async function mountChatbotGroup(t, location, stored = {}) {
  const { default: i18next } = await import("i18next");
  const mounted = await renderer.mount(SIDEBAR, {
    exportName: "ChatbotOption",
    location,
    route: location,
    stored,
    props: {
      user: { id: 1, role: "admin" },
      t: i18next.t.bind(i18next),
      canViewChatHistory: true,
    },
  });
  t.after(() => mounted.unmount());
  return mounted;
}

/** Menüpunkte mit Punkt: „<Menüpunkt>: <Text für Screenreader>“. */
const menuDots = (container) =>
  elements(container, (el) => el.hasAttribute("data-menu-dot")).map(
    (el) =>
      `${elements(el.parentNode, (p) => p.tagName === "P")[0].textContent}: ${
        el.textContent
      }`
  );

test(
  "AK-5: Seitenleiste: Rot an „Status“ bei offener Gruppe, zugeklappt am Kopf; Gelb mit Text; Grün und nicht eingerichtet ohne Punkt",
  { skip },
  async (t) => {
    let state = "rot";
    const calls = stubDotState(t, async () => state);
    const open = await mountChatbotGroup(t, "/settings/chatbot/widgets");
    await open.act();
    assert.ok(calls[0].endsWith("/embeds/course-status"));
    assert.deepEqual(menuDots(open.container), ["Status: Status: Rot"]);
    await open.unmount();

    const closed = await mountChatbotGroup(t, "/settings/users", {
      anything_llm_menu_chatbot_expanded: "false",
    });
    await closed.act();
    assert.deepEqual(menuDots(closed.container), ["Chatbot: Status: Rot"]);
    await closed.unmount();

    for (const [next, expected] of [
      ["gelb", ["Status: Status: Gelb"]],
      ["gruen", []],
      ["nicht_eingerichtet", []],
    ]) {
      state = next;
      const mounted = await mountChatbotGroup(t, "/settings/chatbot/widgets");
      await mounted.act();
      assert.deepEqual(menuDots(mounted.container), expected, next);
      await mounted.unmount();
    }
  }
);

test(
  "F-C3: Jede Seite fragt neu, ohne Speicher im Browser; bis zur Antwort bleibt der zuletzt geladene Zustand stehen",
  { skip },
  async (t) => {
    let answer = async () => "rot";
    const calls = stubDotState(t, () => answer());
    const first = await mountChatbotGroup(t, "/settings/chatbot/widgets");
    await first.act();
    assert.deepEqual(menuDots(first.container), ["Status: Status: Rot"]);
    await first.unmount();

    // Gleich danach ist alles in Ordnung: die nächste Seite fragt neu.
    let resolve;
    answer = () => new Promise((done) => (resolve = done));
    const second = await mountChatbotGroup(t, "/settings/chatbot/widgets");
    await second.act();
    assert.equal(calls.length, 2);
    assert.deepEqual(menuDots(second.container), ["Status: Status: Rot"]);
    await second.act(() => resolve("gruen"));
    assert.deepEqual(menuDots(second.container), []);

    const util = await renderer.load("/src/utils/courseStatus.js");
    for (const name of [
      "STATES",
      "STATE_CACHE_MS",
      "loadCourseStatusState",
      "resetCourseStatusState",
    ])
      assert.equal(name in util, false, name);
  }
);
