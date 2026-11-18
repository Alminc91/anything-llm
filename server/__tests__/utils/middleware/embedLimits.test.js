/* eslint-env jest, node */
// widget-grenzen-kontakt (issues/widget-grenzen-kontakt.md): Grenzen des
// Widgets im öffentlichen Chat-Endpunkt (canRespond).
//
// AK-6 (D1): Beide Grenzen zählen Nachrichten seit 0:00 Uhr Europe/Berlin des
// laufenden Kalendertags, nicht mehr die letzten 24 Stunden. Die Zeitzone des
// Prozesses wird nicht gesetzt: Die Erwartungen gelten für TZ=UTC,
// TZ=Europe/Berlin und TZ=America/New_York (yarn test:tz). Jeder Fall nennt
// eine Nachricht, die nach der Zeitzone des Prozesses falsch zählen würde.
//
// AK-11 (E5): Die 429-Antwort trägt errorCode "session_limit" bzw.
// "daily_limit"; jede andere Fehlerantwort keinen dieser Werte. Die Fälle
// stehen in fixtures/embedLimitContract.json, einer wortgleichen Kopie von
// tests/fixtures/embedLimitContract.json im Widget-Repo.
//
// Gegen eine echte SQLite-Datei aus den Migrationen
// (helpers/sqliteTestDatabase.js): Die Zählung läuft über Prisma wie im
// Betrieb.
jest.mock(
  "../../../utils/prisma",
  () => require("../../helpers/sqliteTestDatabase").testPrisma
);

const {
  createTestDatabase,
  createWorkspace,
  createEmbed,
  seedEmbedChats,
  berlinInstant,
} = require("../../helpers/sqliteTestDatabase");
const {
  canRespond,
  limitWindowStart,
  EMBED_LIMIT_ERROR_CODES,
} = require("../../../utils/middleware/embedMiddleware");
const { EmbedConfig } = require("../../../models/embedConfig");
const CONTRACT = require("../chats/fixtures/embedLimitContract.json");

jest.setTimeout(60000);

const SESSION = "6f1c2a1e-3b4d-4c5e-8f60-718293a4b5c6";
const OTHER_SESSION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ORIGIN = "https://www.vhs-beispiel.de";

// Nur die Uhr steht, alles andere läuft weiter (Prisma braucht die Timer).
function freezeClock(instant) {
  jest.useFakeTimers({
    now: instant,
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
}

let db;
let workspace;
beforeEach(async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  db = await createTestDatabase();
  workspace = await createWorkspace(db.client);
});
afterEach(async () => {
  jest.useRealTimers();
  console.error.mockRestore();
  await db.close();
});

/** Ein Widget wie in der Datenbank, mit Workspace (validEmbedConfig). */
async function embedWith(data = {}) {
  const { id } = await createEmbed(db.client, workspace, {
    chat_mode: "chat",
    ...data,
  });
  return await EmbedConfig.getWithWorkspace({ id });
}

/** Nachrichten des Widgets zu den genannten Zeitpunkten. */
async function chatsAt(embed, instants, session = SESSION) {
  await seedEmbedChats(
    db.client,
    instants.map((createdAt) => ({
      embed_id: embed.id,
      session_id: session,
      createdAt,
    }))
  );
}

/** canRespond wie in der Kette von POST /embed/:embedId/stream-chat. */
async function ask(
  embed,
  { sessionId = SESSION, message = "Wann beginnt der Kurs?", headers } = {}
) {
  const result = { statusCode: null, body: undefined, passed: false };
  const response = {
    locals: { embedConfig: embed },
    status(code) {
      result.statusCode = code;
      return response;
    },
    sendStatus(code) {
      result.statusCode = code;
      return response;
    },
    json(body) {
      result.body = JSON.parse(JSON.stringify(body));
      return response;
    },
    end() {
      return response;
    },
  };
  const request = {
    headers: headers === undefined ? { origin: ORIGIN } : headers,
    body: { sessionId, message },
    params: { embedId: embed?.uuid },
  };
  await canRespond(request, response, () => {
    result.passed = true;
  });
  return result;
}

// ---------------------------------------------------------------------------
// AK-6: Kalendertag Europe/Berlin statt der letzten 24 Stunden
// ---------------------------------------------------------------------------
describe("AK-6: Zählung ab 0:00 Uhr Europe/Berlin des laufenden Tages", () => {
  test("Beginn des Fensters: 0:00 Uhr Berliner Zeit, im Winter und im Sommer, auch kurz nach Mitternacht", () => {
    for (const [now, start] of [
      // 15:00 Uhr MEZ
      ["2026-11-12T14:00:00.000Z", "2026-11-11T23:00:00.000Z"],
      // 00:30 Uhr MEZ: in UTC und New York noch der Vortag
      ["2026-11-11T23:30:00.000Z", "2026-11-11T23:00:00.000Z"],
      // 23:59 Uhr MEZ
      ["2026-11-12T22:59:59.999Z", "2026-11-11T23:00:00.000Z"],
      // 12:00 Uhr MESZ
      ["2026-07-15T10:00:00.000Z", "2026-07-14T22:00:00.000Z"],
      // Tag der Umstellung auf Sommerzeit (23 Stunden), 10:00 Uhr MESZ
      ["2026-03-29T08:00:00.000Z", "2026-03-28T23:00:00.000Z"],
      // Tag der Umstellung auf Winterzeit (25 Stunden), 23:30 Uhr MEZ
      ["2026-10-25T22:30:00.000Z", "2026-10-24T22:00:00.000Z"],
    ])
      expect([now, limitWindowStart(new Date(now)).toISOString()]).toEqual([
        now,
        start,
      ]);
  });

  test("Fragen je Besucher und Tag: 23:30 Uhr gestern zählt heute nicht mit, 0:00 Uhr heute zählt", async () => {
    freezeClock(berlinInstant("2026-11-12", 15));
    const embed = await embedWith({ max_chats_per_session: 2 });
    await chatsAt(embed, [
      berlinInstant("2026-11-11", 23, 30),
      // eine Millisekunde vor Mitternacht
      new Date(berlinInstant("2026-11-12", 0).getTime() - 1),
      berlinInstant("2026-11-12", 9),
    ]);
    // In den letzten 24 Stunden wären es 3, heute ist es 1.
    expect(await ask(embed)).toMatchObject({ passed: true });

    await chatsAt(embed, [berlinInstant("2026-11-12", 0)]);
    const reached = await ask(embed);
    expect(reached.passed).toBe(false);
    expect(reached.statusCode).toBe(429);
    expect(reached.body.errorCode).toBe("session_limit");
  });

  test("Fragen aller Besucher je Tag: Nachrichten aller Sitzungen, gezählt ab 0:00 Uhr Berliner Zeit", async () => {
    freezeClock(berlinInstant("2026-11-12", 15));
    const embed = await embedWith({ max_chats_per_day: 3 });
    await chatsAt(embed, [berlinInstant("2026-11-11", 23, 30)], OTHER_SESSION);
    await chatsAt(embed, [berlinInstant("2026-11-12", 8)], OTHER_SESSION);
    await chatsAt(embed, [berlinInstant("2026-11-12", 9)]);
    expect(await ask(embed)).toMatchObject({ passed: true });

    await chatsAt(embed, [berlinInstant("2026-11-12", 14)], OTHER_SESSION);
    const reached = await ask(embed, { sessionId: SESSION });
    expect(reached.statusCode).toBe(429);
    expect(reached.body.errorCode).toBe("daily_limit");
  });

  test("kurz nach Mitternacht: 00:30 Uhr zählt nur die halbe Stunde seit 0:00 Uhr (in UTC und New York noch der Vortag)", async () => {
    // 00:30 Uhr MEZ = 23:30 UTC des Vortags = 18:30 Uhr in New York
    freezeClock(berlinInstant("2026-11-12", 0, 30));
    const embed = await embedWith({
      max_chats_per_session: 1,
      max_chats_per_day: 2,
    });
    // 22:00 Uhr MEZ gestern: nach UTC- oder New-Yorker Mitternacht noch „heute"
    await chatsAt(embed, [berlinInstant("2026-11-11", 22)]);
    await chatsAt(embed, [berlinInstant("2026-11-11", 23, 50)], OTHER_SESSION);
    expect(await ask(embed)).toMatchObject({ passed: true });

    // 0:10 Uhr MEZ heute = 23:10 UTC des Vortags: nach UTC-Mitternacht
    // gerechnet „gestern", in Berlin heute
    await chatsAt(embed, [berlinInstant("2026-11-12", 0, 10)]);
    const reached = await ask(embed);
    expect(reached.statusCode).toBe(429);
    expect(reached.body.errorCode).toBe("session_limit");
  });

  test("Sommerzeit: 0:00 Uhr MESZ ist 22:00 UTC des Vortags", async () => {
    freezeClock(berlinInstant("2026-07-15", 12));
    const embed = await embedWith({ max_chats_per_day: 1 });
    await chatsAt(embed, [new Date("2026-07-14T21:59:59.000Z")]);
    expect(await ask(embed)).toMatchObject({ passed: true });
    await chatsAt(embed, [new Date("2026-07-14T22:00:00.000Z")]);
    expect((await ask(embed)).body.errorCode).toBe("daily_limit");
  });

  test("nach Mitternacht geht es wieder: die Nachrichten von gestern Abend zählen am neuen Tag nicht", async () => {
    const embed = await embedWith({
      max_chats_per_session: 2,
      max_chats_per_day: 2,
    });
    await chatsAt(embed, [
      berlinInstant("2026-11-11", 20),
      berlinInstant("2026-11-11", 21),
    ]);
    freezeClock(berlinInstant("2026-11-11", 23, 59));
    expect((await ask(embed)).statusCode).toBe(429);
    jest.setSystemTime(berlinInstant("2026-11-12", 0, 1));
    expect(await ask(embed)).toMatchObject({ passed: true });
  });

  // §7 Bestand: 0 oder leer heißt unbegrenzt
  test("Bestand: 0 oder leer bedeutet unbegrenzt", async () => {
    freezeClock(berlinInstant("2026-11-12", 15));
    for (const value of [null, 0]) {
      const embed = await embedWith({
        max_chats_per_session: value,
        max_chats_per_day: value,
      });
      await chatsAt(
        embed,
        Array.from({ length: 30 }, (_, i) => berlinInstant("2026-11-12", 8, i))
      );
      expect([value, await ask(embed)]).toMatchObject([
        value,
        { passed: true },
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// AK-11: errorCode nach Vertrag (Fixture)
// ---------------------------------------------------------------------------
describe("AK-11: Kennung der Grenze in der 429-Antwort (Vertrag mit dem Widget)", () => {
  const limitCase = (code) =>
    CONTRACT.limitResponses.find((c) => c.response.errorCode === code);

  test("Fixture und Server nennen dieselben zwei Kennungen", () => {
    expect(Object.keys(CONTRACT.errorCodes).sort()).toEqual([
      "daily_limit",
      "session_limit",
    ]);
    expect(EMBED_LIMIT_ERROR_CODES).toEqual({
      daily: "daily_limit",
      session: "session_limit",
    });
    expect(CONTRACT.errorCodes).toEqual({
      session_limit: "max_chats_per_session",
      daily_limit: "max_chats_per_day",
    });
    expect(CONTRACT.limitStatus).toBe(429);
    expect(CONTRACT.window).toEqual({
      timeZone: "Europe/Berlin",
      start: "00:00",
      unlimited: [0, null],
    });
    expect(
      CONTRACT.limitResponses.map((c) => [c.setting, c.response.errorCode])
    ).toEqual([
      ["max_chats_per_session", "session_limit"],
      ["max_chats_per_day", "daily_limit"],
    ]);
  });

  test.each(CONTRACT.limitResponses.map((c) => [c.name, c]))(
    "%s: Antwort wie in der Fixture, dazu eine id",
    async (_name, { setting, status, response }) => {
      freezeClock(berlinInstant("2026-11-12", 15));
      const embed = await embedWith({ [setting]: 1 });
      await chatsAt(embed, [berlinInstant("2026-11-12", 9)]);
      const result = await ask(embed);
      expect(result.passed).toBe(false);
      expect(result.statusCode).toBe(status);
      const { id, ...rest } = result.body;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(rest).toEqual(response);
    }
  );

  test("beide Grenzen erreicht: daily_limit (die Grenze aller Besucher wird zuerst geprüft)", async () => {
    freezeClock(berlinInstant("2026-11-12", 15));
    const embed = await embedWith({
      max_chats_per_session: 1,
      max_chats_per_day: 1,
    });
    await chatsAt(embed, [berlinInstant("2026-11-12", 9)]);
    const { id: _id, ...rest } = (await ask(embed)).body;
    expect(rest).toEqual(limitCase("daily_limit").response);
  });

  test("nur die eigene Sitzung zählt für session_limit: ein anderer Besucher fragt weiter", async () => {
    freezeClock(berlinInstant("2026-11-12", 15));
    const embed = await embedWith({ max_chats_per_session: 1 });
    await chatsAt(embed, [berlinInstant("2026-11-12", 9)]);
    expect((await ask(embed)).body.errorCode).toBe("session_limit");
    expect(await ask(embed, { sessionId: OTHER_SESSION })).toMatchObject({
      passed: true,
    });
  });

  // Vertrag 5 und NAK-4 (Server-Seite): jede andere Fehlerantwort ohne
  // diese Kennungen. Die Grenzen sind dabei erreicht, damit eine falsch
  // gesetzte Kennung auffiele.
  describe("andere Fehlerantworten tragen keinen errorCode der Grenzen", () => {
    const other = (name) =>
      CONTRACT.otherResponses.find((c) => c.name === name);
    const triggers = {
      "Widget abgeschaltet": async (embed) => {
        await db.client.embed_configs.update({
          where: { id: embed.id },
          data: { enabled: false },
        });
        return ask({ ...embed, enabled: false });
      },
      "Seite nicht in den erlaubten Domains": (embed) =>
        ask(
          {
            ...embed,
            allowlist_domains: JSON.stringify(["https://andere.de"]),
          },
          {}
        ),
      "Sitzung ungültig": (embed) => ask(embed, { sessionId: "keine-uuid" }),
      "Nachricht leer": (embed) => ask(embed, { message: "" }),
      // Anfrage ohne Kopfzeilen: canRespond fängt den Fehler ab (500)
      "Fehler im Server": (embed) => ask(embed, { headers: null }),
    };

    test("jede Fehlerantwort der Fixture ist hier ausgelöst", () => {
      expect(CONTRACT.otherResponses.map((c) => c.name).sort()).toEqual(
        Object.keys(triggers).sort()
      );
      for (const c of CONTRACT.otherResponses) {
        expect([c.name, c.widget]).toEqual([c.name, "technical"]);
        expect(c.response).not.toHaveProperty("errorCode");
      }
    });

    test.each(Object.keys(triggers))("%s", async (name) => {
      freezeClock(berlinInstant("2026-11-12", 15));
      const embed = await embedWith({
        max_chats_per_session: 1,
        max_chats_per_day: 1,
      });
      await chatsAt(embed, [berlinInstant("2026-11-12", 9)]);
      const result = await triggers[name](embed);
      const expected = other(name);
      expect(result.passed).toBe(false);
      expect(result.statusCode).toBe(expected.status);
      const { id, ...rest } = result.body;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(rest).toEqual(expected.response);
      expect(Object.keys(CONTRACT.errorCodes)).not.toContain(
        result.body.errorCode
      );
    });
  });

  test("Texte der Fixture: de und en mit denselben Schlüsseln, Kontaktsatz am Ende der Grenzen, keine Gedankenstriche, keine Kufer-Adresse", () => {
    const { de, en } = CONTRACT.texts;
    expect(Object.keys(de).sort()).toEqual([
      "contact",
      "daily_limit",
      "session_limit",
      "technical",
    ]);
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
    for (const texts of [de, en]) {
      for (const code of Object.keys(CONTRACT.errorCodes))
        expect(texts[code].endsWith(` ${texts.contact}`)).toBe(true);
      expect(texts.technical).not.toContain("<E-Mail>");
      expect(texts.contact.endsWith(": <E-Mail>")).toBe(true);
    }
    const all = JSON.stringify(CONTRACT.texts);
    expect(all).not.toMatch(/[–—]/);
    expect(all).not.toMatch(/kufer/i);
    for (const c of [...CONTRACT.limitResponses, ...CONTRACT.otherResponses])
      expect(Object.keys(de)).toContain(c.widget);
  });
});

// Gegenprobe gegen das Widget-Repo (wie embedConfigContract.test.js mit
// KUFER_EMBED_DIR): Die Kopie der Fixture im Widget ist wortgleich.
const embedDir = process.env.KUFER_EMBED_DIR;
const describeWidget = embedDir ? describe : describe.skip;
describeWidget(
  "Vertrag der Grenzen: Gegenprobe im Embed-Repo (KUFER_EMBED_DIR)",
  () => {
    test("Kopie der Fixture im Widget-Repo ist wortgleich", () => {
      const fs = require("fs");
      const path = require("path");
      const copy = JSON.parse(
        fs.readFileSync(
          path.join(embedDir, "tests/fixtures/embedLimitContract.json"),
          "utf8"
        )
      );
      expect(copy).toEqual(CONTRACT);
    });
  }
);
