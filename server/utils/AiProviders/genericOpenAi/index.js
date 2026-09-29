const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");
const {
  formatChatHistory,
  writeResponseChunk,
  clientAbortedHandler,
} = require("../../helpers/chat/responses");
const { toValidNumber } = require("../../http");
const { getAnythingLLMUserAgent } = require("../../../endpoints/utils");

class GenericOpenAiLLM {
  constructor(embedder = null, modelPreference = null) {
    const { OpenAI: OpenAIApi } = require("openai");
    if (!process.env.GENERIC_OPEN_AI_BASE_PATH)
      throw new Error(
        "GenericOpenAI must have a valid base path to use for the api."
      );

    this.className = "GenericOpenAiLLM";
    this.basePath = process.env.GENERIC_OPEN_AI_BASE_PATH;
    this.openai = new OpenAIApi({
      baseURL: this.basePath,
      apiKey: process.env.GENERIC_OPEN_AI_API_KEY ?? null,
      defaultHeaders: {
        "User-Agent": getAnythingLLMUserAgent(),
        ...GenericOpenAiLLM.parseCustomHeaders(),
      },
    });
    this.model =
      modelPreference ?? process.env.GENERIC_OPEN_AI_MODEL_PREF ?? null;
    this.maxTokens = process.env.GENERIC_OPEN_AI_MAX_TOKENS
      ? toValidNumber(process.env.GENERIC_OPEN_AI_MAX_TOKENS, 1024)
      : 1024;
    if (!this.model)
      throw new Error("GenericOpenAI must have a valid model set.");
    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7;
    this.log(`Inference API: ${this.basePath} Model: ${this.model}`);
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.className}]\x1b[0m ${text}`, ...args);
  }

  /**
   * Parses custom headers from a CSV-formatted environment variable.
   * Format: "Header-Name:value,Another-Header:value2"
   * @returns {Object} Object with header key-value pairs
   */
  static parseCustomHeaders() {
    const customHeadersEnv = process.env.GENERIC_OPEN_AI_CUSTOM_HEADERS;
    if (!customHeadersEnv) return {};

    const headers = {};
    const pairs = customHeadersEnv.split(",");

    for (const pair of pairs) {
      const colonIndex = pair.indexOf(":"); // only split on first colon for key/value separation
      if (colonIndex === -1) continue;

      const key = pair.substring(0, colonIndex).trim();
      const value = pair.substring(colonIndex + 1).trim();

      if (key && value) headers[key] = value;
    }

    return headers;
  }

  #appendContext(contextTexts = []) {
    if (!contextTexts || !contextTexts.length) return "";
    return (
      "\nContext:\n" +
      contextTexts
        .map((text, i) => {
          return `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`;
        })
        .join("")
    );
  }

  streamingEnabled() {
    if (process.env.GENERIC_OPENAI_STREAMING_DISABLED === "true") return false;
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit(_modelName) {
    const limit = process.env.GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT || 4096;
    if (!limit || isNaN(Number(limit)))
      throw new Error("No token context limit was set.");
    return Number(limit);
  }

  // Ensure the user set a value for the token limit
  // and if undefined - assume 4096 window.
  promptWindowLimit() {
    const limit = process.env.GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT || 4096;
    if (!limit || isNaN(Number(limit)))
      throw new Error("No token context limit was set.");
    return Number(limit);
  }

  // Short circuit since we have no idea if the model is valid or not
  // in pre-flight for generic endpoints
  isValidChatCompletionModel(_modelName = "") {
    return true;
  }

  /**
   * Generates appropriate content array for a message + attachments.
   *
   * ## Developer Note
   * This function assumes the generic OpenAI provider is _actually_ OpenAI compatible.
   * For example, Ollama is "OpenAI compatible" but does not support images as a content array.
   * The contentString also is the base64 string WITH `data:image/xxx;base64,` prefix, which may not be the case for all providers.
   * If your provider does not work exactly this way, then attachments will not function or potentially break vision requests.
   * If you encounter this issue, you are welcome to open an issue asking for your specific provider to be supported.
   *
   * This function will **not** be updated for providers that **do not** support images as a content array like OpenAI does.
   * Do not open issues to update this function due to your specific provider not being compatible. Open an issue to request support for your specific provider.
   * @param {Object} props
   * @param {string} props.userPrompt - the user prompt to be sent to the model
   * @param {import("../../helpers").Attachment[]} props.attachments - the array of attachments to be sent to the model
   * @returns {string|object[]}
   */
  #generateContent({ userPrompt, attachments = [] }) {
    if (!attachments.length) {
      return userPrompt;
    }

    const content = [{ type: "text", text: userPrompt }];
    for (let attachment of attachments) {
      content.push({
        type: "image_url",
        image_url: {
          url: attachment.contentString,
          detail: "high",
        },
      });
    }
    return content.flat();
  }

  /**
   * Construct the user prompt for this model.
   * @param {{attachments: import("../../helpers").Attachment[]}} param0
   * @returns
   */
  constructPrompt({
    systemPrompt = "",
    contextTexts = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [],
  }) {
    const prompt = {
      role: "system",
      content: `${systemPrompt}${this.#appendContext(contextTexts)}`,
    };
    return [
      prompt,
      ...formatChatHistory(chatHistory, this.#generateContent),
      {
        role: "user",
        content: this.#generateContent({ userPrompt, attachments }),
      },
    ];
  }

  /**
   * Extracts accurate generation-only timing and token count from a llama.cpp
   * response or streaming chunk. Mutates the provided usage object in place
   * so it can be used by both streaming and non-streaming code paths.
   * @param {Object} response - the API response or final streaming chunk
   * @param {Object} usage - the usage object to mutate
   */
  #extractLlamaCppTimings(response, usage) {
    if (!response || !response.timings) return;

    if (response.timings.hasOwnProperty("predicted_n"))
      usage.completion_tokens = Number(response.timings.predicted_n);

    if (response.timings.hasOwnProperty("predicted_ms"))
      usage.duration = Number(response.timings.predicted_ms) / 1000;
  }

  /**
   * Parses and prepends reasoning from the response and returns the full text response.
   * @param {Object} response
   * @returns {string}
   */
  #parseReasoningFromResponse({ message }) {
    let textResponse = message?.content;
    if (
      !!message?.reasoning_content &&
      message.reasoning_content.trim().length > 0
    )
      // content kann null sein, wenn das Thinking durch max_tokens
      // abgeschnitten wurde (finish_reason "length") – dann kein "null" anhängen.
      textResponse = `<think>${message.reasoning_content}</think>${textResponse ?? ""}`;
    return textResponse;
  }

  async getChatCompletion(
    messages = null,
    {
      temperature = 0.7,
      max_tokens,
      top_p,
      reasoning_effort,
      chat_template_kwargs,
    } = {}
  ) {
    const result = await LLMPerformanceMonitor.measureAsyncFunction(
      this.openai.chat.completions
        .create({
          model: this.model,
          messages,
          temperature,
          max_tokens: max_tokens ?? this.maxTokens,
          // Optionale Anfrage-Optionen (utils/helpers/chat/llmRequestOptions.js):
          // nur gesetzte Felder, damit der Body ohne sie byte-gleich bleibt.
          ...(top_p !== undefined && { top_p }),
          ...(reasoning_effort !== undefined && { reasoning_effort }),
          ...(chat_template_kwargs !== undefined && { chat_template_kwargs }),
        })
        .catch((e) => {
          throw new Error(e.message);
        })
    );

    if (
      !result.output.hasOwnProperty("choices") ||
      result.output.choices.length === 0
    )
      return null;

    const usage = {
      prompt_tokens: result.output?.usage?.prompt_tokens || 0,
      completion_tokens: result.output?.usage?.completion_tokens || 0,
      total_tokens: result.output?.usage?.total_tokens || 0,
      duration: result.duration,
    };
    this.#extractLlamaCppTimings(result.output, usage);

    return {
      textResponse: this.#parseReasoningFromResponse(result.output.choices[0]),
      metrics: {
        ...usage,
        outputTps: usage.completion_tokens / usage.duration,
        model: this.model,
        provider: this.className,
        timestamp: new Date(),
      },
    };
  }

  async streamGetChatCompletion(
    messages = null,
    {
      temperature = 0.7,
      max_tokens,
      top_p,
      reasoning_effort,
      chat_template_kwargs,
    } = {}
  ) {
    const measuredStreamRequest = await LLMPerformanceMonitor.measureStream({
      func: this.openai.chat.completions.create({
        model: this.model,
        stream: true,
        messages,
        temperature,
        max_tokens: max_tokens ?? this.maxTokens,
        ...(top_p !== undefined && { top_p }),
        ...(reasoning_effort !== undefined && { reasoning_effort }),
        ...(chat_template_kwargs !== undefined && { chat_template_kwargs }),
      }),
      messages,
      runPromptTokenCalculation: true,
      modelTag: this.model,
      provider: this.className,
    });
    return measuredStreamRequest;
  }

  // TODO: This is a copy of the generic handleStream function in responses.js
  // to specifically handle the DeepSeek reasoning model `reasoning_content` field.
  // When or if ever possible, we should refactor this to be in the generic function.
  handleStream(response, stream, responseProps) {
    const { uuid = uuidv4(), sources = [] } = responseProps;
    let hasUsageMetrics = false;
    let usage = {
      completion_tokens: 0,
    };

    return new Promise(async (resolve) => {
      let fullText = "";
      let reasoningText = "";
      let finished = false;

      // Kufer-Fork: Schließt einen offenen <think>-Block und übernimmt ihn in
      // fullText – wenn Content beginnt (auch im selben Chunk wie das letzte
      // Reasoning-Token) oder beim Abschluss, falls nur Reasoning gestreamt
      // wurde (z. B. Thinking durch max_tokens abgeschnitten, finish_reason
      // "length"). fullText wird vor dem Schreiben aktualisiert, damit der
      // Text auch bei einem Schreibfehler vollständig bleibt.
      const closeOpenReasoning = ({ emit = true } = {}) => {
        if (!reasoningText) return;
        fullText += `${reasoningText}</think>`;
        reasoningText = "";
        if (emit)
          writeResponseChunk(response, {
            uuid,
            sources: [],
            type: "textResponseChunk",
            textResponse: `</think>`,
            close: false,
            error: false,
          });
      };

      // Regulärer Abschluss (finish_reason oder Stream-Ende ohne finish_reason).
      // Löst in jedem Fall genau einmal mit fullText auf, auch wenn Schreiben,
      // Listener-Abbau oder Messung werfen – sonst bliebe das Promise offen.
      const finish = (lastChunk = null) => {
        if (finished) return;
        finished = true;
        try {
          closeOpenReasoning();
          writeResponseChunk(response, {
            uuid,
            sources,
            type: "textResponseChunk",
            textResponse: "",
            close: true,
            error: false,
          });
          if (lastChunk) this.#extractLlamaCppTimings(lastChunk, usage);
        } catch (e) {
          console.error(
            `[GenericOpenAiLLM] Error while finishing stream: ${e.message}`
          );
        } finally {
          try {
            response.removeListener("close", handleAbort);
            stream?.endMeasurement(usage);
          } catch (e) {
            console.error(
              `[GenericOpenAiLLM] Error while ending stream measurement: ${e.message}`
            );
          }
          resolve(fullText);
        }
      };

      // Establish listener to early-abort a streaming response
      // in case things go sideways or the user does not like the response.
      // We preserve the generated text but continue as if chat was completed
      // to preserve previously generated content.
      const handleAbort = () => {
        if (finished) return;
        finished = true;
        try {
          closeOpenReasoning({ emit: false });
          stream?.endMeasurement(usage);
        } catch (e) {
          console.error(
            `[GenericOpenAiLLM] Error while aborting stream: ${e.message}`
          );
        }
        clientAbortedHandler(resolve, fullText);
      };
      response.on("close", handleAbort);

      try {
        for await (const chunk of stream) {
          const message = chunk?.choices?.[0];
          const token = message?.delta?.content;
          const reasoningToken = message?.delta?.reasoning_content;

          if (
            chunk.hasOwnProperty("usage") && // exists
            !!chunk.usage && // is not null
            Object.values(chunk.usage).length > 0 // has values
          ) {
            if (chunk.usage.hasOwnProperty("prompt_tokens")) {
              usage.prompt_tokens = Number(chunk.usage.prompt_tokens);
            }

            if (chunk.usage.hasOwnProperty("completion_tokens")) {
              hasUsageMetrics = true; // to stop estimating counter
              usage.completion_tokens = Number(chunk.usage.completion_tokens);
            }
          }

          // Reasoning models will always return the reasoning text before the token text.
          if (reasoningToken) {
            // The first reasoning chunk opens the <think> block.
            const reasoningChunk =
              reasoningText.length === 0
                ? `<think>${reasoningToken}`
                : reasoningToken;
            writeResponseChunk(response, {
              uuid,
              sources: [],
              type: "textResponseChunk",
              textResponse: reasoningChunk,
              close: false,
              error: false,
            });
            reasoningText += reasoningChunk;
          }

          // Kufer-Fork: Sobald Content kommt, zuerst den offenen <think>-Block
          // schließen – auch wenn derselbe Chunk noch reasoning_content trägt
          // (vLLM/DeepSeek an der Grenze Denken → Antwort). Sonst landete das
          // erste Content-Token im Denkblock und das Reasoning dahinter.
          if (!!reasoningText && token) closeOpenReasoning();

          if (token) {
            fullText += token;
            // If we never saw a usage metric, we can estimate them by number of completion chunks
            if (!hasUsageMetrics) usage.completion_tokens++;
            writeResponseChunk(response, {
              uuid,
              sources: [],
              type: "textResponseChunk",
              textResponse: token,
              close: false,
              error: false,
            });
          }

          if (
            message?.hasOwnProperty("finish_reason") && // Got valid message and it is an object with finish_reason
            message.finish_reason !== "" &&
            message.finish_reason !== null
          ) {
            finish(chunk);
            break; // Break streaming when a valid finish_reason is first encountered
          }
        }
        // Stream endete ohne finish_reason: trotzdem sauber abschließen.
        finish();
      } catch (e) {
        // Bereits abgeschlossen (finish/Abbruch): resolve ist idempotent,
        // trotzdem nie ohne resolve enden.
        if (finished) return resolve(fullText);
        finished = true;
        console.log(`\x1b[43m\x1b[34m[STREAMING ERROR]\x1b[0m ${e.message}`);
        try {
          closeOpenReasoning({ emit: false });
          writeResponseChunk(response, {
            uuid,
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: e.message,
          });
          stream?.endMeasurement(usage);
        } catch (err) {
          console.error(
            `[GenericOpenAiLLM] Error while handling stream error: ${err.message}`
          );
        }
        resolve(fullText);
      }
    });
  }

  // Simple wrapper for dynamic embedder & normalize interface for all LLM implementations
  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }
}

module.exports = {
  GenericOpenAiLLM,
};
