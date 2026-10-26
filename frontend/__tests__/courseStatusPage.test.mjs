// KB-3: Seite „Status“ (Mockup Tafel 3) mit React DOM in einem Dokument ohne
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

/** Antwort des Servers für ein gelbes Kursprogramm, sonst wie angegeben. */
function answer(overrides = {}) {
  return {
    state: "gelb",
    since: "2026-10-26T09:00:00.000Z",
    reason: "fehlen",
    whoActs: "kufer",
    counts: { offered: 864, count: 844, missing: 20, hidden: 2 },
    missing: missing(20),
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
    estimatedEnd: true,
    workspace: { name: "VHS Beispiel" },
    widgets: [
      { id: 3, name: "VHS Beispiel" },
      { id: 9, name: "VHS Beispiel" },
    ],
    visitors: { count: 844, word: "Kurse" },
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
        "Im KI-Berater sind alle aktuellen Kurse aus Ihrem Kursprogramm (KuferSQL), stündlich abgeglichen. Hier stehen nur Abweichungen."
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
    const banner = find(container, "data-course-status-banner", "gelb");
    assert.equal(
      banner.textContent,
      "Einzelne Kurse fehlen im KI-Berater20 von 864 Kursen sind zurzeit nicht eingelernt. Kufer ist informiert. Meist erledigt sich das mit dem nächsten stündlichen Abgleich."
    );
    const kpi = (key) => find(container, "data-course-kpi", key).textContent;
    assert.equal(kpi("offered"), "Im Kursprogramm864");
    assert.equal(kpi("count"), "Im KI-Berater844");
    assert.equal(kpi("missing"), "Fehlen20(2 %)");
    assert.equal(kpi("hidden"), "Ausgeblendet2");

    const missingList = find(container, "data-course-list", "missing");
    assert.ok(missingList.textContent.startsWith("Fehlende Kurse (20)"));
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
    assert.ok(sync.textContent.endsWith("Besucher sehenaktuell 844 Kurse"));
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
  "AK-3: Lauf mit Störung: Ergebnis im Abgleich; Besucher ohne Kursanzahl",
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
    assert.ok(sync.includes("ErgebnisKursprogramm unvollständig geliefert"));
    assert.ok(sync.endsWith("Besucher sehenkeine Kursanzahl"));
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
        counts: { offered: 864, count: 844, missing: 20, hidden: 0 },
        hidden: [],
      })
    );
    assert.ok(!nothingHidden.text.includes(NOTICE));
  }
);

// ---------------------------------------------------------------------------
// AK-6: Wer handelt
// ---------------------------------------------------------------------------

test(
  "AK-6: Kursprogramm nicht erreichbar: die Einrichtung handelt",
  { skip },
  async (t) => {
    const { container } = await open(
      t,
      answer({
        state: "rot",
        reason: "nicht_erreichbar",
        whoActs: "einrichtung",
        counts: { offered: 864, count: 864, missing: 0, hidden: 0 },
        missing: [],
        hidden: [],
        lastRun: {
          at: new Date().toISOString(),
          result: "nicht_geschrieben",
          cause: "feed_nicht_erreichbar",
        },
      })
    );
    assert.equal(
      find(container, "data-course-status-banner", "rot").textContent,
      "Ihr Kursprogramm ist nicht erreichbarSeit dem vorigen Abgleich ist Ihr Kursprogramm nicht erreichbar. Der KI-Berater nutzt den Stand des letzten erfolgreichen Abgleichs. Bitte prüfen Sie Webseite und Kursprogramm."
    );
    assert.equal(
      find(container, "data-course-who", "einrichtung").textContent,
      "Wer handeltIhre EinrichtungBitte prüfen Sie Webseite und Kursprogramm."
    );
  }
);

test(
  "AK-6: andere Ursache: Kufer handelt; bei Grün niemand",
  { skip },
  async (t) => {
    const yellow = await open(t, answer());
    assert.equal(
      find(yellow.container, "data-course-who", "kufer").textContent,
      "Wer handeltKuferKufer ist informiert."
    );
    await yellow.unmount();

    const green = await open(
      t,
      answer({
        state: "gruen",
        reason: null,
        whoActs: null,
        counts: { offered: 864, count: 864, missing: 0, hidden: 0 },
        missing: [],
        hidden: [],
      })
    );
    assert.equal(
      find(green.container, "data-course-status-banner", "gruen").textContent,
      "Alle Kurse sind im KI-BeraterAlle 864 Kurse aus Ihrem Kursprogramm sind eingelernt."
    );
    assert.equal(find(green.container, "data-course-who"), undefined);
    assert.ok(!green.text.includes("Kufer ist informiert"));
    assert.ok(!green.text.includes("Bitte prüfen Sie"));
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
        reason: null,
        whoActs: null,
        counts: null,
        missing: [],
        hidden: [],
        lastRun: null,
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
      ["listbox", "Alle 20 anzeigen"]
    );
  }
);

test(
  "Textregeln: keine Gedankenstriche, keine internen Begriffe",
  { skip },
  async (t) => {
    for (const body of [
      answer(),
      answer({ state: "rot", reason: "alter" }),
      answer({ state: "gelb", reason: "alter" }),
      answer({
        state: "rot",
        reason: "nicht_erreichbar",
        whoActs: "einrichtung",
      }),
    ]) {
      const page = await open(t, body);
      assert.doesNotMatch(page.text, /[–—]|Feed|Workspace|Schätzung\)/);
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
