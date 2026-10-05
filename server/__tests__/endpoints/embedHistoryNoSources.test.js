/**
 * Hotfix: Der Embed-Verlaufs-Endpunkt darf keine Kontext-Schnipsel (sources)
 * an das Widget liefern. forEmbedByUser filtert nur bei boolescher
 * Legacy-Signatur; der Endpunkt übergibt seit der conversation_id-Umstellung
 * einen String und muss selbst filtern.
 */
const { EmbedChats } = require("../../models/embedChats");

describe("EmbedChats.filterSources", () => {
  it("entfernt sources aus den Antworten, behält den Text", () => {
    const chats = [
      {
        id: 1,
        prompt: "Gibt es Yogakurse?",
        response: JSON.stringify({
          text: "Ja, es gibt Yoga am Abend.",
          type: "chat",
          sources: [{ title: "yoga.txt", text: "GEHEIMER KONTEXT" }],
        }),
      },
    ];
    const out = EmbedChats.filterSources(chats);
    const parsed = JSON.parse(out[0].response);
    expect(parsed.text).toBe("Ja, es gibt Yoga am Abend.");
    expect(parsed.sources).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("GEHEIMER KONTEXT");
  });
});

describe("History-Endpunkt (Quelltext)", () => {
  it("ruft filterSources vor der Ausgabe auf", () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require.resolve("../../endpoints/embed/index.js"),
      "utf8"
    );
    expect(src).toMatch(
      /convertToChatHistory\(\s*EmbedChats\.filterSources\(history\)\s*\)/
    );
  });
});
