// Geräteklassen der Konversationsansicht (Fixliste 7.22-rc13, E15):
// Smartphone unter 768 px, Tablet 768 bis 1.279 px, Desktop ab 1.280 px.
// Eine Stelle für die Schwelle des Desktops (Review 7.22-rc15, C10): Aus ihr
// folgen die Tailwind-Stufe desktop: (tailwind.config.js, theme.extend.screens)
// und die Abfrage im Code (WIDE_QUERY in conversationView.js: aria-modal,
// inert, Escape). So laufen CSS und Code nicht auseinander, wenn sich die
// Schwelle ändert. Ohne Abhängigkeiten: tailwind.config.js lädt die Datei
// direkt.

/** Desktop ab dieser Fensterbreite (px): Verlauf neben der Liste (KIE-575). */
export const DESKTOP_MIN_WIDTH = 1280;

/** Wert der Tailwind-Stufe desktop: (theme.extend.screens.desktop). */
export const DESKTOP_SCREEN = `${DESKTOP_MIN_WIDTH}px`;
