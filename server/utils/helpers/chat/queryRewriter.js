// Query Rewriter: formuliert kurze Folgefragen für die Suche zu einer
// vollständigen Frage um.
// Variante E mit Nachrichtenform E2 (issues/folgefragen-variante-e.md,
// Messung 16.11.2026, D4): der Prompt ist wörtlich der gemessene, mit
// früheren Fragen des Besuchers sucht er das Thema rückwärts durch sie.
// Prompt und Nachrichtenform nur nach einer neuen Messung ändern (AK-1,
// Fixture-Test byte-gleich, Zufallsabgleich abgleich_form_e2.js).
const REWRITE_PROMPT = `Given a chat history and the latest user question which might reference context in the chat history, determine if the question needs to be reformulated to be understood without the chat history.

If the question is fully self-contained — meaning a stranger could understand it without any prior conversation — return it EXACTLY as written. Do not rephrase, expand, or modify it. NEVER translate or switch the language of a self-contained question.

If the question would be unclear or ambiguous to someone who has NOT read the chat history, reformulate it by adding the missing context from the history. When in doubt, reformulate — it is better to add context than to lose it.

When reformulating:
- Find the SPECIFIC topic by going backwards through the USER questions: first the user question in the chat history, then the "Earlier user questions" from newest to oldest. Stop at the first user question that names a topic (a subject, course or service) and take that topic. Take the topic from the assistant response ONLY if no user question names one, or if the latest question directly reacts to something the assistant offered or asked (e.g. "yes", "the second one", "tell me more"); then use the item the assistant named. Use the EXACT words the user used — never shorten, generalize, or drop qualifiers.
- For very short questions (1-3 words), ALWAYS combine them with the topic found this way into a complete sentence.
- If several user questions name different topics, use the most recent one; use an older one only if the latest question explicitly refers back to it.
- If the latest question itself names a new topic, use ONLY that new topic and drop every earlier topic.
- Keep the question structure intact: the question word(s) at the start of the user's question MUST remain at the start of the reformulated question. Only append the missing topic — never restructure the sentence.
- Respond with ONLY the reformulated question (max 15 words).
- NEVER generalize the topic. Keep the full compound noun or phrase from the user's question. Do not drop adjectives, prefixes, or qualifiers.
- Do NOT add information not present in the conversation.
- Write in the same language as the LATEST user question (not previous messages).`;

async function shouldRewrite(userQuery, chatHistory, workspace) {
  if (!chatHistory || chatHistory.length === 0) return false;
  let mode = workspace?.queryRewriteMode;
  // If workspace value is not explicitly set, resolve via system setting → ENV → "off"
  if (mode !== "on" && mode !== "off") {
    const { SystemSettings } = require("../../../models/systemSettings");
    const systemDefault = await SystemSettings.getValueOrFallback(
      { label: "query_rewrite_default" },
      null
    );
    if (systemDefault === "on" || systemDefault === "off") {
      mode = systemDefault;
    } else {
      mode = process.env.QUERY_REWRITING === "true" ? "on" : "off";
    }
  }
  if (mode !== "on") return false;
  const wordCount = userQuery.trim().split(/\s+/).length;
  const threshold = parseInt(process.env.QUERY_REWRITE_WORD_THRESHOLD) || 12;
  return wordCount <= threshold;
}

// Form E2 (D4, wie gemessen): höchstens 2 frühere Fragen, je auf 40 Wörter
// gekürzt; im Block „Chat history“ die letzten Runden (rewriteHistoryTurns),
// Antworten auf 150 Wörter gekürzt, Fragen ungekürzt.
// EARLIER_QUESTIONS_MAX ist die eine Grenze für die Kürzung hier und für die
// Abfrage im Widget (EmbedChats.earlierPrompts, limit). 2 statt 5 (E-R6,
// Nutzer 16.11. abends, D1 gekippt, gemessen als E2m2): der Rewriter soll kaum
// mehr wissen als das Antwortmodell, eine feste Grenze wegen der Wartezeit.
const EARLIER_QUESTIONS_MAX = 2;
const EARLIER_QUESTION_WORDS = 40;
const HISTORY_ANSWER_WORDS = 150;
const HISTORY_TURNS_DEFAULT = 2;

/**
 * Kürzt einen Text auf maxWords Wörter, mit "..." dahinter, wenn gekürzt
 * wurde. Wie kurz() der Messung (Python str.split ohne Argument): Leerraum
 * am Rand fällt weg, jeder Leerraum dazwischen wird ein Leerzeichen, auch
 * ohne Kürzung. Abweichung nur bei seltenem Leerraum: JS \s trennt
 * zusätzlich an U+FEFF, Python zusätzlich an U+0085 und U+001C bis U+001F;
 * die Byte-Gleichheit (AK-1) gilt für Texte ohne diese Zeichen.
 * @param {string} text
 * @param {number} maxWords
 * @returns {string}
 */
function shortenWords(text, maxWords) {
  const words = String(text ?? "")
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.slice(0, maxWords).join(" ") + (words.length > maxWords ? "..." : "")
  );
}

/**
 * Zahl der Runden im Block „Chat history“: QUERY_REWRITE_MAX_HISTORY als
 * ganze Zahl ab 1, sonst 2 (auch bei 0, negativ, Bruch oder Text). Das
 * Widget bestimmt damit, vor welcher Zeile die früheren Fragen enden.
 * @returns {number}
 */
function rewriteHistoryTurns() {
  const turns = Number(process.env.QUERY_REWRITE_MAX_HISTORY);
  return Number.isInteger(turns) && turns >= 1 ? turns : HISTORY_TURNS_DEFAULT;
}

// Block „Chat history“: die letzten Runden (2 Nachrichten je Runde),
// Antworten mit shortenWords gekürzt, Fragen unverändert
function historyText(chatHistory) {
  return chatHistory
    .slice(-rewriteHistoryTurns() * 2)
    .map(
      (m) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${
          m.role === "assistant"
            ? shortenWords(m.content, HISTORY_ANSWER_WORDS)
            : m.content
        }`
    )
    .join("\n");
}

/**
 * Nachrichten an das LLM des Rewriters, ohne Aufruf (auch für Messungen
 * offline nutzbar). Eine Form für alle Aufrufer (Form E2, D2): Block
 * „Earlier user questions (oldest first)“ nur, wenn es frühere Fragen gibt
 * (die neuesten EARLIER_QUESTIONS_MAX, also 2, je auf 40 Wörter gekürzt),
 * danach „Chat history“ mit den letzten Runden (rewriteHistoryTurns,
 * Standard 2) und „Latest question“.
 * @param {Object} input
 * @param {string} input.userQuery - aktuelle Frage
 * @param {{role: string, content: string}[]} input.chatHistory - ganzer geladener Verlauf (user/assistant, je Runde zwei Nachrichten); die letzten Runden nimmt die Funktion selbst
 * @param {string[]|null} [input.earlierUserQuestions] - Fragen des Besuchers vor diesen Runden, älteste zuerst; die neuesten EARLIER_QUESTIONS_MAX (2) nimmt die Funktion selbst; null oder [] = kein Block
 * @returns {{role: string, content: string}[]}
 */
function buildRewriteMessages({
  userQuery,
  chatHistory,
  earlierUserQuestions = null,
}) {
  const earlier = Array.isArray(earlierUserQuestions)
    ? earlierUserQuestions.slice(-EARLIER_QUESTIONS_MAX)
    : [];
  const block =
    earlier.length > 0
      ? `Earlier user questions (oldest first):\n${earlier
          .map((q, i) => `${i + 1}. ${shortenWords(q, EARLIER_QUESTION_WORDS)}`)
          .join("\n")}\n\n`
      : "";
  return [
    { role: "system", content: REWRITE_PROMPT },
    {
      role: "user",
      content: `${block}Chat history:\n${historyText(chatHistory)}\n\nLatest question: ${userQuery}`,
    },
  ];
}

/**
 * Suchfrage für eine Folgefrage. Ohne Verlauf, mit Schalter aus oder über
 * der Wortgrenze bleibt die Frage unverändert (shouldRewrite).
 * @param {Object} input
 * @param {string} input.userQuery
 * @param {{role: string, content: string}[]} input.chatHistory
 * @param {Object} input.LLMConnector
 * @param {Object} input.workspace
 * @param {() => Promise<string[]|null>} [input.loadEarlierUserQuestions] - nur Widget (Variante E): lädt die Fragen des Besuchers derselben Unterhaltung vor den Runden im Block „Chat history“, älteste zuerst; läuft erst nach shouldRewrite, ohne Rewrite also keine Abfrage
 * @returns {Promise<string>}
 */
async function rewriteQueryForSearch({
  userQuery,
  chatHistory,
  LLMConnector,
  workspace,
  loadEarlierUserQuestions = null,
}) {
  if (!(await shouldRewrite(userQuery, chatHistory, workspace)))
    return userQuery;

  try {
    const messages = buildRewriteMessages({
      userQuery,
      chatHistory,
      earlierUserQuestions: loadEarlierUserQuestions
        ? await loadEarlierUserQuestions()
        : null,
    });
    const start = Date.now();
    const result = await LLMConnector.getChatCompletion(messages, {
      temperature: 0.1,
    });

    const rewritten = result?.textResponse
      ?.trim()
      ?.replace(/<think>[\s\S]*?<\/think>/g, "") // Strip reasoning tags
      ?.split("\n")[0]
      ?.trim(); // Take first line only

    const elapsed = Date.now() - start;
    console.log(
      `\x1b[35m[QueryRewrite]\x1b[0m "${userQuery}" → "${rewritten}" (${elapsed}ms)`
    );

    if (!rewritten) return userQuery;

    // Verbatim check — LLM returned the query as-is (self-contained)
    if (rewritten.trim().toLowerCase() === userQuery.trim().toLowerCase())
      return userQuery;

    return rewritten;
  } catch (error) {
    console.error(
      "[QueryRewrite] Failed, using original query:",
      error.message
    );
    return userQuery;
  }
}

module.exports = {
  rewriteQueryForSearch,
  buildRewriteMessages,
  rewriteHistoryTurns,
  REWRITE_PROMPT,
  EARLIER_QUESTIONS_MAX,
};
