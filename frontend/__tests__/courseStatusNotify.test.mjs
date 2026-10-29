// KB-10 Teil 2, AK-T2-2: Karte „Benachrichtigung per E-Mail“ auf der Seite
// „Kursbestand“ (Mockup Tafel 2, Version 10, Texte wörtlich) mit React DOM
// in einem Dokument ohne Browser (helpers/renderSettingsPage.mjs, mount).
// Die Antworten des Servers sind ersetzt (GET /api/embed/course-status,
// GET und POST /api/embeds/course-status/notify); die Prüfung der Adressen
// und die Rollen prüft der Server
// (server/__tests__/endpoints/courseStatusNotifyEndpoints.test.js).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { elements, handlersOf } from "./helpers/testDom.mjs";

const VIEW =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/CourseStatus/index.jsx";
const CARD_MODULE =
  "/src/pages/GeneralSettings/ChatEmbedWidgets/CourseStatus/NotifyCard.jsx";
const STATUS = "/settings/chatbot/status";
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

let renderer;
let toasts = [];
before(async () => {
  if (!hasFrontendDeps) return;
  renderer = await createRenderer();
  // Dieselbe Instanz wie in utils/toast.js (Vite lädt Pakete wie Node)
  const { toast } = await import("react-toastify");
  toast.success = (message) => toasts.push({ type: "success", message });
  toast.error = (message) => toasts.push({ type: "error", message });
});
after(async () => {
  await renderer?.close();
});

const CONTACTS = ["kontakt@vhs-beispiel.de", "leitung@vhs-beispiel.de"];
const EMBEDS = [
  {
    id: 3,
    uuid: "uuid-3",
    workspace: { id: 100, name: "chatbot", slug: "chatbot" },
  },
];
const STATUS_ANSWER = {
  state: "gruen",
  headline: "aktuell",
  details: [],
  reasons: [],
  counts: { offered: 496, count: 496, missing: 0, hidden: 1 },
  missingPercent: 0,
  listApplied: true,
  notice: null,
  missing: [],
  hidden: [
    {
      knr: "261-7",
      title: "Yoga",
      start: "2026-09-02",
      duration: "6 Termine",
      offWebsite: false,
    },
  ],
  lastRun: { at: new Date().toISOString(), result: "ok", cause: null },
  syncedAt: new Date().toISOString(),
  estimatedEnd: true,
  workspace: { name: "chatbot" },
  widgets: [{ id: 3, name: "chatbot" }],
};
const notifyAnswer = (overrides = {}) => ({
  enabled: true,
  recipients: null,
  contacts: CONTACTS,
  effective: CONTACTS,
  canEdit: true,
  ...overrides,
});

const TEXT = {
  title: "Benachrichtigung per E-Mail",
  intro:
    "Wir schreiben Ihnen nur bei einer ernsten Störung und höchstens einmal pro Woche. Kufer wird in jedem Fall informiert und kümmert sich darum.",
  disruption: "Störung des Kursbestands",
  disruptionText:
    "Wenn mehr als 10\u00a0% Ihrer Kurse mindestens einen Tag lang im KI-Berater fehlen oder Ihr Kursprogramm seit mehr als 3 Tagen nicht aktualisiert werden konnte. Ist der Kursbestand danach 2 Tage lang wieder in Ordnung, erhalten Sie eine Bestätigung.",
  expired: "Abgelaufene Kurse auf Ihrer Website",
  expiredText:
    "Wenn mehr als 10\u00a0% der Kurse auf Ihrer Website bereits beendet sind. Verfügbar, sobald wir das Kursende genauer erkennen.",
  recipients: "Empfänger",
  save: "Speichern",
  hint: "Mehrere Adressen mit Komma trennen. Vorbelegt mit Ihrer Kontaktadresse. Ändern können das Administratoren und Manager.",
};

/**
 * fetch je Adresse für die Dauer eines Tests; POST an notify antwortet mit
 * save(body) => {status, body}.
 */
function stubServer(
  t,
  {
    status = STATUS_ANSWER,
    notify = notifyAnswer(),
    notifyStatus = 200,
    save = null,
  } = {}
) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url,
      method: options.method ?? "GET",
      body: options.body ?? null,
    });
    const reply = (code, body) => ({
      ok: code >= 200 && code < 300,
      status: code,
      json: async () => body,
    });
    if (url.includes("/embeds/course-status/notify")) {
      if (options.method === "POST") {
        const result = save?.(JSON.parse(options.body)) ?? {
          status: 500,
          body: {},
        };
        return reply(result.status, result.body);
      }
      return reply(notifyStatus, notify);
    }
    if (url.includes("/embed/course-status")) return reply(200, status);
    return reply(404, null);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

async function open(t, options = {}) {
  toasts = [];
  const calls = stubServer(t, options);
  const mounted = await renderer.mount(VIEW, {
    location: `${STATUS}?widget=3`,
    route: STATUS,
    props: { embeds: EMBEDS, lastActivity: null },
  });
  t.after(() => mounted.unmount());
  await mounted.act();
  await mounted.act();
  return { ...mounted, calls };
}

const find = (root, attribute, value = null) =>
  elements(root, (el) =>
    value === null
      ? el.hasAttribute(attribute)
      : el.getAttribute(attribute) === value
  )[0];
const card = (container) => find(container, "data-course-notify");
const byTag = (root, tag) => elements(root, (el) => el.tagName === tag);
const checkboxes = (root) =>
  byTag(root, "INPUT").filter((el) => el.getAttribute("type") === "checkbox");
const field = (root) => find(root, "data-course-notify-recipients");
const submit = (act, root) =>
  act(() =>
    handlersOf(byTag(root, "FORM")[0]).onSubmit({ preventDefault() {} })
  );

test(
  "AK-T2-2: Karte unten vor der Fußnote, Texte wörtlich, vorbelegt mit den Kontaktadressen",
  { skip },
  async (t) => {
    const { container, calls } = await open(t);
    const section = card(container);
    assert.ok(section, "Karte fehlt");
    assert.ok(
      calls.some((c) => c.url.endsWith("/embeds/course-status/notify"))
    );
    assert.equal(byTag(section, "H3")[0].textContent, TEXT.title);
    assert.equal(
      find(section, "data-course-notify-intro").textContent,
      TEXT.intro
    );
    assert.equal(
      find(section, "data-course-notify-option", "disruption").textContent,
      TEXT.disruption + TEXT.disruptionText
    );
    assert.equal(
      find(section, "data-course-notify-option", "expired").textContent,
      TEXT.expired + TEXT.expiredText
    );
    const [disruption, expired] = checkboxes(section);
    assert.equal(handlersOf(disruption).checked, true);
    assert.equal(handlersOf(disruption).disabled, false);
    assert.equal(handlersOf(expired).checked, false);
    assert.equal(handlersOf(expired).disabled, true);
    const label = byTag(section, "LABEL").find(
      (el) => el.textContent === TEXT.recipients
    );
    assert.ok(label);
    assert.equal(label.getAttribute("for"), field(section).getAttribute("id"));
    assert.equal(handlersOf(field(section)).value, CONTACTS.join(", "));
    assert.equal(
      find(section, "data-course-notify-save").textContent,
      TEXT.save
    );
    assert.equal(
      find(section, "data-course-notify-hint").textContent,
      TEXT.hint
    );

    // Reihenfolge: Listen, Karte, Fußnote (Hinweis „Seit 26.10.2026 …“)
    const order = elements(container, (el) =>
      ["data-course-list", "data-course-notify", "data-course-notice"].some(
        (name) => el.hasAttribute(name)
      )
    ).map((el) =>
      el.hasAttribute("data-course-notify")
        ? "karte"
        : el.hasAttribute("data-course-notice")
          ? "fussnote"
          : "liste"
    );
    assert.deepEqual(order, ["liste", "karte", "fussnote"]);
  }
);

test(
  "AK-T2-2: eigene Empfänger und ausgeschaltet werden angezeigt",
  { skip },
  async (t) => {
    const { container } = await open(t, {
      notify: notifyAnswer({
        enabled: false,
        recipients: ["kursbestand@vhs-beispiel.de"],
        effective: ["kursbestand@vhs-beispiel.de"],
      }),
    });
    const section = card(container);
    assert.equal(handlersOf(checkboxes(section)[0]).checked, false);
    assert.equal(
      handlersOf(field(section)).value,
      "kursbestand@vhs-beispiel.de"
    );
  }
);

test(
  "AK-T2-2: Speichern sendet Schalter und Adressen, Erfolg per Toast",
  { skip },
  async (t) => {
    const saved = [];
    const { container, act, calls } = await open(t, {
      save: (body) => {
        saved.push(body);
        return {
          status: 200,
          body: notifyAnswer({
            success: true,
            enabled: false,
            recipients: ["kurse@vhs-beispiel.de", "b@vhs-beispiel.de"],
            effective: ["kurse@vhs-beispiel.de", "b@vhs-beispiel.de"],
          }),
        };
      },
    });
    const section = card(container);
    await act(() =>
      handlersOf(checkboxes(section)[0]).onChange({
        target: { checked: false },
      })
    );
    await act(() =>
      handlersOf(field(section)).onChange({
        target: { value: " Kurse@VHS-Beispiel.de, b@vhs-beispiel.de ;" },
      })
    );
    await submit(act, section);
    await act();
    assert.deepEqual(saved, [
      {
        enabled: false,
        recipients: ["Kurse@VHS-Beispiel.de", "b@vhs-beispiel.de"],
      },
    ]);
    assert.ok(calls.some((c) => c.method === "POST"));
    // Feld aus der Antwort des Servers (bereinigt)
    assert.equal(
      handlersOf(field(card(container))).value,
      "kurse@vhs-beispiel.de, b@vhs-beispiel.de"
    );
    assert.deepEqual(toasts, [
      { type: "success", message: "Benachrichtigung gespeichert." },
    ]);
  }
);

test(
  "AK-T2-2: Fehler beim Speichern per Toast, übersetzt nach Code",
  { skip },
  async (t) => {
    for (const [answer, message] of [
      [
        {
          status: 400,
          body: {
            success: false,
            code: "adresse",
            address: "kontakt@vhs",
            error: "x",
          },
        },
        "„kontakt@vhs“ ist keine gültige E-Mail-Adresse.",
      ],
      [
        {
          status: 400,
          body: {
            success: false,
            code: "zu_viele",
            address: null,
            max: 5,
            error: "x",
          },
        },
        "Bitte geben Sie höchstens 5 Empfänger an.",
      ],
      [
        { status: 401, body: null },
        "Die Benachrichtigung konnte nicht gespeichert werden.",
      ],
      [
        { status: 500, body: { success: false, code: "unbekannt" } },
        "Die Benachrichtigung konnte nicht gespeichert werden.",
      ],
    ]) {
      await t.test(message, async (st) => {
        const { container, act } = await open(st, { save: () => answer });
        const before = handlersOf(field(card(container))).value;
        await submit(act, card(container));
        await act();
        assert.deepEqual(toasts, [{ type: "error", message }]);
        // die Eingabe bleibt stehen
        assert.equal(handlersOf(field(card(container))).value, before);
        // Fixliste r1 Nr. 14: Fehler der Eingabe auch am Feld (rot, per
        // aria-describedby), Fehler des Servers nur im Toast
        const input = field(card(container));
        const atField = find(card(container), "data-course-notify-field-error");
        if (["adresse", "zu_viele"].includes(answer.body?.code)) {
          assert.equal(input.getAttribute("aria-invalid"), "true");
          assert.equal(atField.textContent, message);
          assert.ok(
            input
              .getAttribute("aria-describedby")
              .split(" ")
              .includes(atField.getAttribute("id"))
          );
          // verschwindet beim nächsten Tippen
          await act(() =>
            handlersOf(input).onChange({ target: { value: `${before} ` } })
          );
          assert.equal(
            find(card(container), "data-course-notify-field-error"),
            undefined
          );
          assert.equal(
            field(card(container)).getAttribute("aria-invalid"),
            null
          );
        } else {
          assert.equal(atField, undefined);
          assert.equal(input.getAttribute("aria-invalid"), null);
        }
      });
    }
  }
);

test(
  "AK-T2-2: Rolle default nur lesend (canEdit false): kein Speichern, Schalter aus, Feld schreibgeschützt",
  { skip },
  async (t) => {
    const { container } = await open(t, {
      notify: notifyAnswer({ canEdit: false }),
    });
    const section = card(container);
    assert.equal(find(section, "data-course-notify-save"), undefined);
    assert.equal(handlersOf(checkboxes(section)[0]).disabled, true);
    assert.equal(handlersOf(field(section)).readOnly, true);
    assert.equal(handlersOf(field(section)).value, CONTACTS.join(", "));
    assert.equal(
      find(section, "data-course-notify-hint").textContent,
      TEXT.hint
    );
  }
);

// Die Einstellung lädt die Seite seit Fixliste r1 Nr. 9 parallel zum
// Status, also auch hier; die Karte erscheint trotzdem nicht
test("AK-T2-2: nicht eingerichtet: keine Karte", { skip }, async (t) => {
  const { container } = await open(t, {
    status: {
      state: "nicht_eingerichtet",
      workspace: { name: "chatbot" },
      widgets: [],
    },
  });
  assert.equal(card(container), undefined);
});

test(
  "Fixliste r1 Nr. 9: Einstellung parallel zum Status geladen, Widget-Wechsel lädt sie nicht neu und behält Eingaben",
  { skip },
  async (t) => {
    toasts = [];
    const calls = stubServer(t);
    const embeds = [
      ...EMBEDS,
      { id: 9, uuid: "uuid-9", workspace: EMBEDS[0].workspace },
    ];
    const mounted = await renderer.mount(VIEW, {
      location: `${STATUS}?widget=3`,
      route: STATUS,
      props: { embeds, lastActivity: null },
    });
    t.after(() => mounted.unmount());
    // Beide Abrufe starten im selben Durchgang, vor der ersten Antwort
    const firstStatus = calls.findIndex((c) =>
      c.url.includes("/embed/course-status")
    );
    const firstNotify = calls.findIndex((c) =>
      c.url.endsWith("/embeds/course-status/notify")
    );
    assert.ok(firstStatus >= 0 && firstNotify >= 0, JSON.stringify(calls));
    await mounted.act();
    await mounted.act();
    const { container, act } = mounted;
    await act(() =>
      handlersOf(checkboxes(card(container))[0]).onChange({
        target: { checked: false },
      })
    );
    await act(() =>
      handlersOf(field(card(container))).onChange({
        target: { value: "neu@vhs-beispiel.de" },
      })
    );
    // Widget 9 wählen (Auswahl öffnen, Option anklicken)
    const picker = elements(
      container,
      (el) => el.getAttribute("aria-haspopup") === "listbox"
    )[0];
    await act(() => handlersOf(picker).onClick({}));
    const option = elements(
      container,
      (el) =>
        el.getAttribute("role") === "option" &&
        el.getAttribute("aria-selected") === "false"
    )[0];
    await act(() => handlersOf(option).onClick({}));
    await act();
    await act();
    assert.ok(
      calls.filter((c) => c.url.includes("/embed/course-status")).length >= 2,
      "Status des zweiten Widgets nicht geladen"
    );
    assert.equal(
      calls.filter((c) => c.url.endsWith("/embeds/course-status/notify"))
        .length,
      1
    );
    assert.equal(
      handlersOf(field(card(container))).value,
      "neu@vhs-beispiel.de"
    );
    assert.equal(handlersOf(checkboxes(card(container))[0]).checked, false);
  }
);

test(
  "Fixliste r1 Nr. 10: bis zur Antwort Karte mit Titel und Ladezeile",
  { skip },
  async (t) => {
    toasts = [];
    stubServer(t);
    // Antwort der Einstellung zurückhalten
    const original = globalThis.fetch;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async (url, options) => {
      if (url.endsWith("/embeds/course-status/notify")) await held;
      return original(url, options);
    };
    const mounted = await renderer.mount(VIEW, {
      location: `${STATUS}?widget=3`,
      route: STATUS,
      props: { embeds: EMBEDS, lastActivity: null },
    });
    t.after(() => mounted.unmount());
    await mounted.act();
    await mounted.act();
    const section = card(mounted.container);
    assert.ok(section, "Karte fehlt während des Ladens");
    assert.equal(byTag(section, "H3")[0].textContent, TEXT.title);
    assert.equal(
      find(section, "data-course-notify-loading").textContent,
      "Laden..."
    );
    assert.equal(byTag(section, "FORM").length, 0);
    release();
    await mounted.act();
    await mounted.act();
    assert.equal(
      find(card(mounted.container), "data-course-notify-loading"),
      undefined
    );
    assert.equal(
      handlersOf(field(card(mounted.container))).value,
      CONTACTS.join(", ")
    );
  }
);

test(
  "Fixliste r1 Nr. 13: Feld „Empfänger“ mehrzeilig, Enter speichert nicht",
  { skip },
  async (t) => {
    const { container } = await open(t);
    const input = field(card(container));
    assert.equal(input.tagName, "TEXTAREA");
    assert.equal(Number(input.getAttribute("rows")), 2);
    // kein einzeiliges Feld mehr im Formular, das Enter absenden ließe
    assert.equal(
      byTag(card(container), "INPUT").filter(
        (el) => el.getAttribute("type") !== "checkbox"
      ).length,
      0
    );
  }
);

test(
  "Fixliste r1 Nr. 1, 11, 15: Farben über Theme-Variablen, Button weiß in beiden Designs",
  { skip },
  async (t) => {
    const { container } = await open(t);
    const section = card(container);
    const button = find(section, "data-course-notify-save");
    const classes = [section, button, ...checkboxes(section), field(section)]
      .map((el) => el.getAttribute("class"))
      .join(" ");
    // text-white wird im hellen Design umgebogen (index.css), feste
    // Hex-Farben folgen dem Design nicht
    assert.ok(!/\btext-white\b/.test(button.getAttribute("class")));
    assert.ok(!/#[0-9a-f]{3,6}/i.test(classes), classes);
    assert.match(
      button.getAttribute("class"),
      /text-\[color:var\(--course-notify-button-text\)\]/
    );
    const [, expired] = checkboxes(section);
    assert.match(expired.getAttribute("class"), /--course-notify-locked-/);
    const row = find(section, "data-course-notify-option", "expired");
    assert.ok(!/opacity-/.test(row.getAttribute("class")));

    const { readFileSync } = await import("node:fs");
    const css = readFileSync(
      new URL("../src/index.css", import.meta.url),
      "utf8"
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const block = (selector) => {
      const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
        (m) => m[1].trim() === selector && m[2].includes("--course-notify-")
      );
      assert.equal(blocks.length, 1, selector);
      return Object.fromEntries(
        [...blocks[0][2].matchAll(/(--course-notify-[\w-]+):\s*([^;]+);/g)].map(
          (m) => [m[1], m[2].trim()]
        )
      );
    };
    const dark = block(":root");
    const light = block('[data-theme="light"]');
    assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
    for (const theme of [dark, light]) {
      assert.equal(theme["--course-notify-button-text"], "#ffffff");
      assert.equal(theme["--course-notify-button-bg"], "#0f766e");
      assert.equal(theme["--course-notify-button-hover"], "#115e59");
    }
  }
);

test(
  "AK-T2-2: Ladefehler: Karte mit Hinweis statt Formular",
  { skip },
  async (t) => {
    const { container } = await open(t, { notifyStatus: 500, notify: null });
    const section = card(container);
    assert.equal(
      find(section, "data-course-notify-load-failed").textContent,
      "Die Benachrichtigung konnte nicht geladen werden. Bitte versuchen Sie es später erneut."
    );
    assert.equal(byTag(section, "FORM").length, 0);
  }
);

test(
  "splitRecipients: Komma, Semikolon und Leerraum trennen",
  { skip },
  async () => {
    const { splitRecipients, readNotifyState } =
      await renderer.load(CARD_MODULE);
    assert.deepEqual(splitRecipients(" a@b.de, c@d.de;e@f.de  g@h.de ,, "), [
      "a@b.de",
      "c@d.de",
      "e@f.de",
      "g@h.de",
    ]);
    assert.deepEqual(splitRecipients(""), []);
    assert.equal(readNotifyState({ state: "gruen" }), null);
    assert.equal(readNotifyState(notifyAnswer({ contacts: [1] })), null);
    assert.equal(readNotifyState(notifyAnswer()).canEdit, true);
  }
);

test(
  "Textregeln: de und en vollständig, keine Gedankenstriche, keine Gendersprache",
  { skip },
  async () => {
    const { resources } = await renderer.load("/src/locales/resources.js");
    const keysOf = (object, prefix = "") =>
      Object.entries(object).flatMap(([key, value]) =>
        typeof value === "object"
          ? keysOf(value, `${prefix}${key}.`)
          : [`${prefix}${key}`]
      );
    const de = resources.de.common["course-status"].notify;
    const en = resources.en.common["course-status"].notify;
    assert.deepEqual(keysOf(de).sort(), keysOf(en).sort());
    for (const text of [
      ...Object.values(TEXT),
      JSON.stringify(de),
      JSON.stringify(en),
    ]) {
      assert.ok(!/[–—]/.test(text), text);
      assert.ok(!/\*innen|:innen|Innen\b|_innen/.test(text), text);
    }
  }
);
