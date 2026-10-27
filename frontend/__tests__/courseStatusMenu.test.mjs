// KB-3: Hilfsfunktionen der Status-Seite (utils/courseStatus.js) und der Punkt
// am Menüpunkt „Status“ in der Seitenleiste, serverseitig gerendert
// (helpers/renderSettingsPage.mjs, render). Die Seite selbst:
// courseStatusPage.test.mjs.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
  menuEntries,
} from "./helpers/renderSettingsPage.mjs";

const SIDEBAR = "/src/components/SettingsSidebar/index.jsx";
const UTIL = "/src/utils/courseStatus.js";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

let renderer;
let util;
let t;
before(async () => {
  if (!hasFrontendDeps) return;
  renderer = await createRenderer();
  util = await renderer.load(UTIL);
  const { default: i18next } = await import("i18next");
  t = i18next.t.bind(i18next);
});
after(async () => {
  await renderer?.close();
});

// 26.10.2026, 10:00 Uhr Berliner Zeit (Winterzeit, UTC+1)
const NOW = Date.parse("2026-10-26T09:00:00.000Z");

// ---------------------------------------------------------------------------
// AK-4, AK-5 und Meldungen: Regeln
// ---------------------------------------------------------------------------

test(
  "AK-4: Datum des Hinweises als Konstante; nur bei geschätztem Ende und ausgeblendeten Kursen",
  { skip },
  () => {
    assert.equal(util.OPTIMIZATION_NOTICE_SINCE, "26.10.2026");
    const status = (estimatedEnd, hidden) => ({
      estimatedEnd,
      counts: { hidden },
    });
    assert.equal(util.showsOptimizationNotice(status(true, 3)), true);
    assert.equal(util.showsOptimizationNotice(status(true, 0)), false);
    assert.equal(util.showsOptimizationNotice(status(false, 3)), false);
    assert.equal(
      util.showsOptimizationNotice({ estimatedEnd: true, counts: null }),
      false
    );
    assert.equal(util.showsOptimizationNotice(null), false);
  }
);

test("AK-5: Punkt am Menü nur bei Gelb oder Rot", { skip }, () => {
  assert.equal(util.menuDotState("gelb"), "gelb");
  assert.equal(util.menuDotState("rot"), "rot");
  for (const state of ["gruen", "nicht_eingerichtet", null, undefined, "x"])
    assert.equal(util.menuDotState(state), null, String(state));
});

// Fixliste r4 Nr. 1 (Vertrag): Überschrift, Zeilen, Anteil und den Fall
// „nicht abrufbar“ rechnet nur der Server; die eigenen Regeln der Seite sind
// entfallen
test(
  "Kontakt als eine Konstante; keine eigenen Regeln mehr für Überschrift, Zeilen und Anteil",
  { skip },
  () => {
    // Fixliste KB-3 r3 Nr. 5: support@kufer.de statt info@kufer.de
    assert.equal(util.KUFER_CONTACT_EMAIL, "support@kufer.de");
    for (const name of [
      "bannerKey",
      "bannerTitle",
      "bannerDetails",
      "isUnreachable",
      "missingShare",
      // Fixliste r8 Nr. 3 und 5: ohne Karte „Abgleich“ und ohne farbigen
      // Hinweis; Nr. 6: der Menüpunkt liest den ganzen Zustand
      "formatNextRun",
      "NOTICE_COLORS",
      "useCourseStatusDot",
    ])
      assert.equal(name in util, false, name);
  }
);

// Fixliste r4 Nr. 13 (NF-C4): ein Element mitten im übersetzten Satz an
// einer Stelle für Design Center und Status-Seite
test(
  "NF-C4: withElement setzt das Element an jede Marke; keine eigene Marke mehr in Design Center und Status-Seite",
  { skip },
  async () => {
    const { ELEMENT_MARK, withElement } = await renderer.load(
      "/src/utils/withElement.js"
    );
    const { default: React } = await import("react");
    const parts = withElement(
      `a${ELEMENT_MARK}b${ELEMENT_MARK}c`,
      React.createElement("code", null, "x")
    );
    assert.equal(parts.length, 5);
    assert.deepEqual([parts[0], parts[2], parts[4]], ["a", "b", "c"]);
    assert.deepEqual(
      [parts[1].key, parts[3].key, parts[1].type, parts[1].props.children],
      ["0", "1", "code", "x"]
    );
    const { readFileSync } = await import("node:fs");
    const src = new URL("../src/", import.meta.url);
    for (const file of [
      "pages/GeneralSettings/ChatEmbedWidgets/EmbedAppearance/EmbedTab.jsx",
      "pages/GeneralSettings/ChatEmbedWidgets/CourseStatus/index.jsx",
    ]) {
      const source = readFileSync(new URL(file, src), "utf8");
      assert.doesNotMatch(source, /\\u0000/, file);
      assert.match(source, /from "@\/utils\/withElement"/, file);
    }
  }
);

test("Meldungen der Ampel in de und en", { skip }, () => {
  const keys = [
    "course-status.banner.level.gruen",
    "course-status.banner.level.gelb",
    "course-status.banner.level.rot",
    "course-status.banner.title.aktuell",
    "course-status.banner.title.unvollstaendig",
    "course-status.banner.title.nicht_aktualisiert",
    "course-status.banner.title.nicht_abrufbar",
    "course-status.banner.title.nicht_eingerichtet",
    "course-status.banner.list-not-applied",
    "course-status.banner.not-set-up",
    "course-status.banner.available",
    "course-status.banner.not-updated",
    "course-status.banner.unreachable",
    "course-status.banner.closing",
    "course-status.banner.closing-unreachable",
    "course-status.since-date",
  ];
  for (const lng of ["de", "en"])
    for (const path of keys)
      assert.notEqual(t(path, { lng }), path, `${lng} ${path}`);

  const de = (key, options) => t(`course-status.banner.${key}`, options);
  // Nr. 1: Statusangabe je Stufe
  assert.deepEqual(
    ["gruen", "gelb", "rot"].map((state) => de(`level.${state}`)),
    ["In Ordnung", "Eingeschränkt", "Gestört"]
  );
  // Nr. 2 und 3: Überschriften
  assert.deepEqual(
    [
      "aktuell",
      "unvollstaendig",
      "nicht_aktualisiert",
      "nicht_abrufbar",
      "nicht_eingerichtet",
    ].map((key) => de(`title.${key}`)),
    [
      "Kursprogramm aktuell",
      "Kursprogramm unvollständig",
      "Kursprogramm nicht aktualisiert",
      "Kursprogramm nicht abrufbar",
      "Abgleich nicht eingerichtet",
    ]
  );
  // Nr. 2: Grün, Einzahl und Mehrzahl
  const plural = (key, count, extra = {}, lng = "de") =>
    t(`course-status.banner.${key}`, { count, number: count, lng, ...extra });
  assert.equal(
    plural("all-available", 864),
    "Alle 864 Kurse sind im KI-Berater verfügbar."
  );
  assert.equal(
    plural("all-available", 1),
    "1 Kurs ist im KI-Berater verfügbar."
  );
  assert.equal(
    de("available", { available: 834, offered: 864 }),
    "834 von 864 Kursen sind im KI-Berater verfügbar."
  );
  assert.equal(plural("pending", 1), "1 neuer Kurs wird in Kürze übernommen.");
  assert.equal(
    plural("pending", 30),
    "30 neue Kurse werden in Kürze übernommen."
  );
  assert.equal(
    plural("pending", 1, {}, "en"),
    "1 new course will be added shortly."
  );
  assert.equal(
    plural("pending", 30, {}, "en"),
    "30 new courses will be added shortly."
  );
  // Nr. 4: Zeilen bei Gelb und Rot
  assert.equal(
    plural("missing", 52, { offered: 864 }),
    "52 von 864 Kursen sind derzeit nicht im KI-Berater verfügbar."
  );
  assert.equal(
    plural("missing", 1, { offered: 3 }),
    "1 von 3 Kursen ist derzeit nicht im KI-Berater verfügbar."
  );
  const since = util.formatSyncedAt(t, "2026-10-25T13:00:00.000Z", NOW);
  assert.equal(
    de("not-updated", { time: since }),
    "Das Kursprogramm wurde seit gestern, 14:00 Uhr nicht aktualisiert."
  );
  assert.equal(
    de("unreachable", {
      time: util.formatSyncedAt(t, "2026-10-24T12:00:00.000Z", NOW),
    }),
    "Ihr Kursprogramm konnte seit dem 24.10., 14:00 Uhr nicht von Ihrer Website abgerufen werden."
  );
  // Nr. 5: beide Schlusssätze
  assert.equal(
    de("closing", { email: "support@kufer.de" }),
    "Wir kümmern uns darum. Bei Fragen kontaktieren Sie uns unter support@kufer.de."
  );
  assert.equal(
    de("closing-unreachable", { email: "support@kufer.de" }),
    "Wir kümmern uns darum. Falls sich die Adresse Ihrer Website oder Ihres Kursprogramms geändert hat, kontaktieren Sie uns bitte unter support@kufer.de."
  );
  // Nr. 6: kein „eingelernt“ mehr; entfallen sind auch frühere Meldungen
  for (const path of [
    "course-status.banner.learning",
    "course-status.banner.contact",
    "course-status.banner.age",
    "course-status.banner.title.gruen",
    "course-status.banner.title.gelb",
    "course-status.banner.title.rot",
    "course-status.on-date-at",
    "course-status.who.title",
    "course-status.sync.result",
    "course-status.sync.causes.feed_unsicher",
    "course-status.banner.gelb-fehlen.title",
    "course-status.banner.next-sync",
  ])
    assert.equal(t(path), path, path);
});

// Fixliste r8 Nr. 1, 2, 4 und 5: Kopf, Grundsatz, Liste „Ausgeblendete
// Kurse“ und Hinweis unten; die Texte der Karte „Abgleich“ und der
// Übergangslösung sind entfallen
test(
  "r8: Texte von Kopf, Grundsatz, Liste und Hinweis in de und en",
  { skip },
  () => {
    const de = (key, options) => t(`course-status.${key}`, options);
    const en = (key, options) =>
      t(`course-status.${key}`, { lng: "en", ...options });
    assert.equal(de("workspace", { name: "VHS" }), "Arbeitsbereich „VHS“");
    assert.equal(de("widget", { name: "Widget 3" }), "Widget: Widget 3");
    assert.equal(
      de("widgets", { names: "Widget 3 und Widget 9" }),
      "Widgets: Widget 3 und Widget 9"
    );
    assert.equal(
      de("principle"),
      "Alle aktuellen Kurse aus Ihrem Kursprogramm sind im KI-Berater verfügbar. Der Abgleich läuft tagsüber stündlich und nachts einmal."
    );
    assert.equal(
      de("last-sync", { time: "heute, 10:00 Uhr" }),
      "Letzter Abgleich: heute, 10:00 Uhr"
    );
    assert.equal(de("hidden.title", { count: 2 }), "Ausgeblendete Kurse (2)");
    assert.equal(
      de("hidden.description"),
      "Diese Kurse sind beendet oder stehen nicht mehr im Kursprogramm. Der KI-Berater nennt sie nicht."
    );
    assert.equal(
      de("notice", { date: "26.10.2026" }),
      "Seit 26.10.2026: Zurzeit wird das Ausschließen vergangener Kurse optimiert."
    );
    assert.equal(en("workspace", { name: "VHS" }), "Workspace “VHS”");
    assert.equal(en("widget", { name: "Widget 3" }), "Widget: Widget 3");
    assert.equal(
      en("principle"),
      "All current courses from your course program are available in the AI advisor. The synchronization runs every hour during the day and once at night."
    );
    assert.equal(
      en("last-sync", { time: "today, 10:00" }),
      "Last synchronization: today, 10:00"
    );
    assert.equal(en("hidden.title", { count: 2 }), "Hidden courses (2)");
    for (const key of ["widgets", "hidden.description", "notice"])
      assert.notEqual(en(key), `course-status.${key}`, key);
    for (const lng of ["de", "en"])
      for (const key of [
        "program",
        "applies-to",
        "quoted",
        "hidden.estimated",
        "hidden.notice",
        "sync.title",
        "sync.last",
        "sync.next",
        "sync.visitors",
        "sync.pending",
      ])
        assert.equal(
          t(`course-status.${key}`, { lng }),
          `course-status.${key}`,
          `${lng} ${key}`
        );
  }
);

test("Zeitpunkte des Abgleichs in Berliner Zeit", { skip }, () => {
  const at = (iso) => util.formatRunTime(t, iso, NOW);
  assert.equal(at("2026-10-26T09:00:00.000Z"), "heute, 10:00 Uhr");
  assert.equal(at("2026-10-25T22:59:00.000Z"), "gestern, 23:59 Uhr");
  assert.equal(at("2026-10-24T08:00:00.000Z"), "24.10., 10:00 Uhr");
  assert.equal(at("2025-12-31T08:00:00.000Z"), "31.12.2025, 09:00 Uhr");
  assert.equal(at(null), "k. A.");
  // nach „seit“ („Das Kursprogramm wurde seit … nicht aktualisiert.“)
  const inSentence = (iso) => util.formatSyncedAt(t, iso, NOW);
  assert.equal(inSentence("2026-10-24T08:00:00.000Z"), "dem 24.10., 10:00 Uhr");
  assert.equal(inSentence("2026-10-26T08:00:00.000Z"), "heute, 09:00 Uhr");
  assert.equal(inSentence("2026-10-25T08:00:00.000Z"), "gestern, 09:00 Uhr");
});

// Fixliste r2 Nr. 3 (F5): „gestern“ und „morgen“ nach Berliner Kalendertagen,
// auch an den Tagen der Zeitumstellung (25.10.2026 hat 25 h, 29.03.2026 23 h)
test("Gestern und morgen über die Zeitumstellung", { skip }, () => {
  const at = (iso, now) => util.formatRunTime(t, iso, Date.parse(now));
  // 25.10.2026, 23:30 Uhr (Winterzeit): 24 h zuvor ist noch der 25.10.
  assert.equal(
    at("2026-10-24T08:00:00.000Z", "2026-10-25T22:30:00.000Z"),
    "gestern, 10:00 Uhr"
  );
  assert.equal(
    at("2026-10-25T07:00:00.000Z", "2026-10-25T22:30:00.000Z"),
    "heute, 08:00 Uhr"
  );
  // 28.03.2026, 23:30 Uhr (Winterzeit): 24 h später ist schon der 30.03.
  assert.equal(
    at("2026-03-29T08:00:00.000Z", "2026-03-28T22:30:00.000Z"),
    "morgen, 10:00 Uhr"
  );
  assert.equal(
    at("2026-03-29T22:30:00.000Z", "2026-03-28T22:30:00.000Z"),
    "30.03., 00:30 Uhr"
  );
  // Jahreswechsel
  assert.equal(
    at("2025-12-31T22:00:00.000Z", "2026-01-01T10:00:00.000Z"),
    "gestern, 23:00 Uhr"
  );
  assert.equal(
    at("2026-01-01T10:00:00.000Z", "2025-12-31T12:00:00.000Z"),
    "morgen, 11:00 Uhr"
  );
});

test("Beginn und Dauer ausgeblendeter Kurse", { skip }, () => {
  const when = (entry) => util.hiddenWhen(t, entry, NOW);
  assert.equal(
    when({ start: "2026-09-02", duration: "6 Termine" }),
    "ab 02.09., 6 Termine"
  );
  assert.equal(
    when({ start: "2026-09-15", duration: "1 Termin" }),
    "15.09., 1 Termin"
  );
  assert.equal(when({ start: "2025-09-15", duration: null }), "ab 15.09.2025");
  assert.equal(when({ start: null, duration: "4 Wochen" }), "4 Wochen");
  assert.equal(when({ start: "gestern", duration: null }), "k. A.");
  assert.equal(when({}), "k. A.");
});

// ---------------------------------------------------------------------------
// AK-5: Punkt in der Seitenleiste (Abfrage und Wechsel des Zustands:
// courseStatusPage.test.mjs, eingehängt)
// ---------------------------------------------------------------------------

test(
  "AK-5: ohne geladenen Zustand kein Punkt (die Seitenleiste wartet nicht)",
  { skip },
  async () => {
    const html = await renderer.render(SIDEBAR, {
      location: "/settings/chatbot/widgets",
    });
    assert.equal(menuEntries(html)[1]?.label, "Status");
    assert.doesNotMatch(html, /data-menu-dot/);
  }
);
