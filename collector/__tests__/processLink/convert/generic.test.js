/* eslint-env jest */
// Ablauf in getPageContent (einlesen-tabellen-platzhalter, Teil T): Puppeteer,
// langchain und slugify fehlen lokal, deshalb Ersatzmodule. Geprüft wird die
// Reihenfolge der Schritte im Browser und welcher Text zurückkommt.
const mockState = { page: null };

jest.mock(
  "langchain/document_loaders/web/puppeteer",
  () => {
    class PuppeteerWebBaseLoader {
      constructor(webPath, options) {
        this.webPath = webPath;
        this.options = options;
      }
      static async imports() {
        return {
          launch: async () => ({
            newPage: async () => mockState.page,
            close: async () => {},
            process: () => null,
          }),
        };
      }
      async load() {
        return [{ pageContent: await this.scrape() }];
      }
    }
    return { PuppeteerWebBaseLoader };
  },
  { virtual: true }
);
jest.mock("slugify", () => ({ default: (value) => String(value) }), {
  virtual: true,
});
jest.mock(
  "uuid",
  () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }),
  {
    virtual: true,
  }
);
jest.mock("../../../processLink/helpers", () => ({
  returnResult: (result) => result,
  determineContentType: async () => ({
    contentType: "text/html",
    processVia: "web",
  }),
  processAsFile: async () => ({ success: false }),
}));
jest.mock("../../../utils/extensions/YoutubeTranscript", () => ({
  loadYouTubeTranscript: async () => ({ success: false }),
}));
jest.mock("../../../utils/files", () => ({
  writeToServerDocuments: ({ data }) => data,
}));
jest.mock("../../../utils/tokenizer", () => ({
  tokenizeString: () => 0,
}));
jest.mock("../../../utils/runtimeSettings", () =>
  jest.fn().mockImplementation(() => ({ get: () => [] }))
);

const { scrapeGenericUrl } = require("../../../processLink/convert/generic");
const { tableRowsToText } = require("../../../processLink/convert/tableRows");

// Ersatzseite: erkennt die Schritte am übergebenen Funktionsobjekt oder Quelltext.
function fakePage({ tableResult, tableError } = {}) {
  const calls = [];
  return {
    calls,
    setExtraHTTPHeaders: async () => {},
    setRequestInterception: async () => {},
    on: () => {},
    goto: async () => {},
    waitForFunction: async () => {},
    evaluate: async (fn) => {
      if (fn === tableRowsToText) {
        calls.push("tableRows");
        if (tableError) throw tableError;
        return tableResult;
      }
      const source = String(fn);
      if (source.includes("innerText.length")) {
        calls.push("measure");
        return 10;
      }
      if (source.includes("aria-expanded")) {
        calls.push("expand");
        return 0;
      }
      if (source.includes("header, footer, nav")) {
        calls.push("noise");
        return undefined;
      }
      if (source.includes("documentElement.innerHTML")) {
        calls.push("html");
        return "<head></head><body>HTML</body>";
      }
      if (source.includes("document.body.innerText")) {
        calls.push("innerText");
        return "Heutiger Text";
      }
      calls.push(`unbekannt: ${source.slice(0, 60)}`);
      return null;
    },
  };
}

async function capture(captureAs, pageOptions) {
  mockState.page = fakePage(pageOptions);
  const args = { link: "https://example.org/kurse", saveAsDocument: false };
  if (captureAs !== undefined) args.captureAs = captureAs;
  const result = await scrapeGenericUrl(args);
  return { result, calls: mockState.page.calls };
}

describe("getPageContent liest Tabellenzeilen als Textzeilen", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const converted = {
    text: "Kurs | 26B0001",
    rows: 1,
    fallback: null,
  };

  test("captureAs text: nach Aufklappen und Entfernen kommt die Umwandlung", async () => {
    const { result, calls } = await capture("text", { tableResult: converted });
    expect(calls).toEqual(["measure", "expand", "noise", "tableRows"]);
    expect(result.content).toBe("Kurs | 26B0001");
  });

  test("ohne captureAs (Standard) ebenso", async () => {
    const { result, calls } = await capture(undefined, {
      tableResult: converted,
    });
    expect(calls[calls.length - 1]).toBe("tableRows");
    expect(result.content).toBe("Kurs | 26B0001");
  });

  test("captureAs html bleibt unverändert, ohne Umwandlung", async () => {
    const { result, calls } = await capture("html", { tableResult: converted });
    expect(calls).toEqual(["measure", "expand", "noise", "html"]);
    expect(result.content).toBe("<head></head><body>HTML</body>");
  });

  test("Rückfall in der Seite: der zurückgegebene heutige Text gilt", async () => {
    const { result } = await capture("text", {
      tableResult: { text: "A\tB", rows: 0, fallback: "woerter" },
    });
    expect(result.content).toBe("A\tB");
  });

  test("Aufruf im Browser scheitert: heutiger innerText", async () => {
    const { result, calls } = await capture("text", {
      tableError: new Error("Protocol error"),
    });
    expect(calls.slice(-2)).toEqual(["tableRows", "innerText"]);
    expect(result.content).toBe("Heutiger Text");
  });

  test("unerwartete Antwort: heutiger innerText", async () => {
    const { result, calls } = await capture("text", { tableResult: null });
    expect(calls.slice(-2)).toEqual(["tableRows", "innerText"]);
    expect(result.content).toBe("Heutiger Text");
  });
});
