import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import Embed from "@/models/embed";
import showToast from "@/utils/toast";
import { MUTED } from "@/utils/conversationView";

// KB-10 Teil 2 (Mockup Tafel 2, Version 10): Karte „Benachrichtigung per
// E-Mail“ unten auf der Seite „Kursbestand“. Die Einstellung gilt für die
// Instanz; Regeln für den Versand (Rot, 24 h, 3 Tage, 2 Tage, einmal je
// Woche) liegen in der Pipeline, die Seite beschreibt sie nur. Wirksame
// Empfänger und ob gespeichert werden darf (canEdit) sagt der Server.
// Ein Schalter für „Abgelaufene Kurse auf Ihrer Website“ ist bis KB-7
// ausgegraut und ohne Wirkung.

// Teal wie im Mockup (#0f766e); im dunklen Design heller (#14b8a6). Die
// Farbe „teal“ des Tailwind-Themes ist überschrieben, deshalb Hex-Werte.
const ACCENT_BORDER = "border-[#14b8a6] light:border-[#0f766e]";
const CHECKBOX =
  "mt-0.5 h-5 w-5 flex-none accent-[#14b8a6] light:accent-[#0f766e]";

/**
 * Feldinhalt in Adressen zerlegen: Komma (wie im Hinweis), aber auch
 * Semikolon und Leerraum trennen; leere Teile fallen weg. Prüfen und
 * bereinigen tut der Server.
 * @param {string} text
 * @returns {string[]}
 */
export function splitRecipients(text) {
  return String(text ?? "")
    .split(/[,;\s]+/)
    .filter((part) => part.length > 0);
}

/**
 * Antwort des Servers in der erwarteten Form? Sonst null (Ladefehler).
 * @param {*} data
 * @returns {object|null}
 */
export function readNotifyState(data) {
  const list = (value) =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (
    !data ||
    typeof data.enabled !== "boolean" ||
    !(data.recipients === null || list(data.recipients)) ||
    !list(data.contacts) ||
    !list(data.effective)
  )
    return null;
  return {
    enabled: data.enabled,
    recipients: data.recipients,
    contacts: data.contacts,
    canEdit: data.canEdit === true,
  };
}

/** Vorbelegung des Felds: eigene Empfänger, sonst die Kontaktadressen. */
function fieldText(state) {
  return (state.recipients ?? state.contacts).join(", ");
}

/**
 * Meldung zu einem Fehler beim Speichern (Code des Servers, übersetzt).
 * @param {Function} t
 * @param {{code?: string, address?: string|null}} result
 * @returns {string}
 */
export function saveErrorMessage(t, result) {
  const known = ["adresse", "zu_viele", "ungueltig", "fehler"];
  const code = known.includes(result?.code) ? result.code : "fehler";
  if (code === "adresse" && !result.address)
    return t("course-status.notify.errors.ungueltig");
  return t(`course-status.notify.errors.${code}`, {
    address: result?.address ?? "",
  });
}

export default function NotifyCard() {
  const { t } = useTranslation();
  const [state, setState] = useState(undefined);
  const [enabled, setEnabled] = useState(true);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const inputId = useId();
  const hintId = useId();

  useEffect(() => {
    let ignore = false;
    Embed.courseStatusNotify().then((data) => {
      if (ignore) return;
      const next = readNotifyState(data);
      setState(next);
      if (next) {
        setEnabled(next.enabled);
        setText(fieldText(next));
      }
    });
    return () => {
      ignore = true;
    };
  }, []);

  if (state === undefined) return null;

  async function save(event) {
    event.preventDefault();
    if (!state?.canEdit || saving) return;
    setSaving(true);
    const result = await Embed.saveCourseStatusNotify({
      enabled,
      recipients: splitRecipients(text),
    });
    setSaving(false);
    const next = result?.success === true ? readNotifyState(result) : null;
    if (!next) {
      showToast(saveErrorMessage(t, result), "error");
      return;
    }
    setState(next);
    setEnabled(next.enabled);
    setText(fieldText(next));
    showToast(t("course-status.notify.saved"), "success");
  }

  const readOnly = !state?.canEdit;
  return (
    <section
      data-course-notify=""
      aria-labelledby={`${inputId}-title`}
      className={`rounded-xl border-2 ${ACCENT_BORDER} bg-theme-bg-primary px-4 py-5 text-theme-text-primary sm:px-6`}
    >
      <div className="flex flex-col gap-1.5">
        <h3 id={`${inputId}-title`} className="text-lg font-bold">
          {t("course-status.notify.title")}
        </h3>
        <p data-course-notify-intro="" className={`text-sm ${MUTED}`}>
          {t("course-status.notify.intro")}
        </p>
      </div>

      {state === null ? (
        <p
          role="alert"
          data-course-notify-load-failed=""
          className="mt-4 text-sm"
        >
          {t("course-status.notify.load-failed")}
        </p>
      ) : (
        <form onSubmit={save} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-3.5">
            <label
              data-course-notify-option="disruption"
              className="flex items-start gap-3 text-[15px]"
            >
              <input
                type="checkbox"
                className={CHECKBOX}
                checked={enabled}
                disabled={readOnly}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-semibold">
                  {t("course-status.notify.disruption.label")}
                </span>
                <span className={`text-[13px] leading-normal ${MUTED}`}>
                  {t("course-status.notify.disruption.description")}
                </span>
              </span>
            </label>
            {/* Bis KB-7 ausgegraut und ohne Wirkung (Standard aus) */}
            <label
              data-course-notify-option="expired"
              className="flex items-start gap-3 text-[15px] opacity-60"
            >
              <input
                type="checkbox"
                className={CHECKBOX}
                checked={false}
                disabled
                readOnly
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-semibold">
                  {t("course-status.notify.expired.label")}
                </span>
                <span className="text-[13px] leading-normal">
                  {t("course-status.notify.expired.description")}
                </span>
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1.5">
              <label htmlFor={inputId} className="text-sm font-semibold">
                {t("course-status.notify.recipients")}
              </label>
              <input
                id={inputId}
                type="text"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                maxLength={2000}
                data-course-notify-recipients=""
                aria-describedby={hintId}
                value={text}
                readOnly={readOnly}
                onChange={(event) => setText(event.target.value)}
                className="block w-full min-w-0 rounded-lg border border-white/20 bg-theme-settings-input-bg px-3 py-2.5 text-sm text-theme-text-primary outline-none focus:border-[#14b8a6] light:border-gray-300 light:focus:border-[#0f766e] read-only:opacity-80"
              />
            </div>
            {!readOnly && (
              <button
                type="submit"
                data-course-notify-save=""
                disabled={saving}
                className="min-h-[44px] rounded-lg bg-[#0f766e] px-5 text-sm font-semibold text-white hover:bg-[#115e59] disabled:opacity-60"
              >
                {saving
                  ? t("course-status.notify.saving")
                  : t("course-status.notify.save")}
              </button>
            )}
          </div>
          <p
            id={hintId}
            data-course-notify-hint=""
            className={`text-[13px] ${MUTED}`}
          >
            {t("course-status.notify.hint")}
          </p>
        </form>
      )}
    </section>
  );
}
