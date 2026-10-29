import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
//
// Den Zustand hält CourseStatusView (useCourseStatusNotify, Fixliste r1
// Nr. 9 und 10): einmal geladen, parallel zum Status; beim Wechsel des
// Widgets bleiben Schalter und ungespeicherter Text stehen.

// Farben über Theme-Variablen (index.css, --course-notify-*), nicht über
// text-white: das biegt das helle Design auf die dunkle Textfarbe um
// (Fixliste r1 Nr. 1, 11, 15)
const ACCENT_BORDER = "border-[color:var(--course-notify-accent)]";
const CHECKBOX =
  "mt-0.5 h-5 w-5 flex-none accent-[color:var(--course-notify-accent)]";
// Gesperrtes Kästchen selbst gezeichnet (das des Browsers ist im hellen
// Design fast weiß); immer leer, deshalb ohne Haken
const LOCKED_CHECKBOX =
  "mt-0.5 h-5 w-5 flex-none cursor-not-allowed appearance-none rounded border-2 border-[color:var(--course-notify-locked-border)] bg-[color:var(--course-notify-locked-bg)]";
const LOCKED_TEXT = "text-[color:var(--course-notify-locked-text)]";
const SAVE_BUTTON =
  "min-h-[44px] rounded-lg bg-[color:var(--course-notify-button-bg)] px-5 text-sm font-semibold text-[color:var(--course-notify-button-text)] hover:bg-[color:var(--course-notify-button-hover)] disabled:opacity-60";
const FIELD =
  "block w-full min-w-0 resize-none overflow-hidden rounded-lg border border-[color:var(--course-notify-field-border)] bg-theme-settings-input-bg px-3 py-2.5 text-sm leading-5 text-theme-text-primary outline-none focus:border-[color:var(--course-notify-accent)] read-only:opacity-80 aria-[invalid=true]:border-[color:var(--course-status-rot-text)]";
const FIELD_ERROR = "text-[13px] text-[color:var(--course-status-rot-text)]";
// Fehler, die an der Eingabe liegen und deshalb am Feld stehen; die übrigen
// (Server, Verbindung) nur als Toast
const FIELD_ERRORS = ["adresse", "zu_viele"];

/**
 * Feldinhalt in Adressen zerlegen: Komma (wie im Hinweis), aber auch
 * Semikolon und Leerraum (auch Zeilenumbruch) trennen; leere Teile fallen
 * weg. Prüfen und bereinigen tut der Server.
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
 * Übernommen werden nur enabled, die wirksamen Empfänger (effective, die
 * Regel rechnet der Server) und canEdit.
 * @param {*} data
 * @returns {{enabled: boolean, effective: string[], canEdit: boolean}|null}
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
    effective: [...data.effective],
    canEdit: data.canEdit === true,
  };
}

/**
 * Meldung zu einem Fehler beim Speichern (Code des Servers, übersetzt).
 * Die Liste der Codes schützt den Übersetzungsschlüssel.
 * @param {Function} t
 * @param {{code?: string, address?: string|null, max?: number|null}} result
 * @returns {string}
 */
export function saveErrorMessage(t, result) {
  const known = ["adresse", "zu_viele", "ungueltig", "fehler"];
  const code = known.includes(result?.code) ? result.code : "fehler";
  if (code === "adresse" && !result.address)
    return t("course-status.notify.errors.ungueltig");
  if (code === "zu_viele" && !Number.isInteger(result.max))
    return t("course-status.notify.errors.ungueltig");
  return t(`course-status.notify.errors.${code}`, {
    address: result?.address ?? "",
    max: result?.max ?? "",
  });
}

/**
 * Zustand der Karte für CourseStatusView: lädt die Einstellung einmal beim
 * Öffnen der Seite (nicht je Widget, sie gilt für die Instanz) und hält
 * Schalter, Feldinhalt, Fehler am Feld und das Speichern.
 * state: undefined = lädt, null = Ladefehler, sonst readNotifyState.
 */
export function useCourseStatusNotify() {
  const { t } = useTranslation();
  const [state, setState] = useState(undefined);
  const [enabled, setEnabled] = useState(true);
  const [text, setTextValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState(null);

  useEffect(() => {
    let ignore = false;
    Embed.courseStatusNotify().then((data) => {
      if (ignore) return;
      const next = readNotifyState(data);
      setState(next);
      if (next) {
        setEnabled(next.enabled);
        setTextValue(next.effective.join(", "));
      }
    });
    return () => {
      ignore = true;
    };
  }, []);

  // Der Fehler am Feld verschwindet beim nächsten Tippen
  const setText = useCallback((value) => {
    setTextValue(value);
    setFieldError(null);
  }, []);

  async function save() {
    if (!state?.canEdit || saving) return;
    setSaving(true);
    const result = await Embed.saveCourseStatusNotify({
      enabled,
      recipients: splitRecipients(text),
    });
    setSaving(false);
    const next = result?.success === true ? readNotifyState(result) : null;
    if (!next) {
      const message = saveErrorMessage(t, result);
      setFieldError(FIELD_ERRORS.includes(result?.code) ? message : null);
      showToast(message, "error");
      return;
    }
    setState(next);
    setEnabled(next.enabled);
    setTextValue(next.effective.join(", "));
    setFieldError(null);
    showToast(t("course-status.notify.saved"), "success");
  }

  return {
    state,
    enabled,
    setEnabled,
    text,
    setText,
    saving,
    fieldError,
    save,
  };
}

/**
 * Feld wächst mit dem Inhalt (mindestens 2 Zeilen über rows), damit alle
 * Empfänger auch am Handy zu sehen sind (Fixliste r1 Nr. 13).
 */
function useGrowingField(ref, text) {
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field?.style || typeof window === "undefined") return;
    const grow = () => {
      field.style.height = "auto";
      const border = field.offsetHeight - field.clientHeight;
      field.style.height = `${field.scrollHeight + border}px`;
    };
    grow();
    window.addEventListener("resize", grow);
    return () => window.removeEventListener("resize", grow);
  }, [ref, text]);
}

/**
 * @param {{notify: ReturnType<typeof useCourseStatusNotify>}} props
 */
export default function NotifyCard({ notify }) {
  const { t } = useTranslation();
  const { state, enabled, setEnabled, text, setText, saving, fieldError } =
    notify;
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const fieldRef = useRef(null);
  useGrowingField(fieldRef, text);

  const readOnly = !state?.canEdit;
  return (
    <section
      data-course-notify=""
      aria-labelledby={`${inputId}-title`}
      aria-busy={state === undefined ? "true" : undefined}
      className={`rounded-xl border-2 ${ACCENT_BORDER} bg-theme-bg-primary px-4 py-5 text-theme-text-primary sm:px-6`}
    >
      <div className="flex flex-col gap-1.5">
        <h3 id={`${inputId}-title`} className="text-lg font-bold">
          {t("course-status.notify.title")}
        </h3>
        {state === undefined ? (
          <p data-course-notify-loading="" className={`text-sm ${MUTED}`}>
            {t("common.loading")}
          </p>
        ) : (
          <p data-course-notify-intro="" className={`text-sm ${MUTED}`}>
            {t("course-status.notify.intro")}
          </p>
        )}
      </div>

      {state === null && (
        <p
          role="alert"
          data-course-notify-load-failed=""
          className="mt-4 text-sm"
        >
          {t("course-status.notify.load-failed")}
        </p>
      )}
      {state && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            notify.save();
          }}
          className="mt-4 flex flex-col gap-4"
        >
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
              className={`flex cursor-not-allowed items-start gap-3 text-[15px] ${LOCKED_TEXT}`}
            >
              <input
                type="checkbox"
                className={LOCKED_CHECKBOX}
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
              {/* Mehrzeilig (Fixliste r1 Nr. 13): Enter macht eine neue
                  Zeile, gespeichert wird nur über den Button */}
              <textarea
                ref={fieldRef}
                id={inputId}
                rows={2}
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                maxLength={2000}
                data-course-notify-recipients=""
                aria-invalid={fieldError ? "true" : undefined}
                aria-describedby={fieldError ? `${errorId} ${hintId}` : hintId}
                value={text}
                readOnly={readOnly}
                onChange={(event) => setText(event.target.value)}
                className={FIELD}
              />
              {fieldError && (
                <p
                  id={errorId}
                  data-course-notify-field-error=""
                  className={FIELD_ERROR}
                >
                  {fieldError}
                </p>
              )}
            </div>
            {!readOnly && (
              <button
                type="submit"
                data-course-notify-save=""
                disabled={saving}
                className={SAVE_BUTTON}
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
