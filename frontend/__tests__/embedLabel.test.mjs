// Wie ein Widget dem Nutzer genannt wird (utils/embedLabel.js): der Name des
// Workspaces, die Widget-Nummer nur als Zusatz an mehrdeutigen Einträgen –
// und die Texte dazu in den Sprachdateien. Im deutschen Bereich „Chatbot"
// steht nirgends mehr „Embed".
//
// Die Funktionen sind rein; die Tests brauchen weder Vite noch React.
import test from "node:test";
import assert from "node:assert/strict";
import { embedLabels, sortEmbedsByLabel } from "../src/utils/embedLabel.js";
import de from "../src/locales/de/common.js";
import en from "../src/locales/en/common.js";

/** Text eines Schlüssels („embed-analytics.embed-label.suffix") aus einer Sprachdatei. */
const textOf = (resources, key) =>
  key.split(".").reduce((node, part) => node?.[part], resources);

/** Übersetzungsfunktion wie i18next, für die beiden Texte der Bezeichnung. */
const translate =
  (resources) =>
  (key, values = {}) => {
    const text = textOf(resources, key);
    assert.equal(typeof text, "string", `kein Text für ${key}`);
    return text.replace(/{{(\w+)}}/g, (_, name) => values[name]);
  };
const t = translate(de);

const widget = (id, name) => ({ id, workspace: { id: 100 + id, name } });
/** Bezeichnungen in der Reihenfolge der Liste. */
const labelsOf = (embeds, translation = t) =>
  embeds.map((embed) => embedLabels(embeds, translation).get(embed.id));

// ---------------------------------------------------------------------------
// Bezeichnung
// ---------------------------------------------------------------------------

test("Eindeutige Namen: nur der Name des Workspaces, kein Zusatz, kein „Embed“, keine Nummer", () => {
  const embeds = [
    widget(5, "Chatbot Elbe"),
    widget(2, "Chatbot Donau"),
    widget(9, "KuferMedia"),
  ];
  assert.deepEqual(labelsOf(embeds), [
    { name: "Chatbot Elbe", suffix: "", label: "Chatbot Elbe" },
    { name: "Chatbot Donau", suffix: "", label: "Chatbot Donau" },
    { name: "KuferMedia", suffix: "", label: "KuferMedia" },
  ]);
  // Ein einzelnes Widget ist immer eindeutig.
  assert.deepEqual(labelsOf([widget(5, "Chatbot Elbe")]), [
    { name: "Chatbot Elbe", suffix: "", label: "Chatbot Elbe" },
  ]);
});

test("Zwei Widgets im selben Workspace: beide mit der Widget-Nummer als Zusatz", () => {
  const workspace = { id: 1, name: "KuferMedia" };
  const embeds = [
    { id: 3, workspace },
    { id: 2, workspace },
  ];
  assert.deepEqual(labelsOf(embeds), [
    {
      name: "KuferMedia",
      suffix: "· Widget 3",
      label: "KuferMedia · Widget 3",
    },
    {
      name: "KuferMedia",
      suffix: "· Widget 2",
      label: "KuferMedia · Widget 2",
    },
  ]);
});

test("Zwei Workspaces mit gleichem Namen: beide mit Zusatz", () => {
  const embeds = [
    { id: 4, workspace: { id: 1, name: "Chatbot" } },
    { id: 8, workspace: { id: 2, name: "Chatbot" } },
  ];
  assert.deepEqual(
    labelsOf(embeds).map(({ label }) => label),
    ["Chatbot · Widget 4", "Chatbot · Widget 8"]
  );
});

test("Drei Widgets, zwei gleich benannt: Nur diese zwei bekommen den Zusatz", () => {
  const embeds = [
    widget(2, "KuferMedia"),
    widget(5, "Chatbot Elbe"),
    widget(3, "KuferMedia"),
  ];
  assert.deepEqual(
    labelsOf(embeds).map(({ label }) => label),
    ["KuferMedia · Widget 2", "Chatbot Elbe", "KuferMedia · Widget 3"]
  );
  // Fällt eines der beiden weg, steht das andere wieder ohne Zusatz – mit
  // derselben Nummer wie zuvor.
  assert.deepEqual(
    labelsOf(embeds.slice(1)).map(({ label }) => label),
    ["Chatbot Elbe", "KuferMedia"]
  );
});

test("Groß-/Kleinschreibung und Leerzeichen am Rand unterscheiden zwei Namen nicht", () => {
  const embeds = [
    widget(1, "KuferMedia"),
    widget(2, "  kufermedia "),
    widget(3, "KUFERMEDIA\t"),
    widget(4, "Kufer  Media"),
    widget(5, "Kufer Media"),
    widget(6, "Kufermedien"),
  ];
  assert.deepEqual(labelsOf(embeds), [
    {
      name: "KuferMedia",
      suffix: "· Widget 1",
      label: "KuferMedia · Widget 1",
    },
    // Der Name steht, wie er geschrieben ist – ohne die Leerzeichen am Rand.
    {
      name: "kufermedia",
      suffix: "· Widget 2",
      label: "kufermedia · Widget 2",
    },
    {
      name: "KUFERMEDIA",
      suffix: "· Widget 3",
      label: "KUFERMEDIA · Widget 3",
    },
    // Mehrere Leerzeichen zeigt der Browser als eines.
    {
      name: "Kufer Media",
      suffix: "· Widget 4",
      label: "Kufer Media · Widget 4",
    },
    {
      name: "Kufer Media",
      suffix: "· Widget 5",
      label: "Kufer Media · Widget 5",
    },
    { name: "Kufermedien", suffix: "", label: "Kufermedien" },
  ]);
  // Umlaute unterscheiden: „Baren" und „Bären" sind zwei Namen.
  assert.deepEqual(
    labelsOf([widget(1, "Bären"), widget(2, "Baren")]).map((l) => l.label),
    ["Bären", "Baren"]
  );
});

test("Fehlender oder leerer Workspace-Name: Rückfall „Widget <Nummer>“, ohne Zusatz", () => {
  const embeds = [
    { id: 7 },
    { id: 8, workspace: null },
    { id: 9, workspace: {} },
    { id: 10, workspace: { name: "" } },
    { id: 11, workspace: { name: "   " } },
    { id: 12, workspace: { name: null } },
    widget(13, "Chatbot Elbe"),
  ];
  assert.deepEqual(
    labelsOf(embeds),
    [7, 8, 9, 10, 11, 12]
      .map((id) => ({
        name: `Widget ${id}`,
        suffix: "",
        label: `Widget ${id}`,
      }))
      .concat({ name: "Chatbot Elbe", suffix: "", label: "Chatbot Elbe" })
  );

  // Heißt ein Workspace wie der Rückfall eines anderen Widgets, bleibt auch
  // das unterscheidbar.
  assert.deepEqual(
    labelsOf([{ id: 4 }, widget(9, "Widget 4")]).map(({ label }) => label),
    ["Widget 4", "Widget 4 · Widget 9"]
  );
});

test("Leere Liste und keine Liste: keine Bezeichnungen, kein Fehler", () => {
  for (const embeds of [[], null, undefined]) {
    assert.equal(embedLabels(embeds, t).size, 0);
    assert.deepEqual(sortEmbedsByLabel(embeds, new Map(), "de"), []);
  }
});

test("Englisch: derselbe Aufbau, der Bereich heißt dort ebenfalls „Widget“", () => {
  const embeds = [
    widget(2, "KuferMedia"),
    widget(3, "KuferMedia"),
    { id: 4 },
    widget(5, "Chatbot Elbe"),
  ];
  assert.deepEqual(
    labelsOf(embeds, translate(en)).map(({ label }) => label),
    [
      "KuferMedia · Widget 2",
      "KuferMedia · Widget 3",
      "Widget 4",
      "Chatbot Elbe",
    ]
  );
});

// ---------------------------------------------------------------------------
// Reihenfolge der Auswahl
// ---------------------------------------------------------------------------

/** Namen in der Reihenfolge der Auswahl. */
function sorted(embeds, locale = "de") {
  const labels = embedLabels(embeds, t);
  return sortEmbedsByLabel(embeds, labels, locale).map(
    (embed) => labels.get(embed.id).label
  );
}

test("Sortierung: alphabetisch in der Sortierung der Sprache – Umlaute bei ihren Grundbuchstaben", () => {
  const embeds = [
    widget(1, "Zweigstelle"),
    widget(2, "Österreich"),
    widget(3, "Ärzte"),
    widget(4, "Oper"),
    widget(5, "Arbeit"),
    widget(6, "Übersee"),
    widget(7, "Ulm"),
    widget(8, "chatbot Elbe"),
    widget(9, "Chatbot Donau"),
  ];
  assert.deepEqual(sorted(embeds), [
    "Arbeit",
    "Ärzte",
    "Chatbot Donau",
    "chatbot Elbe",
    "Oper",
    "Österreich",
    "Übersee",
    "Ulm",
    "Zweigstelle",
  ]);
  // Gegenprobe: Nach Zeichencode stünden die Umlaute am Ende, hinter
  // „Zweigstelle" und dem klein geschriebenen Namen.
  assert.deepEqual(
    embeds
      .map((embed) => embed.workspace.name)
      .sort()
      .slice(-5),
    ["Zweigstelle", "chatbot Elbe", "Ärzte", "Österreich", "Übersee"]
  );
});

test("Sortierung: bei gleicher Bezeichnung nach Widget-Nummer, Ziffern als Zahl", () => {
  assert.deepEqual(
    sorted([
      widget(12, "KuferMedia"),
      widget(3, "kufermedia"),
      widget(7, "KuferMedia"),
      widget(1, "Zentrale"),
      { id: 10 },
      { id: 9 },
      widget(20, "Kurs 10"),
      widget(21, "Kurs 2"),
    ]),
    [
      "kufermedia · Widget 3",
      "KuferMedia · Widget 7",
      "KuferMedia · Widget 12",
      "Kurs 2",
      "Kurs 10",
      "Widget 9",
      "Widget 10",
      "Zentrale",
    ]
  );
});

test("Sortierung: Die übergebene Liste bleibt, wie sie ist; eine unbekannte Sprachangabe ist kein Fehler", () => {
  const embeds = [widget(1, "Zweigstelle"), widget(2, "Arbeit")];
  const before = [...embeds];
  assert.deepEqual(sorted(embeds), ["Arbeit", "Zweigstelle"]);
  assert.deepEqual(embeds, before);
  for (const locale of [undefined, "", "de_DE", "nicht eine sprache"])
    assert.deepEqual(sorted(embeds, locale), ["Arbeit", "Zweigstelle"]);
});

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

test("Texte der Bezeichnung: Deutsch und Englisch ausformuliert, der alte Text „Embed #…“ entfällt", () => {
  for (const resources of [de, en]) {
    assert.deepEqual(resources["embed-analytics"]["embed-label"], {
      unnamed: "Widget {{id}}",
      suffix: "· Widget {{id}}",
    });
  }
  assert.equal(de["embed-analytics"]["select-embed"], "Widget wählen");
  assert.equal(en["embed-analytics"]["select-embed"], "Select widget");
});

/** Alle Texte unter einem Knoten der Sprachdatei, mit ihrem Schlüssel. */
function textsUnder(node, path, found = []) {
  if (typeof node === "string") found.push([path, node]);
  else if (node && typeof node === "object")
    for (const [key, value] of Object.entries(node))
      textsUnder(value, `${path}.${key}`, found);
  return found;
}

// Der Bereich „Chatbot" der deutschen Oberfläche: Ansicht „Konversationen",
// Widget-Liste mit ihren Dialogen und Meldungen, Einbettungscode. Diese
// Bereiche muss es geben.
const CHATBOT_SECTIONS = [
  "embed-analytics",
  "embeddable",
  "embed-row",
  "embed-modal",
  "code-snippet-modal",
];
// Menüpunkte der Einstellungs-Sidebar zum Bereich.
const CHATBOT_MENU = [
  "settings.embeds",
  "settings.chatbot",
  "settings.chatbot-widgets",
  "settings.chatbot-conversations",
  "settings.embed-chats",
];
// Meldungen und Rückfragen der Nachrichtentabelle. Die Tabelle wird mit
// KIE-538 entfernt – solange es die Texte gibt, gilt die Regel auch für sie.
const MESSAGE_TABLE_SECTIONS = [
  "toast.embed-chats",
  "embed-chats",
  "chat-row",
  "settings.chatbot-messages",
];

test("Deutsche Oberfläche: Im Bereich „Chatbot“ enthält kein sichtbarer Text das Wort „Embed“", () => {
  for (const section of [...CHATBOT_SECTIONS, ...CHATBOT_MENU])
    assert.ok(textOf(de, section), `Bereich ${section} fehlt`);

  const texts = [
    ...CHATBOT_SECTIONS,
    ...CHATBOT_MENU,
    ...MESSAGE_TABLE_SECTIONS,
  ].flatMap((section) => textsUnder(textOf(de, section), section));
  assert.ok(texts.length > 200, `nur ${texts.length} Texte geprüft`);

  // „Embed" als Wort oder Wortteil („Embed-Chats", „Embeds"); der technische
  // Begriff „Embedding(s)" ist ausgenommen.
  const embed = /embed(?!ding)/i;
  assert.match("Embed wählen", embed);
  assert.match("3 Embed-Chats gelöscht", embed);
  assert.match("Alle Embeds", embed);
  assert.doesNotMatch("Text-Embeddings", embed);
  assert.doesNotMatch("Einbettung", embed);
  assert.deepEqual(
    texts.filter(([, text]) => embed.test(text)),
    []
  );

  // Die genannten Meldungen im Wortlaut – solange es sie gibt.
  const expected = {
    "embed-analytics.select-embed": "Widget wählen",
    "toast.embed-chats.export-success":
      "Widget-Chats erfolgreich als {{name}} exportiert.",
    "toast.embed-chats.export-error":
      "Fehler beim Exportieren der Widget-Chats.",
    "embed-chats.clear-all-confirm":
      "Möchten Sie wirklich ALLE Widget-Chats löschen?\n\nDiese Aktion kann nicht rückgängig gemacht werden.",
    "embed-chats.clear-all-success":
      "{{count}} Widget-Chats erfolgreich gelöscht.",
    "embed-chats.clear-all-error": "Fehler beim Löschen der Widget-Chats.",
  };
  for (const [key, text] of Object.entries(expected)) {
    const actual = textOf(de, key);
    if (actual !== undefined) assert.equal(actual, text, key);
  }
});
