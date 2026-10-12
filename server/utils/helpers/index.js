/**
 * File Attachment for automatic upload on the chat container page.
 * @typedef Attachment
 * @property {string} name - the given file name
 * @property {string} mime - the given file mime
 * @property {string} contentString - full base64 encoded string of file
 */

/**
 * @typedef {Object} ResponseMetrics
 * @property {number} prompt_tokens - The number of prompt tokens used
 * @property {number} completion_tokens - The number of completion tokens used
 * @property {number} total_tokens - The total number of tokens used
 * @property {number} outputTps - The output tokens per second
 * @property {number} duration - The duration of the request in seconds
 *
 * @typedef {Object} ChatMessage
 * @property {string} role - The role of the message sender (e.g. 'user', 'assistant', 'system')
 * @property {string} content - The content of the message
 *
 * @typedef {Object} ChatCompletionResponse
 * @property {string} textResponse - The text response from the LLM
 * @property {ResponseMetrics} metrics - The response metrics
 *
 * @typedef {Object} ChatCompletionOptions
 * @property {number} temperature - The sampling temperature for the LLM response
 * @property {import("@prisma/client").users} user - The user object for the chat completion to send to the LLM provider for user tracking (optional)
 *
 * @typedef {function(Array<ChatMessage>, ChatCompletionOptions): Promise<ChatCompletionResponse>} getChatCompletionFunction
 *
 * @typedef {function(Array<ChatMessage>, ChatCompletionOptions): Promise<import("./chat/LLMPerformanceMonitor").MonitoredStream>} streamGetChatCompletionFunction
 */

/**
 * @typedef {Object} BaseLLMProvider - A basic llm provider object
 * @property {Function} streamingEnabled - Checks if streaming is enabled for chat completions.
 * @property {Function} promptWindowLimit - Returns the token limit for the current model.
 * @property {Function} isValidChatCompletionModel - Validates if the provided model is suitable for chat completion.
 * @property {Function} constructPrompt - Constructs a formatted prompt for the chat completion request.
 * @property {getChatCompletionFunction} getChatCompletion - Gets a chat completion response from OpenAI.
 * @property {streamGetChatCompletionFunction} streamGetChatCompletion - Streams a chat completion response from OpenAI.
 * @property {Function} handleStream - Handles the streaming response.
 * @property {Function} embedTextInput - Embeds the provided text input using the specified embedder.
 * @property {Function} embedChunks - Embeds multiple chunks of text using the specified embedder.
 * @property {Function} compressMessages - Compresses chat messages to fit within the token limit.
 */

/**
 * @typedef {Object} BaseLLMProviderClass - Class method of provider - not instantiated
 * @property {function(string): number} promptWindowLimit - Returns the token limit for the provided model.
 */

/**
 * @typedef {Object} BaseVectorDatabaseProvider
 * @property {string} name - The name of the Vector Database instance.
 * @property {Function} connect - Connects to the Vector Database client.
 * @property {Function} totalVectors - Returns the total number of vectors in the database.
 * @property {Function} namespaceCount - Returns the count of vectors in a given namespace.
 * @property {Function} similarityResponse - Performs a similarity search on a given namespace.
 * @property {Function} rerankedSimilarityResponse - Performs a similarity search on a given namespace with reranking (if supported by provider).
 * @property {Function} namespace - Retrieves the specified namespace collection.
 * @property {Function} hasNamespace - Checks if a namespace exists.
 * @property {Function} namespaceExists - Verifies if a namespace exists in the client.
 * @property {Function} deleteVectorsInNamespace - Deletes all vectors in a specified namespace.
 * @property {Function} deleteDocumentFromNamespace - Deletes a document from a specified namespace.
 * @property {Function} addDocumentToNamespace - Adds a document to a specified namespace.
 * @property {Function} performSimilaritySearch - Performs a similarity search in the namespace.
 */

/**
 * @typedef {Object} BaseEmbedderProvider
 * @property {string} model - The model used for embedding.
 * @property {number} maxConcurrentChunks - The maximum number of chunks processed concurrently.
 * @property {number} embeddingMaxChunkLength - The maximum length of each chunk for embedding.
 * @property {Function} embedTextInput - Embeds a single text input.
 * @property {Function} embedChunks - Embeds multiple chunks of text.
 */

/**
 * Gets the systems current vector database provider.
 * @param {('pinecone' | 'chroma' | 'chromacloud' | 'lancedb' | 'weaviate' | 'qdrant' | 'milvus' | 'zilliz' | 'astra') | null} getExactly - If provided, this will return an explit provider.
 * @returns { BaseVectorDatabaseProvider}
 */
function getVectorDbClass(getExactly = null) {
  const vectorSelection = getExactly ?? process.env.VECTOR_DB ?? "lancedb";
  switch (vectorSelection) {
    case "pinecone":
      const { Pinecone } = require("../vectorDbProviders/pinecone");
      return new Pinecone();
    case "chroma":
      const { Chroma } = require("../vectorDbProviders/chroma");
      return new Chroma();
    case "chromacloud":
      const { ChromaCloud } = require("../vectorDbProviders/chromacloud");
      return new ChromaCloud();
    case "lancedb":
      const { LanceDb } = require("../vectorDbProviders/lance");
      return new LanceDb();
    case "weaviate":
      const { Weaviate } = require("../vectorDbProviders/weaviate");
      return new Weaviate();
    case "qdrant":
      const { QDrant } = require("../vectorDbProviders/qdrant");
      return new QDrant();
    case "milvus":
      const { Milvus } = require("../vectorDbProviders/milvus");
      return new Milvus();
    case "zilliz":
      const { Zilliz } = require("../vectorDbProviders/zilliz");
      return new Zilliz();
    case "astra":
      const { AstraDB } = require("../vectorDbProviders/astra");
      return new AstraDB();
    case "pgvector":
      const { PGVector } = require("../vectorDbProviders/pgvector");
      return new PGVector();
    default:
      console.error(
        `\x1b[31m[ENV ERROR]\x1b[0m No VECTOR_DB value found in environment! Falling back to LanceDB`
      );
      const { LanceDb: DefaultLanceDb } = require("../vectorDbProviders/lance");
      return new DefaultLanceDb();
  }
}

/**
 * Returns the LLMProvider with its embedder attached via system or via defined provider.
 * @param {{provider: string | null, model: string | null} | null} params - Initialize params for LLMs provider
 * @returns {BaseLLMProvider}
 */
function getLLMProvider({ provider = null, model = null } = {}) {
  const LLMSelection = provider ?? process.env.LLM_PROVIDER ?? "openai";
  const embedder = getEmbeddingEngineSelection();

  switch (LLMSelection) {
    case "openai":
      const { OpenAiLLM } = require("../AiProviders/openAi");
      return new OpenAiLLM(embedder, model);
    case "azure":
      const { AzureOpenAiLLM } = require("../AiProviders/azureOpenAi");
      return new AzureOpenAiLLM(embedder, model);
    case "anthropic":
      const { AnthropicLLM } = require("../AiProviders/anthropic");
      return new AnthropicLLM(embedder, model);
    case "gemini":
      const { GeminiLLM } = require("../AiProviders/gemini");
      return new GeminiLLM(embedder, model);
    case "lmstudio":
      const { LMStudioLLM } = require("../AiProviders/lmStudio");
      return new LMStudioLLM(embedder, model);
    case "localai":
      const { LocalAiLLM } = require("../AiProviders/localAi");
      return new LocalAiLLM(embedder, model);
    case "ollama":
      const { OllamaAILLM } = require("../AiProviders/ollama");
      return new OllamaAILLM(embedder, model);
    case "togetherai":
      const { TogetherAiLLM } = require("../AiProviders/togetherAi");
      return new TogetherAiLLM(embedder, model);
    case "fireworksai":
      const { FireworksAiLLM } = require("../AiProviders/fireworksAi");
      return new FireworksAiLLM(embedder, model);
    case "perplexity":
      const { PerplexityLLM } = require("../AiProviders/perplexity");
      return new PerplexityLLM(embedder, model);
    case "openrouter":
      const { OpenRouterLLM } = require("../AiProviders/openRouter");
      return new OpenRouterLLM(embedder, model);
    case "mistral":
      const { MistralLLM } = require("../AiProviders/mistral");
      return new MistralLLM(embedder, model);
    case "huggingface":
      const { HuggingFaceLLM } = require("../AiProviders/huggingface");
      return new HuggingFaceLLM(embedder, model);
    case "groq":
      const { GroqLLM } = require("../AiProviders/groq");
      return new GroqLLM(embedder, model);
    case "koboldcpp":
      const { KoboldCPPLLM } = require("../AiProviders/koboldCPP");
      return new KoboldCPPLLM(embedder, model);
    case "textgenwebui":
      const { TextGenWebUILLM } = require("../AiProviders/textGenWebUI");
      return new TextGenWebUILLM(embedder, model);
    case "cohere":
      const { CohereLLM } = require("../AiProviders/cohere");
      return new CohereLLM(embedder, model);
    case "litellm":
      const { LiteLLM } = require("../AiProviders/liteLLM");
      return new LiteLLM(embedder, model);
    case "generic-openai":
      const { GenericOpenAiLLM } = require("../AiProviders/genericOpenAi");
      return new GenericOpenAiLLM(embedder, model);
    case "bedrock":
      const { AWSBedrockLLM } = require("../AiProviders/bedrock");
      return new AWSBedrockLLM(embedder, model);
    case "deepseek":
      const { DeepSeekLLM } = require("../AiProviders/deepseek");
      return new DeepSeekLLM(embedder, model);
    case "apipie":
      const { ApiPieLLM } = require("../AiProviders/apipie");
      return new ApiPieLLM(embedder, model);
    case "novita":
      const { NovitaLLM } = require("../AiProviders/novita");
      return new NovitaLLM(embedder, model);
    case "xai":
      const { XAiLLM } = require("../AiProviders/xai");
      return new XAiLLM(embedder, model);
    case "nvidia-nim":
      const { NvidiaNimLLM } = require("../AiProviders/nvidiaNim");
      return new NvidiaNimLLM(embedder, model);
    case "ppio":
      const { PPIOLLM } = require("../AiProviders/ppio");
      return new PPIOLLM(embedder, model);
    case "moonshotai":
      const { MoonshotAiLLM } = require("../AiProviders/moonshotAi");
      return new MoonshotAiLLM(embedder, model);
    case "dpais":
      const { DellProAiStudioLLM } = require("../AiProviders/dellProAiStudio");
      return new DellProAiStudioLLM(embedder, model);
    case "cometapi":
      const { CometApiLLM } = require("../AiProviders/cometapi");
      return new CometApiLLM(embedder, model);
    case "foundry":
      const { FoundryLLM } = require("../AiProviders/foundry");
      return new FoundryLLM(embedder, model);
    case "zai":
      const { ZAiLLM } = require("../AiProviders/zai");
      return new ZAiLLM(embedder, model);
    case "giteeai":
      const { GiteeAILLM } = require("../AiProviders/giteeai");
      return new GiteeAILLM(embedder, model);
    case "docker-model-runner":
      const {
        DockerModelRunnerLLM,
      } = require("../AiProviders/dockerModelRunner");
      return new DockerModelRunnerLLM(embedder, model);
    case "privatemode":
      const { PrivatemodeLLM } = require("../AiProviders/privatemode");
      return new PrivatemodeLLM(embedder, model);
    case "sambanova":
      const { SambaNovaLLM } = require("../AiProviders/sambanova");
      return new SambaNovaLLM(embedder, model);
    default:
      throw new Error(
        `ENV: No valid LLM_PROVIDER value found in environment! Using ${process.env.LLM_PROVIDER}`
      );
  }
}

/**
 * Returns the EmbedderProvider by itself to whatever is currently in the system settings.
 * @returns {BaseEmbedderProvider}
 */
function getEmbeddingEngineSelection() {
  const { NativeEmbedder } = require("../EmbeddingEngines/native");
  const engineSelection = process.env.EMBEDDING_ENGINE;
  switch (engineSelection) {
    case "openai":
      const { OpenAiEmbedder } = require("../EmbeddingEngines/openAi");
      return new OpenAiEmbedder();
    case "azure":
      const {
        AzureOpenAiEmbedder,
      } = require("../EmbeddingEngines/azureOpenAi");
      return new AzureOpenAiEmbedder();
    case "localai":
      const { LocalAiEmbedder } = require("../EmbeddingEngines/localAi");
      return new LocalAiEmbedder();
    case "ollama":
      const { OllamaEmbedder } = require("../EmbeddingEngines/ollama");
      return new OllamaEmbedder();
    case "native":
      return new NativeEmbedder();
    case "lmstudio":
      const { LMStudioEmbedder } = require("../EmbeddingEngines/lmstudio");
      return new LMStudioEmbedder();
    case "cohere":
      const { CohereEmbedder } = require("../EmbeddingEngines/cohere");
      return new CohereEmbedder();
    case "voyageai":
      const { VoyageAiEmbedder } = require("../EmbeddingEngines/voyageAi");
      return new VoyageAiEmbedder();
    case "litellm":
      const { LiteLLMEmbedder } = require("../EmbeddingEngines/liteLLM");
      return new LiteLLMEmbedder();
    case "mistral":
      const { MistralEmbedder } = require("../EmbeddingEngines/mistral");
      return new MistralEmbedder();
    case "generic-openai":
      const {
        GenericOpenAiEmbedder,
      } = require("../EmbeddingEngines/genericOpenAi");
      return new GenericOpenAiEmbedder();
    case "gemini":
      const { GeminiEmbedder } = require("../EmbeddingEngines/gemini");
      return new GeminiEmbedder();
    case "openrouter":
      const { OpenRouterEmbedder } = require("../EmbeddingEngines/openRouter");
      return new OpenRouterEmbedder();
    default:
      return new NativeEmbedder();
  }
}

/**
 * Returns the reranker provider instance for vector-search reranking (KIE-471).
 *
 * Switches on process.env.RERANKER_PROVIDER. When it is unset (or unknown), the
 * NativeEmbeddingReranker is returned so the existing default/rerank behavior is
 * preserved byte-for-byte. When set to an external provider, a GenericReranker
 * (HTTP client) is returned. Both classes implement the same interface:
 *   rerank(query, documents:[{text}], {topK}) -> [{...doc, rerank_score}].
 *
 * @param {object} [config] - Optional overrides forwarded to GenericReranker
 *   (e.g. { instruction, timeoutMs }). Ignored for the native reranker.
 * @returns {import("../EmbeddingRerankers/native").NativeEmbeddingReranker | import("../EmbeddingRerankers/generic").GenericReranker}
 */
function getRerankerProviderSelection(config = {}) {
  const { NativeEmbeddingReranker } = require("../EmbeddingRerankers/native");
  const provider = process.env.RERANKER_PROVIDER;

  switch (provider) {
    case "cohere":
    case "tei": {
      const { GenericReranker } = require("../EmbeddingRerankers/generic");
      return new GenericReranker(config);
    }
    default:
      return new NativeEmbeddingReranker();
  }
}

/**
 * Returns the LLMProviderClass - this is a helper method to access static methods on a class
 * @param {{provider: string | null} | null} params - Initialize params for LLMs provider
 * @returns {BaseLLMProviderClass}
 */
function getLLMProviderClass({ provider = null } = {}) {
  switch (provider) {
    case "openai":
      const { OpenAiLLM } = require("../AiProviders/openAi");
      return OpenAiLLM;
    case "azure":
      const { AzureOpenAiLLM } = require("../AiProviders/azureOpenAi");
      return AzureOpenAiLLM;
    case "anthropic":
      const { AnthropicLLM } = require("../AiProviders/anthropic");
      return AnthropicLLM;
    case "gemini":
      const { GeminiLLM } = require("../AiProviders/gemini");
      return GeminiLLM;
    case "lmstudio":
      const { LMStudioLLM } = require("../AiProviders/lmStudio");
      return LMStudioLLM;
    case "localai":
      const { LocalAiLLM } = require("../AiProviders/localAi");
      return LocalAiLLM;
    case "ollama":
      const { OllamaAILLM } = require("../AiProviders/ollama");
      return OllamaAILLM;
    case "togetherai":
      const { TogetherAiLLM } = require("../AiProviders/togetherAi");
      return TogetherAiLLM;
    case "fireworksai":
      const { FireworksAiLLM } = require("../AiProviders/fireworksAi");
      return FireworksAiLLM;
    case "perplexity":
      const { PerplexityLLM } = require("../AiProviders/perplexity");
      return PerplexityLLM;
    case "openrouter":
      const { OpenRouterLLM } = require("../AiProviders/openRouter");
      return OpenRouterLLM;
    case "mistral":
      const { MistralLLM } = require("../AiProviders/mistral");
      return MistralLLM;
    case "huggingface":
      const { HuggingFaceLLM } = require("../AiProviders/huggingface");
      return HuggingFaceLLM;
    case "groq":
      const { GroqLLM } = require("../AiProviders/groq");
      return GroqLLM;
    case "koboldcpp":
      const { KoboldCPPLLM } = require("../AiProviders/koboldCPP");
      return KoboldCPPLLM;
    case "textgenwebui":
      const { TextGenWebUILLM } = require("../AiProviders/textGenWebUI");
      return TextGenWebUILLM;
    case "cohere":
      const { CohereLLM } = require("../AiProviders/cohere");
      return CohereLLM;
    case "litellm":
      const { LiteLLM } = require("../AiProviders/liteLLM");
      return LiteLLM;
    case "generic-openai":
      const { GenericOpenAiLLM } = require("../AiProviders/genericOpenAi");
      return GenericOpenAiLLM;
    case "bedrock":
      const { AWSBedrockLLM } = require("../AiProviders/bedrock");
      return AWSBedrockLLM;
    case "deepseek":
      const { DeepSeekLLM } = require("../AiProviders/deepseek");
      return DeepSeekLLM;
    case "apipie":
      const { ApiPieLLM } = require("../AiProviders/apipie");
      return ApiPieLLM;
    case "novita":
      const { NovitaLLM } = require("../AiProviders/novita");
      return NovitaLLM;
    case "xai":
      const { XAiLLM } = require("../AiProviders/xai");
      return XAiLLM;
    case "nvidia-nim":
      const { NvidiaNimLLM } = require("../AiProviders/nvidiaNim");
      return NvidiaNimLLM;
    case "ppio":
      const { PPIOLLM } = require("../AiProviders/ppio");
      return PPIOLLM;
    case "dpais":
      const { DellProAiStudioLLM } = require("../AiProviders/dellProAiStudio");
      return DellProAiStudioLLM;
    case "moonshotai":
      const { MoonshotAiLLM } = require("../AiProviders/moonshotAi");
      return MoonshotAiLLM;
    case "cometapi":
      const { CometApiLLM } = require("../AiProviders/cometapi");
      return CometApiLLM;
    case "foundry":
      const { FoundryLLM } = require("../AiProviders/foundry");
      return FoundryLLM;
    case "zai":
      const { ZAiLLM } = require("../AiProviders/zai");
      return ZAiLLM;
    case "giteeai":
      const { GiteeAILLM } = require("../AiProviders/giteeai");
      return GiteeAILLM;
    case "docker-model-runner":
      const {
        DockerModelRunnerLLM,
      } = require("../AiProviders/dockerModelRunner");
      return DockerModelRunnerLLM;
    case "privatemode":
      const { PrivateModeLLM } = require("../AiProviders/privatemode");
      return PrivateModeLLM;
    case "sambanova":
      const { SambaNovaLLM } = require("../AiProviders/sambanova");
      return SambaNovaLLM;
    default:
      return null;
  }
}

/**
 * Returns the defined model (if available) for the given provider.
 * @param {{provider: string | null} | null} params - Initialize params for LLMs provider
 * @returns {string | null}
 */
function getBaseLLMProviderModel({ provider = null } = {}) {
  switch (provider) {
    case "openai":
      return process.env.OPEN_MODEL_PREF;
    case "azure":
      return process.env.OPEN_MODEL_PREF;
    case "anthropic":
      return process.env.ANTHROPIC_MODEL_PREF;
    case "gemini":
      return process.env.GEMINI_LLM_MODEL_PREF;
    case "lmstudio":
      return process.env.LMSTUDIO_MODEL_PREF;
    case "localai":
      return process.env.LOCAL_AI_MODEL_PREF;
    case "ollama":
      return process.env.OLLAMA_MODEL_PREF;
    case "togetherai":
      return process.env.TOGETHER_AI_MODEL_PREF;
    case "fireworksai":
      return process.env.FIREWORKS_AI_LLM_MODEL_PREF;
    case "perplexity":
      return process.env.PERPLEXITY_MODEL_PREF;
    case "openrouter":
      return process.env.OPENROUTER_MODEL_PREF;
    case "mistral":
      return process.env.MISTRAL_MODEL_PREF;
    case "huggingface":
      return null;
    case "groq":
      return process.env.GROQ_MODEL_PREF;
    case "koboldcpp":
      return process.env.KOBOLD_CPP_MODEL_PREF;
    case "textgenwebui":
      return null;
    case "cohere":
      return process.env.COHERE_MODEL_PREF;
    case "litellm":
      return process.env.LITE_LLM_MODEL_PREF;
    case "generic-openai":
      return process.env.GENERIC_OPEN_AI_MODEL_PREF;
    case "bedrock":
      return process.env.AWS_BEDROCK_LLM_MODEL_PREFERENCE;
    case "deepseek":
      return process.env.DEEPSEEK_MODEL_PREF;
    case "apipie":
      return process.env.APIPIE_LLM_MODEL_PREF;
    case "novita":
      return process.env.NOVITA_LLM_MODEL_PREF;
    case "xai":
      return process.env.XAI_LLM_MODEL_PREF;
    case "nvidia-nim":
      return process.env.NVIDIA_NIM_LLM_MODEL_PREF;
    case "ppio":
      return process.env.PPIO_MODEL_PREF;
    case "dpais":
      return process.env.DPAIS_LLM_MODEL_PREF;
    case "moonshotai":
      return process.env.MOONSHOT_AI_MODEL_PREF;
    case "cometapi":
      return process.env.COMETAPI_LLM_MODEL_PREF;
    case "foundry":
      return process.env.FOUNDRY_MODEL_PREF;
    case "zai":
      return process.env.ZAI_MODEL_PREF;
    case "giteeai":
      return process.env.GITEE_AI_MODEL_PREF;
    case "docker-model-runner":
      return process.env.DOCKER_MODEL_RUNNER_LLM_MODEL_PREF;
    case "privatemode":
      return process.env.PRIVATEMODE_LLM_MODEL_PREF;
    case "sambanova":
      return process.env.SAMBANOVA_LLM_MODEL_PREF;
    default:
      return null;
  }
}

// Some models have lower restrictions on chars that can be encoded in a single pass
// and by default we assume it can handle 1,000 chars, but some models use work with smaller
// chars so here we can override that value when embedding information.
function maximumChunkLength() {
  if (
    !!process.env.EMBEDDING_MODEL_MAX_CHUNK_LENGTH &&
    !isNaN(process.env.EMBEDDING_MODEL_MAX_CHUNK_LENGTH) &&
    Number(process.env.EMBEDDING_MODEL_MAX_CHUNK_LENGTH) > 1
  )
    return Number(process.env.EMBEDDING_MODEL_MAX_CHUNK_LENGTH);

  return 1_000;
}

function toChunks(arr, size) {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_v, i) =>
    arr.slice(i * size, i * size + size)
  );
}

/**
 * @typedef {Object} MessageCountBreakdown
 * @property {number} total - Billable message count (chats + embed chats + adjustments, clamped at 0)
 * @property {number} workspaceChatCount
 * @property {number} embedChatCount
 * @property {number} adjustmentsTotal - Sum of manual quota adjustments in the range (>0 deduct, <0 credit)
 */

/**
 * Counts billable messages for a workspace within the given time range.
 * Includes manual quota adjustments (workspace_message_adjustments) so API-side
 * deductions consume the contingent exactly like real chat messages.
 *
 * Das Fenster ist halboffen: Start inklusiv, Ende exklusiv. So schließen zwei
 * aufeinanderfolgende Fenster lückenlos und ohne Überschneidung aneinander an.
 * Die Grenzen kommen aus getBillingWindow (billingWindow.js).
 *
 * Quelle der Nachrichten ist das Zählerbuch (KIE-532, models/messageLedger.js):
 * Löschungen senken den Stand nicht mehr. Die Live-Zählung der vorhandenen
 * Zeilen gilt nur noch, solange der Nachtrag des Zählerbuchs nicht als
 * abgeschlossen markiert ist. Danach dient sie allein dem Vergleich: Eine
 * Abweichung wird als Ereignis gemeldet, geliefert wird trotzdem das
 * Zählerbuch. Beide Quellen werden nie addiert.
 * @param {Object} workspace - The workspace object
 * @param {Date} start - The start of the window (inclusive)
 * @param {Date} endExclusive - The end of the window (exclusive)
 * @param {Object} options
 * @param {boolean} options.throwOnError - KIE-534: If true, a failing count query rejects
 * instead of being counted as 0 (default false: unchanged for normal chat and API paths)
 * @returns {Promise<MessageCountBreakdown>} - Breakdown of messages within the window
 */
async function countMessagesInDateRange(workspace, start, endExclusive, { throwOnError = false } = {}) {
  const { WorkspaceChats } = require("../../models/workspaceChats");
  const { EmbedChats } = require("../../models/embedChats");
  const {
    WorkspaceMessageAdjustments,
  } = require("../../models/workspaceMessageAdjustments");
  const { MessageLedger } = require("../../models/messageLedger");

  const [workspaceChatCount, embedChatCount, adjustmentsTotal, ledgerReady] =
    await Promise.all([
      WorkspaceChats.count(
        {
          workspaceId: workspace.id,
          createdAt: {
            gte: start,
            lt: endExclusive,
          },
        },
        { throwOnError }
      ),
      EmbedChats.countForWorkspaceInDateRange(
        workspace.id,
        start,
        endExclusive,
        { throwOnError }
      ),
      WorkspaceMessageAdjustments.sumForWorkspaceInDateRange(
        workspace.id,
        start,
        endExclusive,
        { throwOnError }
      ),
      MessageLedger.isBackfillComplete(),
    ]);

  if (!ledgerReady)
    return {
      // Credits cannot push the billable count below zero
      total: Math.max(
        0,
        workspaceChatCount + embedChatCount + adjustmentsTotal
      ),
      workspaceChatCount,
      embedChatCount,
      adjustmentsTotal,
    };

  const ledger = await countLedgerMessagesInDateRange(
    workspace,
    start,
    endExclusive,
    workspaceChatCount + embedChatCount
  );
  return {
    // Credits cannot push the billable count below zero
    total: Math.max(0, ledger.messages + adjustmentsTotal),
    workspaceChatCount: ledger.workspaceMessages,
    embedChatCount: ledger.embedMessages,
    adjustmentsTotal,
  };
}

/**
 * Nachrichten eines Workspaces im Fenster laut Zählerbuch. Vergleicht mit der
 * Live-Zählung desselben Fensters und meldet eine Abweichung (Ereignis
 * message_ledger_mismatch, höchstens einmal je Workspace und Stunde) - ohne
 * Rückfall auf die Live-Zählung. Wie die übrigen Zähler liefert ein
 * Datenbankfehler 0.
 * @param {Object} workspace - The workspace object
 * @param {Date} start - The start of the window (inclusive)
 * @param {Date} endExclusive - The end of the window (exclusive)
 * @param {number} liveCount - Vorhandene Chat-Zeilen im selben Fenster
 * @returns {Promise<{messages: number, copied: number, workspaceMessages: number, embedMessages: number}>}
 */
async function countLedgerMessagesInDateRange(
  workspace,
  start,
  endExclusive,
  liveCount
) {
  const { MessageLedger } = require("../../models/messageLedger");
  try {
    const { fromDay, toDayExclusive, aligned } = MessageLedger.daysOfWindow(
      start,
      endExclusive
    );
    const ledger = await MessageLedger.sumForWorkspace(
      workspace.id,
      fromDay,
      toDayExclusive
    );
    // Nur ganze Berliner Tage sind mit der Live-Zählung vergleichbar.
    if (aligned)
      await MessageLedger.reportMismatch({
        workspace,
        ledger,
        liveCount,
        start,
        endExclusive,
      });
    return ledger;
  } catch (error) {
    console.error(error.message);
    return { messages: 0, copied: 0, workspaceMessages: 0, embedMessages: 0 };
  }
}

/**
 * Counts messages for a workspace for the current calendar month (Berlin time),
 * regardless of any cycle fields on the workspace.
 * @param {Object} workspace - The workspace object
 * @param {Object} options - Passed on to countMessagesInDateRange (throwOnError)
 * @returns {Promise<MessageCountBreakdown>} - Breakdown of messages for the current month
 */
async function countMessagesForCurrentMonth(workspace, options = {}) {
  const { getBillingWindow } = require("./billingWindow");
  const { start, endExclusive } = getBillingWindow({ cycleStartDate: null });

  return await countMessagesInDateRange(workspace, start, endExclusive, options);
}

/**
 * Billing window of a workspace plus the cycle info derived from it.
 * cycleInfo is only set while a cycle is running (cycleNumber > 0); in the
 * calendar month (no cycle, or cycle not started yet) it is null.
 * @param {Object} workspace - The workspace object
 * @param {Date} [now] - Reference time (default: now)
 * @returns {{billingWindow: import("./billingWindow").BillingWindow, cycleInfo: Object|null}}
 */
function getBillingWindowWithCycleInfo(workspace, now = new Date()) {
  const { getBillingWindow } = require("./billingWindow");
  const billingWindow = getBillingWindow(workspace, now);

  let cycleInfo = null;
  if (billingWindow.cycleNumber > 0) {
    const { getCycleInfo } = require("./cycleHelpers");
    cycleInfo = getCycleInfo(workspace, now);
  }

  return { billingWindow, cycleInfo };
}

/**
 * Gets standardized message limit info for consistent response formatting.
 * Counts inside the workspace's billing window (see getBillingWindow): the
 * active cycle, or the calendar month when no cycle is set or it has not
 * started yet. cycleInfo is only set while a cycle is running.
 * @param {Object} workspace - The workspace object
 * @param {Date} [now] - Reference time (default: now)
 * @param {Object} options
 * @param {boolean} options.throwOnError - KIE-534: If true, a failing count query rejects
 * instead of being counted as 0 (see countMessagesInDateRange)
 * @returns {Promise<{messageCount: number, messagesLimit: number|null, contingent: string, adjustmentsTotal: number, cycleInfo: Object|null, billingWindow: import("./billingWindow").BillingWindow}>}
 */
async function getMessageLimitInfo(workspace, now = new Date(), { throwOnError = false } = {}) {
  const messagesLimit = workspace.messagesLimit; // Can be null
  const { billingWindow, cycleInfo } = getBillingWindowWithCycleInfo(workspace, now);
  const countBreakdown = await countMessagesInDateRange(
    workspace,
    billingWindow.start,
    billingWindow.endExclusive,
    { throwOnError }
  );

  const messageCount = countBreakdown.total;
  return {
    messageCount,
    messagesLimit,
    contingent: `${messageCount}/${messagesLimit ?? 'Unlimited'}`,
    adjustmentsTotal: countBreakdown.adjustmentsTotal,
    cycleInfo,
    billingWindow
  };
}

/**
 * Usage data for the billing tab (GET /workspace/:slug/usage).
 *
 * cycleInfo hat denselben Aufbau wie in der API und ist nur gesetzt, solange
 * ein Zyklus läuft. resetInfo nennt Reset-Tag und Resttage des laufenden
 * Fensters in jedem Fall, also auch im Kalendermonat (ohne Zyklus oder vor dem
 * Zyklusstart) - mit denselben Werten wie die Sperrmeldung. Die Ansicht muss
 * damit nichts selbst berechnen.
 * @param {Object} workspace - The workspace object
 * @param {Date} [now] - Reference time (default: now)
 * @returns {Promise<{messageCount: number, messagesLimit: number|null, contingent: string, adjustmentsTotal: number, cycleInfo: Object|null, resetInfo: {nextReset: Date, daysRemaining: number}}>}
 */
async function getWorkspaceUsageInfo(workspace, now = new Date()) {
  const usageInfo = await getMessageLimitInfo(workspace, now);
  const { resetDate, daysRemaining } = getMessageLimitResetInfo(usageInfo.billingWindow, usageInfo.cycleInfo);

  return {
    messageCount: usageInfo.messageCount,
    messagesLimit: usageInfo.messagesLimit,
    contingent: usageInfo.contingent,
    adjustmentsTotal: usageInfo.adjustmentsTotal,
    cycleInfo: usageInfo.cycleInfo
      ? {
          cycleNumber: usageInfo.cycleInfo.cycleNumber,
          cycleDurationMonths: usageInfo.cycleInfo.cycleDurationMonths,
          currentCycleStart: usageInfo.cycleInfo.currentCycleStart,
          currentCycleEnd: usageInfo.cycleInfo.currentCycleEnd,
          nextReset: usageInfo.cycleInfo.nextReset,
          daysRemaining: usageInfo.cycleInfo.daysRemaining,
        }
      : null,
    // nextReset ist eine Tagesmarke (00:00 UTC des Berliner Kalendertags)
    resetInfo: {
      nextReset: resetDate,
      daysRemaining,
    },
  };
}

/**
 * Gets the message limit error message in the appropriate language
 * @param {number} messagesLimit - The message limit set for the workspace
 * @param {string} periodName - The name of the period (month name or cycle description)
 * @param {number} daysRemaining - Number of days until the limit resets
 * @param {string} resetDate - The formatted date when the limit will reset
 * @param {string} language - The language code (default: 'en')
 * @param {Object|null} cycleInfo - Cycle info object if using cycle-based limits
 * @returns {string} - The translated error message
 */
function getMessageLimitErrorText(messagesLimit, periodName, daysRemaining, resetDate, language = 'en', cycleInfo = null) {
  const pluralS = daysRemaining !== 1 ? 's' : '';

  // Determine period type for messaging
  const isCycleBased = cycleInfo !== null;

  switch (language.toLowerCase()) {
    case 'de':
      // German translation
      const germanMonthName = {
        'January': 'Januar',
        'February': 'Februar',
        'March': 'März',
        'April': 'April',
        'May': 'Mai',
        'June': 'Juni',
        'July': 'Juli',
        'August': 'August',
        'September': 'September',
        'October': 'Oktober',
        'November': 'November',
        'December': 'Dezember'
      }[periodName] || periodName;

      const germanPluralDays = daysRemaining !== 1 ? 'en' : '';
      const germanPluralMessages = messagesLimit !== 1 ? 'en' : '';

      if (isCycleBased) {
        // Cycle-based message
        const cyclePeriodText = getCyclePeriodText(cycleInfo.cycleDurationMonths, 'de');
        return `Dieser Workspace hat das Limit von ${messagesLimit} Nachricht${germanPluralMessages} für den aktuellen ${cyclePeriodText} erreicht. Ihr Limit wird in ${daysRemaining} Tag${germanPluralDays} am ${resetDate} zurückgesetzt.`;
      } else {
        // Monthly message (backward compatible)
        return `Dieser Workspace hat das monatliche Limit von ${messagesLimit} Nachricht${germanPluralMessages} für den Monat ${germanMonthName} erreicht. Ihr Limit wird in ${daysRemaining} Tag${germanPluralDays} am ${resetDate} zurückgesetzt.`;
      }

    default:
      // English (default)
      if (isCycleBased) {
        const cyclePeriodText = getCyclePeriodText(cycleInfo.cycleDurationMonths, 'en');
        return `This workspace has reached the message limit of ${messagesLimit} for the current ${cyclePeriodText}. Your limit will reset in ${daysRemaining} day${pluralS} on ${resetDate}.`;
      } else {
        return `This workspace has reached the monthly message limit of ${messagesLimit} for ${periodName}. Your limit will reset in ${daysRemaining} day${pluralS} on ${resetDate}.`;
      }
  }
}

/**
 * Gets the human-readable cycle period text
 * @param {number} months - Cycle duration in months
 * @param {string} language - Language code
 * @returns {string} - Human-readable period text
 */
function getCyclePeriodText(months, language = 'en') {
  if (language === 'de') {
    switch (months) {
      case 1: return 'Monatszyklus';
      case 2: return '2-Monatszyklus';
      case 3: return 'Quartalszyklus';
      case 4: return '4-Monatszyklus';
      case 6: return 'Halbjahreszyklus';
      case 12: return 'Jahreszyklus';
      default: return `${months}-Monatszyklus`;
    }
  } else {
    switch (months) {
      case 1: return 'monthly cycle';
      case 2: return '2-month cycle';
      case 3: return 'quarterly cycle';
      case 4: return '4-month cycle';
      case 6: return 'semi-annual cycle';
      case 12: return 'annual cycle';
      default: return `${months}-month cycle`;
    }
  }
}

/**
 * Period name, remaining days and reset date as the limit-reached message and
 * the billing tab state them, derived from the billing window
 * (getBillingWindow) - never from the time zone of the process.
 * @param {import("./billingWindow").BillingWindow} billingWindow
 * @param {Object|null} cycleInfo - Cycle info while a cycle is running, otherwise null
 * @returns {{periodName: string, daysRemaining: number, resetDate: Date, formattedResetDate: string}} - resetDate ist eine Tagesmarke (00:00 UTC)
 */
function getMessageLimitResetInfo(billingWindow, cycleInfo = null) {
  const { BILLING_TIME_ZONE } = require("./billingWindow");
  let daysRemaining;
  let resetDate;
  let periodName;

  if (cycleInfo !== null) {
    // Use cycle-based reset info
    daysRemaining = cycleInfo.daysRemaining;
    resetDate = cycleInfo.nextReset;
    periodName = getCyclePeriodText(cycleInfo.cycleDurationMonths, 'en');
  } else {
    // Fallback to monthly reset (first day of next month).
    // Wie bisher: Tage bis zum letzten Tag des Fensters, am letzten Tag also 0.
    daysRemaining = billingWindow.daysRemaining - 1;
    resetDate = billingWindow.nextReset;
    // Monat des Fensters in Berliner Zeit, nicht in der Zeitzone des Prozesses
    periodName = billingWindow.start.toLocaleString('default', { month: 'long', timeZone: BILLING_TIME_ZONE });
  }

  // Format the date using Intl.DateTimeFormat for proper internationalization.
  // resetDate ist eine Tagesmarke (00:00 UTC), deshalb in UTC formatieren.
  const formattedResetDate = new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(resetDate);

  return { periodName, daysRemaining, resetDate, formattedResetDate };
}

/**
 * Limit-reached message for a workspace, derived from its billing window.
 * Same wording and numbers as checkWorkspaceMessagesLimit, without touching
 * the database - for handlers that already know the limit is reached.
 * @param {Object} workspace - The workspace object
 * @param {number} messagesLimit - The message limit set for the workspace
 * @param {string} language - The language code (default: 'en')
 * @param {Date} [now] - Reference time (default: now)
 * @returns {string} - The translated error message
 */
function getWorkspaceMessageLimitErrorText(workspace, messagesLimit, language = 'en', now = new Date()) {
  const { billingWindow, cycleInfo } = getBillingWindowWithCycleInfo(workspace, now);
  const { periodName, daysRemaining, formattedResetDate } = getMessageLimitResetInfo(billingWindow, cycleInfo);

  return getMessageLimitErrorText(
    messagesLimit,
    periodName,
    daysRemaining,
    formattedResetDate,
    language,
    cycleInfo
  );
}

/**
 * Checks if a workspace has reached its message limit and handles
 * the appropriate response. Supports both monthly and cycle-based limits.
 * @param {Object} workspace - The workspace object
 * @param {Object} response - Express response object or stream response
 * @param {Object} options - Additional options for handling responses
 * @param {boolean} options.isStreaming - Whether this is a streaming response
 * @param {Function} options.writeResponseChunk - Function to write chunks to streaming response
 * @param {Array} options.attachments - Any attachments to include in the response
 * @param {string} options.uuid - UUID to use for the response (or will generate new one)
 * @param {boolean} options.returnData - If true, returns the data instead of sending a response (for compatibility handlers)
 * @param {string} options.language - The language code for error messages (default: 'en')
 * @param {boolean} options.throwOnError - KIE-534: If true, a database error while counting rejects
 * instead of being counted as 0 messages. The agent entry points use this so a failed check ends the
 * session instead of silently passing; default false keeps normal chat and API paths unchanged.
 * @returns {Promise<{limitReached: boolean, messageCount: number, messagesLimit: number|null, errorData: Object|null, cycleInfo: Object|null}>}
 */
async function checkWorkspaceMessagesLimit(workspace, response, options = {}) {
  const { v4: uuidv4 } = require("uuid");

  const {
    isStreaming = false,
    writeResponseChunk = null,
    attachments = [],
    uuid = uuidv4(),
    returnData = false,
    language = 'de', // Default to German as requested
    throwOnError = false
  } = options;

  // Use the helper function to get consistent message limit info (cycle-aware)
  const { messageCount, messagesLimit, contingent, cycleInfo, billingWindow } = await getMessageLimitInfo(workspace, new Date(), { throwOnError });
  const { periodName, daysRemaining, formattedResetDate } = getMessageLimitResetInfo(billingWindow, cycleInfo);

  // Determine period info for logging
  const isCycleBased = cycleInfo !== null;
  const periodDescription = isCycleBased
    ? `${periodName} (Cycle #${cycleInfo.cycleNumber})`
    : `${periodName} ${billingWindow.startDay.slice(0, 4)}`;

  console.log(`---
Checking message limit for ${periodDescription}
Workspace: ${workspace.name} (${workspace.slug})
Message Count: ${messageCount}
Limit: ${messagesLimit ?? 'Unlimited'}
${isCycleBased ? `Cycle Start: ${cycleInfo.currentCycleStart.toISOString().split('T')[0]}
Next Reset: ${cycleInfo.nextReset.toISOString().split('T')[0]}
Days Remaining: ${cycleInfo.daysRemaining}` : ''}
---`);

  // Prepare return data regardless of limit status for consistent interface
  const result = {
    limitReached: false,
    messageCount,
    messagesLimit,
    errorData: null,
    cycleInfo
  };

  if (messagesLimit !== null && messageCount >= messagesLimit) {
    // Get the error message in the appropriate language (now cycle-aware)
    const errorMessage = getMessageLimitErrorText(
      messagesLimit,
      periodName,
      daysRemaining,
      formattedResetDate,
      language,
      cycleInfo // Pass cycle info for proper messaging
    );

    // Create consistent error data object with translated message
    const errorData = {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: errorMessage,
      messages_limit: messagesLimit,
      contingent,
      ...(isCycleBased && {
        cycle_info: {
          cycleNumber: cycleInfo.cycleNumber,
          daysRemaining: cycleInfo.daysRemaining,
          nextReset: cycleInfo.nextReset.toISOString(),
          cycleDurationMonths: cycleInfo.cycleDurationMonths
        }
      })
    };

    result.limitReached = true;
    result.errorData = errorData;

    // Only send response if not just returning data
    if (!returnData) {
      if (isStreaming && writeResponseChunk) {
        // For streaming responses
        // Set status code before writing the chunk
        if (response.status) {
          response.status(429);
        }
        writeResponseChunk(response, {
          ...errorData,
          type: "textResponse", // Different type for streaming responses
          textResponse: errorData.error,
          attachments,
          httpStatusCode: 429 // Add HTTP status code flag for consistency
        });
      } else {
        // For regular Express responses
        response.status(429).json(errorData);
      }
    }
  }

  return result;
}

function humanFileSize(bytes, si = false, dp = 1) {
  const thresh = si ? 1000 : 1024;

  if (Math.abs(bytes) < thresh) {
    return bytes + " B";
  }

  const units = si
    ? ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]
    : ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
  let u = -1;
  const r = 10 ** dp;

  do {
    bytes /= thresh;
    ++u;
  } while (
    Math.round(Math.abs(bytes) * r) / r >= thresh &&
    u < units.length - 1
  );

  return bytes.toFixed(dp) + " " + units[u];
}

module.exports = {
  getEmbeddingEngineSelection,
  getRerankerProviderSelection,
  maximumChunkLength,
  getVectorDbClass,
  getLLMProviderClass,
  getBaseLLMProviderModel,
  getLLMProvider,
  toChunks,
  countMessagesInDateRange,
  countMessagesForCurrentMonth,
  getMessageLimitInfo,
  getWorkspaceUsageInfo,
  getMessageLimitErrorText,
  getWorkspaceMessageLimitErrorText,
  getCyclePeriodText,
  checkWorkspaceMessagesLimit,
  humanFileSize,
};
