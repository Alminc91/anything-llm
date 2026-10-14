import { useEffect, useState } from "react";
import { WIDE_QUERY, isWide } from "@/utils/conversationView";

// Gemeinsame Hooks der Ansicht „Konversationen“ – je eine Stelle statt
// Kopien in Liste, Panel, Exportmenü und Kopfzeile (Fixliste 7, F23/F24).

/**
 * Breiter Bildschirm (ab lg: Panel neben der Liste)? Folgt Größenänderungen.
 * Der Startwert kommt aus isWide() – derselben Prüfung wie überall in der
 * Ansicht, auch ohne matchMedia (dann false).
 * @returns {boolean}
 */
export function useWide() {
  const [wide, setWide] = useState(isWide);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(WIDE_QUERY);
    if (!media?.addEventListener) return;
    const update = () => setWide(!!media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

/**
 * Schließt ein aufgeklapptes Element – Menü, Auswahl – bei einem Klick
 * außerhalb und bei Escape: eine Stelle für das Exportmenü, das Menü „⋯“
 * und die Widget-Auswahl (Fixliste 7, F24, B5).
 *
 * Escape wird für das Element verbraucht (preventDefault): Das Seitenpanel
 * darunter achtet auf defaultPrevented und bleibt offen. Danach geht der
 * Fokus auf den Auslöser (focusRef) zurück, statt im Leeren zu stehen. Ein
 * Klick außerhalb lässt den Fokus, wo der Klick ihn hinsetzt.
 * @param {{current: Element|null}} ref - das Element samt Auslöser
 * @param {boolean} open
 * @param {() => void} onClose - stabil (useCallback/setState)
 * @param {{focusRef?: {current: HTMLElement|null}}} [options]
 */
export function useDismiss(ref, open, onClose, { focusRef = null } = {}) {
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    function handleMouseDown(event) {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    }
    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      focusRef?.current?.focus?.();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [ref, open, onClose, focusRef]);
}
