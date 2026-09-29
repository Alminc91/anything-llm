const {
  GenericReranker,
} = require("../../../utils/EmbeddingRerankers/generic");

describe("GenericReranker.resolveInstruction", () => {
  const now = new Date(2026, 8, 22, 11, 40); // Dienstag, 22.09.2026 (lokal)

  test("leere oder fehlende Anweisung bleibt leer", () => {
    expect(GenericReranker.resolveInstruction("", now)).toBe("");
    expect(GenericReranker.resolveInstruction(undefined, now)).toBe("");
    expect(GenericReranker.resolveInstruction(null, now)).toBe("");
  });

  test("Anweisung ohne Platzhalter bleibt byte-genau erhalten", () => {
    const text = "Repräsentiere diese Anfrage zum Abrufen relevanter Kurse";
    expect(GenericReranker.resolveInstruction(text, now)).toBe(text);
  });

  test("{date} wird zu deutschem Wochentag + Datum", () => {
    expect(
      GenericReranker.resolveInstruction(
        "Heute ist {date}. Nur passende Kurse.",
        now
      )
    ).toBe("Heute ist Dienstag, 22.09.2026. Nur passende Kurse.");
  });

  test("{datetime} entspricht dem System-Prompt-Format (moment LLLL) und mehrere Platzhalter werden ersetzt", () => {
    const moment = require("moment");
    const out = GenericReranker.resolveInstruction(
      "{date} / {datetime} / {date}",
      now
    );
    expect(out).toBe(
      `Dienstag, 22.09.2026 / ${moment(now).format("LLLL")} / Dienstag, 22.09.2026`
    );
    expect(out).not.toContain("{");
  });

  test("Locale-Aufruf verändert das globale moment nicht", () => {
    const moment = require("moment");
    const before = moment.locale();
    GenericReranker.resolveInstruction("{date}", now);
    expect(moment.locale()).toBe(before);
  });
});
