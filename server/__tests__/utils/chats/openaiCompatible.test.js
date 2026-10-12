/* eslint-env jest, node */
// Der Fork prüft im OpenAI-kompatiblen Pfad das Kontingent: Am Eingang sperrt
// er, wenn das Limit erreicht ist, und nach jeder gespeicherten Antwort liest
// er den neuen Stand (getMessageLimitInfo) und gibt ihn in der Antwort aus.
// Beides läuft hier echt: gegen eine SQLite-Datei aus den Migrationen
// (helpers/sqliteTestDatabase.js), mit echter Speicherung und dem Zählerbuch
// als Quelle. Ersetzt sind nur LLM, Vektorsuche und angeheftete Dokumente.
jest.mock(
  "../../../utils/prisma",
  () => require("../../helpers/sqliteTestDatabase").testPrisma
);
// Nur LLM und Vektorsuche sind Attrappen; die Kontingent-Helfer bleiben echt.
jest.mock("../../../utils/helpers", () => ({
  ...jest.requireActual("../../../utils/helpers"),
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));
jest.mock("../../../utils/DocumentManager", () => ({
  DocumentManager: class {
    constructor() {
      this.pinnedDocs = jest.fn().mockResolvedValue([]);
    }
  },
}));

const {
  OpenAICompatibleChat,
} = require("../../../utils/chats/openaiCompatible");
const { WorkspaceChats } = require("../../../models/workspaceChats");
const { MessageLedger } = require("../../../models/messageLedger");
const {
  getVectorDbClass,
  getLLMProvider,
  getMessageLimitInfo,
} = require("../../../utils/helpers");
const {
  runMessageLedgerBackfill,
} = require("../../../utils/boot/messageLedgerBackfill");
const {
  extractTextContent,
  extractAttachments,
} = require("../../../endpoints/api/openai/helpers");
const {
  createTestDatabase,
  removeTestDatabases,
  createWorkspace,
} = require("../../helpers/sqliteTestDatabase");

const DAY = 24 * 60 * 60 * 1000;

// Der erste Test erzeugt die Vorlage mit `prisma migrate deploy`.
jest.setTimeout(60000);

describe("OpenAICompatibleChat", () => {
  let db;
  let mockWorkspace;
  let mockVectorDb;
  let mockLLMConnector;
  let mockResponse;

  beforeEach(async () => {
    // Reset all mocks
    jest.clearAllMocks();

    // Die Filter-Erkennung (KIE-480) meldet die Antwort des Attrappen-LLM als
    // unlesbar und filtert dann nicht; die Meldungen bleiben aus der Ausgabe.
    jest.spyOn(console, "error").mockImplementation(() => {});

    // Wie nach dem Start des Servers: Der Nachtrag ist abgeschlossen, das
    // Kontingent liest das Zählerbuch.
    MessageLedger._resetCache();
    db = await createTestDatabase();
    const backfill = await runMessageLedgerBackfill({ log: () => {} });
    expect(backfill.ok).toBe(true);

    // Workspace mit Limit 5 und zwei schon verbrauchten Nachrichten. Der
    // Zyklus begann vor 20 Tagen: Das Abrechnungsfenster wechselt nicht
    // während des Tests, an keinem Kalendertag.
    mockWorkspace = await createWorkspace(db.client, {
      slug: "test-workspace",
      chatMode: "chat",
      chatProvider: "openai",
      chatModel: "gpt-4",
      messagesLimit: 5,
      cycleStartDate: new Date(Date.now() - 20 * DAY),
      cycleDurationMonths: 1,
    });
    for (const prompt of ["Earlier message 1", "Earlier message 2"])
      await WorkspaceChats.new({ workspaceId: mockWorkspace.id, prompt });

    // Setup mock VectorDb
    mockVectorDb = {
      hasNamespace: jest.fn().mockResolvedValue(true),
      namespaceCount: jest.fn().mockResolvedValue(1),
      // Wie die echte Suche wartet die Attrappe die Filter-Erkennung ab, die
      // der Handler parallel startet. So läuft nach dem Test nichts mehr
      // gegen die dann geschlossene Datenbank.
      performSimilaritySearch: jest.fn(async ({ filtersPromise }) => {
        await filtersPromise;
        return { contextTexts: [], sources: [], message: null };
      }),
    };
    getVectorDbClass.mockReturnValue(mockVectorDb);

    // Setup mock LLM connector
    mockLLMConnector = {
      promptWindowLimit: jest.fn().mockReturnValue(4000),
      compressMessages: jest.fn().mockResolvedValue([]),
      getChatCompletion: jest.fn().mockResolvedValue({
        textResponse: "Mock response",
        metrics: {},
      }),
      streamingEnabled: jest.fn().mockReturnValue(true),
      streamGetChatCompletion: jest.fn().mockResolvedValue({
        metrics: {},
      }),
      handleStream: jest.fn().mockResolvedValue("Mock streamed response"),
      defaultTemp: 0.7,
    };
    getLLMProvider.mockReturnValue(mockLLMConnector);

    // Die Speicherung ist echt und wird nur beobachtet: Die Limitprüfung
    // zählt, was hier entsteht.
    jest.spyOn(WorkspaceChats, "new");

    // Setup mock response object for streaming
    mockResponse = {
      write: jest.fn(),
    };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.close();
  });

  afterAll(() => removeTestDatabases());

  // Wie der Endpunkt (endpoints/api/openai): Er liest den Stand vor der
  // Anfrage und gibt ihn mit; daran entscheidet der Handler über die Sperre.
  async function limitBefore() {
    const { messageCount, messagesLimit } =
      await getMessageLimitInfo(mockWorkspace);
    return { messageCount, messagesLimit };
  }

  // Abschluss-Chunk des Streams im OpenAI-Format.
  function finalChunk() {
    return mockResponse.write.mock.calls
      .map(([raw]) => String(raw))
      .filter((raw) => raw.startsWith("data: {"))
      .map((raw) => JSON.parse(raw.slice("data: ".length)))
      .find((chunk) => chunk.choices?.[0]?.finish_reason === "stop");
  }

  describe("chatSync", () => {
    test("should handle OpenAI vision multimodal messages", async () => {
      const multiModalPrompt = [
        {
          type: "text",
          text: "What do you see in this image?",
        },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,abc123",
            detail: "low",
          },
        },
      ];

      const prompt = extractTextContent(multiModalPrompt);
      const attachments = extractAttachments(multiModalPrompt);
      const result = await OpenAICompatibleChat.chatSync({
        ...(await limitBefore()),
        workspace: mockWorkspace,
        prompt,
        attachments,
        systemPrompt: "You are a helpful assistant",
        history: [
          { role: "user", content: "Previous message" },
          { role: "assistant", content: "Previous response" },
        ],
        temperature: 0.7,
      });

      // Verify chat was saved with correct format
      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: mockWorkspace.id,
          prompt: multiModalPrompt[0].text,
          response: expect.objectContaining({
            text: "Mock response",
            attachments: [
              {
                name: "uploaded_image_0",
                mime: "image/png",
                contentString: multiModalPrompt[1].image_url.url,
              },
            ],
          }),
        })
      );

      // Verify response format
      expect(result).toEqual(
        expect.objectContaining({
          object: "chat.completion",
          choices: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                role: "assistant",
                content: "Mock response",
              }),
            }),
          ]),
        })
      );

      // Kontingent der Antwort: Stand nach dem Speichern, 2 frühere + diese
      expect(result).toEqual(
        expect.objectContaining({ contingent: "3/5", messages_limit: 5 })
      );
    });

    test("should handle regular text messages in OpenAI format", async () => {
      const promptString = "Hello world";
      const result = await OpenAICompatibleChat.chatSync({
        ...(await limitBefore()),
        workspace: mockWorkspace,
        prompt: promptString,
        systemPrompt: "You are a helpful assistant",
        history: [
          { role: "user", content: "Previous message" },
          { role: "assistant", content: "Previous response" },
        ],
        temperature: 0.7,
      });

      // Verify chat was saved without attachments
      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: mockWorkspace.id,
          prompt: promptString,
          response: expect.objectContaining({
            text: "Mock response",
            attachments: [],
          }),
        })
      );

      expect(result).toBeTruthy();

      // Kontingent der Antwort: Stand nach dem Speichern, 2 frühere + diese
      expect(result).toEqual(
        expect.objectContaining({ contingent: "3/5", messages_limit: 5 })
      );
    });
  });

  describe("streamChat", () => {
    test("should handle OpenAI vision multimodal messages in streaming mode", async () => {
      const multiModalPrompt = [
        {
          type: "text",
          text: "What do you see in this image?",
        },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,abc123",
            detail: "low",
          },
        },
      ];

      const prompt = extractTextContent(multiModalPrompt);
      const attachments = extractAttachments(multiModalPrompt);
      await OpenAICompatibleChat.streamChat({
        ...(await limitBefore()),
        workspace: mockWorkspace,
        response: mockResponse,
        prompt,
        attachments,
        systemPrompt: "You are a helpful assistant",
        history: [
          { role: "user", content: "Previous message" },
          { role: "assistant", content: "Previous response" },
        ],
        temperature: 0.7,
      });

      // Verify streaming was handled
      expect(mockLLMConnector.streamGetChatCompletion).toHaveBeenCalled();
      expect(mockLLMConnector.handleStream).toHaveBeenCalled();

      // Verify chat was saved with attachments
      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: mockWorkspace.id,
          prompt: multiModalPrompt[0].text,
          response: expect.objectContaining({
            text: "Mock streamed response",
            attachments: [
              {
                name: "uploaded_image_0",
                mime: "image/png",
                contentString: multiModalPrompt[1].image_url.url,
              },
            ],
          }),
        })
      );

      // Kontingent im Abschluss-Chunk: Stand nach dem Speichern, 2 frühere + diese
      expect(finalChunk()).toEqual(
        expect.objectContaining({ contingent: "3/5", messages_limit: 5 })
      );
    });

    test("should handle regular text messages in streaming mode", async () => {
      const promptString = "Hello world";
      await OpenAICompatibleChat.streamChat({
        ...(await limitBefore()),
        workspace: mockWorkspace,
        response: mockResponse,
        prompt: promptString,
        systemPrompt: "You are a helpful assistant",
        history: [
          { role: "user", content: "Previous message" },
          { role: "assistant", content: "Previous response" },
        ],
        temperature: 0.7,
      });

      // Verify streaming was handled
      expect(mockLLMConnector.streamGetChatCompletion).toHaveBeenCalled();
      expect(mockLLMConnector.handleStream).toHaveBeenCalled();

      // Verify chat was saved without attachments
      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: mockWorkspace.id,
          prompt: promptString,
          response: expect.objectContaining({
            text: "Mock streamed response",
            attachments: [],
          }),
        })
      );

      // Kontingent im Abschluss-Chunk: Stand nach dem Speichern, 2 frühere + diese
      expect(finalChunk()).toEqual(
        expect.objectContaining({ contingent: "3/5", messages_limit: 5 })
      );
    });
  });

  // Fork: Ist das Limit erreicht, sperrt der Handler am Eingang - ohne LLM,
  // ohne Suche und ohne dass eine Nachricht entsteht.
  describe("Limit erreicht", () => {
    const request = {
      prompt: "Hello world",
      systemPrompt: "You are a helpful assistant",
      history: [
        { role: "user", content: "Previous message" },
        { role: "assistant", content: "Previous response" },
      ],
      temperature: 0.7,
    };

    beforeEach(async () => {
      // Limit 2 bei zwei verbrauchten Nachrichten
      mockWorkspace = await db.client.workspaces.update({
        where: { id: mockWorkspace.id },
        data: { messagesLimit: 2 },
      });
    });

    async function expectNothingHappened() {
      expect(mockVectorDb.performSimilaritySearch).not.toHaveBeenCalled();
      expect(mockLLMConnector.getChatCompletion).not.toHaveBeenCalled();
      expect(mockLLMConnector.streamGetChatCompletion).not.toHaveBeenCalled();
      expect(WorkspaceChats.new).not.toHaveBeenCalled();
      expect(await db.client.workspace_chats.count()).toBe(2);
      expect(await limitBefore()).toEqual({
        messageCount: 2,
        messagesLimit: 2,
      });
    }

    test("chatSync: Abbruch mit 429-Kennzeichen, nichts gespeichert", async () => {
      const result = await OpenAICompatibleChat.chatSync({
        ...(await limitBefore()),
        workspace: mockWorkspace,
        ...request,
      });

      expect(result).toEqual(
        expect.objectContaining({
          object: "chat.completion",
          choices: [
            expect.objectContaining({
              message: { role: "assistant", content: null },
              finish_reason: "abort",
            }),
          ],
          contingent: "2/2",
          messages_limit: 2,
          httpStatusCode: 429,
        })
      );
      await expectNothingHappened();
    });

    test("streamChat: Abbruch-Chunk mit 429-Kennzeichen und [DONE], nichts gespeichert", async () => {
      mockResponse.status = jest.fn();
      await OpenAICompatibleChat.streamChat({
        ...(await limitBefore()),
        workspace: mockWorkspace,
        response: mockResponse,
        ...request,
      });

      expect(mockResponse.status).toHaveBeenCalledWith(429);
      expect(mockResponse.write).toHaveBeenCalledTimes(2);
      const [[chunk], [done]] = mockResponse.write.mock.calls;
      expect(JSON.parse(chunk.replace(/^data: /, ""))).toEqual(
        expect.objectContaining({
          choices: [
            expect.objectContaining({
              message: { role: "assistant", content: null },
              finish_reason: "abort",
            }),
          ],
          contingent: "2/2",
          messages_limit: 2,
          httpStatusCode: 429,
        })
      );
      expect(done).toBe("data: [DONE]\n\n");
      expect(mockLLMConnector.handleStream).not.toHaveBeenCalled();
      await expectNothingHappened();
    });
  });
});
