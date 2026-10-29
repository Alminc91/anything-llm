// KB-10 Teil 2: Benachrichtigung per E-Mail bei einer Störung des
// Kursbestands (issues/P-kursbestand/KB-10-hinweis-und-benachrichtigung.md,
// „Teil 2: Umsetzung Benachrichtigung“, Vertrag wörtlich).
//
// Zwei SystemSettings:
//   kufer_course_status_contacts (schreibt nur die Pipeline über
//     container_setting/_updateSettings, nicht über HTTP: das Label steht
//     nicht in supportedFields, wie die Kursliste des Kursbestands):
//     {"version":1,"emails":["a@b.de",…],"at":"<ISO>"}
//     emails = contact_emails[*].email aus Kunden.json, bereinigt,
//     kleingeschrieben, dedupliziert, höchstens 10, jede gültig. Leere Liste
//     erlaubt.
//   kufer_course_status_notify (schreibt nur der Server über
//     POST /embeds/course-status/notify):
//     {"version":1,"enabled":true|false,"recipients":["…"]|null,
//      "updatedAt":"<ISO>"}
//     recipients null = die Kontaktadressen gelten; sonst 1 bis 5 gültige
//     Adressen, kleingeschrieben, dedupliziert. Fehlt der Wert: enabled true,
//     recipients null.
// Wirksame Empfänger (eine Stelle, /v1/course-status und Status-Seite):
// eigene, sonst Kontaktadressen, sonst []. Die Pipeline rechnet sie nicht
// selbst.
//
// Die Validatoren nehmen nur Werte in genau dieser Form an und geben den
// String unverändert zurück (die Pipeline prüft durch Rücklesen); sonst
// werfen sie, das Update wird abgelehnt, der alte Wert bleibt. Fehlertexte
// nennen nie eine Adresse: _updateSettings schreibt sie ins Protokoll.
// Die Kontaktadressen gehören dem Kunden dieser Instanz; sie gehen nur an
// angemeldete Nutzer der Instanz (Status-Seite) und an den API-Schlüssel.

const prisma = require("../prisma");

const CONTACTS_LABEL = "kufer_course_status_contacts";
const NOTIFY_LABEL = "kufer_course_status_notify";
const CONTRACT_VERSION = 1;
// Beide Werte sind klein (höchstens 10 bzw. 5 Adressen zu 254 Zeichen)
const SETTING_MAX_BYTES = 8 * 1024;
const EMAIL_MAX_LEN = 254;
const CONTACTS_MAX = 10;
const RECIPIENTS_MAX = 5;
// Eingabe der Seite: so viele Einträge vor dem Entfernen doppelter Adressen
const INPUT_MAX_ENTRIES = 20;
// Einfache Adressprüfung in Kleinschreibung, dieselbe Form wie die
// Kontaktadressen der Pipeline (collect_contact_emails.EMAIL_RE)
const EMAIL_RX = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DEFAULT_NOTIFY = Object.freeze({ enabled: true, recipients: null });

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Gültige Adresse in der gespeicherten Form (kleingeschrieben, getrimmt)?
 * @param {*} value
 * @returns {boolean}
 */
function isValidEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= EMAIL_MAX_LEN &&
    EMAIL_RX.test(value)
  );
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// Liste gültiger, verschiedener Adressen mit höchstens max Einträgen? null =
// in Ordnung, sonst der Grund (ohne Adresse)
function emailListProblem(list, max) {
  if (!Array.isArray(list)) return "keine Liste";
  if (list.length > max) return `mehr als ${max} Adressen`;
  if (!list.every(isValidEmail)) return "ungültige Adresse";
  if (new Set(list).size !== list.length) return "doppelte Adresse";
  return null;
}

// JSON-String des Vertrags lesen; {data} oder {problem}
function parseSetting(raw) {
  if (typeof raw !== "string") return { problem: "Wert ist kein JSON-String" };
  if (Buffer.byteLength(raw, "utf8") > SETTING_MAX_BYTES)
    return { problem: "größer als 8 KiB" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { problem: "kein gültiges JSON" };
  }
  if (!isPlainObject(data)) return { problem: "kein JSON-Objekt" };
  if (data.version !== CONTRACT_VERSION)
    return { problem: "version ist nicht 1" };
  return { data };
}

function contactsProblem(raw) {
  const { data, problem } = parseSetting(raw);
  if (problem) return { problem };
  const listProblem = emailListProblem(data.emails, CONTACTS_MAX);
  if (listProblem) return { problem: `emails: ${listProblem}` };
  if (!isTimestamp(data.at)) return { problem: "at ist kein Zeitpunkt" };
  return { data };
}

function notifyProblem(raw) {
  const { data, problem } = parseSetting(raw);
  if (problem) return { problem };
  if (typeof data.enabled !== "boolean")
    return { problem: "enabled ist kein Wahrheitswert" };
  if (data.recipients !== null) {
    const listProblem = emailListProblem(data.recipients, RECIPIENTS_MAX);
    if (listProblem) return { problem: `recipients: ${listProblem}` };
    if (data.recipients.length === 0)
      return { problem: "recipients ist leer (statt null)" };
  }
  if (!isTimestamp(data.updatedAt))
    return { problem: "updatedAt ist kein Zeitpunkt" };
  return { data };
}

/**
 * Validator kufer_course_status_contacts (AK-T2-3): leer -> null (Wert
 * entfernt); gültig nach Vertrag -> derselbe String; sonst Fehler.
 * @param {*} update
 * @returns {string|null}
 */
function validateCourseStatusContactsSetting(update) {
  if (update === null || update === undefined || update === "") return null;
  const { problem } = contactsProblem(update);
  if (problem) throw new Error(`${CONTACTS_LABEL}: ${problem}`);
  return update;
}

/**
 * Validator kufer_course_status_notify (AK-T2-3): leer -> null (es gilt der
 * Standard: an, Kontaktadressen); gültig nach Vertrag -> derselbe String;
 * sonst Fehler.
 * @param {*} update
 * @returns {string|null}
 */
function validateCourseStatusNotifySetting(update) {
  if (update === null || update === undefined || update === "") return null;
  const { problem } = notifyProblem(update);
  if (problem) throw new Error(`${NOTIFY_LABEL}: ${problem}`);
  return update;
}

/** Gespeicherter Wert eines Labels; wirft bei einem Lesefehler der Datenbank. */
async function readStored(label) {
  const row = await prisma.system_settings.findFirst({
    where: { label },
    select: { value: true },
  });
  return row?.value ?? null;
}

// Ein ungültiger gespeicherter Wert (etwa von Hand gesetzt) gilt als nicht
// vorhanden; ins Protokoll kommt nur der Grund, nie eine Adresse
function logInvalid(label, problem) {
  console.error(`${label}: gespeicherter Wert ungültig (${problem})`);
}

/**
 * Kontaktadressen der Instanz (Pipeline), sonst []. Wirft bei einem
 * Lesefehler der Datenbank.
 * @returns {Promise<string[]>}
 */
async function readContacts() {
  const raw = await readStored(CONTACTS_LABEL);
  if (raw === null || raw === "") return [];
  const { data, problem } = contactsProblem(raw);
  if (problem) {
    logInvalid(CONTACTS_LABEL, problem);
    return [];
  }
  return [...data.emails];
}

/**
 * Einstellung der Instanz; fehlt sie oder ist sie ungültig, der Standard
 * (an, Kontaktadressen). Wirft bei einem Lesefehler der Datenbank.
 * @returns {Promise<{enabled: boolean, recipients: string[]|null}>}
 */
async function readNotify() {
  const raw = await readStored(NOTIFY_LABEL);
  if (raw === null || raw === "") return { ...DEFAULT_NOTIFY };
  const { data, problem } = notifyProblem(raw);
  if (problem) {
    logInvalid(NOTIFY_LABEL, problem);
    return { ...DEFAULT_NOTIFY };
  }
  return {
    enabled: data.enabled,
    recipients: data.recipients === null ? null : [...data.recipients],
  };
}

/**
 * Wirksame Empfänger: eigene, sonst Kontaktadressen, sonst [].
 * @param {string[]|null} recipients
 * @param {string[]} contacts
 * @returns {string[]}
 */
function effectiveRecipients(recipients, contacts) {
  return [...(recipients ?? contacts)];
}

/**
 * Stand für die Status-Seite (AK-T2-1). Wirft bei einem Lesefehler.
 * @returns {Promise<{enabled: boolean, recipients: string[]|null, contacts: string[], effective: string[]}>}
 */
async function courseStatusNotifyState() {
  const [notify, contacts] = await Promise.all([readNotify(), readContacts()]);
  return {
    enabled: notify.enabled,
    recipients: notify.recipients,
    contacts,
    effective: effectiveRecipients(notify.recipients, contacts),
  };
}

/**
 * `notify` für /v1/course-status (AK-T2-4): enabled und die wirksamen
 * Empfänger. Wirft bei einem Lesefehler.
 * @returns {Promise<{enabled: boolean, recipients: string[]}>}
 */
async function courseStatusNotifyContract() {
  const { enabled, effective } = await courseStatusNotifyState();
  return { enabled, recipients: effective };
}

/**
 * Rumpf von POST /embeds/course-status/notify prüfen: {enabled: boolean,
 * recipients: string[]|null}. Adressen werden getrimmt, kleingeschrieben und
 * dedupliziert; eine leere Liste oder dieselben Adressen wie die
 * Kontaktadressen ergeben null (es gelten die Kontaktadressen, auch wenn die
 * Pipeline sie später ändert).
 * @param {*} body
 * @param {string[]} contacts
 * @returns {{value: {enabled: boolean, recipients: string[]|null}}|{error: {code: string, message: string, address?: string}}}
 */
function parseNotifyInput(body, contacts) {
  const invalid = {
    error: { code: "ungueltig", message: "Die Angaben sind ungültig." },
  };
  if (!isPlainObject(body) || typeof body.enabled !== "boolean") return invalid;
  // recipients muss mitkommen: ein fehlendes Feld setzte sonst still eigene
  // Empfänger zurück
  if (!Object.prototype.hasOwnProperty.call(body, "recipients")) return invalid;
  const input = body.recipients;
  if (input === null)
    return { value: { enabled: body.enabled, recipients: null } };
  if (!Array.isArray(input)) return invalid;
  if (input.length > INPUT_MAX_ENTRIES) return tooMany();

  const recipients = [];
  for (const entry of input) {
    if (typeof entry !== "string" || entry.length > EMAIL_MAX_LEN + 50)
      return typeof entry === "string" ? invalidAddress(entry) : invalid;
    const address = entry.trim().toLowerCase();
    if (address.length === 0) continue;
    if (!isValidEmail(address)) return invalidAddress(entry);
    if (!recipients.includes(address)) recipients.push(address);
  }
  if (recipients.length > RECIPIENTS_MAX) return tooMany();
  const sameAsContacts =
    recipients.length === contacts.length &&
    recipients.every((address) => contacts.includes(address));
  return {
    value: {
      enabled: body.enabled,
      recipients: recipients.length === 0 || sameAsContacts ? null : recipients,
    },
  };
}

function invalidAddress(entry) {
  const address = shorten(entry.trim());
  return {
    error: {
      code: "adresse",
      message: `„${address}“ ist keine gültige E-Mail-Adresse.`,
      address,
    },
  };
}

function tooMany() {
  return {
    error: {
      code: "zu_viele",
      message: `Bitte geben Sie höchstens ${RECIPIENTS_MAX} Empfänger an.`,
    },
  };
}

// Eingabe für die Meldung kürzen (die Seite zeigt sie im Hinweis)
function shorten(text) {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * Gespeicherte Form (Vertrag) einer geprüften Eingabe.
 * @param {{enabled: boolean, recipients: string[]|null}} value
 * @param {number} [now]
 * @returns {string}
 */
function notifySettingValue({ enabled, recipients }, now = Date.now()) {
  return JSON.stringify({
    version: CONTRACT_VERSION,
    enabled,
    recipients,
    updatedAt: new Date(now).toISOString(),
  });
}

module.exports = {
  CONTACTS_LABEL,
  NOTIFY_LABEL,
  RECIPIENTS_MAX,
  CONTACTS_MAX,
  validateCourseStatusContactsSetting,
  validateCourseStatusNotifySetting,
  readContacts,
  readNotify,
  effectiveRecipients,
  courseStatusNotifyState,
  courseStatusNotifyContract,
  parseNotifyInput,
  notifySettingValue,
};
