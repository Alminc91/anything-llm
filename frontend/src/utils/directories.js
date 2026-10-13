import moment from "moment";

export function formatDate(dateString) {
  const date = isNaN(new Date(dateString).getTime())
    ? new Date()
    : new Date(dateString);
  const options = { year: "numeric", month: "short", day: "numeric" };
  const formattedDate = date.toLocaleDateString("en-US", options);
  return formattedDate;
}

// Deutsche Zeitstempel: zentrale Funktion in utils/dateTimeDE.js (ohne
// moment), hier weiter exportiert (Fixliste 5, S3).
export { formatDateTimeDE } from "./dateTimeDE.js";

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
