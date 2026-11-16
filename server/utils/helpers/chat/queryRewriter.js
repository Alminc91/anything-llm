// Query Rewriter: formuliert kurze Folgefragen für die Suche zu einer
// vollständigen Frage um.
// Variante E (issues/folgefragen-variante-e.md, Messung 16.11.2026): der
// Prompt ist wörtlich der gemessene, mit früheren Fragen des Besuchers sucht
// er das Thema rückwärts durch sie. Prompt und Nachrichtenform nur nach einer
// neuen Messung ändern (AK-1, Fixture-Test byte-gleich).
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

// Variante E (D1, wie gemessen): höchstens 5 frühere Fragen, je auf 40 Wörter
// gekürzt; die Antwort der letzten Runde auf 150 Wörter
const EARLIER_QUESTIONS_MAX = 5;
const EARLIER_QUESTION_WORDS = 40;
const LAST_ANSWER_WORDS = 150;

/**
 * Kürzt einen Text auf maxWords Wörter, mit "..." dahinter, wenn gekürzt
 * wurde. Wie kurz() der Messung (Python str.split): Leerraum am Rand fällt
 * weg, jeder Leerraum dazwischen wird ein Leerzeichen, auch ohne Kürzung.
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

// Verlauf ohne frühere Fragen (wie bisher): die letzten Runden nach
// QUERY_REWRITE_MAX_HISTORY, lange Antworten gekürzt
function historyText(chatHistory) {
  const maxTurns = parseInt(process.env.QUERY_REWRITE_MAX_HISTORY) || 2;
  const recentHistory = chatHistory.slice(-maxTurns * 2); // 2 msgs per turn
  return recentHistory
    .map((m) => {
      // Truncate long assistant messages to keep the rewrite prompt compact
      // Keep the beginning: it usually contains the most relevant topic context
      let content = m.content;
      if (m.role === "assistant") {
        const words = content.split(/\s+/);
        if (words.length > 150) content = words.slice(0, 150).join(" ") + "...";
      }
      return `${m.role === "user" ? "User" : "Assistant"}: ${content}`;
    })
    .join("\n");
}

// Verlauf mit früheren Fragen (Variante E, wie gemessen): genau die letzte
// Runde, die Antwort mit shortenWords auf 150 Wörter
function lastRoundText(chatHistory) {
  return chatHistory
    .slice(-2)
    .map(
      (m) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${
          m.role === "assistant"
            ? shortenWords(m.content, LAST_ANSWER_WORDS)
            : m.content
        }`
    )
    .join("\n");
}

/**
 * Nachrichten an das LLM des Rewriters, ohne Aufruf (auch für Messungen
 * offline nutzbar).
 * Mit earlierUserQuestions (Array, Variante E): Block „Earlier user
 * questions (oldest first)“ nur, wenn es welche gibt (die 5 neuesten, je
 * auf 40 Wörter gekürzt), danach genau die letzte Runde des Verlaufs.
 * Ohne (undefined oder null): Verlauf wie bisher. Der Prompt ist in beiden
 * Fällen derselbe (D2).
 * @param {Object} input
 * @param {string} input.userQuery - aktuelle Frage
 * @param {{role: string, content: string}[]} input.chatHistory - geladener Verlauf
 * @param {string[]|null} [input.earlierUserQuestions] - Fragen des Besuchers vor der letzten Runde, älteste zuerst
 * @returns {{role: string, content: string}[]}
 */
function buildRewriteMessages({
  userQuery,
  chatHistory,
  earlierUserQuestions = null,
}) {
  let content;
  if (Array.isArray(earlierUserQuestions)) {
    const earlier = earlierUserQuestions.slice(-EARLIER_QUESTIONS_MAX);
    const block =
      earlier.length > 0
        ? `Earlier user questions (oldest first):\n${earlier
            .map(
              (q, i) => `${i + 1}. ${shortenWords(q, EARLIER_QUESTION_WORDS)}`
            )
            .join("\n")}\n\n`
        : "";
    content = `${block}Chat history:\n${lastRoundText(chatHistory)}\n\nLatest question: ${userQuery}`;
  } else {
    content = `Chat history:\n${historyText(chatHistory)}\n\nLatest question: ${userQuery}`;
  }
  return [
    { role: "system", content: REWRITE_PROMPT },
    { role: "user", content },
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
 * @param {() => Promise<string[]|null>} [input.loadEarlierUserQuestions] - nur Widget (Variante E): lädt die früheren Fragen des Besuchers derselben Unterhaltung, älteste zuerst; läuft erst nach shouldRewrite, ohne Rewrite also keine Abfrage
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
  REWRITE_PROMPT,
  EARLIER_QUESTIONS_MAX,
};
