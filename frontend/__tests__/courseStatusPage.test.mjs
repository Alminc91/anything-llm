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

/**
 * Antwort des Servers für ein gelbes Kursprogramm, sonst wie angegeben. Wie
 * der Server (Fixliste r7 Nr. 1): ausgeblendete Kurse nur bei listApplied.
 */
function answer(overrides = {}) {
  const applied = overrides.listApplied !== false;
  return {
    state: "gelb",
    headline: "unvollstaendig",
    details: ["unvollstaendig"],
    reasons: ["fehlen"],
    counts: { offered: 864, count: 812, missing: 52, hidden: applied ? 2 : 0 },
    missingPercent: 6,
    listApplied: true,
    notice: null,
    missing: missing(52),
    hidden: applied
      ? [
          {
            knr: "261-7",
            title: "Yoga am Morgen",
            start: "2026-09-02",
            duration: "6 Termine",
            offWebsite: false,
          },
          {
            knr: "261-8",
            title: "Excel",
            start: null,
            duration: null,
            offWebsite: false,
          },
        ]
      : [],
    lastRun: { at: new Date().toISOString(), result: "ok", cause: null },
    syncedAt: new Date().toISOString(),
    estimatedEnd: true,
    workspace: { name: "VHS Beispiel" },
    widgets: [
      { id: 3, name: "VHS Beispiel" },
      { id: 9, name: "VHS Beispiel" },
    ],
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
const HIDDEN_TITLE = "Ausgeblendete Kurse";
const HIDDEN_DESCRIPTION =
  "Diese Kurse sind beendet oder stehen nicht mehr im Kursprogramm. Der KI-Berater nennt sie nicht.";
const PRINCIPLE =
  "Alle aktuellen Kurse aus Ihrem Kursprogramm sind im KI-Berater verfügbar. Der Abgleich läuft tagsüber stündlich und nachts einmal.";
const NOT_APPLIED =
  "Bis zum nächsten erfolgreichen Abgleich blendet der KI-Berater keine Kurse aus.";

// ---------------------------------------------------------------------------
// AK-3: Aufbau nach Mockup Tafel 3
// ---------------------------------------------------------------------------

// Fixliste r8 Nr. 1 und 2: Arbeitsbereich mit den Widgets (ohne den
// vorangestellten Arbeitsbereich), Grundsatz ohne „(KuferSQL)“ und ohne
// „Hier stehen nur Abweichungen.“, darunter der letzte Abgleich
test(
  "r8 Nr. 1 und 2: Kopf mit Arbeitsbereich und Widgets, Grundsatz und letztem Abgleich",
  { skip },
  async (t) => {
    const { container, calls } = await open(t, answer());
    assert.ok(calls[0].endsWith("/embed/course-status?widget=3"));
    const heading = elements(container, (el) => el.tagName === "H2")[0];
    assert.equal(heading.textContent, "Kursbestand");
    assert.equal(
      find(container, "data-course-status-program").textContent,
      "Arbeitsbereich „VHS Beispiel“ · Widgets: Widget 3 und Widget 9"
    );
    assert.equal(
      find(container, "data-course-principle").textContent,
      PRINCIPLE
    );
    assert.match(
      find(container, "data-course-last-sync").textContent,
      /^Letzter Abgleich: heute, \d\d:\d\d Uhr$/
    );
    // Reihenfolge: Arbeitsbereich, Grundsatz, letzter Abgleich
    const lines = elements(container, (el) =>
      [
        "data-course-status-program",
        "data-course-principle",
        "data-course-last-sync",
      ].some((name) => el.hasAttribute(name))
    ).map((el) => el.textContent.slice(0, 12));
    assert.deepEqual(lines, ["Arbeitsberei", "Alle aktuell", "Letzter Abgl"]);
    for (const gone of [
      "KuferSQL",
      "Hier stehen nur Abweichungen",
      "Kursprogramm: ",
      "gilt für",
    ])
      assert.ok(!container.textContent.includes(gone), gone);
  }
);

test(
  "r8 Nr. 1: Mit einem Widget im Arbeitsbereich „Widget: <Name>“",
  { skip },
  async (t) => {
    const { container } = await open(
      t,
      answer({ widgets: [{ id: 3, name: "VHS Beispiel" }] })
    );
    assert.equal(
      find(container, "data-course-status-program").textContent,
      "Arbeitsbereich „VHS Beispiel“ · Widget: Widget 3"
    );
  }
);

test(
  "AK-3: Ampel-Meldung, Kennzahlen und Listen; keine Karte „Abgleich“ (r8 Nr. 3)",
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

    // Fixliste r8 Nr. 4: Überschrift wie „Fehlende Kurse (n)“, darunter
    // die Erklärung; weder Hinweis noch „Übergangslösung“ in der Liste
    const hiddenList = find(container, "data-course-list", "hidden");
    const hiddenHeading = elements(hiddenList, (el) => el.tagName === "H3")[0];
    const missingHeading = elements(
      missingList,
      (el) => el.tagName === "H3"
    )[0];
    assert.equal(hiddenHeading.textContent, `${HIDDEN_TITLE} (2)`);
    assert.equal(
      hiddenHeading.getAttribute("class"),
      missingHeading.getAttribute("class")
    );
    assert.equal(
      find(hiddenList, "data-course-hidden-description").textContent,
      HIDDEN_DESCRIPTION
    );
    assert.equal(
      hiddenHeading.nextSibling,
      find(hiddenList, "data-course-hidden-description")
    );
    assert.ok(
      hiddenList.textContent.startsWith(
        `${HIDDEN_TITLE} (2)${HIDDEN_DESCRIPTION}`
      ),
      hiddenList.textContent
    );
    assert.ok(!hiddenList.textContent.includes(NOTICE));
    assert.ok(!hiddenList.textContent.includes("Übergangslösung"));
    assert.equal(
      rows(hiddenList)[0].textContent,
      "261-7Yoga am Morgenab 02.09., 6 Termine"
    );
    assert.equal(rows(hiddenList)[1].textContent, "261-8Excelk. A.");

    // Fixliste r8 Nr. 3: keine Karte „Abgleich“ mit Letzter, Nächster und
    // „Besucher sehen“
    assert.equal(find(container, "data-course-sync"), undefined);
    for (const gone of ["Nächster", "Besucher sehen", "aktuell 812 Kurse"])
      assert.ok(!container.textContent.includes(gone), gone);
    assert.equal(
      elements(container, (el) => el.tagName === "H3").filter(
        (el) => el.textContent === "Abgleich"
      ).length,
      0
    );
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

// ---------------------------------------------------------------------------
// AK-4: Hinweis „Seit 26.10.2026: …“
// ---------------------------------------------------------------------------

test(
  "AK-4, r8 Nr. 5: Der Hinweis steht nur bei geschätztem Ende und ausgeblendeten Kursen, als dezente Zeile mit Info-Symbol ganz unten",
  { skip },
  async (t) => {
    const withEstimate = await open(t, answer());
    const notice = find(withEstimate.container, "data-course-notice");
    assert.equal(notice.textContent, NOTICE);
    // ganz unten auf der Seite, nicht in der Liste
    assert.equal(withEstimate.container.firstChild.lastChild, notice);
    assert.equal(
      find(
        find(withEstimate.container, "data-course-list", "hidden"),
        "data-course-notice"
      ),
      undefined
    );
    // dezent: kleine, gedämpfte Schrift ohne eigene Fläche, mit Info-Symbol
    assert.match(notice.getAttribute("class"), /\btext-xs\b/);
    assert.equal(notice.getAttribute("style"), null);
    assert.equal(
      elements(notice, (el) => el.getAttribute("aria-hidden") === "true")
        .length,
      1
    );
    await withEstimate.unmount();

    const withoutEstimate = await open(t, answer({ estimatedEnd: false }));
    assert.equal(
      find(withoutEstimate.container, "data-course-notice"),
      undefined
    );
    // die Erklärung der Liste steht auch ohne geschätztes Ende
    assert.ok(
      withoutEstimate.text.includes(`${HIDDEN_TITLE} (2)${HIDDEN_DESCRIPTION}`)
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
    headline: "aktuell",
    details: [],
    reasons: [],
    counts: { offered: 864, count: 864, missing: 0, hidden: 0 },
    missingPercent: 0,
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
      green({
        state: "gelb",
        headline: "nicht_aktualisiert",
        details: ["nicht_aktualisiert"],
        reasons: ["alter"],
        syncedAt: ago(25),
      })
    );
    assert.equal(level(container), "Eingeschränkt");
    assert.equal(title(container), "Kursprogramm nicht aktualisiert");
    assert.equal(
      find(container, "data-course-detail", "unvollstaendig"),
      undefined
    );
    assert.match(
      find(container, "data-course-detail", "nicht_aktualisiert").textContent,
      new RegExp(
        `^Das Kursprogramm wurde seit ${SINCE}, nicht aktualisiert\\.$`
      )
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
        headline: "nicht_aktualisiert",
        details: ["nicht_aktualisiert", "unvollstaendig"],
        reasons: ["fehlen", "alter"],
        syncedAt: ago(80),
        listApplied: false,
        notice: "liste_nicht_angewendet",
      })
    );
    assert.ok(find(container, "data-course-status-banner", "rot"));
    // Rot mit Liste: Grundsatz und letzter Abgleich bleiben (Fixliste KB-9
    // r2 Nr. 1 gilt nur ohne Liste)
    assert.equal(
      find(container, "data-course-principle").textContent,
      PRINCIPLE
    );
    assert.ok(find(container, "data-course-last-sync"));
    const text = banner(container);
    assert.ok(text.endsWith(`${NOT_APPLIED}${CONTACT}`));
    assert.match(
      text.slice(0, -(NOT_APPLIED.length + CONTACT.length)),
      new RegExp(
        `^GestörtKursprogramm nicht aktualisiertDas Kursprogramm wurde seit dem \\d\\d\\.\\d\\d\\.(\\d{4})?, \\d\\d:\\d\\d Uhr, nicht aktualisiert\\.52 von 864 Kursen sind derzeit nicht im KI-Berater verfügbar\\.$`
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
          headline: "nicht_abrufbar",
          details: ["nicht_abrufbar", "unvollstaendig"],
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
        ["nicht_abrufbar", "unvollstaendig"],
        state
      );
      assert.match(
        details[0].textContent,
        new RegExp(
          `^Ihr Kursprogramm konnte seit ${SINCE}, nicht von Ihrer Website abgerufen werden\\.$`
        )
      );
      assert.equal(
        find(page.container, "data-course-contact", "nicht_abrufbar")
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

// KB-9: Der Abgleich hat noch nie eine Liste geliefert (Störungsmeldung
// ohne Liste). Der Server meldet Rot mit Zahlen 0 und leeren Listen; die
// Seite zeigt nur die Meldung mit den vorhandenen Texten, keine leeren
// Kennzahlen und keinen „Letzter Abgleich“ (es gab keinen erfolgreichen).
const noListAnswer = (overrides = {}) =>
  answer({
    state: "rot",
    headline: "nicht_abrufbar",
    details: ["nicht_abrufbar"],
    reasons: ["alter"],
    counts: { offered: 0, count: 0, missing: 0, hidden: 0 },
    missingPercent: 0,
    missing: [],
    hidden: [],
    listApplied: false,
    notice: null,
    syncedAt: ago(3),
    lastRun: unreachableRun,
    estimatedEnd: false,
    ...overrides,
  });

test(
  "KB-9 AK-5: Ohne erste Liste Rot „Gestört“ mit Überschrift und Satz „seit …“, ohne Kennzahlen, Listen und letzten Abgleich",
  { skip },
  async (t) => {
    const unreachable = await open(t, noListAnswer());
    const { container } = unreachable;
    assert.ok(find(container, "data-course-status-banner", "rot"));
    assert.equal(level(container), "Gestört");
    assert.equal(title(container), "Kursprogramm nicht abrufbar");
    assert.match(
      banner(container),
      new RegExp(
        `^GestörtKursprogramm nicht abrufbarIhr Kursprogramm konnte seit ${SINCE}, nicht von Ihrer Website abgerufen werden\\.`
      )
    );
    assert.ok(banner(container).endsWith(CONTACT_UNREACHABLE));
    assert.equal(find(container, "data-course-kpi"), undefined);
    assert.equal(find(container, "data-course-list"), undefined);
    assert.equal(find(container, "data-course-notice"), undefined);
    assert.equal(find(container, "data-course-list-not-applied"), undefined);
    assert.equal(find(container, "data-course-last-sync"), undefined);
    // Kopf mit Arbeitsbereich, aber ohne Grundsatz: „Alle aktuellen Kurse
    // … sind im KI-Berater verfügbar“ widerspräche der Störung (Fixliste
    // KB-9 r2 Nr. 1)
    assert.equal(find(container, "data-course-principle"), undefined);
    assert.ok(!unreachable.text.includes("Alle aktuellen Kurse"));
    assert.ok(find(container, "data-course-status-program"));
    assert.doesNotMatch(unreachable.text, /[–—]|NaN|undefined/);
    await unreachable.unmount();

    const notUpdated = await open(
      t,
      noListAnswer({
        headline: "nicht_aktualisiert",
        details: ["nicht_aktualisiert"],
        lastRun: {
          at: new Date().toISOString(),
          result: "fehler",
          cause: "einlernen_fehlgeschlagen",
        },
      })
    );
    assert.equal(
      title(notUpdated.container),
      "Kursprogramm nicht aktualisiert"
    );
    assert.match(
      banner(notUpdated.container),
      new RegExp(
        `^GestörtKursprogramm nicht aktualisiertDas Kursprogramm wurde seit ${SINCE}, nicht aktualisiert\\.${CONTACT.replace(/\./g, "\\.")}$`
      )
    );
    assert.equal(find(notUpdated.container, "data-course-kpi"), undefined);
    assert.equal(
      find(notUpdated.container, "data-course-principle"),
      undefined
    );
  }
);

// ---------------------------------------------------------------------------
// Fixliste r4: Vertrag mit dem Server, Abgleich, Kopfzeile
// ---------------------------------------------------------------------------

const kpi = (container, key) =>
  find(container, "data-course-kpi", key)?.textContent;

test(
  "r4 Nr. 1: Überschrift, Zeilen und Anteil kommen vom Server, die Seite rechnet nichts nach",
  { skip },
  async (t) => {
    // reasons allein ergäbe „unvollständig“; es gilt headline des Servers
    const { container, unmount } = await open(
      t,
      answer({
        headline: "nicht_abrufbar",
        details: ["nicht_abrufbar", "unvollstaendig"],
        reasons: ["fehlen"],
        counts: { offered: 100, count: 71, missing: 29, hidden: 2 },
        missingPercent: 29,
        syncedAt: ago(30),
        lastRun: unreachableRun,
      })
    );
    assert.equal(title(container), "Kursprogramm nicht abrufbar");
    assert.deepEqual(
      elements(container, (el) => el.hasAttribute("data-course-detail")).map(
        (el) => el.getAttribute("data-course-detail")
      ),
      ["nicht_abrufbar", "unvollstaendig"]
    );
    // 29 von 100: 29 %, nicht 28 % (Gleitkomma, NF3)
    assert.equal(kpi(container, "missing"), "Fehlen29(29 %)");
    await unmount();

    // Anteil 0 bei fehlenden Kursen heißt „unter 1 %“
    const small = await open(
      t,
      green({
        counts: { offered: 864, count: 860, missing: 4, hidden: 0 },
        missingPercent: 0,
      })
    );
    assert.equal(kpi(small.container, "missing"), "Fehlen4(unter 1 %)");
  }
);

test(
  "r4 Nr. 2, r6-4: Wendet der Chat die Kursliste nicht an, gibt es keine Liste und keine Kennzahl „Ausgeblendet“; die Zeile dazu nur nach notice",
  { skip },
  async (t) => {
    const yellow = await open(
      t,
      answer({
        headline: "nicht_aktualisiert",
        details: ["nicht_aktualisiert", "unvollstaendig"],
        reasons: ["fehlen", "alter"],
        syncedAt: ago(25),
        listApplied: false,
        notice: "liste_nicht_angewendet",
      })
    );
    assert.equal(
      find(yellow.container, "data-course-list", "hidden"),
      undefined
    );
    assert.equal(kpi(yellow.container, "hidden"), undefined);
    assert.ok(!yellow.text.includes(HIDDEN_TITLE));
    assert.ok(!yellow.text.includes(NOTICE));
    assert.equal(
      find(yellow.container, "data-course-list-not-applied").textContent,
      NOT_APPLIED
    );
    assert.ok(banner(yellow.container).endsWith(`${NOT_APPLIED}${CONTACT}`));
    await yellow.unmount();

    // D-r6-3: Die Zeile kommt nur aus notice, nicht aus listApplied
    const withoutNotice = await open(
      t,
      answer({
        headline: "nicht_aktualisiert",
        details: ["nicht_aktualisiert"],
        reasons: ["alter"],
        syncedAt: ago(25),
        listApplied: false,
        notice: null,
      })
    );
    assert.equal(kpi(withoutNotice.container, "hidden"), undefined);
    assert.equal(
      find(withoutNotice.container, "data-course-list-not-applied"),
      undefined
    );
    await withoutNotice.unmount();

    // Grün (Uhrabweichung): ohne Ausblenden und ohne Zeile
    const fine = await open(t, green({ listApplied: false }));
    assert.equal(kpi(fine.container, "hidden"), undefined);
    assert.equal(
      find(fine.container, "data-course-list-not-applied"),
      undefined
    );
    await fine.unmount();

    // angewendet: Kennzahl und Liste wie bisher, keine Zeile
    const applied = await open(t, answer());
    assert.equal(kpi(applied.container, "hidden"), "Ausgeblendet2");
    assert.ok(find(applied.container, "data-course-list", "hidden"));
    assert.equal(
      find(applied.container, "data-course-list-not-applied"),
      undefined
    );
  }
);

test(
  "r7 Nr. 1: Die Seite zeigt Liste und Kennzahl „Ausgeblendet“ nach dem, was der Server liefert, ohne eigene Bedingung auf listApplied",
  { skip },
  async (t) => {
    // nichts ausgeblendet: keine Liste und keine Kennzahl, auch bei listApplied
    const none = await open(
      t,
      answer({
        counts: { offered: 864, count: 812, missing: 52, hidden: 0 },
        hidden: [],
      })
    );
    assert.equal(kpi(none.container, "hidden"), undefined);
    assert.equal(find(none.container, "data-course-list", "hidden"), undefined);
    assert.ok(find(none.container, "data-course-list", "missing"));
    await none.unmount();

    // geliefert: Liste und Kennzahl, auch ohne listApplied in der Antwort
    const shown = await open(t, answer({ listApplied: undefined }));
    assert.equal(kpi(shown.container, "hidden"), "Ausgeblendet2");
    assert.ok(find(shown.container, "data-course-list", "hidden"));
  }
);

test(
  "r4 Nr. 3, r8 Nr. 2: „Letzter Abgleich“ ist der letzte erfolgreiche (syncedAt), nicht der letzte Lauf",
  { skip },
  async (t) => {
    const { container } = await open(
      t,
      answer({
        syncedAt: ago(30),
        lastRun: {
          at: new Date().toISOString(),
          result: "nicht_geschrieben",
          cause: "feed_unsicher",
        },
      })
    );
    assert.match(
      find(container, "data-course-last-sync").textContent,
      /^Letzter Abgleich: (gestern|\d\d\.\d\d\.(\d{4})?), \d\d:\d\d Uhr$/
    );
  }
);

test(
  "r4 Nr. 9 und 10: Widget-Auswahl oben rechts in der Zeile der Überschrift; Statusangabe mindestens 14 px",
  { skip },
  async (t) => {
    const { container } = await open(t, answer());
    const heading = elements(container, (el) => el.tagName === "H2")[0];
    const row = heading.parentNode;
    assert.match(row.getAttribute("class"), /justify-between/);
    assert.ok(
      elements(row, (el) => el.getAttribute("aria-haspopup") === "listbox")
        .length === 1
    );
    // Arbeitsbereich, Grundsatz und letzter Abgleich stehen unter der Zeile,
    // nicht neben der Auswahl
    assert.equal(find(row, "data-course-status-program"), undefined);
    assert.equal(find(row, "data-course-last-sync"), undefined);
    const level = find(container, "data-course-status-level", "gelb");
    assert.match(level.getAttribute("class"), /\btext-sm\b/);
    assert.doesNotMatch(level.getAttribute("class"), /\btext-xs\b/);
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
        headline: null,
        details: [],
        reasons: [],
        counts: null,
        missingPercent: 0,
        missing: [],
        hidden: [],
        lastRun: null,
        syncedAt: null,
        listApplied: false,
        notice: null,
        estimatedEnd: false,
      })
    );
    assert.equal(
      find(container, "data-course-status-banner", "nicht_eingerichtet")
        .textContent,
      "Abgleich nicht eingerichtetFür dieses Kursprogramm ist der Abgleich nicht eingerichtet."
    );
    // Fixliste r4 Nr. 8: kein Grundsatz-Satz, er widerspräche der Meldung
    assert.equal(find(container, "data-course-principle"), undefined);
    assert.equal(find(container, "data-course-last-sync"), undefined);
    assert.ok(!container.textContent.includes("Alle aktuellen Kurse"));
    assert.ok(!container.textContent.includes("Letzter Abgleich"));
    assert.equal(find(container, "data-course-kpi"), undefined);
    assert.equal(find(container, "data-course-notice"), undefined);
    // Kopf: Arbeitsbereich mit Widgets wie sonst
    assert.equal(
      find(container, "data-course-status-program").textContent,
      "Arbeitsbereich „VHS Beispiel“ · Widgets: Widget 3 und Widget 9"
    );
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

// KB-10 Teil 2: ausgenommen ist die Karte „Benachrichtigung per E-Mail“
// (courseStatusNotify.test.mjs)
const outsideNotifyCard = (el) => {
  for (let node = el; node; node = node.parentNode)
    if (node.hasAttribute?.("data-course-notify")) return false;
  return true;
};

test(
  "NAK-3: nur lesend: keine Eingabefelder, Buttons nur zum Aufklappen und für die Widget-Auswahl (außer der Karte Benachrichtigung)",
  { skip },
  async (t) => {
    const { container } = await open(t, answer());
    assert.deepEqual(
      elements(
        container,
        (el) =>
          ["INPUT", "SELECT", "TEXTAREA", "FORM"].includes(el.tagName) &&
          outsideNotifyCard(el)
      ),
      []
    );
    assert.deepEqual(
      elements(
        container,
        (el) => el.tagName === "BUTTON" && outsideNotifyCard(el)
      ).map((el) => el.getAttribute("aria-haspopup") ?? el.textContent),
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
      answer({
        state: "rot",
        headline: "nicht_aktualisiert",
        details: ["nicht_aktualisiert", "unvollstaendig"],
        reasons: ["fehlen", "alter"],
        syncedAt: ago(80),
        listApplied: false,
        notice: "liste_nicht_angewendet",
      }),
      answer({
        state: "gelb",
        headline: "nicht_aktualisiert",
        details: ["nicht_aktualisiert"],
        reasons: ["alter"],
        syncedAt: ago(30),
        listApplied: false,
        notice: "liste_nicht_angewendet",
      }),
      answer({
        state: "rot",
        headline: "nicht_abrufbar",
        details: ["nicht_abrufbar"],
        reasons: ["alter"],
        syncedAt: ago(80),
        listApplied: false,
        notice: "liste_nicht_angewendet",
        lastRun: {
          at: new Date().toISOString(),
          result: "nicht_geschrieben",
          cause: "feed_nicht_erreichbar",
        },
      }),
      answer({
        state: "gruen",
        headline: "aktuell",
        details: [],
        reasons: [],
        counts: { offered: 864, count: 860, missing: 4, hidden: 2 },
        missingPercent: 0,
      }),
      answer({
        state: "gruen",
        headline: "aktuell",
        details: [],
        reasons: [],
        counts: { offered: 864, count: 864, missing: 0, hidden: 2 },
        missingPercent: 0,
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
    const dot = { state: "gelb", color: "#D9961A", label: "Kursbestand: Gelb" };
    const props = {
      btnText: "Chatbot",
      dot,
      user: { id: 1, role: "admin" },
      childOptions: [
        { btnText: "Kursbestand", href: STATUS, flex: true, roles, dot },
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
    assert.deepEqual(dots(collapsed.container), ["ChatbotKursbestand: Gelb"]);
    await collapsed.unmount();

    const expanded = await renderer.mount(MENU_OPTION, {
      location: "/settings/users",
      route: "/settings/users",
      stored: { anything_llm_menu_chatbot_expanded: "true" },
      props,
    });
    t.after(() => expanded.unmount());
    await expanded.act();
    assert.deepEqual(dots(expanded.container), [
      "KursbestandKursbestand: Gelb",
    ]);
    const sr = elements(
      expanded.container,
      (el) => el.getAttribute("class") === "sr-only"
    );
    assert.deepEqual(
      sr.map((el) => el.textContent),
      ["Kursbestand: Gelb"]
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
    // Fixliste r8 Nr. 5: der Hinweis hat keine eigenen Farben mehr
    const used = Object.values(util.STATE_COLORS).flatMap(Object.values);
    assert.equal(used.length, 16);
    assert.equal("NOTICE_COLORS" in util, false);
    const names = used.map((value) => {
      const match = /^var\((--course-status-[a-z_-]+)\)$/.exec(value);
      assert.ok(match, value);
      return match[1];
    });

    const css = readFileSync(path.join(src, "index.css"), "utf8");
    assert.doesNotMatch(css, /--course-status-notice-/);
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
    assert.deepEqual(menuDots(open.container), [
      "Kursbestand: Kursbestand: Rot",
    ]);
    await open.unmount();

    const closed = await mountChatbotGroup(t, "/settings/users", {
      anything_llm_menu_chatbot_expanded: "false",
    });
    await closed.act();
    assert.deepEqual(menuDots(closed.container), ["Chatbot: Kursbestand: Rot"]);
    await closed.unmount();

    for (const [next, expected] of [
      ["gelb", ["Kursbestand: Kursbestand: Gelb"]],
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
    assert.deepEqual(menuDots(first.container), [
      "Kursbestand: Kursbestand: Rot",
    ]);
    await first.unmount();

    // Gleich danach ist alles in Ordnung: die nächste Seite fragt neu.
    let resolve;
    answer = () => new Promise((done) => (resolve = done));
    const second = await mountChatbotGroup(t, "/settings/chatbot/widgets");
    await second.act();
    assert.equal(calls.length, 2);
    assert.deepEqual(menuDots(second.container), [
      "Kursbestand: Kursbestand: Rot",
    ]);
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

// Fixliste r4 Nr. 13 (NF-N1): Eine ältere Abfrage, die erst nach dem
// Aushängen ankommt, überschreibt den gemerkten Zustand nicht.
test(
  "NF-N1: Eine verspätete Antwort einer ausgehängten Seite setzt den Punkt nicht",
  { skip },
  async (t) => {
    const pending = [];
    stubDotState(t, () => new Promise((done) => pending.push(done)));
    const first = await mountChatbotGroup(t, "/settings/chatbot/widgets");
    await first.act();
    await first.unmount();
    const second = await mountChatbotGroup(t, "/settings/chatbot/widgets");
    await second.act();
    await second.act(() => pending[1]("gelb"));
    assert.deepEqual(menuDots(second.container), [
      "Kursbestand: Kursbestand: Gelb",
    ]);
    // die Antwort der ersten Seite kommt zuletzt
    await second.act(() => pending[0]("rot"));
    await second.unmount();
    const third = await mountChatbotGroup(t, "/settings/chatbot/widgets");
    await third.act();
    assert.deepEqual(menuDots(third.container), [
      "Kursbestand: Kursbestand: Gelb",
    ]);
  }
);

// Fixliste r4 Nr. 12 (Sonnet L3): Der Pfeil der Gruppe „Chatbot“ sagt
// Screenreadern, ob er auf- oder zuklappt; andere Gruppen bleiben wie im
// Original
test(
  "r4 Nr. 12: Pfeil der Gruppe „Chatbot“ mit aria-expanded und Beschriftung, andere Gruppen unverändert",
  { skip },
  async (t) => {
    stubDotState(t, async () => "gruen");
    const group = await mountChatbotGroup(t, "/settings/users", {
      anything_llm_menu_chatbot_expanded: "true",
    });
    await group.act();
    const arrow = () =>
      elements(group.container, (el) => el.tagName === "BUTTON")[0];
    assert.equal(arrow().getAttribute("aria-expanded"), "true");
    assert.equal(arrow().getAttribute("aria-label"), "Chatbot zuklappen");
    await group.act(() => click(arrow()));
    assert.equal(arrow().getAttribute("aria-expanded"), "false");
    assert.equal(arrow().getAttribute("aria-label"), "Chatbot aufklappen");
    await group.unmount();

    const other = await renderer.mount(MENU_OPTION, {
      location: "/settings/users",
      route: "/settings/users",
      props: {
        btnText: "Administrator",
        user: { id: 1, role: "admin" },
        childOptions: [
          {
            btnText: "Benutzer",
            href: "/settings/users",
            roles: ["admin"],
          },
        ],
      },
    });
    t.after(() => other.unmount());
    await other.act();
    const button = elements(
      other.container,
      (el) => el.tagName === "BUTTON"
    )[0];
    assert.equal(button.getAttribute("aria-expanded"), null);
    assert.equal(button.getAttribute("aria-label"), null);
  }
);

// Fixliste r8 Nr. 6: Ohne Arbeitsbereich mit gültiger Kursliste (alle nicht
// eingerichtet, etwa der KI-Helfer als Support-Bot) gibt es den Menüpunkt
// „Status“ nicht; Quelle ist GET /api/embeds/course-status. Vor der ersten
// Antwort und bei einem Fehler steht er da (die Adresse bleibt erreichbar).
test(
  "r8 Nr. 6: Menüpunkt „Status“ nur bei Kursen; nicht eingerichtet blendet ihn aus",
  { skip },
  async (t) => {
    // der Kopf „Chatbot“ und die Unterpunkte
    const links = (container) =>
      elements(container, (el) => el.tagName === "A").map((el) =>
        el.textContent.trim()
      );
    const head = (container) =>
      elements(container, (el) => el.tagName === "A")[0].getAttribute("href");
    let state = "nicht_eingerichtet";
    const calls = stubDotState(t, async () => state);
    const none = await mountChatbotGroup(t, "/settings/chatbot/widgets", {
      anything_llm_menu_chatbot_expanded: "true",
    });
    await none.act();
    assert.ok(calls[0].endsWith("/embeds/course-status"));
    assert.deepEqual(links(none.container), [
      "Chatbot",
      "Konversationen",
      "Design Center",
      "Widgets",
    ]);
    assert.deepEqual(menuDots(none.container), []);
    // der Kopf öffnet den ersten sichtbaren Unterpunkt
    assert.equal(head(none.container), "/settings/chatbot/conversations");
    await none.unmount();

    for (const next of ["gruen", "gelb", "rot"]) {
      state = next;
      const mounted = await mountChatbotGroup(t, "/settings/chatbot/widgets", {
        anything_llm_menu_chatbot_expanded: "true",
      });
      await mounted.act();
      assert.ok(links(mounted.container)[1].startsWith("Kursbestand"), next);
      assert.equal(head(mounted.container), STATUS, next);
      await mounted.unmount();
    }

    // Lesefehler: kein Zustand, der Menüpunkt bleibt
    state = undefined;
    const failed = await mountChatbotGroup(t, "/settings/chatbot/widgets", {
      anything_llm_menu_chatbot_expanded: "true",
    });
    await failed.act();
    assert.equal(links(failed.container)[1], "Kursbestand");
  }
);

// KB-10 (issues/P-kursbestand/KB-10-hinweis-und-benachrichtigung.md, AK-3,
// Mockup Tafel 1 Variante D): Bei offWebsite vom Server steht unter der
// Zeile über alle Spalten ein dekoratives Info-Symbol und der Satz; die
// Seite rechnet nicht selbst (ohne offWebsite kein Hinweis, auch bei
// künftigem Beginn). Kursnummer, Titel mit Link und Termin bleiben.
const OFF_WEBSITE = "Dieser Kurs ist auf der Website nicht mehr verfügbar.";
const OFF_WEBSITE_EN = "This course is no longer available on the website.";

function offWebsiteAnswer() {
  return answer({
    counts: { offered: 864, count: 812, missing: 52, hidden: 3 },
    hidden: [
      {
        knr: "26H44002",
        title: "Sprachenberatung",
        start: "2025-09-15",
        duration: "1 Termin",
        url: "https://www.vhs-beispiel.de/kurs/26H44002",
        offWebsite: false,
      },
      {
        knr: "26H13006",
        title: "Grill dich schlau",
        start: "2099-11-02",
        duration: "1 Termin",
        url: "https://www.vhs-beispiel.de/kurs/26H13006",
        offWebsite: true,
      },
      // künftiger Beginn ohne offWebsite (älterer Server): kein Hinweis
      {
        knr: "26H24228",
        title: "Bessere Fotos",
        start: "2099-11-03",
        duration: "1 Termin",
        url: null,
      },
    ],
  });
}

test(
  "KB-10 AK-3: Hinweis „nicht mehr auf der Website“ als eigene Zeile über alle Spalten, nur bei offWebsite",
  { skip },
  async (t) => {
    const { container } = await open(t, offWebsiteAnswer());
    const list = find(container, "data-course-list", "hidden");
    const [past, upcoming, legacy] = rows(list);
    assert.equal(
      past.textContent,
      "26H44002Sprachenberatung15.09.2025, 1 Termin"
    );
    assert.equal(find(past, "data-course-off-website"), undefined);
    assert.equal(find(legacy, "data-course-off-website"), undefined);
    assert.ok(!legacy.textContent.includes(OFF_WEBSITE));

    assert.equal(
      upcoming.textContent,
      `26H13006Grill dich schlau02.11.2099, 1 Termin${OFF_WEBSITE}`
    );
    const notice = find(upcoming, "data-course-off-website");
    assert.equal(notice.textContent, OFF_WEBSITE);
    // letzte Zelle der Zeile, über alle Spalten (Handy 2, ab sm 3)
    assert.equal(notice.parentNode, upcoming);
    assert.equal(upcoming.lastChild, notice);
    const classes = notice.getAttribute("class").split(/\s+/);
    assert.ok(classes.includes("col-span-full"), notice.getAttribute("class"));
    // lesbar hell und dunkel (Bernstein wie im Mockup, #92400e auf Weiß)
    assert.ok(classes.includes("text-amber-300"));
    assert.ok(classes.includes("light:text-amber-800"));
    const icons = elements(notice, (el) => el.tagName.toLowerCase() === "svg");
    assert.equal(icons.length, 1);
    assert.equal(icons[0].getAttribute("aria-hidden"), "true");
    // Titel bleibt der Link zur Kursseite (KB-8)
    assert.equal(
      find(upcoming, "data-course-hidden-link").getAttribute("href"),
      "https://www.vhs-beispiel.de/kurs/26H13006"
    );
  }
);

test("KB-10 AK-3: Hinweis auf Englisch", { skip }, async (t) => {
  const { default: i18next } = await import("i18next");
  await i18next.changeLanguage("en");
  t.after(() => i18next.changeLanguage("de"));
  const { container } = await open(t, offWebsiteAnswer());
  const list = find(container, "data-course-list", "hidden");
  assert.equal(
    find(list, "data-course-off-website").textContent,
    OFF_WEBSITE_EN
  );
});

// KB-10 r1 (fixliste-kb10-r1.md, Browserbericht L2): Bricht der Hinweis am
// Handy auf zwei Zeilen um, steht das Symbol an der ersten Zeile, nicht
// mittig zwischen beiden.
test(
  "KB-10 r1: Info-Symbol im Hinweis oben an der ersten Textzeile",
  { skip },
  async (t) => {
    const { container } = await open(t, offWebsiteAnswer());
    const list = find(container, "data-course-list", "hidden");
    const notice = find(list, "data-course-off-website");
    const classes = notice.getAttribute("class").split(/\s+/);
    assert.ok(classes.includes("items-start"), notice.getAttribute("class"));
    assert.ok(!classes.includes("items-center"), notice.getAttribute("class"));
    const [icon] = elements(notice, (el) => el.tagName.toLowerCase() === "svg");
    // Zeilenhöhe 13 px × 1,5 = 19,5 px, Symbol 16 px: 2 px nach unten
    assert.ok(
      icon.getAttribute("class").split(/\s+/).includes("mt-0.5"),
      icon.getAttribute("class")
    );
  }
);

// KB-10 r1 (fixliste-kb10-r1.md, Browserbericht L1 und L3, Mockup Variante
// D): Am Handy ist die Kursnummernspalte 82 px breit mit 10 px Abstand,
// damit der Titel nicht gequetscht wird; ab sm wie bisher 110 px und 12 px.
// Im hellen Design ist die Trennlinie sichtbar (Mockup #f0f1f3), dunkel
// unverändert. Gilt für beide Listen.
test(
  "KB-10 r1: Zeilen beider Listen am Handy mit schmaler Kursnummernspalte und hell sichtbarer Trennlinie",
  { skip },
  async (t) => {
    const { container } = await open(t, offWebsiteAnswer());
    for (const name of ["missing", "hidden"]) {
      const list = find(container, "data-course-list", name);
      const listRows = rows(list);
      assert.ok(listRows.length > 0, name);
      for (const row of listRows) {
        const classes = row.getAttribute("class").split(/\s+/);
        for (const expected of [
          "grid-cols-[82px_minmax(0,1fr)]",
          "gap-x-2.5",
          "sm:grid-cols-[110px_minmax(0,1fr)_auto]",
          "sm:gap-x-3",
          "border-white/5",
          "light:border-gray-100",
        ])
          assert.ok(classes.includes(expected), `${name}: ${expected}`);
        assert.ok(!classes.includes("grid-cols-[110px_minmax(0,1fr)]"), name);
        assert.ok(!classes.includes("gap-x-3"), name);
      }
    }
  }
);
