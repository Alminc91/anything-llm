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
// - Empfehlung: Kontrast der Kundenfarbe zu den tatsächlich gezeigten
//   Schriftfarben, Weiß #FFFFFF und „Schwarz“ #222628 (SHOWN_BLACK: so
//   speichert das Design Center „Schwarz“, so liefert der Server es aus,
//   Entscheidung E1 der Fixliste 7.22-rc7), der höhere gewinnt, bei
//   Gleichstand Weiß. Ungültige Farbe: Weiß (bisheriger Standard).
// Farben: #rgb, #rrggbb, #rrggbbaa (Alpha wird ignoriert), rgb()/rgba().

export const WHITE = "#FFFFFF";
export const BLACK = "#000000";
// „Schwarz“, wie es gezeigt wird (Design Center und Widget gleich, E1)
export const SHOWN_BLACK = "#222628";
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

// Schrift auf der Kundenfarbe: "#FFFFFF" oder "#222628" (SHOWN_BLACK), der
// höhere Kontrast gewinnt, bei Gleichstand Weiß; ungültige Farbe -> Weiß.
export function recommendedTextColor(background) {
  const white = contrastRatio(background, WHITE);
  const black = contrastRatio(background, SHOWN_BLACK);
  if (white === null || black === null) return WHITE;
  return white >= black ? WHITE : SHOWN_BLACK;
}

// Richtung zum Abdunkeln bzw. Aufhellen (accessibleTextColor): reines
// Schwarz für helle Flächen, Weiß für dunkle (nach WCAG wie bisher).
function extremeFor(background) {
  const white = contrastRatio(background, WHITE);
  const black = contrastRatio(background, BLACK);
  return white >= black ? WHITE : BLACK;
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
  const target = parseColor(extremeFor(list[0]));
  for (let step = 0; step <= 100; step++) {
    const t = step / 100;
    const hex = toHex(rgb.map((v, i) => v * (1 - t) + target[i] * t));
    if (list.every((bg) => contrastRatio(hex, bg) >= minRatio)) return hex;
  }
  return toHex(target);
}
