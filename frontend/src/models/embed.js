import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

/**
 * Dateiname aus dem Content-Disposition-Header des Exports (KIE-538). Der
 * Server sendet nur Buchstaben, Ziffern, ".", "_" und "-"; alles andere wird
 * nicht übernommen.
 * @param {string|null} header
 * @returns {string|null}
 */
export function filenameFromDisposition(header) {
  const name = /filename="([^"]*)"/i.exec(header ?? "")?.[1] ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) ? name : null;
}

/**
 * Die Auswahl der Konversationsliste als Rumpf – dieselbe für eine Seite der
 * Liste und für den Export (Fixliste 7, F25; der Server liest sie ebenso an
 * einer Stelle, conversationSelection).
 *
 * Der Zeitraum geht als die Kalendertage, die der Nutzer gewählt hat
 * (fromDay/toDay, beide einschließlich; null = „Gesamt“) – dieselben Tage
 * wie für Kennzahlen und Diagramm. Der Server begrenzt sie in Berliner Zeit,
 * unabhängig von der Zeitzone des Browsers (Fixliste 7, F06).
 * @param {Object} [selection]
 * @param {string|null} [selection.fromDay] - "YYYY-MM-DD"
 * @param {string|null} [selection.toDay]
 * @param {"all"|"negative"|"positive"} [selection.feedbackFilter] - KIE-508/527
 * @param {{fromDay: string, toDay: string}|null} [selection.startedBetween] -
 *   KIE-536: nur Konversationen, deren erste vorhandene Nachricht in diesem
 *   Abschnitt liegt (Klick auf eine Säule)
 * @param {string} [selection.search] - Suchbegriff (q); ohne Suche fehlt das Feld
 * @returns {object}
 */
export function conversationSelectionBody({
  fromDay = null,
  toDay = null,
  feedbackFilter = "all",
  startedBetween = null,
  search = "",
} = {}) {
  return {
    fromDay,
    toDay,
    feedbackFilter,
    ...(startedBetween
      ? {
          startedFromDay: startedBetween.fromDay,
          startedToDay: startedBetween.toDay,
        }
      : {}),
    ...(search ? { q: search } : {}),
  };
}

/**
 * Ergebnis einer gescheiterten Lösch-Anfrage (Netzfehler, keine JSON-Antwort,
 * Abbruch). Hat die Ansicht die Anfrage nach ihrer Höchstdauer abgebrochen
 * (signal), lautet es reason "timeout": Ob der Server noch löscht, ist dann
 * offen (Nachtrag rc3).
 * @param {Error} error
 * @param {AbortSignal} [signal]
 * @returns {{success: false, error: string, reason?: "timeout"}}
 */
function deleteFailure(error, signal) {
  if (signal?.aborted)
    return { success: false, reason: "timeout", error: "timeout" };
  console.error(error);
  return { success: false, error: error?.message };
}

const Embed = {
  embeds: async () => {
    return await fetch(`${API_BASE}/embeds`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res?.embeds || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  // Fixliste 6, N2: letzte Nachricht je sichtbarem Widget – für die
  // Vorauswahl der Ansicht „Konversationen“. Ergebnis: Liste
  // [{ embedId, lastMessageAt }] oder null (Fehler, kein Recht) – dann gilt
  // die Reihenfolge der Widget-Liste.
  lastActivity: async () => {
    return await fetch(`${API_BASE}/embeds/last-activity`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((res) =>
        res?.success && Array.isArray(res.lastActivity)
          ? res.lastActivity
          : null
      )
      .catch((e) => {
        console.error(e);
        return null;
      });
  },
  /**
   * KB-3: Status des Kursbestands zum Kursprogramm eines Widgets.
   * @param {number} widgetId
   * @returns {Promise<object|{notFound: true}|null>} null bei einem Fehler
   */
  courseStatus: async (widgetId) => {
    return await fetch(
      `${API_BASE}/embed/course-status?widget=${encodeURIComponent(widgetId)}`,
      { method: "GET", headers: baseHeaders() }
    )
      .then((res) => {
        if (res.status === 404) return { notFound: true };
        return res.ok ? res.json() : null;
      })
      .catch((e) => {
        console.error(e);
        return null;
      });
  },
  /**
   * KB-3, AK-5: nur der Zustand für den Punkt am Menüpunkt „Status“.
   * @returns {Promise<string|null>}
   */
  courseStatusState: async () => {
    return await fetch(`${API_BASE}/embeds/course-status`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((res) => (typeof res?.state === "string" ? res.state : null))
      .catch((e) => {
        console.error(e);
        return null;
      });
  },
  /**
   * KB-10 Teil 2: Benachrichtigung per E-Mail (Einstellung der Instanz).
   * @returns {Promise<{enabled: boolean, recipients: string[]|null, contacts: string[], effective: string[], canEdit: boolean}|null>}
   *   null bei einem Fehler
   */
  courseStatusNotify: async () => {
    return await fetch(`${API_BASE}/embeds/course-status/notify`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch((e) => {
        console.error(e);
        return null;
      });
  },
  /**
   * KB-10 Teil 2: Benachrichtigung speichern (admin, manager).
   * @param {{enabled: boolean, recipients: string[]}} settings
   * @returns {Promise<object>} Antwort des Servers; bei einem Fehler
   *   success false mit code (adresse, zu_viele, ungueltig, fehler) und
   *   der deutschen Meldung error
   */
  saveCourseStatusNotify: async (settings) => {
    return await fetch(`${API_BASE}/embeds/course-status/notify`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(settings),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (res.ok && body?.success === true) return body;
        return {
          success: false,
          code: typeof body?.code === "string" ? body.code : "fehler",
          address: typeof body?.address === "string" ? body.address : null,
          error: typeof body?.error === "string" ? body.error : null,
        };
      })
      .catch((e) => {
        console.error(e);
        return { success: false, code: "fehler", address: null, error: null };
      });
  },
  newEmbed: async (data) => {
    return await fetch(`${API_BASE}/embeds/new`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(data),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { embed: null, error: e.message };
      });
  },
  updateEmbed: async (embedId, data) => {
    return await fetch(`${API_BASE}/embed/update/${embedId}`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(data),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  deleteEmbed: async (embedId) => {
    return await fetch(`${API_BASE}/embed/${embedId}`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => {
        if (res.ok) return { success: true, error: null };
        throw new Error(res.statusText);
      })
      .catch((e) => {
        console.error(e);
        return { success: true, error: e.message };
      });
  },
  // DSGVO: Clear all embed chats (globally)
  clearAllChats: async () => {
    return await fetch(`${API_BASE}/embed-chats/clear/-1`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  // DSGVO: Clear all chats for a specific embed
  clearEmbedChats: async (embedId) => {
    return await fetch(`${API_BASE}/embed-chats/clear/${embedId}`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Analytics: Get basic statistics overview
  getAnalyticsOverview: async (embedId, startDate, endDate) => {
    return await fetch(`${API_BASE}/embed/${embedId}/analytics/overview`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ startDate, endDate }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Analytics (KIE-536): Kennzahlen und Zeitreihe aus dem Zählerbuch.
  // fromDay/toDay sind Kalendertage ("YYYY-MM-DD", beide einschließlich) –
  // die Tage, die der Nutzer gewählt hat; der Server rechnet in Berliner Zeit.
  // Antwort: { success, granularity, totals, buckets, firstLedgerDay,
  // weekdayHour }. KIE-539: weekdayHour sind die Nachrichten des Zeitraums
  // nach Wochentag (0 = Montag … 6 = Sonntag) und Berliner Stunde (0–23).
  // KIE-537: Mit compare zusätzlich { previous } – die Zählwerte des
  // Vorzeitraums, ohne Raster. Ausgeschaltet wird compare nicht gesendet.
  getAnalyticsSummary: async (
    embedId,
    fromDay,
    toDay,
    { compare = false } = {}
  ) => {
    return await fetch(`${API_BASE}/embed/${embedId}/analytics/summary`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        fromDay,
        toDay,
        ...(compare ? { compare: true } : {}),
      }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Analytics: eine Seite der Konversationsliste. selection wie
  // conversationSelectionBody. Blättern: die erste Seite mit offset 0, jede
  // weitere mit after – der letzten geladenen Zeile { lastMessageAt,
  // firstChatId }: Verschwindet dazwischen eine Konversation, fehlt so keine
  // andere (Fixliste 7, F14). Ergebnis { success, conversations, hasMore,
  // totalCount } bzw. { success: false, error }.
  getConversations: async (
    embedId,
    { offset = 0, limit = 20, after = null, ...selection } = {}
  ) => {
    return await fetch(`${API_BASE}/embed/${embedId}/analytics/conversations`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        offset,
        limit,
        ...(after ? { after } : {}),
        ...conversationSelectionBody(selection),
      }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Analytics (KIE-538): Export der Konversationen der aktuellen Auswahl –
  // dieselbe Auswahl wie die Liste (conversationSelectionBody, auch der
  // Suchbegriff), dazu format ("csv" | "json"). Die Antwort ist die Datei;
  // Ergebnis { success, blob, filename, error } – der Dateiname kommt vom
  // Server (konversationen_<widget>_<von>_<bis>.<endung>). Mit Suche und zu
  // vielen Treffern (413) zusätzlich reason "too-many-hits" und max.
  exportConversations: async (embedId, format, selection = {}) => {
    return await fetch(`${API_BASE}/embed/${embedId}/analytics/export`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        format,
        ...conversationSelectionBody(selection),
      }),
    })
      .then(async (res) => {
        if (res.status === 413) {
          const body = await res.json().catch(() => ({}));
          return {
            success: false,
            blob: null,
            filename: null,
            error: body.error ?? `HTTP ${res.status}`,
            reason: body.reason ?? null,
            max: Number.isSafeInteger(body.max) ? body.max : null,
          };
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Bricht die Verbindung mitten im Export ab, scheitert blob() – eine
        // abgeschnittene Datei wird nicht gespeichert.
        const blob = await res.blob();
        return {
          success: true,
          blob,
          filename:
            filenameFromDisposition(res.headers.get("Content-Disposition")) ??
            `konversationen_widget-${Number(embedId)}.${format === "json" ? "json" : "csv"}`,
          error: null,
        };
      })
      .catch((e) => {
        console.error(e);
        return { success: false, blob: null, filename: null, error: e.message };
      });
  },

  // Konversation löschen (KIE-538): Vorschau – nur Zahlen.
  // Antwort: { success, messageCount, visitor: { conversationCount,
  // messageCount } | null }; visitor nennt, was derselbe Browser in diesem
  // Widget insgesamt hat.
  //
  // Hier und in den beiden Lösch-Aufrufen bezeichnet chatId die Konversation:
  // first_chat_id aus der Liste, die id ihrer ersten Zeile – nicht ihre
  // Kennung. Die conversation_id vergibt der Besucher: Eine zweite Sitzung
  // kann dieselbe senden (zwei Karten in der Liste), und als Pfadabschnitt
  // löst der Browser "." und ".." auf (auch kodiert) – „Konversation ..
  // löschen" träfe sonst DELETE /embed/:embedId, das Widget.
  getConversationDeletionPreview: async (embedId, chatId) => {
    return await fetch(
      `${API_BASE}/embed/${embedId}/conversation/deletion-preview`,
      {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ chatId }),
      }
    )
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Konversation löschen (KIE-538). chatId: first_chat_id aus der Liste.
  // Antwort: { success, deletedCount } bzw. { success: false, error }; war
  // die Datenbank gesperrt (503): { success: false, reason: "busy" } –
  // nichts gelöscht. signal: Abbruch durch die Ansicht nach ihrer
  // Höchstdauer, dann { success: false, reason: "timeout" } (Nachtrag rc3).
  deleteConversation: async (embedId, chatId, { signal } = {}) => {
    return await fetch(`${API_BASE}/embed/${embedId}/conversation`, {
      method: "DELETE",
      headers: baseHeaders(),
      body: JSON.stringify({ chatId }),
      signal,
    })
      .then((res) => res.json())
      .catch((e) => deleteFailure(e, signal));
  },

  // Alle Konversationen des Besuchers (derselbe Browser) in diesem Widget
  // löschen (KIE-538). expected: die Zahlen, die die Rückfrage genannt hat
  // (visitor der Vorschau) – gelöscht wird nur dieser Stand (Fixliste 7,
  // F10). Antwort: { success, deletedCount, conversationCount }; hat sich
  // der Stand inzwischen geändert (409): { success: false, reason:
  // "changed", visitor } mit den neuen Zahlen. Gesperrte Datenbank (503)
  // und Abbruch über signal wie bei deleteConversation.
  deleteVisitorConversations: async (
    embedId,
    chatId,
    expected = null,
    { signal } = {}
  ) => {
    return await fetch(`${API_BASE}/embed/${embedId}/conversation/visitor`, {
      method: "DELETE",
      headers: baseHeaders(),
      body: JSON.stringify({ chatId, ...(expected ? { expected } : {}) }),
      signal,
    })
      .then((res) => res.json())
      .catch((e) => deleteFailure(e, signal));
  },

  // Analytics: Get conversation details
  // KIE-538: chatId ist first_chat_id aus der Liste (siehe Vorschau) – eine
  // Zahl des Servers, keine Kennung des Besuchers. Kodiert, damit der
  // Abschnitt in jedem Fall ein einziges Pfadsegment bleibt. Ohne Zeitraum:
  // Das Seitenpanel öffnet so auch Konversationen per Link, die außerhalb des
  // gewählten Zeitraums liegen. Ohne Recht auf das Widget: success false.
  // status: HTTP-Status bei einer Ablehnung (403/404 = nicht gefunden oder
  // kein Zugriff), null bei einem Netzfehler – das Panel unterscheidet
  // „nicht gefunden" von „Laden fehlgeschlagen".
  getConversationDetails: async (embedId, chatId) => {
    return await fetch(
      `${API_BASE}/embed/${embedId}/conversation/${encodeURIComponent(chatId)}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then((res) => {
        // 403/404 ohne JSON: keine Inhalte, kein Fehler in der Konsole
        if (!res.ok)
          return {
            success: false,
            status: res.status,
            error: `HTTP ${res.status}`,
            messages: [],
          };
        return res.json();
      })
      .catch((e) => {
        console.error(e);
        return { success: false, status: null, error: e.message };
      });
  },

  // Visual Config: Get embed by ID (with visual_config)
  getEmbed: async (embedId) => {
    const embeds = await Embed.embeds();
    return embeds.find((e) => e.id === Number(embedId)) || null;
  },

  // Design Center: Kufer-Standardtexte des Widgets (de/en).
  // Ergebnis { defaults, error }: bei Fehler defaults = null und error mit
  // Meldung (das Design Center zeigt sie und behandelt dann nichts als
  // Standard).
  // KIE-576 Paket 3: mit embedId zusätzlich courseInventory (Zahl in der
  // Vorschau), sonst bzw. ohne Kursbestand null
  getDefaults: async (lang = "de", embedId = null) => {
    const embedQuery =
      embedId === null || embedId === undefined
        ? ""
        : `&embedId=${encodeURIComponent(embedId)}`;
    return await fetch(
      `${API_BASE}/embed/defaults?lang=${encodeURIComponent(lang)}${embedQuery}`,
      { method: "GET", headers: baseHeaders() }
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const defaults = body?.defaults;
        if (
          !defaults ||
          typeof defaults !== "object" ||
          Array.isArray(defaults)
        )
          throw new Error("Antwort ohne Standardtexte");
        return {
          defaults,
          courseInventory: body?.courseInventory ?? null,
          error: null,
        };
      })
      .catch((e) => {
        console.error(e);
        return {
          defaults: null,
          courseInventory: null,
          error: e.message || String(e),
        };
      });
  },

  // Visual Config: Update visual config
  updateVisualConfig: async (embedId, visualConfig) => {
    return await fetch(`${API_BASE}/embed/update/${embedId}`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ visual_config: JSON.stringify(visualConfig) }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Visual Config: Upload embed logo
  uploadEmbedLogo: async (embedId, formData) => {
    return await fetch(`${API_BASE}/embed/${embedId}/upload-logo`, {
      method: "POST",
      headers: {
        Authorization: baseHeaders().Authorization,
      },
      body: formData,
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Visual Config: Remove embed logo
  removeEmbedLogo: async (embedId) => {
    return await fetch(`${API_BASE}/embed/${embedId}/remove-logo`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
};

export default Embed;
