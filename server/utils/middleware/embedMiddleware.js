const { v4: uuidv4, validate } = require("uuid");
const { VALID_CHAT_MODE } = require("../chats/stream");
const { EmbedChats } = require("../../models/embedChats");
const { EmbedConfig } = require("../../models/embedConfig");
const { reqBody } = require("../http");
const { berlinDayOf, berlinMidnight } = require("../helpers/billingWindow");

// widget-grenzen-kontakt (issues/widget-grenzen-kontakt.md, §11 E5): Kennung
// der erreichten Grenze in der 429-Antwort von canRespond. Das Widget wählt
// seinen Text nur danach; jede andere Fehlerantwort trägt keinen dieser
// Werte. Vertrag mit dem Widget als Fixture:
// __tests__/utils/chats/fixtures/embedLimitContract.json (wortgleich im
// Widget-Repo unter tests/fixtures/embedLimitContract.json).
const EMBED_LIMIT_ERROR_CODES = Object.freeze({
  // max_chats_per_day: Fragen aller Besucher je Tag
  daily: "daily_limit",
  // max_chats_per_session: Fragen je Besucher und Tag
  session: "session_limit",
});

/**
 * Beginn des Zählfensters beider Grenzen: 0:00 Uhr Europe/Berlin des
 * laufenden Kalendertags (widget-grenzen-kontakt, D1), unabhängig von der
 * Zeitzone des Prozesses. Gezählt wird ab diesem Zeitpunkt einschließlich;
 * bis 8.1 zählten beide Grenzen die letzten 24 Stunden.
 * @param {Date} [now]
 * @returns {Date}
 */
function limitWindowStart(now = new Date()) {
  return berlinMidnight(berlinDayOf(now));
}

// Finds or Aborts request for a /:embedId/ url. This should always
// be the first middleware and the :embedID should be in the URL.
async function validEmbedConfig(request, response, next) {
  const { embedId } = request.params;

  const embed = await EmbedConfig.getWithWorkspace({ uuid: embedId });
  if (!embed) {
    response.sendStatus(404).end();
    return;
  }

  response.locals.embedConfig = embed;
  next();
}

function setConnectionMeta(request, response, next) {
  response.locals.connection = {
    host: request.headers?.origin,
    ip: request?.ip,
  };
  next();
}

async function validEmbedConfigId(request, response, next) {
  const { embedId } = request.params;

  const embed = await EmbedConfig.get({ id: Number(embedId) });
  if (!embed) {
    response.sendStatus(404).end();
    return;
  }

  response.locals.embedConfig = embed;
  next();
}

async function canRespond(request, response, next) {
  try {
    const embed = response.locals.embedConfig;
    if (!embed) {
      response.sendStatus(404).end();
      return;
    }

    // Block if disabled by admin.
    if (!embed.enabled) {
      response.status(503).json({
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error:
          "This chat has been disabled by the administrator - try again later.",
      });
      return;
    }

    // Check if requester hostname is in the valid allowlist of domains.
    const host = request.headers.origin ?? "";
    const allowedHosts = EmbedConfig.parseAllowedHosts(embed);
    if (allowedHosts !== null && !allowedHosts.includes(host)) {
      response.status(401).json({
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: "Invalid request.",
      });
      return;
    }

    const { sessionId, message } = reqBody(request);
    if (typeof sessionId !== "string" || !validate(String(sessionId))) {
      response.status(404).json({
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: "Invalid session ID.",
      });
      return;
    }

    if (!message?.length || !VALID_CHAT_MODE.includes(embed.chat_mode)) {
      response.status(400).json({
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: !message?.length
          ? "Message is empty."
          : `${embed.chat_mode} is not a valid mode.`,
      });
      return;
    }

    // Grenzen je Kalendertag (0 oder leer: unbegrenzt). Die Grenze aller
    // Besucher zuerst: Sind beide erreicht, gilt daily_limit.
    const windowStart = limitWindowStart();
    if (
      !isNaN(embed.max_chats_per_day) &&
      Number(embed.max_chats_per_day) > 0
    ) {
      const dailyChatCount = await EmbedChats.count({
        embed_id: embed.id,
        createdAt: { gte: windowStart },
      });

      if (dailyChatCount >= Number(embed.max_chats_per_day)) {
        response.status(429).json({
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: "Rate limit exceeded",
          errorMsg:
            "The quota for this chat has been reached. Try again later or contact the site owner.",
          errorCode: EMBED_LIMIT_ERROR_CODES.daily,
        });
        return;
      }
    }

    if (
      !isNaN(embed.max_chats_per_session) &&
      Number(embed.max_chats_per_session) > 0
    ) {
      const dailySessionCount = await EmbedChats.count({
        embed_id: embed.id,
        session_id: sessionId,
        createdAt: { gte: windowStart },
      });

      if (dailySessionCount >= Number(embed.max_chats_per_session)) {
        response.status(429).json({
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error:
            "Your quota for this chat has been reached. Try again later or contact the site owner.",
          errorCode: EMBED_LIMIT_ERROR_CODES.session,
        });
        return;
      }
    }

    next();
  } catch (e) {
    response.status(500).json({
      id: uuidv4(),
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: "Invalid request.",
    });
    return;
  }
}

module.exports = {
  EMBED_LIMIT_ERROR_CODES,
  limitWindowStart,
  setConnectionMeta,
  validEmbedConfig,
  validEmbedConfigId,
  canRespond,
};
