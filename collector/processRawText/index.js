const { v4 } = require("uuid");
const { writeToServerDocuments } = require("../utils/files");
const { tokenizeString } = require("../utils/tokenizer");
const { default: slugify } = require("slugify");

// Will remove the last .extension from the input 
// and stringify the input + move to lowercase.
function stripAndSlug(input) {
  if (!input.includes('.')) return slugify(input, { lower: true });
  return slugify(input.split('.').slice(0, -1).join('-'), { lower: true })
}

const METADATA_KEYS = {
  possible: {
    url: ({ url, title }) => {
      let validUrl;
      try {
        const u = new URL(url);
        validUrl = ["https:", "http:"].includes(u.protocol);
      } catch { }

      if (validUrl) return `web://${url.toLowerCase()}.website`;
      return `file://${stripAndSlug(title)}.txt`;
    },
    title: ({ title }) => `${stripAndSlug(title)}.txt`,
    docAuthor: ({ docAuthor }) => { return typeof docAuthor === 'string' ? docAuthor : 'no author specified' },
    description: ({ description }) => { return typeof description === 'string' ? description : 'no description found' },
    docSource: ({ docSource }) => { return typeof docSource === 'string' ? docSource : 'no source set' },
    chunkSource: ({ chunkSource, title }) => { return typeof chunkSource === 'string' ? chunkSource : `${stripAndSlug(title)}.txt` },
    published: ({ published }) => {
      if (isNaN(Number(published))) return new Date().toLocaleString();
      return new Date(Number(published)).toLocaleString()
    },
  },
  // KIE-480: optional structured course metadata for hard-constraint
  // retrieval filters. Values are ONLY passed through when they validate —
  // an invalid value is dropped (never guessed), and absent keys stay
  // absent so non-course documents keep their slim schema. Each validator
  // returns a correctly TYPED value (string/number/boolean) because these
  // become flat, typed LanceDB columns downstream.
  course: {
    start_date: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined),
    end_date: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined),
    start_minutes: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n < 1440 ? n : undefined;
    },
    weekdays: (v) =>
      typeof v === 'string' && /^,((mon|tue|wed|thu|fri|sat|sun),)+$/.test(v)
        ? v
        : undefined,
    price: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    },
    bookable: (v) => (typeof v === 'boolean' ? v : undefined),
    format: (v) =>
      typeof v === 'string' && ['online', 'onsite', 'hybrid'].includes(v)
        ? v
        : undefined,
    location: (v) =>
      typeof v === 'string' && /^[a-z0-9äöüß\-. ]{1,80}$/.test(v.trim().toLowerCase())
        ? v.trim().toLowerCase()
        : undefined,
  },
}

/**
 * Validates and collects the optional KIE-480 course metadata keys from an
 * upload's metadata object. Only valid, correctly typed values survive.
 * @param {object} metadata - Raw metadata object from the upload request.
 * @returns {object} Subset of validated course metadata (possibly empty).
 */
function courseMetadata(metadata = {}) {
  const out = {};
  for (const [key, validate] of Object.entries(METADATA_KEYS.course)) {
    if (!(key in metadata)) continue;
    const value = validate(metadata[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function processRawText(textContent, metadata) {
  console.log(`-- Working Raw Text doc ${metadata.title} --`);
  if (!textContent || textContent.length === 0) {
    return {
      success: false,
      reason: "textContent was empty - nothing to process.",
      documents: [],
    };
  }

  const data = {
    id: v4(),
    url: METADATA_KEYS.possible.url(metadata),
    title: METADATA_KEYS.possible.title(metadata),
    docAuthor: METADATA_KEYS.possible.docAuthor(metadata),
    description: METADATA_KEYS.possible.description(metadata),
    docSource: METADATA_KEYS.possible.docSource(metadata),
    chunkSource: METADATA_KEYS.possible.chunkSource(metadata),
    published: METADATA_KEYS.possible.published(metadata),
    // KIE-480: validated structured course fields (flat LanceDB columns for
    // hard-constraint filters). Empty object when none were sent/valid.
    ...courseMetadata(metadata),
    wordCount: textContent.split(" ").length,
    pageContent: textContent,
    token_count_estimate: tokenizeString(textContent),
  };

  // Truncate to avoid ENAMETOOLONG (ext4 limit: 255 bytes).
  // Final: "raw-" (4) + slug + "-" (1) + UUID (36) + ".json" (5) = 46 chars overhead
  const rawSlug = stripAndSlug(metadata.title).replace(/^www-/, "");
  const slug = rawSlug.length > 200 ? rawSlug.substring(0, 200) : rawSlug;
  const document = writeToServerDocuments({
    data,
    filename: `raw-${slug}-${data.id}`,
  });
  console.log(`[SUCCESS]: Raw text and metadata saved & ready for embedding.\n`);
  return { success: true, reason: null, documents: [document] };
}

module.exports = { processRawText }