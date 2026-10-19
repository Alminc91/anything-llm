const { parse: parseHTML } = require("node-html-parser");

/**
 * Kufer webbasys filter box on category pages (dropdowns for location, weekday and
 * instructor). It is a navigation aid, not content: locations and dates are part of
 * every course document from the course feed. On some sites it lists every instructor
 * of the whole school, which bloats every category page and changes daily.
 */
const KUFER_FILTER_SELECTOR = "#kw-filter, .kw-filter, .kw-filtercontainer";

/**
 * Remove the Kufer filter box from raw HTML (fetch fallback path).
 * Returns the input unchanged when the page has no filter box.
 * @param {string} html
 * @returns {string}
 */
function stripKuferFilter(html) {
  if (typeof html !== "string" || !html.includes("kw-filter")) return html;
  try {
    const root = parseHTML(html);
    const boxes = root.querySelectorAll(KUFER_FILTER_SELECTOR);
    if (!boxes.length) return html;
    boxes.forEach((el) => el.remove());
    return root.toString();
  } catch (error) {
    console.error("stripKuferFilter failed, keeping original HTML:", error?.message || error);
    return html;
  }
}

module.exports = { KUFER_FILTER_SELECTOR, stripKuferFilter };
