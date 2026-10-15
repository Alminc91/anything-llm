// Wortgleiche Kopie von anythingllm-embed src/utils/contrast.js (KIE-565
// Nachtrag). Bei einer Änderung dort auch hier ändern; nur die Formatierung
// folgt dem Prettier dieses Repos. Gegenprobe: Test designCenterTextOnAccent.
//
// Kontrast nach WCAG 2.x (KIE-565 Nachtrag, Punkt 2 und 4).
//
// Diese Datei ist bewusst ohne Importe geschrieben: Das Design Center im
// Fork (Empfehlung „Empfohlen: Weiß“ bzw. „Schwarz“ unter „Schrift auf der
// Kundenfarbe“, Warnung unter 4,5:1) übernimmt recommendedTextColor und die
// Hilfsfunktionen wortgleich, damit Widget und Design Center immer dieselbe
// Empfehlung zeigen.
//
// Regeln:
// - relative Luminanz nach WCAG 2.x: Kanal c = Wert / 255, linear
//   c <= 0,04045 ? c / 12,92 : ((c + 0,055) / 1,055) ^ 2,4,
//   L = 0,2126 R + 0,7152 G + 0,0722 B
// - Kontrast (L1 + 0,05) / (L2 + 0,05), L1 die hellere Farbe
// - Empfehlung (Schrift auf der Kundenfarbe): Kontrast der Kundenfarbe zu
//   den beiden Schriften, die das Widget wirklich zeigt, Weiß #FFFFFF und
//   „Schwarz“ #222628 (DARK_TEXT; Entscheidung E1 der Fixliste 7.22-rc7: so
//   speichert das Design Center „Schwarz“, und der Server liefert auch ein
//   früher gespeichertes #000000 als #222628 aus). Der höhere gewinnt, bei
//   Gleichstand Weiß. Ungültige Farbe: Weiß (bisheriger Standard). Auf
//   mittleren Kundenfarben (relative Luminanz etwa 0,18 bis 0,26) erreicht
//   keine der beiden 4,5:1; das Design Center warnt dann auch bei der
//   Empfehlung.
// - Pillen (accessibleTextColor) mischen weiter Richtung reinem Schwarz bzw.
//   Weiß (extremeTextColor).
// Farben: #rgb, #rrggbb, #rrggbbaa (Alpha wird ignoriert), rgb()/rgba().

export const WHITE = "#FFFFFF";
export const BLACK = "#000000";
// „Schwarz“ als Schrift auf der Kundenfarbe (Option im Design Center, Wert
// im Widget), Entscheidung E1
export const DARK_TEXT = "#222628";
export const MIN_TEXT_CONTRAST = 4.5;

// "#01a5a9" -> [1, 165, 169]; ungültig -> null
export function parseColor(color) {
  if (typeof color !== "string") return null;
  const c = color.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return [...m[1]].map((ch) => parseInt(ch + ch, 16));
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m =
    /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(
      c
    );
  if (m) {
    const rgb = m.slice(1, 4).map(Number);
    return rgb.every((v) => v <= 255) ? rgb : null;
  }
  return null;
}

// [r, g, b] -> "#RRGGBB"
export function toHex(rgb) {
  return `#${rgb
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

// relative Luminanz 0 … 1; ungültige Farbe -> null
export function relativeLuminance(color) {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Kontrastverhältnis 1 … 21; eine ungültige Farbe -> null
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Der höhere Kontrast von Weiß und dark auf background, bei Gleichstand
// Weiß; ungültige Farbe -> Weiß
function lighterOrDark(background, dark) {
  const white = contrastRatio(background, WHITE);
  const other = contrastRatio(background, dark);
  if (white === null || other === null) return WHITE;
  return white >= other ? WHITE : dark;
}

// Schrift auf der Kundenfarbe: "#FFFFFF" oder "#222628" (DARK_TEXT), mit
// den gezeigten Farben gerechnet (E1)
export function recommendedTextColor(background) {
  return lighterOrDark(background, DARK_TEXT);
}

// Richtung für lesbare Schrift auf einer Fläche: "#FFFFFF" oder "#000000"
export function extremeTextColor(background) {
  return lighterOrDark(background, BLACK);
}

// Kundenfarbe als Schrift auf einer oder mehreren Flächen (Pillen: Rand und
// Text in Kundenfarbe): die Farbe selbst, wenn sie auf allen Flächen
// mindestens minRatio erreicht, sonst schrittweise (1 %) Richtung Schwarz
// (helle Flächen) bzw. Weiß (dunkle Flächen) gemischt, bis sie es tut.
// Ergebnis "#RRGGBB"; ungültige Farbe oder Fläche -> null.
export function accessibleTextColor(
  color,
  backgrounds = [WHITE],
  minRatio = MIN_TEXT_CONTRAST
) {
  const rgb = parseColor(color);
  const list = Array.isArray(backgrounds) ? backgrounds : [backgrounds];
  if (!rgb || list.length === 0 || list.some((bg) => !parseColor(bg)))
    return null;
  // helle Fläche -> Richtung Schwarz, dunkle -> Richtung Weiß
  const target = parseColor(extremeTextColor(list[0]));
  for (let step = 0; step <= 100; step++) {
    const t = step / 100;
    const hex = toHex(rgb.map((v, i) => v * (1 - t) + target[i] * t));
    if (list.every((bg) => contrastRatio(hex, bg) >= minRatio)) return hex;
  }
  return toHex(target);
}
