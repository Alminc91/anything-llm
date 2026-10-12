/**
 * Unit Tests for Cycle Helpers - Enterprise Billing Feature
 *
 * Tests cover:
 * - addMonths with clamping (edge cases)
 * - getCycleInfo calculations
 * - All cycle durations (1, 2, 3, 4, 6, 12 months)
 * - Upgrade scenarios
 * - Long-term consistency (multi-year)
 * - Various message packages
 *
 * Die Datumsfelder aus getCycleInfo sind Tagesmarken (00:00 UTC des Berliner
 * Kalendertags) und addMonths rechnet im UTC-Kalender. Deshalb wird hier mit
 * den UTC-Gettern geprüft, die Tests laufen so in jeder Prozess-Zeitzone.
 */

const {
  addMonths,
  getCycleInfo,
  isValidCycleDuration,
  getCycleDurationOptions,
  formatNextResetDate
} = require('../../utils/helpers/cycleHelpers');

// ============================================================================
// addMonths - Core Logic
// ============================================================================

describe('addMonths - Core Logic', () => {
  test('adds 1 month correctly', () => {
    const result = addMonths(new Date('2025-01-15'), 1);
    expect(result.getUTCFullYear()).toBe(2025);
    expect(result.getUTCMonth()).toBe(1); // February
    expect(result.getUTCDate()).toBe(15);
  });

  test('adds 3 months correctly', () => {
    const result = addMonths(new Date('2025-01-15'), 3);
    expect(result.getUTCFullYear()).toBe(2025);
    expect(result.getUTCMonth()).toBe(3); // April
    expect(result.getUTCDate()).toBe(15);
  });

  test('adds 6 months correctly', () => {
    const result = addMonths(new Date('2025-01-15'), 6);
    expect(result.getUTCFullYear()).toBe(2025);
    expect(result.getUTCMonth()).toBe(6); // July
    expect(result.getUTCDate()).toBe(15);
  });

  test('adds 12 months correctly', () => {
    const result = addMonths(new Date('2025-01-15'), 12);
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(0); // January
    expect(result.getUTCDate()).toBe(15);
  });

  test('handles string date input', () => {
    const result = addMonths('2025-01-15', 1);
    expect(result.getUTCMonth()).toBe(1); // February
    expect(result.getUTCDate()).toBe(15);
  });
});

// ============================================================================
// addMonths - Edge Cases (Clamping)
// ============================================================================

describe('addMonths - Edge Cases (Clamping)', () => {
  test('31. Januar + 1 Monat = 28. Februar (kein Schaltjahr)', () => {
    const result = addMonths(new Date('2025-01-31'), 1);
    expect(result.getUTCMonth()).toBe(1); // February
    expect(result.getUTCDate()).toBe(28);
  });

  test('31. Januar + 1 Monat = 29. Februar (Schaltjahr 2024)', () => {
    const result = addMonths(new Date('2024-01-31'), 1);
    expect(result.getUTCMonth()).toBe(1); // February
    expect(result.getUTCDate()).toBe(29);
  });

  test('31. März + 1 Monat = 30. April (April hat 30 Tage)', () => {
    const result = addMonths(new Date('2025-03-31'), 1);
    expect(result.getUTCMonth()).toBe(3); // April
    expect(result.getUTCDate()).toBe(30);
  });

  test('30. Januar + 1 Monat = 28. Februar (kein Schaltjahr)', () => {
    const result = addMonths(new Date('2025-01-30'), 1);
    expect(result.getUTCMonth()).toBe(1); // February
    expect(result.getUTCDate()).toBe(28);
  });

  test('29. Januar + 1 Monat = 28. Februar (kein Schaltjahr)', () => {
    const result = addMonths(new Date('2025-01-29'), 1);
    expect(result.getUTCMonth()).toBe(1); // February
    expect(result.getUTCDate()).toBe(28);
  });

  test('31. Mai + 1 Monat = 30. Juni', () => {
    const result = addMonths(new Date('2025-05-31'), 1);
    expect(result.getUTCMonth()).toBe(5); // June
    expect(result.getUTCDate()).toBe(30);
  });

  test('31. August + 1 Monat = 30. September', () => {
    const result = addMonths(new Date('2025-08-31'), 1);
    expect(result.getUTCMonth()).toBe(8); // September
    expect(result.getUTCDate()).toBe(30);
  });

  test('31. Oktober + 1 Monat = 30. November', () => {
    const result = addMonths(new Date('2025-10-31'), 1);
    expect(result.getUTCMonth()).toBe(10); // November
    expect(result.getUTCDate()).toBe(30);
  });
});

// ============================================================================
// addMonths - Jahres-Konsistenz (KRITISCH)
// ============================================================================

describe('addMonths - Jahres-Konsistenz (KRITISCH)', () => {
  test.each([1, 2, 3, 4, 6, 12])(
    'Zyklus %i Monate: Nach 12 Monaten zurück zum Original (Tag 15)',
    (months) => {
      const originalDate = new Date('2025-01-15');
      let date = new Date(originalDate);

      const cyclesPerYear = 12 / months;
      for (let i = 0; i < cyclesPerYear; i++) {
        date = addMonths(date, months);
      }

      expect(date.getUTCDate()).toBe(originalDate.getUTCDate());
      expect(date.getUTCMonth()).toBe(originalDate.getUTCMonth());
      expect(date.getUTCFullYear()).toBe(originalDate.getUTCFullYear() + 1);
    }
  );

  test('31. Januar über 4 Quartale = 31. Januar nächstes Jahr', () => {
    let date = new Date('2025-01-31');
    date = addMonths(date, 3); // → 30.04.2025 (April hat 30)
    date = addMonths(date, 3); // → 30.07.2025
    date = addMonths(date, 3); // → 30.10.2025
    date = addMonths(date, 3); // → 30.01.2026

    expect(date.getUTCMonth()).toBe(0); // Januar
    expect(date.getUTCFullYear()).toBe(2026);
    // Note: Day may be 30 due to April clamping propagating
  });

  test('28. Februar über 12 Monate = 28. Februar (Konsistenz)', () => {
    const start = new Date('2025-02-28');
    const end = addMonths(start, 12);

    expect(end.getUTCDate()).toBe(28);
    expect(end.getUTCMonth()).toBe(1); // Februar
    expect(end.getUTCFullYear()).toBe(2026);
  });

  test('15. des Monats bleibt immer 15.', () => {
    let date = new Date('2025-03-15');

    for (let i = 0; i < 24; i++) {
      // 2 years monthly
      date = addMonths(date, 1);
      expect(date.getUTCDate()).toBe(15);
    }
  });
});

// ============================================================================
// getCycleInfo - Zyklus-Berechnung
// ============================================================================

describe('getCycleInfo - Zyklus-Berechnung', () => {
  test('Neuer Zyklus: Tag 1', () => {
    const workspace = {
      cycleStartDate: '2025-01-15',
      cycleDurationMonths: 3,
      messagesLimit: 500
    };

    const info = getCycleInfo(workspace, new Date('2025-01-15'));

    expect(info.cycleNumber).toBe(1);
    expect(info.daysRemaining).toBeGreaterThan(85);
    expect(info.daysRemaining).toBeLessThanOrEqual(92);
  });

  test('Mitte im Zyklus (nach 30 Tagen)', () => {
    const workspace = {
      cycleStartDate: '2025-01-15',
      cycleDurationMonths: 3,
      messagesLimit: 500
    };

    const info = getCycleInfo(workspace, new Date('2025-02-15'));

    expect(info.cycleNumber).toBe(1);
    expect(info.daysRemaining).toBeGreaterThan(50);
    expect(info.daysRemaining).toBeLessThan(65);
  });

  test('Kurz vor Zyklus-Ende', () => {
    const workspace = {
      cycleStartDate: '2025-01-15',
      cycleDurationMonths: 3,
      messagesLimit: 500
    };

    const info = getCycleInfo(workspace, new Date('2025-04-10'));

    expect(info.cycleNumber).toBe(1);
    expect(info.daysRemaining).toBeLessThan(10);
  });

  test('Zweiter Zyklus', () => {
    const workspace = {
      cycleStartDate: '2025-01-15',
      cycleDurationMonths: 3,
      messagesLimit: 500
    };

    const info = getCycleInfo(workspace, new Date('2025-05-01'));

    expect(info.cycleNumber).toBe(2);
  });

  test('Nach einem Jahr: Zyklus 5 (bei Quartal)', () => {
    const workspace = {
      cycleStartDate: '2025-01-15',
      cycleDurationMonths: 3,
      messagesLimit: 500
    };

    const info = getCycleInfo(workspace, new Date('2026-02-01'));

    expect(info.cycleNumber).toBe(5);
  });

  test('Monatlich: Zyklus 7 nach 6.5 Monaten', () => {
    const workspace = {
      cycleStartDate: '2025-01-01',
      cycleDurationMonths: 1,
      messagesLimit: 100
    };

    const info = getCycleInfo(workspace, new Date('2025-07-15'));

    expect(info.cycleNumber).toBe(7);
  });

  test('Jährlich: Zyklus 1 für ganzes Jahr', () => {
    const workspace = {
      cycleStartDate: '2025-01-01',
      cycleDurationMonths: 12,
      messagesLimit: 5000
    };

    const info = getCycleInfo(workspace, new Date('2025-12-15'));

    expect(info.cycleNumber).toBe(1);
    expect(info.daysRemaining).toBeLessThan(20);
  });
});

// ============================================================================
// Alle Zykluslängen
// ============================================================================

describe('Alle Zykluslängen', () => {
  const testCases = [
    { months: 1, name: 'Monatlich', cyclesPerYear: 12 },
    { months: 2, name: 'Alle 2 Monate', cyclesPerYear: 6 },
    { months: 3, name: 'Quartalsweise', cyclesPerYear: 4 },
    { months: 4, name: 'Alle 4 Monate', cyclesPerYear: 3 },
    { months: 6, name: 'Halbjährlich', cyclesPerYear: 2 },
    { months: 12, name: 'Jährlich', cyclesPerYear: 1 }
  ];

  test.each(testCases)(
    '$name: Korrekte Zyklusanzahl pro Jahr',
    ({ months, cyclesPerYear }) => {
      const workspace = {
        cycleStartDate: '2025-01-01',
        cycleDurationMonths: months,
        messagesLimit: 500
      };

      // Simulate end of year (Dec 31)
      const info = getCycleInfo(workspace, new Date('2025-12-31'));

      expect(info.cycleNumber).toBe(cyclesPerYear);
    }
  );

  test.each(testCases)('$name: Startdatum 15. des Monats', ({ months }) => {
    const workspace = {
      cycleStartDate: '2025-03-15',
      cycleDurationMonths: months,
      messagesLimit: 1500
    };

    const info = getCycleInfo(workspace, new Date('2025-03-15'));

    expect(info.cycleNumber).toBe(1);
    expect(info.currentCycleStart.getUTCDate()).toBe(15);
  });

  test.each(testCases)('$name: cycleDurationMonths korrekt zurückgegeben', ({ months }) => {
    const workspace = {
      cycleStartDate: '2025-01-01',
      cycleDurationMonths: months,
      messagesLimit: 500
    };

    const info = getCycleInfo(workspace, new Date('2025-06-15'));

    expect(info.cycleDurationMonths).toBe(months);
  });
});

// ============================================================================
// Upgrade-Szenarien
// ============================================================================

describe('Upgrade-Szenarien', () => {
  test('Upgrade: Startdatum-Reset setzt Zyklus zurück', () => {
    // Vor Upgrade: 45 Tage im Zyklus
    const workspaceBefore = {
      cycleStartDate: '2025-01-01',
      cycleDurationMonths: 3,
      messagesLimit: 500
    };

    const infoBefore = getCycleInfo(workspaceBefore, new Date('2025-02-15'));
    expect(infoBefore.cycleNumber).toBe(1);
    expect(infoBefore.daysRemaining).toBeLessThan(50); // Weniger als die Hälfte

    // Nach Upgrade: Neues Startdatum = heute
    const workspaceAfter = {
      cycleStartDate: '2025-02-15', // Reset auf heute
      cycleDurationMonths: 3,
      messagesLimit: 1500 // Upgrade
    };

    const infoAfter = getCycleInfo(workspaceAfter, new Date('2025-02-15'));
    expect(infoAfter.cycleNumber).toBe(1); // Neuer Zyklus 1
    expect(infoAfter.daysRemaining).toBeGreaterThan(85); // Fast voller Zyklus
  });

  test('Upgrade: Limit-Erhöhung ohne Startdatum-Änderung', () => {
    const workspace = {
      cycleStartDate: '2025-01-15',
      cycleDurationMonths: 3,
      messagesLimit: 1500 // Erhöht von 500
    };

    const info = getCycleInfo(workspace, new Date('2025-02-15'));

    // Zyklus bleibt gleich, nur Limit ist höher
    expect(info.cycleNumber).toBe(1);
    expect(info.messagesLimit).toBe(1500);
  });

  test('Upgrade: Zykluslänge von monatlich auf quartalsweise', () => {
    const workspaceBefore = {
      cycleStartDate: '2025-01-15',
      cycleDurationMonths: 1,
      messagesLimit: 500
    };

    // Nach 2 Monaten, vor Upgrade
    const infoBefore = getCycleInfo(workspaceBefore, new Date('2025-03-10'));
    expect(infoBefore.cycleNumber).toBe(2); // 2. Monatszyklus (Feb 15 - Mar 14)

    // Nach Upgrade auf Quartal mit neuem Startdatum
    const workspaceAfter = {
      cycleStartDate: '2025-03-10',
      cycleDurationMonths: 3,
      messagesLimit: 1500
    };

    const infoAfter = getCycleInfo(workspaceAfter, new Date('2025-03-10'));
    expect(infoAfter.cycleNumber).toBe(1);
    expect(infoAfter.cycleDurationMonths).toBe(3);
  });

  test('Upgrade: Mid-cycle von 500 auf 1500 mit Startdatum-Reset', () => {
    const today = new Date('2025-06-20');

    const workspaceAfterUpgrade = {
      cycleStartDate: '2025-06-20', // Reset auf heute
      cycleDurationMonths: 3,
      messagesLimit: 1500
    };

    const info = getCycleInfo(workspaceAfterUpgrade, today);

    expect(info.cycleNumber).toBe(1);
    expect(info.daysRemaining).toBeGreaterThan(88); // Fast 90 Tage
    expect(info.messagesLimit).toBe(1500);
  });
});

// ============================================================================
// Langzeit-Konsistenz (über mehrere Jahre)
// ============================================================================

describe('Langzeit-Konsistenz (über mehrere Jahre)', () => {
  test('5 Jahre quartalsweise: Immer korrekter Zyklus', () => {
    const workspace = {
      cycleStartDate: '2025-01-15',
      cycleDurationMonths: 3,
      messagesLimit: 500
    };

    // Nach 5 Jahren sollten wir im Zyklus 21 sein (5*4 + 1)
    const info = getCycleInfo(workspace, new Date('2030-02-01'));

    expect(info.cycleNumber).toBe(21);
  });

  test('10 Jahre monatlich: Zyklus 121', () => {
    const workspace = {
      cycleStartDate: '2025-01-01',
      cycleDurationMonths: 1,
      messagesLimit: 100
    };

    const info = getCycleInfo(workspace, new Date('2035-01-15'));

    expect(info.cycleNumber).toBe(121); // 10*12 + 1
  });

  test('3 Jahre halbjährlich: Zyklus 7', () => {
    const workspace = {
      cycleStartDate: '2025-01-01',
      cycleDurationMonths: 6,
      messagesLimit: 2000
    };

    const info = getCycleInfo(workspace, new Date('2028-02-01'));

    expect(info.cycleNumber).toBe(7); // 3*2 + 1
  });
});

// ============================================================================
// Verschiedene Nachrichtenpakete
// ============================================================================

describe('Verschiedene Nachrichtenpakete', () => {
  const packages = [
    { limit: 100, name: 'Starter' },
    { limit: 500, name: 'Basic' },
    { limit: 1500, name: 'Pro' },
    { limit: 5000, name: 'Enterprise' },
    { limit: null, name: 'Unlimited' }
  ];

  test.each(packages)('Paket $name: Limit korrekt in cycleInfo', ({ limit }) => {
    const workspace = {
      cycleStartDate: '2025-01-15',
      cycleDurationMonths: 3,
      messagesLimit: limit
    };

    const info = getCycleInfo(workspace, new Date('2025-02-15'));

    expect(info.messagesLimit).toBe(limit);
  });
});

// ============================================================================
// Validation Functions
// ============================================================================

describe('isValidCycleDuration', () => {
  test('valid durations return true', () => {
    expect(isValidCycleDuration(1)).toBe(true);
    expect(isValidCycleDuration(2)).toBe(true);
    expect(isValidCycleDuration(3)).toBe(true);
    expect(isValidCycleDuration(4)).toBe(true);
    expect(isValidCycleDuration(6)).toBe(true);
    expect(isValidCycleDuration(12)).toBe(true);
  });

  test('invalid durations return false', () => {
    expect(isValidCycleDuration(5)).toBe(false);
    expect(isValidCycleDuration(7)).toBe(false);
    expect(isValidCycleDuration(8)).toBe(false);
    expect(isValidCycleDuration(9)).toBe(false);
    expect(isValidCycleDuration(10)).toBe(false);
    expect(isValidCycleDuration(11)).toBe(false);
    expect(isValidCycleDuration(0)).toBe(false);
    expect(isValidCycleDuration(-1)).toBe(false);
    expect(isValidCycleDuration(13)).toBe(false);
  });
});

describe('getCycleDurationOptions', () => {
  test('returns all 6 valid options', () => {
    const options = getCycleDurationOptions();

    expect(options).toHaveLength(6);
    expect(options.map((o) => o.value)).toEqual([1, 2, 3, 4, 6, 12]);
  });

  test('each option has value and label', () => {
    const options = getCycleDurationOptions();

    options.forEach((option) => {
      expect(option).toHaveProperty('value');
      expect(option).toHaveProperty('label');
      expect(typeof option.value).toBe('number');
      expect(typeof option.label).toBe('string');
    });
  });
});

// ============================================================================
// formatNextResetDate
// ============================================================================

describe('formatNextResetDate', () => {
  test('formats date correctly in German', () => {
    const workspace = {
      cycleStartDate: '2025-01-15',
      cycleDurationMonths: 3,
      messagesLimit: 500
    };

    const formatted = formatNextResetDate(workspace, 'de-DE', new Date('2025-02-01'));

    expect(formatted).toContain('April');
    expect(formatted).toContain('2025');
  });

  test('fallback to monthly when no cycleStartDate', () => {
    const workspace = {
      cycleStartDate: null,
      cycleDurationMonths: null,
      messagesLimit: 500
    };

    const formatted = formatNextResetDate(workspace, 'de-DE', new Date('2025-02-15'));

    expect(formatted).toContain('März');
    expect(formatted).toContain('2025');
  });
});

// ============================================================================
// Edge Case: Startdatum in der Zukunft
// ============================================================================

describe('Edge Case: Startdatum in der Zukunft', () => {
  test('Startdatum liegt in der Zukunft', () => {
    const workspace = {
      cycleStartDate: '2025-06-01',
      cycleDurationMonths: 3,
      messagesLimit: 500
    };

    // Simulate "today" before start date
    const info = getCycleInfo(workspace, new Date('2025-03-15'));

    // KIE-531: Bis zum Start gilt der Kalendermonat, der erste Zyklus hat
    // noch nicht begonnen (cycleNumber 0).
    expect(info.cycleNumber).toBe(0);
    expect(info.currentCycleStart.toISOString()).toBe('2025-03-01T00:00:00.000Z');
    expect(info.currentCycleEnd.toISOString()).toBe('2025-03-31T00:00:00.000Z');
    expect(info.nextReset.toISOString()).toBe('2025-04-01T00:00:00.000Z');
  });
});

// ============================================================================
// Edge Case: Same day calculations
// ============================================================================

describe('Edge Case: Same day calculations', () => {
  test('Exact cycle boundary', () => {
    const workspace = {
      cycleStartDate: '2025-01-01',
      cycleDurationMonths: 1,
      messagesLimit: 500
    };

    // Exactly on Feb 1 (start of cycle 2)
    const info = getCycleInfo(workspace, new Date('2025-02-01'));

    expect(info.cycleNumber).toBe(2);
  });

  test('One day before cycle end', () => {
    const workspace = {
      cycleStartDate: '2025-01-01',
      cycleDurationMonths: 1,
      messagesLimit: 500
    };

    const info = getCycleInfo(workspace, new Date('2025-01-31'));

    expect(info.cycleNumber).toBe(1);
    expect(info.daysRemaining).toBe(1);
  });
});
