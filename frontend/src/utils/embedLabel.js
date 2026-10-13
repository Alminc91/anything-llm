// Wie ein Widget dem Nutzer genannt wird – an jeder Stelle der Oberfläche
// gleich: Auswahl der Ansicht „Konversationen", Widget-Liste, Dialog
// „bearbeiten", Kopfzeile des Design Centers.
//
// Ein Widget hat kein eigenes Namensfeld; es heißt wie sein Workspace. Kommt
// eine Bezeichnung in der Liste mehr als einmal vor (mehrere Widgets in einem
// Workspace oder zwei Workspaces mit demselben Namen), bekommen genau diese
// Einträge die Widget-Nummer als Zusatz („KuferMedia · Widget 3"). Die Nummer
// ist `embed.id`: Sie bleibt, wenn ein anderes Widget gelöscht wird, und steht
// auch im Ereignisprotokoll.

/**
 * @typedef {Object} EmbedLabel
 * @property {string} name   - Name des Workspaces; ohne Namen „Widget <Nummer>".
 * @property {string} suffix - Zusatz bei Mehrdeutigkeit („· Widget 3"), sonst "".
 * @property {string} label  - Name samt Zusatz, wie er in einer Auswahl steht.
 */

/** Name des Workspaces ohne Leerzeichen am Rand; mehrere Leerzeichen zählen als eines. */
function workspaceNameOf(embed) {
  const name = embed?.workspace?.name;
  return typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
}

/** Groß- und Kleinschreibung unterscheidet zwei Bezeichnungen nicht. */
const sameNameKey = (name) => name.normalize("NFC").toLowerCase();

/**
 * Die Bezeichnungen aller Widgets einer Liste. Ob ein Zusatz nötig ist, hängt
 * von den übrigen Einträgen ab – deshalb immer die ganze Liste übergeben, die
 * der Nutzer sieht.
 * @param {Array<{id: number, workspace?: {name?: string}|null}>|null} embeds
 * @param {(key: string, options?: object) => string} t - Übersetzungsfunktion (i18next)
 * @returns {Map<number, EmbedLabel>} - je Widget-Nummer die Bezeichnung
 */
export function embedLabels(embeds, t) {
  const entries = (Array.isArray(embeds) ? embeds : []).map((embed) => {
    const workspaceName = workspaceNameOf(embed);
    return {
      id: embed.id,
      named: workspaceName !== "",
      name:
        workspaceName ||
        t("embed-analytics.embed-label.unnamed", { id: embed.id }),
    };
  });

  const uses = new Map();
  for (const { name } of entries) {
    const key = sameNameKey(name);
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }

  const labels = new Map();
  for (const { id, named, name } of entries) {
    // „Widget 7" (ohne Workspace-Namen) nennt die Nummer schon.
    const ambiguous = named && uses.get(sameNameKey(name)) > 1;
    const suffix = ambiguous
      ? t("embed-analytics.embed-label.suffix", { id })
      : "";
    labels.set(id, {
      name,
      suffix,
      label: suffix ? `${name} ${suffix}` : name,
    });
  }
  return labels;
}

/** Sortierung der Sprache; eine unbekannte Sprachangabe fällt auf die des Systems zurück. */
function collatorFor(locale) {
  // Groß-/Kleinschreibung ordnet nicht („kufermedia" = „KuferMedia"), Ziffern
  // zählen als Zahl („Kurs 2" vor „Kurs 10").
  const options = { sensitivity: "accent", numeric: true };
  try {
    return new Intl.Collator(locale || undefined, options);
  } catch {
    return new Intl.Collator(undefined, options);
  }
}

/**
 * Die Widgets in der Reihenfolge einer Auswahl: alphabetisch nach Bezeichnung
 * in der Sortierung der Sprache (Umlaute bei ihren Grundbuchstaben), bei
 * gleicher Bezeichnung nach Widget-Nummer. Die übergebene Liste bleibt, wie
 * sie ist.
 * @template {{id: number}} T
 * @param {Array<T>|null} embeds
 * @param {Map<number, EmbedLabel>} labels - aus embedLabels() für dieselbe Liste
 * @param {string} [locale] - Sprache der Oberfläche, z. B. "de"
 * @returns {Array<T>}
 */
export function sortEmbedsByLabel(embeds, labels, locale) {
  const collator = collatorFor(locale);
  const nameOf = (embed) => labels.get(embed.id)?.name ?? "";
  return [...(Array.isArray(embeds) ? embeds : [])].sort(
    (a, b) => collator.compare(nameOf(a), nameOf(b)) || a.id - b.id
  );
}
