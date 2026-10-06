// Kufer Design Center: Standardtexte des Embed-Widgets (Panel-Optik,
// Datenschutz- und KI-Hinweis) und die Prompt-Abschnitte des Karten-Modus.
//
// Standardtexte: wörtliche Kopie von PANEL_TEXTS im Embed-Repo
// (anythingllm-embed, src/utils/layout.js) — das Widget hat sie selbst, der
// öffentliche Endpunkt /embed/:id/config liefert sie NICHT aus. Nur das
// Design Center lädt sie (GET /embed/defaults?lang=de|en), um sie als Wert
// ins Feld zu setzen und „Auf Standardtext zurücksetzen“ anzubieten.
// Bei Änderungen im Widget hier nachziehen; der Jest-Test
// (__tests__/utils/chats/embedDefaults.test.js) vergleicht mit einer Kopie
// der Widget-Werte (fixtures/embedPanelTexts.json).
const EMBED_DEFAULT_TEXTS = {
  de: {
    greetingBubbleText:
      "Hallo! Ich bin Ihr digitaler Berater und arbeite mit künstlicher Intelligenz (KI). Beschreiben Sie, was Sie suchen, und ich finde passende Angebote.",
    privacyTitle: "Datenschutz:",
    privacyPoints: [
      "Ihre Anfragen bleiben auf Servern in Deutschland und werden nicht an Dritte weitergegeben.",
      "Mitarbeitende der Einrichtung können Gespräche zur Qualitätssicherung einsehen.",
      "Bitte teilen Sie nur Angaben, die für Ihre Anfrage nötig sind.",
    ],
    privacyButtonText: "Start",
    disclaimerText:
      "Ich bin eine KI und kann Fehler machen. Bitte überprüfen Sie meine Antworten.",
  },
  en: {
    greetingBubbleText:
      "Hello! I am your digital advisor and work with artificial intelligence (AI). Describe what you are looking for and I will find suitable offers.",
    privacyTitle: "Privacy:",
    privacyPoints: [
      "Your requests stay on servers in Germany and are not passed on to third parties.",
      "Staff of the institution may view conversations for quality assurance.",
      "Please only share information that is necessary for your request.",
    ],
    privacyButtonText: "Start",
    disclaimerText:
      "I am an AI and can make mistakes. Please double-check my answers.",
  },
};

// Sprache wie panelLanguage() im Widget: Sprachcode (2 Buchstaben, optional
// Region wie "en-GB"/"en_US"), nur Sprachen mit eigenen Texten; sonst "de".
function embedDefaultsLanguage(value) {
  const raw = typeof value === "string" ? value : "";
  const m = /^([a-z]{2})(?:[-_][a-z0-9]{1,8})?$/i.exec(raw.trim());
  const lang = m ? m[1].toLowerCase() : "de";
  return Object.prototype.hasOwnProperty.call(EMBED_DEFAULT_TEXTS, lang)
    ? lang
    : "de";
}

// Standardtexte einer Sprache unter den visual_config-Schlüsseln, die das
// Design Center bearbeitet; privacyText wie gespeichert: ein Punkt je Zeile.
function embedDefaultTexts(lang = "de") {
  const t = EMBED_DEFAULT_TEXTS[embedDefaultsLanguage(lang)];
  return {
    greetingBubbleText: t.greetingBubbleText,
    privacyTitle: t.privacyTitle,
    privacyText: t.privacyPoints.join("\n"),
    privacyButtonText: t.privacyButtonText,
    disclaimerText: t.disclaimerText,
  };
}

// Karten-Modus serverseitig (visual_config.courseCards = "auto"): einer der
// beiden Abschnitte wird ans ENDE des System-Prompts gehängt (nach der
// Zeitzeile, vor DISCLAIMER_PROMPT_NOTE/FOLLOW_UPS_PROMPT_NOTE), der gecachte
// Prompt-Präfix der Flotte bleibt unverändert. Quelle: Pipelines-Repo
// Kundendaten/Chatbot/prompt_rollout/v3_3_cards_search_section.txt („kurz“,
// courseCardsAnswerStyle "short", Standard) bzw. v3_3_cards_mode_section.txt
// („ausführlich“, "long": Liste mit Links). Gegenüber den Dateien ohne die
// Folgefragen-Regeln (Endzeile [[FRAGEN: …]], „keine Rückfrage im Text“):
// die deckt FOLLOW_UPS_PROMPT_NOTE ab, der nur bei followUps = "pills"
// angehängt wird. Die Teaser-Regel bleibt hier (keine andere Note hat sie).
const COURSE_CARDS_PROMPT_NOTE =
  "\n\n" +
  [
    "### Course Cards Mode — Search (ACTIVE — overrides the Course Information Blueprint)",
    "This workspace automatically shows a course card for every course you recommend. The cards show title, start date, weekday/time, duration, location, price, status and your teaser (see below) — and they are the link to the course. Therefore:",
    '▪ **Language check FIRST — before writing anything:** If you answer in a language other than German: first line `[[KARTEN: -]]` (mandatory — never omit this line), no TEASER lines, then answer in the classic style with the course links in the user\'s language. The cards are German, so for every non-German answer (English, Turkish, Ukrainian, Arabic, …) this mode is OFF: NEVER card numbers, NEVER teaser lines; present 1–3 courses with the Course Information Blueprint (translated labels, translated link texts, exact URLs). Example (question "Are there yoga classes in the evening?"):',
    "[[KARTEN: -]]",
    "Yes, there are two evening yoga courses:",
    "1. [**Yoga for Beginners**]($URL) …",
    "Card numbers and teasers below apply ONLY to answers in German.",
    '▪ **First line of EVERY German answer:** `[[KARTEN: n, n]]` — the numbers n of the context blocks with the courses you recommend, in the order of relevance. The numbers are exactly the block labels of [DOCUMENTS]: `[CONTEXT 0]` → 0, `[CONTEXT 1]` → 1 (counting starts at 0). Only use blocks that describe one single course (with a "Kurs-Link:" line). If you recommend no course — also for registration, contact, opening hours, greetings, general questions or no match — the first line is `[[KARTEN: -]]`. Then a line break and your answer. This line is removed automatically — never mention or explain it.',
    "▪ **Directly after the marker line — one teaser line per recommended course:** `[[TEASER n: …]]`. n is the same number as in the marker; exactly ONE line per course, in the same order as in the marker. The teaser is ONE sentence in [USER_LANG] with **15–20 words — never fewer than 15** (a main clause plus a short subordinate clause, like the example) that says why this course fits the user's question (content, level, target group, atmosphere). Do NOT repeat the course title, weekday, time, date, duration, price or location — the card shows them. No Markdown, no links. With `[[KARTEN: -]]` write NO teaser lines. These lines are removed automatically and shown on the card — never mention or explain them.",
    "▪ Your answer text is **one or two short sentences** that add what the cards cannot show: how many fitting courses there are, what distinguishes them (level, evening/morning, online/on site, already started), or which one fits the question best. Do NOT list the courses, do NOT repeat course titles, do NOT write any links, and do NOT write the Beginn/Ort/Leitung/Preis/Kurs/Status lines or the course description — the cards show all of this.",
    "▪ Recommend at most 5 courses in the marker (so at most 5 teaser lines).",
    "▪ The Mandatory Footer rules stay as they are (if a Footer Override is active, write no footer).",
    "▪ Only when the answer is about something other than courses (registration, contact, opening hours, general questions): answer as usual, with the normal links.",
    '▪ **Complete example** — the answer begins exactly like this, without code block (question: "Gibt es Yoga am Abend?", two fitting courses in [CONTEXT 3] and [CONTEXT 1]):',
    "[[KARTEN: 3, 1]]",
    "[[TEASER 3: Ideal für Einsteiger mit etwas Vorerfahrung, die sanfte Haltungen und bewusste Atmung in ruhigem Tempo üben möchten.]]",
    "[[TEASER 1: Für Geübte, die ihre Praxis mit kräftigenden Abfolgen vertiefen und danach längere Entspannungsphasen ganz bewusst genießen möchten.]]",
    "Ja, zwei Yogakurse am Abend passen: einer für den sanften Einstieg, einer zum Vertiefen Ihrer Praxis.",
    "",
    "*Ich bin eine KI und kann Fehler machen. Bitte überprüfen Sie meine Antworten.*",
    "▪ Everything else (Security Rules, Prime Directives, Translation Protocol, No Results Protocol) stays unchanged.",
  ].join("\n");

const COURSE_CARDS_LONG_PROMPT_NOTE =
  "\n\n" +
  [
    "### Course Cards Mode (ACTIVE — overrides the Course Information Blueprint)",
    "This workspace automatically shows a course card for every course you recommend. The cards already show start date, weekday/time, location, price and status. Therefore:",
    '▪ **Language check FIRST — before writing anything:** If you answer in a language other than German: first line `[[KARTEN: -]]` (mandatory — never omit this line), no TEASER lines, then answer in the classic style with the course links in the user\'s language. The cards are German, so for every non-German answer (English, Turkish, Ukrainian, Arabic, …) this mode is OFF: NEVER card numbers, NEVER teaser lines; present 1–3 courses with the Course Information Blueprint (translated labels, translated link texts, exact URLs). Example (question "Are there yoga classes in the evening?"):',
    "[[KARTEN: -]]",
    "Yes, there are two evening yoga courses:",
    "1. [**Yoga for Beginners**]($URL) …",
    "Card numbers and teasers below apply ONLY to answers in German.",
    '▪ **First line of EVERY German answer:** `[[KARTEN: n, n]]` — the numbers n of the context blocks with the courses you recommend, in the order you list them. The numbers are exactly the block labels of [DOCUMENTS]: `[CONTEXT 0]` → 0, `[CONTEXT 1]` → 1 (counting starts at 0). Only use blocks that describe one single course (with a "Kurs-Link:" line). If you recommend no course — also for registration, contact, opening hours, greetings, general questions or no match — the first line is `[[KARTEN: -]]`. Then a line break and your answer. This line is removed automatically — never mention or explain it.',
    "▪ **Directly after the marker line — one teaser line per recommended course:** `[[TEASER n: …]]`. n is the same number as in the marker; exactly ONE line per course, in the same order as in the marker. The teaser is ONE sentence in [USER_LANG] with **15–20 words — never fewer than 15** (a main clause plus a short subordinate clause, like the example) that says why this course fits the user's question (content, level, target group, atmosphere). Do NOT repeat the course title, weekday, time, date, duration, price or location — the card shows them. No Markdown, no links. With `[[KARTEN: -]]` write NO teaser lines. These lines are removed automatically and shown on the card — never mention or explain them.",
    '▪ When listing courses, write 1–2 short sentences that answer the question (e.g. which courses fit, when they take place in general, what the difference is), then a numbered list with **only** the course title as a Markdown link: `1. [**$COURSE_TITLE**]($URL)` — optionally followed by at most 6 words of reason (e.g. "– abends, für Anfänger").',
    "▪ Do NOT write the Beginn/Ort/Leitung/Preis/Kurs/Status lines or the course description — the cards show these.",
    "▪ List at most 3 courses. Every listed course MUST be linked with its exact URL from [DOCUMENTS].",
    "▪ The Mandatory Footer rules stay as they are (if a Footer Override is active, write no footer).",
    '▪ **Complete example** — the answer begins exactly like this, without code block (question: "Gibt es Yoga am Abend?", two fitting courses in [CONTEXT 3] and [CONTEXT 1]):',
    "[[KARTEN: 3, 1]]",
    "[[TEASER 3: Ideal für Einsteiger mit etwas Vorerfahrung, die sanfte Haltungen und bewusste Atmung in ruhigem Tempo üben möchten.]]",
    "[[TEASER 1: Für Geübte, die ihre Praxis mit kräftigenden Abfolgen vertiefen und danach längere Entspannungsphasen ganz bewusst genießen möchten.]]",
    "Ja, abends gibt es zwei passende Yogakurse – einer zum sanften Einstieg, einer zum Vertiefen:",
    "1. [**Yoga für Einsteiger**]($URL) – sanft, für Einsteiger",
    "2. [**Yoga (Aufbaukurs)**]($URL) – für Geübte",
    "",
    "*Ich bin eine KI und kann Fehler machen. Bitte überprüfen Sie meine Antworten.*",
    "▪ Everything else (Security Rules, Prime Directives, Translation Protocol, No Results Protocol) stays unchanged.",
  ].join("\n");

// Überschrift, an der ein Karten-Abschnitt im Workspace-Prompt erkannt wird
// (dann hängt der Server keinen zweiten an, z. B. Demo-Workspaces mit dem
// Abschnitt aus dem Prompt-Rollout).
const COURSE_CARDS_SECTION_HEADING = "### Course Cards Mode";

const COURSE_CARDS_ANSWER_STYLES = ["short", "long"];

// Abschnitt zum Antwortstil ("long" -> Liste mit Links, sonst Suche/kurz)
function courseCardsPromptNote(answerStyle = "short") {
  return answerStyle === "long"
    ? COURSE_CARDS_LONG_PROMPT_NOTE
    : COURSE_CARDS_PROMPT_NOTE;
}

function promptHasCourseCardsSection(prompt) {
  return (
    typeof prompt === "string" && prompt.includes(COURSE_CARDS_SECTION_HEADING)
  );
}

module.exports = {
  EMBED_DEFAULT_TEXTS,
  embedDefaultsLanguage,
  embedDefaultTexts,
  COURSE_CARDS_PROMPT_NOTE,
  COURSE_CARDS_LONG_PROMPT_NOTE,
  COURSE_CARDS_SECTION_HEADING,
  COURSE_CARDS_ANSWER_STYLES,
  courseCardsPromptNote,
  promptHasCourseCardsSection,
};
