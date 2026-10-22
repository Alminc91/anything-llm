// Eine feste Uhr für Tests, die vom heutigen Tag abhängen: `new Date()` und
// `Date.now()` liefern für die Dauer eines Tests denselben Zeitpunkt. Alles
// andere an Date bleibt, wie es ist (new Date(Jahr, Monat, Tag), Date.UTC,
// Zeitzone des Prozesses) – auch für die Module, die der Test-Renderer lädt.
//
// Der Node-Test-Runner dieser Node-Version (18) kann Date nicht selbst
// ersetzen; Zeitgeber (setTimeout, setImmediate) laufen unverändert weiter.

/**
 * @param {import("node:test").TestContext} t - der Test; danach gilt wieder die echte Uhr
 * @param {string} iso - Zeitpunkt, z. B. "2026-10-13T10:00:00Z"
 * @returns {Date} - der feste Zeitpunkt
 */
export function fixClock(t, iso) {
  const RealDate = globalThis.Date;
  const fixed = new RealDate(iso).getTime();
  if (Number.isNaN(fixed)) throw new Error(`Kein Zeitpunkt: ${iso}`);
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }

    static now() {
      return fixed;
    }
  };
  t.after(() => {
    globalThis.Date = RealDate;
  });
  return new RealDate(fixed);
}

/**
 * Wie fixClock, aber die Uhr lässt sich im Test vorstellen: `set(iso)` gilt
 * für alle folgenden `new Date()` und `Date.now()`.
 * @param {import("node:test").TestContext} t
 * @param {string} iso - Anfangszeitpunkt
 * @returns {{set: (iso: string|number) => void}}
 */
export function movableClock(t, iso) {
  const RealDate = globalThis.Date;
  const parse = (value) => {
    const ms = new RealDate(value).getTime();
    if (Number.isNaN(ms)) throw new Error(`Kein Zeitpunkt: ${value}`);
    return ms;
  };
  let current = parse(iso);
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(current);
      else super(...args);
    }

    static now() {
      return current;
    }
  };
  t.after(() => {
    globalThis.Date = RealDate;
  });
  return {
    set(value) {
      current = parse(value);
    },
  };
}
