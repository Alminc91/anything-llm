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

/** fetch für die Dauer eines Tests: GET /embeds/course-status. */
function stubState(testContext, state) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ state }) };
  };
  testContext.after(() => {
    globalThis.fetch = original;
    util.resetCourseStatusState();
  });
  return calls;
}

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

test(
  "Kontakt bei Gelb und Rot: Adresse als eine Konstante; nicht abrufbar aus der Ursache des letzten Laufs",
  { skip },
  () => {
    assert.equal(util.KUFER_CONTACT_EMAIL, "info@kufer.de");
    assert.equal(
      util.isUnreachable({ lastRun: { cause: "feed_nicht_erreichbar" } }),
      true
    );
    for (const cause of ["feed_unsicher", null, undefined])
      assert.equal(util.isUnreachable({ lastRun: { cause } }), false);
    assert.equal(util.isUnreachable({ lastRun: null }), false);
    assert.equal(util.isUnreachable(null), false);
    assert.equal("bannerKey" in util, false);
  }
);

test("Meldungen der Ampel in de und en", { skip }, () => {
  for (const lng of ["de", "en"])
    for (const path of [
      "course-status.banner.title.gruen",
      "course-status.banner.title.gelb",
      "course-status.banner.title.rot",
      "course-status.banner.title.nicht_eingerichtet",
      "course-status.banner.not-set-up",
      "course-status.banner.missing",
      "course-status.banner.age",
      "course-status.banner.contact",
      "course-status.banner.unreachable",
    ])
      assert.notEqual(t(path, { lng }), path, `${lng} ${path}`);
  assert.equal(
    t("course-status.banner.title.gruen"),
    "Ihr KI-Berater kennt Ihr aktuelles Kursprogramm."
  );
  assert.equal(
    t("course-status.banner.title.gelb"),
    "Ihr KI-Berater ist zurzeit nicht ganz aktuell."
  );
  assert.equal(
    t("course-status.banner.title.rot"),
    "Ihr KI-Berater kennt Ihr Kursprogramm zurzeit nicht vollständig."
  );
  const learning = (count, lng = "de") =>
    t("course-status.banner.learning", { count, number: count, lng });
  assert.equal(learning(1), "1 Kurs wird noch eingelernt.");
  assert.equal(learning(3), "3 Kurse werden noch eingelernt.");
  assert.equal(learning(1, "en"), "1 course is still being learned.");
  assert.equal(learning(3, "en"), "3 courses are still being learned.");
  // entfallen: wer handelt, Ergebnis mit Ursachen, Meldungen je Ursache
  for (const path of [
    "course-status.who.title",
    "course-status.sync.result",
    "course-status.sync.causes.feed_unsicher",
    "course-status.banner.gelb-fehlen.title",
    "course-status.banner.next-sync",
  ])
    assert.equal(t(path), path, path);
});

test("Anteil der fehlenden Kurse", { skip }, () => {
  assert.deepEqual(util.missingShare({ offered: 864, missing: 20 }), {
    value: 2,
  });
  assert.deepEqual(util.missingShare({ offered: 2000, missing: 5 }), {
    small: true,
  });
  assert.equal(util.missingShare({ offered: 864, missing: 0 }), null);
  assert.equal(util.missingShare({ offered: 0, missing: 0 }), null);
});

test("Zeitpunkte des Abgleichs in Berliner Zeit", { skip }, () => {
  const at = (iso) => util.formatRunTime(t, iso, NOW);
  assert.equal(at("2026-10-26T09:00:00.000Z"), "heute, 10:00 Uhr");
  assert.equal(at("2026-10-25T22:59:00.000Z"), "gestern, 23:59 Uhr");
  assert.equal(at("2026-10-24T08:00:00.000Z"), "24.10., 10:00 Uhr");
  assert.equal(at("2025-12-31T08:00:00.000Z"), "31.12.2025, 09:00 Uhr");
  assert.equal(at(null), "k. A.");
  // im Satz „Der letzte erfolgreiche Abgleich war …“
  const inSentence = (iso) => util.formatSyncedAt(t, iso, NOW);
  assert.equal(inSentence("2026-10-24T08:00:00.000Z"), "am 24.10., 10:00 Uhr");
  assert.equal(inSentence("2026-10-25T08:00:00.000Z"), "gestern, 09:00 Uhr");
  assert.equal(
    util.formatNextRun(t, "2026-10-26T08:30:00.000Z", NOW),
    "heute, 10:30 Uhr"
  );
  assert.equal(
    util.formatNextRun(t, "2026-10-26T07:00:00.000Z", NOW),
    "ausstehend"
  );
  assert.equal(
    util.formatNextRun(
      t,
      "2026-10-26T22:30:00.000Z",
      Date.parse("2026-10-26T22:40:00.000Z")
    ),
    "morgen, 00:30 Uhr"
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
// AK-5: Punkt in der Seitenleiste, gecachte Abfrage
// ---------------------------------------------------------------------------

test(
  "AK-5: Der Zustand wird einmal abgefragt und 5 min gemerkt",
  { skip },
  async (tc) => {
    const calls = stubState(tc, "rot");
    assert.equal(await util.loadCourseStatusState(NOW), "rot");
    assert.equal(
      await util.loadCourseStatusState(NOW + util.STATE_CACHE_MS - 1),
      "rot"
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith("/embeds/course-status"));
    await util.loadCourseStatusState(NOW + util.STATE_CACHE_MS);
    assert.equal(calls.length, 2);
  }
);

/** Punkte im HTML der Seitenleiste: Zustand und Text für Screenreader. */
const dots = (html) =>
  [
    ...html.matchAll(
      /data-menu-dot="([^"]+)"[^>]*><span class="sr-only">([^<]*)<\/span>/g
    ),
  ].map(([, state, label]) => ({ state, label }));

test(
  "AK-5: Rot: Punkt an „Status“ (Gruppe offen); zugeklappt am Kopf „Chatbot“",
  { skip },
  async (tc) => {
    stubState(tc, "rot");
    await util.loadCourseStatusState();
    const open = await renderer.render(SIDEBAR, {
      location: "/settings/chatbot/widgets",
    });
    assert.deepEqual(dots(open), [{ state: "rot", label: "Status: Rot" }]);
    const status = menuEntries(open).find((entry) => entry.label === "Status");
    assert.ok(status?.child);
    assert.ok(
      /href="\/settings\/chatbot\/status"><p[^>]*>Status<\/p><span data-menu-dot="rot"/.test(
        open
      )
    );

    const closed = await renderer.render(SIDEBAR, {
      location: "/settings/users",
      stored: { anything_llm_menu_chatbot_expanded: "false" },
    });
    assert.deepEqual(dots(closed), [{ state: "rot", label: "Status: Rot" }]);
    assert.ok(/<p[^>]*>Chatbot<\/p><span data-menu-dot="rot"/.test(closed));
  }
);

test(
  "AK-5: Gelb mit Text „Status: Gelb“; Grün und nicht eingerichtet ohne Punkt",
  { skip },
  async (tc) => {
    for (const [state, expected] of [
      ["gelb", [{ state: "gelb", label: "Status: Gelb" }]],
      ["gruen", []],
      ["nicht_eingerichtet", []],
    ]) {
      util.resetCourseStatusState();
      stubState(tc, state);
      await util.loadCourseStatusState();
      const html = await renderer.render(SIDEBAR, {
        location: "/settings/chatbot/widgets",
      });
      assert.deepEqual(dots(html), expected, state);
    }
  }
);

test(
  "AK-5: ohne geladenen Zustand kein Punkt (die Seitenleiste wartet nicht)",
  { skip },
  async () => {
    util.resetCourseStatusState();
    const html = await renderer.render(SIDEBAR, {
      location: "/settings/chatbot/widgets",
    });
    assert.deepEqual(dots(html), []);
  }
);
