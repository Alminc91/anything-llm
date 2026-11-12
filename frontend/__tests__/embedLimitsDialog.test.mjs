// widget-grenzen-kontakt (issues/widget-grenzen-kontakt.md): Dialoge
// „Einbettung aktualisieren“ und „Neue Einbettung“ der Widget-Liste sowie
// das Feld „E-Mail für Besucher“ im Design Center.
//   AK-1   Das Feld Nachrichtenverlauf sieht nur ein admin; manager und
//          default sehen es nicht.
//   NAK-2  Im Einbenutzerbetrieb (kein Nutzerobjekt) ist es verborgen (§11 E2).
//   AK-3   Standard im Dialog „Neue Einbettung“ 2 statt 20.
//   AK-4   Beschriftungen und Hinweise de nach §11 E3, en nach E4; kein
//          „Standard ist 20“ mehr.
//   AK-5   Hinweis zu „Fragen je Besucher und Tag“ mit „mindestens 10“.
//   AK-14  Design Center: Gruppe „Kontakt“, Feld „E-Mail für Besucher“,
//          Hinweis und Platzhalter nach §11 E6.
//   §7     Die übrigen Felder sehen alle Rollen wie bisher.
// Serverseitig gerendert (helpers/renderSettingsPage.mjs, render); das
// Formular selbst (enforceSubmissionSchema) mit FormData von Node.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer,
  hasFrontendDeps,
} from "./helpers/renderSettingsPage.mjs";
import de from "../src/locales/de/common.js";
import en from "../src/locales/en/common.js";

const DIR = "/src/pages/GeneralSettings/ChatEmbedWidgets";
const EDIT_MODAL = `${DIR}/EmbedConfigs/EmbedRow/EditEmbedModal/index.jsx`;
const NEW_MODAL = `${DIR}/EmbedConfigs/NewEmbedModal/index.jsx`;
const CONTENT = `${DIR}/EmbedAppearance/ContentTab.jsx`;
const skip = hasFrontendDeps
  ? false
  : "frontend/node_modules nicht installiert";

// Wortlaute nach §11 E3 (de) und E4 (en, Beschriftungen)
const LABELS = {
  de: {
    day: "Fragen aller Besucher je Tag",
    session: "Fragen je Besucher und Tag",
    history: "Nachrichtenverlauf für das Modell",
  },
  en: {
    day: "Questions from all visitors per day",
    session: "Questions per visitor per day",
    history: "Message history for the model",
  },
};
const HINTS = {
  de: {
    day: "So viele Fragen beantwortet der Chatbot an einem Kalendertag insgesamt. 0 oder leer: unbegrenzt.",
    session:
      "So viele Fragen kann ein Besucher an einem Kalendertag stellen. Empfohlen: mindestens 10. 0 oder leer: unbegrenzt.",
    history:
      "Frühere Nachrichten, die das Modell als Zusammenhang erhält. Standard und getesteter Wert: 2. Höhere Werte führen zu mehr falschen Antworten.",
  },
  en: {
    day: "This is how many questions the chatbot answers in total on one calendar day. 0 or empty: unlimited.",
    session:
      "This is how many questions one visitor can ask on one calendar day. Recommended: at least 10. 0 or empty: unlimited.",
    history:
      "Earlier messages the model receives as context. Default and tested value: 2. Higher values lead to more wrong answers.",
  },
};
const KEYS = {
  day: "max-chats-day",
  session: "max-chats-session",
  history: "message-limit",
};
// E6
const EMAIL_TITLE = "E-Mail für Besucher";
const EMAIL_HINT =
  "Besucher sehen diese Adresse im Chatfenster und in der Schlussantwort, wenn der Chatbot nicht weiterhelfen kann. Ohne Eintrag erscheint keine Adresse.";
const EMAIL_PLACEHOLDER = "info@ihre-vhs.de";

const DASH = /[–—]/;

let renderer;
before(async () => {
  if (hasFrontendDeps) renderer = await createRenderer();
});
after(async () => {
  await renderer?.close();
});

const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const inputTag = (html, name) =>
  html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? null;

/** Ein Widget, wie GET /embeds es liefert. */
const EMBED = {
  id: 4,
  uuid: "uuid-4",
  enabled: true,
  chat_mode: "query",
  allowlist_domains: null,
  max_chats_per_day: 300,
  max_chats_per_session: 12,
  message_limit: 2,
  chat_retention_days: 30,
  history_enabled: null,
  visual_config: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  workspace: { id: 7, name: "vhs Beispiel", slug: "vhs-beispiel" },
  _count: { embed_chats: 0 },
};

// Rollen; null = Einbenutzerbetrieb (kein Nutzerobjekt)
const ROLES = [
  ["admin", "admin", true],
  ["manager", "manager", false],
  ["default", "default", false],
  ["Einbenutzerbetrieb", null, false],
];

async function dialog(modulePath, role) {
  return await renderer.render(modulePath, {
    location: "/settings/chatbot/widgets",
    role,
    props:
      modulePath === EDIT_MODAL
        ? { embed: EMBED, closeModal() {} }
        : { closeModal() {} },
  });
}

// ---------------------------------------------------------------------------
// Texte (AK-4, AK-5, AK-13 für die Oberfläche)
// ---------------------------------------------------------------------------

test("AK-4, AK-5: Beschriftungen und Hinweise de nach E3, en nach E4", () => {
  for (const [lang, locale] of [
    ["de", de],
    ["en", en],
  ])
    for (const [field, key] of Object.entries(KEYS)) {
      assert.equal(
        locale["embed-modal"][key].label,
        LABELS[lang][field],
        `${lang} ${key}`
      );
      assert.equal(
        locale["embed-modal"][key].hint,
        HINTS[lang][field],
        `${lang} ${key}`
      );
    }
  assert.match(de["embed-modal"]["max-chats-session"].hint, /mindestens 10/);
  assert.match(en["embed-modal"]["max-chats-session"].hint, /at least 10/);
});

test("AK-4: kein „Standard ist 20“, keine 24 Stunden, keine Gedankenstriche, keine Gendersprache", () => {
  for (const locale of [de, en])
    for (const key of Object.values(KEYS)) {
      const { label, hint } = locale["embed-modal"][key];
      for (const value of [label, hint]) {
        assert.doesNotMatch(value, /\b20\b/, value);
        assert.doesNotMatch(value, /24/, value);
        assert.doesNotMatch(value, DASH, value);
        assert.doesNotMatch(value, /[*:_]innen|Innen\b/, value);
      }
    }
});

// ---------------------------------------------------------------------------
// Dialoge (AK-1, NAK-2, AK-3, §7)
// ---------------------------------------------------------------------------

for (const [modal, modulePath] of [
  ["Einbettung aktualisieren", EDIT_MODAL],
  ["Neue Einbettung", NEW_MODAL],
])
  for (const [name, role, sees] of ROLES)
    test(
      `${modal}, ${name}: Feld Nachrichtenverlauf ${sees ? "sichtbar" : "verborgen"}, die übrigen Felder wie bisher`,
      { skip },
      async () => {
        const html = await dialog(modulePath, role);
        const t = text(html);
        assert.equal(inputTag(html, "message_limit") !== null, sees);
        assert.equal(t.includes(LABELS.de.history), sees);
        assert.equal(t.includes(HINTS.de.history), sees);
        // §7: Workspace, Chat-Methode, Domains, Grenzen, Aufbewahrung
        for (const field of [
          "workspace_id",
          "chat_mode",
          "allowlist_domains",
          "chat_retention_days",
        ])
          assert.match(html, new RegExp(`name="${field}"`), field);
        for (const field of ["max_chats_per_day", "max_chats_per_session"])
          assert.ok(inputTag(html, field), field);
        for (const value of [
          LABELS.de.day,
          HINTS.de.day,
          LABELS.de.session,
          HINTS.de.session,
        ])
          assert.ok(t.includes(value), value);
        assert.doesNotMatch(t, /Standard ist 20|Max\. Chats/);
      }
    );

test(
  "AK-3: Neue Einbettung, admin: Nachrichtenverlauf vorbelegt mit 2",
  { skip },
  async () => {
    const html = await dialog(NEW_MODAL, "admin");
    assert.match(inputTag(html, "message_limit"), /value="2"/);
  }
);

test(
  "Einbettung aktualisieren, admin: gespeicherter Nachrichtenverlauf steht im Feld",
  { skip },
  async () => {
    const html = await renderer.render(EDIT_MODAL, {
      location: "/settings/chatbot/widgets",
      role: "admin",
      props: { embed: { ...EMBED, message_limit: 5 }, closeModal() {} },
    });
    assert.match(inputTag(html, "message_limit"), /value="5"/);
  }
);

test(
  "Formular: message_limit nur, wenn das Feld im Formular steht; leer heißt 2",
  { skip },
  async () => {
    const { enforceSubmissionSchema } = await renderer.load(NEW_MODAL);
    const form = (entries) => {
      const data = new FormData();
      for (const [key, value] of entries) data.append(key, value);
      return data;
    };
    // ohne Feld (manager, default, Einbenutzerbetrieb): kein Wert
    const hidden = enforceSubmissionSchema(
      form([
        ["workspace_id", "7"],
        ["max_chats_per_session", "12"],
      ])
    );
    assert.equal(Object.hasOwn(hidden, "message_limit"), false);
    assert.equal(hidden.max_chats_per_session, "12");
    // admin: leeres Feld = Standard 2, sonst der eingegebene Wert
    assert.equal(
      enforceSubmissionSchema(form([["message_limit", ""]])).message_limit,
      2
    );
    assert.equal(
      enforceSubmissionSchema(form([["message_limit", "6"]])).message_limit,
      "6"
    );
  }
);

// ---------------------------------------------------------------------------
// Design Center: E-Mail für Besucher (AK-14)
// ---------------------------------------------------------------------------

const noop = () => {};
const contentProps = (config) => ({
  config,
  initialConfig: config,
  errors: {},
  defaults: null,
  defaultsError: false,
  greetingKey: "greeting",
  updateField: noop,
  updateOptionalField: noop,
  resetKeys: noop,
  addListItem: noop,
  updateListItem: noop,
  removeListItem: noop,
});

test(
  "AK-14: Gruppe „Kontakt“, Feld „E-Mail für Besucher“ mit Hinweis und Platzhalter nach E6",
  { skip },
  async () => {
    for (const displayMode of [undefined, "inline"]) {
      const html = await renderer.render(CONTENT, {
        location: "/",
        props: contentProps({ displayMode }),
      });
      const t = text(html);
      const heading = t.lastIndexOf("Kontakt");
      assert.ok(heading >= 0, `${displayMode}: Gruppe Kontakt fehlt`);
      assert.match(html, /<h2[^>]*>Kontakt<\/h2>/);
      assert.doesNotMatch(html, /<h2[^>]*>Support<\/h2>/);
      const title = t.indexOf(`${EMAIL_TITLE} (optional)`);
      const hint = t.indexOf(EMAIL_HINT);
      assert.ok(heading < title && title < hint, `${displayMode}: Reihenfolge`);
      const input = html.match(/<input[^>]*type="email"[^>]*>/g);
      assert.equal(input.length, 1);
      assert.match(input[0], new RegExp(`placeholder="${EMAIL_PLACEHOLDER}"`));
      assert.doesNotMatch(t, /Support-E-Mail|Support-Link|support@ihre-seite/);
      assert.doesNotMatch(EMAIL_HINT, DASH);
    }
  }
);

test("AK-14: eine gespeicherte Adresse steht im Feld", { skip }, async () => {
  const html = await renderer.render(CONTENT, {
    location: "/",
    props: contentProps({ supportEmail: "info@vhs-beispiel.de" }),
  });
  assert.match(
    html.match(/<input[^>]*type="email"[^>]*>/)[0],
    /value="info@vhs-beispiel\.de"/
  );
});
