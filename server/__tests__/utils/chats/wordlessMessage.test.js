/* eslint-env jest, node */
// Antwortsprache bei Nachrichten ohne Wörter (sprache-nur-nummer, FE-7):
// Erkennung nach Abschnitt 4 der Spezifikation und Wahl des Hinweises aus
// den früheren Nachrichten des Besuchers. Der Hinweis selbst ist ein fester
// Text; an die Nutzernachricht der Modellanfrage kommt nur einer der beiden
// Texte (D5 vom 16.11.2026), der System-Prompt bleibt ohne Hinweis.

const {
  hasWords,
  isWordlessMessage,
  wordlessResponseLanguage,
  responseLanguageNote,
} = require("../../../utils/chats/wordlessMessage");

describe("AK-1: Erkennung nach Abschnitt 4", () => {
  test.each([
    "XI41050",
    "XI41050?",
    "262-3103",
    "26W1001 26W1002",
    "26W1001, 26W1002",
    "12.12.",
    "😀 123",
  ])("ohne Wörter: %j", (message) => {
    expect(isWordlessMessage(message)).toBe(true);
    expect(hasWords(message)).toBe(false);
  });

  test.each([
    "Kurs XI41050",
    "course XI41050",
    "XI41050 bitte",
    "Nr. 123",
    "课程 123",
  ])("mit Wörtern, kein Hinweis: %j", (message) => {
    expect(isWordlessMessage(message)).toBe(false);
    expect(hasWords(message)).toBe(true);
  });

  test.each(["Ok", "?", "😀"])("ohne Ziffer, kein Hinweis: %j", (message) => {
    expect(isWordlessMessage(message)).toBe(false);
  });

  // D3 (16.11.2026): Die Erkennung wird nur enger. Ein Stück mit Ziffer
  // zählt auch als Wort, wenn es ein Zeichen einer Schrift ohne
  // Wortabstände enthält oder mindestens 4 Buchstaben am Stück.
  test.each([
    "我想报名XI41050",
    "这个课程3点开始吗",
    "コースXI41050",
    "코스XI41050",
    "คอร์ส123",
  ])(
    "D3, Schrift ohne Wortabstände mit angeklebter Nummer, mit Wörtern: %j",
    (message) => {
      expect(isWordlessMessage(message)).toBe(false);
      expect(hasWords(message)).toBe(true);
    }
  );

  test.each(["course123", "Kurs123", "Курс123"])(
    "D3, mindestens 4 Buchstaben am Stück vor der Nummer, mit Wörtern: %j",
    (message) => {
      expect(isWordlessMessage(message)).toBe(false);
      expect(hasWords(message)).toBe(true);
    }
  );

  test.each([
    "abc123",
    "XI41050",
    "TM3000",
    "26W1001",
    "H350125",
    "4M14",
    "262-3103",
    "I730112",
  ])(
    "D3, höchstens 3 Buchstaben am Stück (Kursnummern), weiter ohne Wörter: %j",
    (message) => {
      expect(isWordlessMessage(message)).toBe(true);
      expect(hasWords(message)).toBe(false);
    }
  );

  test("D3: jede der acht Schriften ohne Wortabstände zählt für sich, auch mit weniger als 4 Buchstaben am Stück", () => {
    for (const [script, piece] of [
      ["Han", "课3"],
      ["Hiragana", "3じ"],
      ["Katakana", "3コマ"],
      ["Hangul", "3시"],
      ["Thai", "3โมง"],
      ["Lao", "3ໂມງ"],
      ["Khmer", "3ម៉ោង"],
      ["Myanmar", "3နာရီ"],
    ]) {
      // Vorbedingung: Das Stück trägt nur über die Schrift, nicht über die
      // Regel mit 4 Buchstaben am Stück.
      expect([script, /\p{L}{4}/u.test(piece)]).toEqual([script, false]);
      expect([script, isWordlessMessage(piece)]).toEqual([script, false]);
    }
  });

  test("D3: Satzzeichen am Rand, die zu einer Schrift ohne Wortabstände gehören, zeigen die Schrift (mit Wörtern); allgemeine Satzzeichen nicht", () => {
    // Birmanisch ။, Khmer ។ und Thai ๚ gehören zur Schrift
    for (const message of ["XI41050။", "XI41050។", "XI41050๚"])
      expect([message, isWordlessMessage(message)]).toEqual([message, false]);
    // chinesische und japanische Satzzeichen gehören zu keiner Schrift
    for (const message of ["XI41050。", "「XI41050」", "XI41050？"])
      expect([message, isWordlessMessage(message)]).toEqual([message, true]);
  });

  test("D3: 4 Buchstaben müssen am Stück stehen, Ziffern dazwischen unterbrechen", () => {
    for (const message of ["A1B2C3D4", "ab1cd2", "Kur123", "XI41050 abc1"])
      expect([message, isWordlessMessage(message)]).toEqual([message, true]);
    for (const message of ["Kurs123", "123Kurs", "XI41050kurs", "(Kurs123)"])
      expect([message, isWordlessMessage(message)]).toEqual([message, false]);
  });

  test("Leerraum jeder Art trennt die Stücke (Zeilenumbruch, Tab, geschütztes Leerzeichen)", () => {
    for (const message of [
      "  I730112  ",
      "I730112\n",
      "26W1001\n26W1002",
      "26W1001\t26W1002",
      "26W1001 26W1002",
      "26W1001　26W1002",
    ])
      expect([message, isWordlessMessage(message)]).toEqual([message, true]);
    for (const message of [
      "Kurs\nXI41050",
      "XI41050\tbitte",
      "Nr. 123",
      "课程　123",
    ])
      expect([message, isWordlessMessage(message)]).toEqual([message, false]);
  });

  test("Satzzeichen am Rand zählen nicht: ein Wort bleibt ein Wort, Klammern um eine Nummer bleiben ohne Wort", () => {
    expect(isWordlessMessage("(XI41050)")).toBe(true);
    expect(isWordlessMessage("„XI41050“ …")).toBe(true);
    expect(isWordlessMessage("XI41050, bitte!")).toBe(false);
    expect(isWordlessMessage("¿XI41050?")).toBe(true);
    expect(isWordlessMessage("«Kurs» 123")).toBe(false);
  });

  test("leere oder fremde Eingaben gelten nicht als Nachricht ohne Wörter", () => {
    for (const message of ["", "   ", "\n", null, undefined, 123, {}, []]) {
      expect(isWordlessMessage(message)).toBe(false);
      expect(hasWords(message)).toBe(false);
    }
  });
});

describe("Wahl des Hinweises aus den früheren Nachrichten (AK-2, AK-3)", () => {
  test("ohne frühere Nachricht mit Wörtern: Deutsch", () => {
    expect(wordlessResponseLanguage("I730112")).toBe("german");
    expect(wordlessResponseLanguage("I730112", [])).toBe("german");
    // frühere Nachrichten ohne Wörter zählen nicht
    expect(
      wordlessResponseLanguage("I730112", ["262-3103", "😀", "?", "", null])
    ).toBe("german");
  });

  test("mit mindestens einer früheren Nachricht mit Wörtern: Sprache der früheren Nachrichten", () => {
    expect(
      wordlessResponseLanguage("I730112", ["Do you have yoga courses?"])
    ).toBe("previous");
    expect(wordlessResponseLanguage("I730112", ["262-3103", "Ok"])).toBe(
      "previous"
    );
    expect(
      wordlessResponseLanguage("26W1001, 26W1002", ["Gibt es Yogakurse?"])
    ).toBe("previous");
  });

  test("D3: frühere Nachricht mit angeklebter Nummer zählt als Nachricht mit Wörtern", () => {
    for (const earlier of ["我想报名XI41050", "コースXI41050", "Kurs123"])
      expect([earlier, wordlessResponseLanguage("XI41050", [earlier])]).toEqual(
        [earlier, "previous"]
      );
    expect(wordlessResponseLanguage("XI41050", ["abc123", "TM3000"])).toBe(
      "german"
    );
  });

  test("Nachricht mit Wörtern oder ohne Ziffer: nie ein Hinweis, gleich welcher Verlauf", () => {
    for (const history of [[], ["Gibt es Yogakurse?"], ["I730112"]])
      for (const message of [
        "Do you have yoga courses?",
        "course XI41050",
        "Kurs XI41050",
        "课程 123",
        "我想报名XI41050",
        "course123",
        "Ok",
        "?",
        "😀",
      ])
        expect([message, wordlessResponseLanguage(message, history)]).toEqual([
          message,
          null,
        ]);
  });
});

describe("Hinweistexte", () => {
  test("zwei feste englische Abschnitte am Ende, mit Grund und Sprache", () => {
    const german = responseLanguageNote("german");
    const previous = responseLanguageNote("previous");
    for (const note of [german, previous]) {
      expect(note).toMatch(/^\n\n### Response Language \(ACTIVE\)\n/);
      // nennt den Grund: die Nachricht enthält keine Wörter
      expect(note).toMatch(/contains no words/);
      // Textregel: keine Gedankenstriche
      expect(note).not.toMatch(/[–—]/);
      // eine Zeile nach der Überschrift, kurz
      expect(note.split("\n")).toHaveLength(4);
      expect(note.length).toBeLessThan(300);
    }
    expect(german).toMatch(/Answer in German\b/);
    expect(previous).toMatch(
      /Answer in the language of the user's earlier messages in this conversation/
    );
  });
});
