// Korrekturrunde 8.2-rc2, F1 (issues/rollout-8.2/fixliste-8.2-rc2.md; Review
// R1, R19, Browser B1, B4; Klasse K1): Die Dialoge „Einbettung
// aktualisieren“ und „Neue Einbettung“ schicken jedes Feld, das im Formular
// steht, mit seinem Wert.
//   - Schalter: true oder false, wie er steht. Bis rc1 lieferte jeder
//     eingeschaltete Schalter den Formularwert "" (Toggle gibt value auch
//     ohne Wert weiter) und wurde als false gespeichert: „Frühere Chats“ ging
//     bei jedem Speichern aus, ein eingeschalteter Override ebenso.
//   - Zahlenfeld leer: null (§7 „0 oder leer: unbegrenzt“; bis rc1 fehlte der
//     Schlüssel und die alte Grenze blieb stehen). 0 und Zahlen wie getippt.
//   - Nachrichtenverlauf (nur admin): leer schickt null, den Standard setzt
//     der Server (F2); ohne Feld im Formular geht kein Schlüssel mit.
//   - Domains, Aufbewahrung und Workspace wie bisher.
// Die Dialoge hängen in einem Dokument ohne Browser (helpers/testDom.mjs,
// mount); abgeschickt wird über den Handler des Formulars. Was der Browser
// für das Formular bereitstellt (form.elements, name, type, Auswahl einer
// Liste und FormData nach der HTML-Regel), stellt withBrowserForms() unten
// nach; damit fällt auch ein Rückfall auf FormData auf.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import { createDocument, elements, handlersOf } from "./helpers/testDom.mjs";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets/EmbedConfigs";
const EDIT_MODAL = `${DIR}/EmbedRow/EditEmbedModal/index.jsx`;
const NEW_MODAL = `${DIR}/NewEmbedModal/index.jsx`;
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

let renderer;
before(async () => {
  if (!hasFrontendDeps) return;
  renderer = await createRenderer();
  // Nach dem Speichern lädt der Dialog die Seite neu (auch verzögert).
  globalThis.window.location = { reload() {} };
});
after(async () => {
  await renderer?.close();
});

/** Ein Widget, wie GET /embeds es liefert. */
const EMBED = {
  id: 4,
  uuid: "uuid-4",
  enabled: true,
  chat_mode: "chat",
  allowlist_domains: null,
  max_chats_per_day: 300,
  max_chats_per_session: 12,
  message_limit: 2,
  chat_retention_days: 30,
  history_enabled: null,
  allow_model_override: false,
  allow_temperature_override: false,
  allow_prompt_override: false,
  visual_config: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  workspace: { id: 7, name: "vhs Beispiel", slug: "vhs-beispiel" },
  _count: { embed_chats: 0 },
};
const WORKSPACES = [
  { id: 3, name: "Andere", slug: "andere" },
  { id: 7, name: "vhs Beispiel", slug: "vhs-beispiel" },
];
const SWITCHES = [
  "history_enabled",
  "allow_model_override",
  "allow_temperature_override",
  "allow_prompt_override",
];

// ---------------------------------------------------------------------------
// Was der Browser für ein Formular bereitstellt
// ---------------------------------------------------------------------------

const CONTROLS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);
const VALUE = Symbol("value");

/**
 * Gibt den Elementen des Test-Dokuments, was ein Browser für Formulare
 * bereitstellt: form.elements (Felder in Dokumentreihenfolge), name, type,
 * required und disabled aus den Attributen, value einer Option (Attribut
 * oder Text) und einer Auswahlliste (gewählte Option), value eines
 * Eingabefelds ohne gesetzten Wert ("on" bei Schalter und Auswahlknopf, sonst
 * das Attribut). React DOM wählt damit die Option einer Liste nach ihrem Wert
 * wie im Browser. Gilt für die Klasse der Elemente; jede Testdatei läuft in
 * einem eigenen Prozess (node --test), andere Dateien sind nicht berührt.
 */
function withBrowserForms() {
  const proto = Object.getPrototypeOf(createDocument().body);
  const reflect = (name) => ({
    configurable: true,
    get() {
      return this.getAttribute(name) ?? "";
    },
    set(value) {
      this.setAttribute(name, value);
    },
  });
  const flag = (name) => ({
    configurable: true,
    get() {
      return this.hasAttribute(name);
    },
    set(value) {
      if (value) this.setAttribute(name, "");
      else this.removeAttribute(name);
    },
  });
  Object.defineProperties(proto, {
    elements: {
      configurable: true,
      get() {
        return elements(this, (el) => CONTROLS.has(el.tagName));
      },
    },
    name: reflect("name"),
    required: flag("required"),
    disabled: flag("disabled"),
    type: {
      configurable: true,
      get() {
        if (this.tagName === "SELECT") return "select-one";
        if (this.tagName === "TEXTAREA") return "textarea";
        const fallback = this.tagName === "BUTTON" ? "submit" : "text";
        return (this.getAttribute("type") ?? fallback).toLowerCase();
      },
      set(value) {
        this.setAttribute("type", value);
      },
    },
    value: {
      configurable: true,
      get() {
        if (this.tagName === "OPTION")
          return this.getAttribute("value") ?? this.textContent;
        if (this.tagName === "SELECT") {
          const options = this.options;
          return (options.find((o) => o.selected) ?? options[0])?.value ?? "";
        }
        if (this[VALUE] !== undefined) return this[VALUE];
        const checkable = this.type === "checkbox" || this.type === "radio";
        return this.getAttribute("value") ?? (checkable ? "on" : "");
      },
      set(value) {
        if (this.tagName === "OPTION") this.setAttribute("value", value);
        else this[VALUE] = String(value);
      },
    },
  });
}
withBrowserForms();

/**
 * FormData mit einem Formular wie im Browser (HTML „constructing the entry
 * list“): benannte, nicht gesperrte Felder ohne Schaltflächen; Schalter und
 * Auswahlknöpfe nur, wenn gewählt, jeweils mit ihrem Wert.
 */
const NodeFormData = globalThis.FormData;
class BrowserFormData extends NodeFormData {
  constructor(form) {
    super();
    if (!form) return;
    for (const field of form.elements) {
      if (!field.name || field.disabled || field.tagName === "BUTTON") continue;
      const checkable = field.type === "checkbox" || field.type === "radio";
      if (checkable && !field.checked) continue;
      this.append(field.name, field.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Dialog einhängen, Felder ändern, absenden
// ---------------------------------------------------------------------------

/** Server ersetzt: GET /workspaces, POST /embed/update/:id, POST /embeds/new. */
function stubServer(t) {
  const original = { fetch: globalThis.fetch, FormData: globalThis.FormData };
  const sent = [];
  globalThis.FormData = BrowserFormData;
  globalThis.fetch = async (url, init = {}) => {
    let answer = {};
    if (url.endsWith("/workspaces")) answer = { workspaces: WORKSPACES };
    else if (url.includes("/embed/update/")) {
      sent.push({ url, body: JSON.parse(init.body) });
      answer = { success: true, error: null };
    } else if (url.endsWith("/embeds/new")) {
      sent.push({ url, body: JSON.parse(init.body) });
      answer = { embed: { id: 9 }, error: null };
    }
    return { ok: true, status: 200, json: async () => answer };
  };
  t.after(() => {
    globalThis.fetch = original.fetch;
    globalThis.FormData = original.FormData;
  });
  return sent;
}

async function open(t, modulePath, { role = "admin", embed = EMBED } = {}) {
  const sent = stubServer(t);
  const mounted = await renderer.mount(modulePath, {
    location: "/settings/chatbot/widgets",
    role,
    props:
      modulePath === EDIT_MODAL
        ? { embed, closeModal() {} }
        : { closeModal() {} },
  });
  t.after(() => mounted.unmount());
  // Workspaces sind geladen
  await mounted.act();
  const form = elements(mounted.container, (el) => el.tagName === "FORM")[0];
  const field = (name) =>
    elements(form, (el) => el.getAttribute("name") === name)[0] ?? null;

  return {
    field,
    /** Tippen in ein Zahlenfeld: Der Browser ändert den Wert des Felds. */
    type(name, value) {
      field(name).value = value;
    },
    /** Klick auf einen Schalter. */
    async toggle(name) {
      const input = field(name);
      await mounted.act(() =>
        handlersOf(input).onChange({
          target: { checked: !input.checked },
          currentTarget: input,
        })
      );
    },
    /** Absenden; liefert den Rumpf der Anfrage an den Server. */
    async submit() {
      await mounted.act(() =>
        handlersOf(form).onSubmit({
          target: form,
          currentTarget: form,
          preventDefault() {},
        })
      );
      assert.equal(sent.length, 1, "genau eine Anfrage");
      return sent[0].body;
    },
  };
}

// ---------------------------------------------------------------------------
// Einbettung aktualisieren
// ---------------------------------------------------------------------------

test(
  "Einbettung aktualisieren, admin: Speichern ohne Änderung schickt jedes Feld mit seinem Wert",
  { skip },
  async (t) => {
    const dialog = await open(t, EDIT_MODAL, {
      embed: { ...EMBED, allow_model_override: true },
    });
    const body = await dialog.submit();
    assert.deepEqual(body, {
      workspace_id: "7",
      chat_mode: "chat",
      allowlist_domains: null,
      max_chats_per_day: "300",
      max_chats_per_session: "12",
      message_limit: "2",
      chat_retention_days: "30",
      // B1: NULL heißt an, der Schalter steht an und bleibt an
      history_enabled: true,
      // eingeschalteter Override wird true
      allow_model_override: true,
      allow_temperature_override: false,
      allow_prompt_override: false,
    });
  }
);

test(
  "Einbettung aktualisieren: geleerte Grenzfelder schicken null (R1), 0 und Zahlen wie getippt",
  { skip },
  async (t) => {
    for (const [day, session, expected] of [
      ["", "", [null, null]],
      ["0", "", ["0", null]],
      ["", "0", [null, "0"]],
      ["25", "8", ["25", "8"]],
    ]) {
      const dialog = await open(t, EDIT_MODAL, { role: "manager" });
      dialog.type("max_chats_per_day", day);
      dialog.type("max_chats_per_session", session);
      const body = await dialog.submit();
      assert.deepEqual(
        [body.max_chats_per_day, body.max_chats_per_session],
        expected,
        `getippt: „${day}“, „${session}“`
      );
    }
  }
);

test(
  "Einbettung aktualisieren: Schalter an und aus werden true und false",
  { skip },
  async (t) => {
    // alle Schalter umlegen: aus wird an, an wird aus
    const off = await open(t, EDIT_MODAL, { role: "default" });
    for (const name of SWITCHES) await off.toggle(name);
    assert.deepEqual(
      Object.fromEntries(
        SWITCHES.map((name) => [name, off.field(name).checked])
      ),
      {
        history_enabled: false,
        allow_model_override: true,
        allow_temperature_override: true,
        allow_prompt_override: true,
      }
    );
    let body = await off.submit();
    for (const name of SWITCHES)
      assert.equal(body[name], name !== "history_enabled", name);

    // „Frühere Chats“ gespeichert aus: bleibt aus, bis er umgelegt wird
    const stored = { ...EMBED, history_enabled: false };
    body = await (await open(t, EDIT_MODAL, { embed: stored })).submit();
    assert.equal(body.history_enabled, false);
    const on = await open(t, EDIT_MODAL, { embed: stored });
    await on.toggle("history_enabled");
    body = await on.submit();
    assert.equal(body.history_enabled, true);
  }
);

test(
  "Einbettung aktualisieren, admin: Nachrichtenverlauf leer schickt null, Platzhalter 2 (D6, B4, R19)",
  { skip },
  async (t) => {
    // gespeichert NULL: Feld leer, Platzhalter nennt den Standard
    const stored = await open(t, EDIT_MODAL, {
      embed: { ...EMBED, message_limit: null },
    });
    assert.equal(stored.field("message_limit").value, "");
    assert.equal(
      stored.field("message_limit").getAttribute("placeholder"),
      "2"
    );
    let body = await stored.submit();
    assert.ok(Object.hasOwn(body, "message_limit"));
    assert.equal(body.message_limit, null);

    // geleert: null, nicht die feste 2 des Frontends
    const cleared = await open(t, EDIT_MODAL);
    cleared.type("message_limit", "");
    body = await cleared.submit();
    assert.equal(body.message_limit, null);

    const typed = await open(t, EDIT_MODAL);
    typed.type("message_limit", "6");
    body = await typed.submit();
    assert.equal(body.message_limit, "6");
  }
);

for (const [name, role] of [
  ["manager", "manager"],
  ["default", "default"],
  ["Einbenutzerbetrieb", null],
])
  test(
    `Einbettung aktualisieren, ${name}: ohne Feld Nachrichtenverlauf kein Schlüssel message_limit`,
    { skip },
    async (t) => {
      const dialog = await open(t, EDIT_MODAL, { role });
      assert.equal(dialog.field("message_limit"), null);
      const body = await dialog.submit();
      assert.equal(Object.hasOwn(body, "message_limit"), false);
      assert.equal(body.history_enabled, true);
    }
  );

test(
  "Einbettung aktualisieren: Domains, Aufbewahrung und Workspace wie bisher",
  { skip },
  async (t) => {
    // Domains gespeichert: als Liste mit Komma; Aufbewahrung „Nie“: null
    const dialog = await open(t, EDIT_MODAL, {
      embed: {
        ...EMBED,
        allowlist_domains: JSON.stringify([
          "https://vhs-beispiel.de",
          "https://www.vhs-beispiel.de",
        ]),
        chat_retention_days: null,
      },
    });
    const body = await dialog.submit();
    assert.equal(
      body.allowlist_domains,
      "https://vhs-beispiel.de,https://www.vhs-beispiel.de"
    );
    assert.equal(body.chat_retention_days, null);
    assert.equal(body.workspace_id, "7");
    assert.equal(body.chat_mode, "chat");
  }
);

// ---------------------------------------------------------------------------
// Neue Einbettung
// ---------------------------------------------------------------------------

test(
  "Neue Einbettung, admin: „Frühere Chats“ an wird true, Overrides aus false, Nachrichtenverlauf 2",
  { skip },
  async (t) => {
    const dialog = await open(t, NEW_MODAL);
    assert.equal(dialog.field("message_limit").value, "2");
    const body = await dialog.submit();
    assert.deepEqual(
      Object.fromEntries(SWITCHES.map((name) => [name, body[name]])),
      {
        history_enabled: true,
        allow_model_override: false,
        allow_temperature_override: false,
        allow_prompt_override: false,
      }
    );
    assert.equal(body.message_limit, "2");
    assert.equal(body.chat_mode, "query");
    assert.equal(body.allowlist_domains, null);
    assert.equal(body.chat_retention_days, null);
    assert.equal(body.workspace_id, "3");
  }
);

test(
  "Neue Einbettung: Grenzfeld leer null, 0 und Zahl wie getippt; Schalter umgelegt",
  { skip },
  async (t) => {
    const dialog = await open(t, NEW_MODAL, { role: "manager" });
    dialog.type("max_chats_per_day", "");
    dialog.type("max_chats_per_session", "10");
    for (const name of SWITCHES) await dialog.toggle(name);
    const body = await dialog.submit();
    assert.equal(body.max_chats_per_day, null);
    assert.equal(body.max_chats_per_session, "10");
    assert.equal(body.history_enabled, false);
    for (const name of SWITCHES.slice(1)) assert.equal(body[name], true, name);
    assert.equal(Object.hasOwn(body, "message_limit"), false);

    const zero = await open(t, NEW_MODAL);
    zero.type("max_chats_per_session", "0");
    assert.equal((await zero.submit()).max_chats_per_session, "0");
  }
);

test(
  "Neue Einbettung, admin: Nachrichtenverlauf geleert schickt null (Standard setzt der Server, F2)",
  { skip },
  async (t) => {
    const dialog = await open(t, NEW_MODAL);
    assert.equal(
      dialog.field("message_limit").getAttribute("placeholder"),
      "2"
    );
    dialog.type("message_limit", "");
    const body = await dialog.submit();
    assert.ok(Object.hasOwn(body, "message_limit"));
    assert.equal(body.message_limit, null);
  }
);
