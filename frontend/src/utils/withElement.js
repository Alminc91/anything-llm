import { cloneElement } from "react";

// Ein Element (Code, Link) mitten in einem übersetzten Satz: Die Sprachdatei
// hat einen Platzhalter ({{code}}, {{email}}), der beim Übersetzen durch die
// Marke ersetzt wird; an jeder Marke steht dann das Element. Kein <Trans>:
// Der Inhalt kann selbst spitze Klammern haben und würde dort als HTML
// gelesen (Fixliste r4 Nr. 13, NF-C4: eine Stelle für Design Center und
// Status-Seite).

/** Marke im übersetzten Satz, an der das Element steht. */
export const ELEMENT_MARK = "\u0000";

/**
 * Satz mit dem Element an jeder Marke.
 * @param {string} text - übersetzter Satz, der Platzhalter durch ELEMENT_MARK ersetzt
 * @param {JSX.Element} element
 * @returns {Array<string|JSX.Element>}
 */
export function withElement(text, element) {
  const [first, ...rest] = String(text).split(ELEMENT_MARK);
  return [
    first,
    ...rest.flatMap((after, i) => [cloneElement(element, { key: i }), after]),
  ];
}
