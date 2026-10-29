/* eslint-env jest, node */
// KB-10 Teil 2: Benachrichtigung per E-Mail (utils/chats/courseStatusNotify.js)
//   AK-T2-3  Validatoren beider SystemSettings nach Vertrag
//   AK-T2-1  Prüfung der Eingabe der Seite (parseNotifyInput)
//   Vertrag  fixtures/courseStatusNotify/contract.json (liest auch die
//            Pipeline, test_course_status_sender.py)
const CONTRACT = require("../../fixtures/courseStatusNotify/contract.json");
const {
  CONTACTS_LABEL,
  NOTIFY_LABEL,
  validateCourseStatusContactsSetting: contacts,
  validateCourseStatusNotifySetting: notify,
  parseNotifyInput,
  notifySettingValue,
  effectiveRecipients,
} = require("../../../utils/chats/courseStatusNotify");

const AT = "2026-10-29T12:00:00.000Z";
const contactsValue = (emails, extra = {}) =>
  JSON.stringify({ version: 1, emails, at: AT, ...extra });
const notifyValue = (enabled, recipients, extra = {}) =>
  JSON.stringify({ version: 1, enabled, recipients, updatedAt: AT, ...extra });
const many = (n, domain = "vhs-beispiel.de") =>
  Array.from({ length: n }, (_, i) => `a${i}@${domain}`);

describe("Vertrag (Fixture, beide Repos)", () => {
  test("die Werte der Fixture nimmt der Validator unverändert an", () => {
    const raw = JSON.stringify(CONTRACT.contacts);
    expect(contacts(raw)).toBe(raw);
    for (const key of ["notifyOwn", "notifyOff"]) {
      const value = JSON.stringify(CONTRACT[key]);
      expect(notify(value)).toBe(value);
    }
  });

  test("wirksame Empfänger: eigene, sonst Kontaktadressen, sonst []", () => {
    const list = CONTRACT.contacts.emails;
    expect(effectiveRecipients(null, list)).toEqual(
      CONTRACT.v1NotifyDefault.recipients
    );
    expect(effectiveRecipients(CONTRACT.notifyOwn.recipients, list)).toEqual(
      CONTRACT.v1NotifyOwn.recipients
    );
    expect(effectiveRecipients(null, [])).toEqual([]);
  });
});

describe("AK-T2-3: kufer_course_status_contacts", () => {
  test("leer entfernt den Wert", () => {
    expect(contacts(null)).toBeNull();
    expect(contacts(undefined)).toBeNull();
    expect(contacts("")).toBeNull();
  });

  test("leere Liste und 10 Adressen sind erlaubt", () => {
    expect(contacts(contactsValue([]))).toBe(contactsValue([]));
    expect(contacts(contactsValue(many(10)))).toBe(contactsValue(many(10)));
  });

  test.each([
    ["kein JSON", "{"],
    ["kein String", { version: 1, emails: [], at: AT }],
    ["Liste statt Objekt", "[]"],
    ["version 2", contactsValue([], { version: 2 })],
    ["emails fehlt", JSON.stringify({ version: 1, at: AT })],
    ["mehr als 10", contactsValue(many(11))],
    ["Großschreibung", contactsValue(["Kontakt@vhs-beispiel.de"])],
    ["doppelt", contactsValue(["a@b.de", "a@b.de"])],
    ["ohne @", contactsValue(["kontakt.vhs-beispiel.de"])],
    ["Leerzeichen", contactsValue([" a@b.de"])],
    ["Zeilenumbruch", contactsValue(["a@b.de\nBcc: x@y.de"])],
    ["kein Text", contactsValue([42])],
    ["länger als 254", contactsValue([`${"a".repeat(250)}@b.de`])],
    ["at fehlt", JSON.stringify({ version: 1, emails: [] })],
    ["at kein Zeitpunkt", contactsValue([], { at: "gestern" })],
    ["größer als 8 KiB", contactsValue([], { pad: "x".repeat(9000) })],
  ])("abgelehnt: %s", (_name, value) => {
    expect(() => contacts(value)).toThrow(CONTACTS_LABEL);
  });

  test("Fehlertexte nennen keine Adresse (sie stehen im Protokoll)", () => {
    for (const value of [
      contactsValue(["Geheim@vhs-beispiel.de"]),
      contactsValue(["geheim@vhs-beispiel.de", "geheim@vhs-beispiel.de"]),
    ]) {
      let message = "";
      try {
        contacts(value);
      } catch (e) {
        message = e.message;
      }
      expect(message).not.toMatch(/geheim/i);
      expect(message).not.toMatch(/@/);
    }
  });
});

describe("AK-T2-3: kufer_course_status_notify", () => {
  test("recipients null oder 1 bis 5 Adressen", () => {
    for (const value of [
      notifyValue(true, null),
      notifyValue(false, null),
      notifyValue(true, many(1)),
      notifyValue(false, many(5)),
    ])
      expect(notify(value)).toBe(value);
  });

  test.each([
    [
      "enabled fehlt",
      JSON.stringify({ version: 1, recipients: null, updatedAt: AT }),
    ],
    ["enabled als Text", notifyValue("true", null)],
    ["recipients leer statt null", notifyValue(true, [])],
    ["mehr als 5", notifyValue(true, many(6))],
    ["Großschreibung", notifyValue(true, ["A@b.de"])],
    ["doppelt", notifyValue(true, ["a@b.de", "a@b.de"])],
    ["ungültig", notifyValue(true, ["a@b"])],
    [
      "recipients fehlt",
      JSON.stringify({ version: 1, enabled: true, updatedAt: AT }),
    ],
    [
      "updatedAt fehlt",
      JSON.stringify({ version: 1, enabled: true, recipients: null }),
    ],
    ["version 2", notifyValue(true, null, { version: 2 })],
  ])("abgelehnt: %s", (_name, value) => {
    expect(() => notify(value)).toThrow(NOTIFY_LABEL);
  });

  test("notifySettingValue erzeugt die Form des Vertrags", () => {
    const now = Date.parse("2026-10-29T12:05:00.000Z");
    const value = notifySettingValue(
      { enabled: true, recipients: ["kursbestand@vhs-beispiel.de"] },
      now
    );
    expect(JSON.parse(value)).toEqual(CONTRACT.notifyOwn);
    expect(notify(value)).toBe(value);
  });
});

describe("AK-T2-1: Eingabe der Seite (parseNotifyInput)", () => {
  const CONTACTS = ["kontakt@vhs-beispiel.de", "leitung@vhs-beispiel.de"];
  const parse = (body) => parseNotifyInput(body, CONTACTS);

  test("bereinigt, kleingeschrieben, dedupliziert", () => {
    expect(
      parse({
        enabled: true,
        recipients: [
          " Kurse@VHS-Beispiel.de ",
          "kurse@vhs-beispiel.de",
          "",
          "b@c.de",
        ],
      })
    ).toEqual({
      value: { enabled: true, recipients: ["kurse@vhs-beispiel.de", "b@c.de"] },
    });
  });

  test("leere Liste oder dieselben Adressen wie die Kontaktadressen: null", () => {
    expect(parse({ enabled: false, recipients: [] }).value).toEqual({
      enabled: false,
      recipients: null,
    });
    expect(parse({ enabled: true, recipients: ["  "] }).value.recipients).toBe(
      null
    );
    expect(
      parse({ enabled: true, recipients: [...CONTACTS].reverse() }).value
        .recipients
    ).toBeNull();
    expect(parse({ enabled: true, recipients: null }).value.recipients).toBe(
      null
    );
    // eine Teilmenge der Kontaktadressen ist eine eigene Liste
    expect(
      parse({ enabled: true, recipients: [CONTACTS[0]] }).value.recipients
    ).toEqual([CONTACTS[0]]);
  });

  test("höchstens 5 Adressen (nach dem Entfernen doppelter)", () => {
    expect(
      parse({ enabled: true, recipients: many(5) }).value.recipients
    ).toEqual(many(5));
    expect(
      parse({ enabled: true, recipients: [...many(5), "a0@vhs-beispiel.de"] })
        .value.recipients
    ).toHaveLength(5);
    expect(parse({ enabled: true, recipients: many(6) }).error).toEqual({
      code: "zu_viele",
      message: "Bitte geben Sie höchstens 5 Empfänger an.",
      max: 5,
    });
    expect(parse({ enabled: true, recipients: many(21) }).error.code).toBe(
      "zu_viele"
    );
  });

  test("bis zu 10 Kontaktadressen unverändert zurück: null statt zu_viele (Fixliste r1 Nr. 8)", () => {
    const contacts = many(8);
    for (const enabled of [true, false])
      expect(
        parseNotifyInput(
          { enabled, recipients: [...contacts].reverse() },
          contacts
        )
      ).toEqual({ value: { enabled, recipients: null } });
    // eine eigene Liste mit mehr als 5 Adressen bleibt zu viel
    expect(
      parseNotifyInput({ enabled: true, recipients: many(6) }, contacts).error
        .code
    ).toBe("zu_viele");
  });

  test("ungültige Adresse: Code, deutsche Meldung, die Eingabe gekürzt", () => {
    const { error } = parse({
      enabled: true,
      recipients: ["kontakt@vhs-beispiel.de", " keine-adresse "],
    });
    expect(error).toEqual({
      code: "adresse",
      message: "„keine-adresse“ ist keine gültige E-Mail-Adresse.",
      address: "keine-adresse",
    });
    const long = parse({ enabled: true, recipients: ["x".repeat(400)] }).error;
    expect(long.code).toBe("adresse");
    expect(long.address.length).toBeLessThanOrEqual(81);
    for (const bad of [
      "a@b",
      "a b@c.de",
      "a@b.de,c@d.de",
      "a@b.de\r\nBcc: c@d.de",
      "ä@b.de",
    ])
      expect(parse({ enabled: true, recipients: [bad] }).error.code).toBe(
        "adresse"
      );
  });

  test.each([
    ["kein Objekt", null],
    ["Liste", []],
    ["enabled fehlt", { recipients: null }],
    ["enabled als Text", { enabled: "true", recipients: null }],
    ["recipients fehlt", { enabled: false }],
    ["recipients undefined", { enabled: false, recipients: undefined }],
    ["recipients als Text", { enabled: true, recipients: "a@b.de" }],
    ["Eintrag kein Text", { enabled: true, recipients: [1] }],
    ["Eintrag Objekt", { enabled: true, recipients: [{ email: "a@b.de" }] }],
  ])("ungültiger Rumpf: %s", (_name, body) => {
    expect(parse(body).error).toEqual({
      code: "ungueltig",
      message: "Die Angaben sind ungültig.",
    });
  });
});
