import moment from "moment";

export function formatDate(dateString) {
  const date = isNaN(new Date(dateString).getTime())
    ? new Date()
    : new Date(dateString);
  const options = { year: "numeric", month: "short", day: "numeric" };
  const formattedDate = date.toLocaleDateString("en-US", options);
  return formattedDate;
}

/**
 * Formatiert einen ISO-Zeitstempel in ein deutsches Datumsformat mit Uhrzeit
 * @param {string} isoString - ISO-Zeitstempel (z.B. "2025-04-23T12:30:57.634Z")
 * @param {{timeZone?: string}} [options] - timeZone: feste Zeitzone (z. B.
 *   "Europe/Berlin"); ohne Angabe die des Browsers wie bisher
 * @returns {string} Formatiertes Datum (z.B. "23.04.2025, 12:30:57 Uhr")
 */
export function formatDateTimeDE(isoString, { timeZone } = {}) {
  if (!isoString) return "-";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "-";
  return (
    date.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }) + " Uhr"
  );
}

export function formatDateTimeAsMoment(dateString, format = "LLL") {
  if (!dateString) return moment().format(format);
  try {
    return moment(dateString).format(format);
  } catch {
    return moment().format(format);
  }
}

export function getFileExtension(path) {
  const hasExtension = path?.includes(".");
  if (!hasExtension) return "FILE";
  const extension = path?.split(".")?.slice(-1)?.[0];
  return extension?.toUpperCase() || "FILE";
}

export function middleTruncate(str, n) {
  const fileExtensionPattern = /([^.]*)$/;
  const extensionMatch = str.includes(".") && str.match(fileExtensionPattern);

  if (str.length <= n) return str;

  if (extensionMatch && extensionMatch[1]) {
    const extension = extensionMatch[1];
    const nameWithoutExtension = str.replace(fileExtensionPattern, "");
    const truncationPoint = Math.max(0, n - extension.length - 4);
    const truncatedName =
      nameWithoutExtension.substr(0, truncationPoint) +
      "..." +
      nameWithoutExtension.slice(-4);

    return truncatedName + extension;
  } else {
    return str.length > n ? str.substr(0, n - 8) + "..." + str.slice(-4) : str;
  }
}
