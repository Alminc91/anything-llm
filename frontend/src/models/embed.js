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
  // Antwort: { success, granularity, totals, buckets, firstLedgerDay }.
  getAnalyticsSummary: async (embedId, fromDay, toDay) => {
    return await fetch(`${API_BASE}/embed/${embedId}/analytics/summary`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ fromDay, toDay }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Analytics: Get conversations list
  getConversations: async (
    embedId,
    offset = 0,
    limit = 20,
    startDate,
    endDate,
    feedbackFilter = "all", // KIE-508/527: "all" | "negative" (👎) | "positive" (👍)
    // KIE-536: { fromDay, toDay } – nur Konversationen, deren erste
    // vorhandene Nachricht in diesem Abschnitt liegt (Klick auf eine Säule).
    startedBetween = null
  ) => {
    return await fetch(`${API_BASE}/embed/${embedId}/analytics/conversations`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        offset,
        limit,
        startDate,
        endDate,
        feedbackFilter,
        ...(startedBetween
          ? {
              startedFromDay: startedBetween.fromDay,
              startedToDay: startedBetween.toDay,
            }
          : {}),
      }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Analytics (KIE-538): Export der Konversationen der aktuellen Auswahl.
  // Dieselben Felder wie eine Seite der Liste (getConversations) ohne das
  // Blättern, dazu format ("csv" | "json"). Die Antwort ist die Datei;
  // Ergebnis { success, blob, filename, error } – der Dateiname kommt vom
  // Server (konversationen_<widget>_<von>_<bis>.<endung>).
  exportConversations: async (
    embedId,
    format,
    { startDate, endDate, feedbackFilter = "all", startedBetween = null } = {}
  ) => {
    return await fetch(`${API_BASE}/embed/${embedId}/analytics/export`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        format,
        startDate,
        endDate,
        feedbackFilter,
        ...(startedBetween
          ? {
              startedFromDay: startedBetween.fromDay,
              startedToDay: startedBetween.toDay,
            }
          : {}),
      }),
    })
      .then(async (res) => {
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
  // Antwort: { success, deletedCount } bzw. { success: false, error }.
  deleteConversation: async (embedId, chatId) => {
    return await fetch(`${API_BASE}/embed/${embedId}/conversation`, {
      method: "DELETE",
      headers: baseHeaders(),
      body: JSON.stringify({ chatId }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Alle Konversationen des Besuchers (derselbe Browser) in diesem Widget
  // löschen (KIE-538). Antwort: { success, deletedCount, conversationCount }.
  deleteVisitorConversations: async (embedId, chatId) => {
    return await fetch(`${API_BASE}/embed/${embedId}/conversation/visitor`, {
      method: "DELETE",
      headers: baseHeaders(),
      body: JSON.stringify({ chatId }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  // Analytics: Get conversation details
  // KIE-538: chatId ist first_chat_id aus der Liste (siehe Vorschau) – eine
  // Zahl des Servers, keine Kennung des Besuchers. Kodiert, damit der
  // Abschnitt in jedem Fall ein einziges Pfadsegment bleibt.
  getConversationDetails: async (embedId, chatId) => {
    return await fetch(
      `${API_BASE}/embed/${embedId}/conversation/${encodeURIComponent(chatId)}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
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
  getDefaults: async (lang = "de") => {
    return await fetch(
      `${API_BASE}/embed/defaults?lang=${encodeURIComponent(lang)}`,
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
        return { defaults, error: null };
      })
      .catch((e) => {
        console.error(e);
        return { defaults: null, error: e.message || String(e) };
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

  // Get conversations (global view, grouped by conversation_id)
  getConversationsGlobal: async (
    offset = 0,
    limit = 20,
    startDate,
    endDate
  ) => {
    return await fetch(`${API_BASE}/embed/chats/conversations`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ offset, limit, startDate, endDate }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
};

export default Embed;
