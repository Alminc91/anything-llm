/**
 * Checks if an option belongs to the current location.
 * An option matches when its `href` is the current path or when the path starts
 * with one of its optional `activePrefixes` - used for sub pages that have their
 * own address but no menu entry (eg: the embed design center below "Widgets").
 * @param {{href?: string, activePrefixes?: string[]}} option - The (child) option.
 * @param {string} pathname - The current location pathname.
 * @returns {boolean} - True if the option should be treated as the current page.
 */
export default function matchesLocation(
  { href, activePrefixes = [] } = {},
  pathname = ""
) {
  if (href === pathname) return true;
  if (!Array.isArray(activePrefixes)) return false;
  return activePrefixes.some(
    (prefix) => !!prefix && pathname.startsWith(prefix)
  );
}
