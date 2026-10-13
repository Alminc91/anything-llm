/* eslint-env jest, node */
// Gemeinsames Gerüst der Rollen- und Bindungs-Tests (KIE-533).
//
// Die Tests laufen gegen die echten Routen: Jede Route wird mit ihrer ganzen
// Middleware-Kette registriert und in derselben Reihenfolge durchlaufen wie
// unter Express (validatedRequest, flexUserRoleValid, validEmbedConfigId …).
// Modelle, Anmeldung (JWT) und Rollenprüfung sind die echten; ersetzt ist nur
// die Datenbank, durch einen Prisma-Ersatz im Speicher.
//
// Verwendung in einer Testdatei:
//   jest.mock("../../utils/prisma", () =>
//     require("./support/routeHarness").createFakePrisma()
//   );
//   const { collectRoutes, invoke, … } = require("./support/routeHarness");

// Vor dem ersten require von utils/http setzen: makeJWT/decodeJWT lesen es.
process.env.JWT_SECRET = "kie-533-test-secret";
// Einbenutzerbetrieb ohne Passwortschutz: validatedRequest lässt durch.
delete process.env.AUTH_TOKEN;

// Relationen des Schemas, soweit die geprüften Routen sie benutzen.
const RELATIONS = {
  embed_chats: {
    embed_config: { table: "embed_configs", local: "embed_id", foreign: "id" },
  },
  embed_configs: {
    workspace: { table: "workspaces", local: "workspace_id", foreign: "id" },
    embed_chats: {
      many: true,
      table: "embed_chats",
      local: "id",
      foreign: "embed_id",
    },
  },
  workspaces: {
    workspace_users: {
      many: true,
      table: "workspace_users",
      local: "id",
      foreign: "workspace_id",
    },
    documents: {
      many: true,
      table: "workspace_documents",
      local: "id",
      foreign: "workspaceId",
    },
  },
};

// Spaltenvorgaben wie im Schema (@default).
const DEFAULTS = {
  embed_chats: () => ({ include: true, createdAt: new Date() }),
  embed_configs: () => ({ createdAt: new Date() }),
  workspaces: () => ({
    messagesLimit: null,
    cycleStartDate: null,
    cycleDurationMonths: null,
    createdAt: new Date(),
  }),
};

const OPERATORS = ["equals", "in", "notIn", "not", "gt", "gte", "lt", "lte"];

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    !Array.isArray(value)
  );
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function matchesOperators(actual, filter) {
  for (const [operator, expected] of Object.entries(filter)) {
    if (expected === undefined) continue;
    const a = comparable(actual);
    const e = comparable(expected);
    if (operator === "equals" && a !== e) return false;
    if (operator === "in" && !expected.map(comparable).includes(a))
      return false;
    if (operator === "notIn" && expected.map(comparable).includes(a))
      return false;
    if (operator === "not" && a === e) return false;
    if (operator === "gt" && !(a > e)) return false;
    if (operator === "gte" && !(a >= e)) return false;
    if (operator === "lt" && !(a < e)) return false;
    if (operator === "lte" && !(a <= e)) return false;
  }
  return true;
}

/**
 * Prisma-Ersatz im Speicher. Unbekannte Filter werfen, statt still zu passen:
 * Ein Test darf nicht bestehen, weil der Ersatz eine Bedingung überliest.
 */
function createFakePrisma() {
  const tables = {};
  const counters = {};
  const rawQueries = [];
  const rowsOf = (table) => (tables[table] ??= []);

  function matches(table, row, where = {}) {
    for (const [key, condition] of Object.entries(where ?? {})) {
      if (condition === undefined) continue;
      if (key === "AND") {
        if (![].concat(condition).every((part) => matches(table, row, part)))
          return false;
        continue;
      }
      if (key === "OR") {
        if (!condition.some((part) => matches(table, row, part))) return false;
        continue;
      }
      if (key === "NOT") {
        if ([].concat(condition).some((part) => matches(table, row, part)))
          return false;
        continue;
      }

      const relation = RELATIONS[table]?.[key];
      if (relation) {
        const related = rowsOf(relation.table).filter(
          (other) => other[relation.foreign] === row[relation.local]
        );
        if (relation.many) {
          const unknown = Object.keys(condition).filter((k) => k !== "some");
          if (unknown.length > 0)
            throw new Error(`fakePrisma: ${table}.${key}.${unknown[0]}`);
          if (
            !related.some((other) =>
              matches(relation.table, other, condition.some)
            )
          )
            return false;
        } else if (
          !related.some((other) => matches(relation.table, other, condition))
        ) {
          return false;
        }
        continue;
      }

      if (isPlainObject(condition)) {
        const unknown = Object.keys(condition).filter(
          (operator) => !OPERATORS.includes(operator)
        );
        if (unknown.length > 0)
          throw new Error(`fakePrisma: ${table}.${key}.${unknown[0]}`);
        if (!matchesOperators(row[key], condition)) return false;
        continue;
      }

      // Wie Prisma: NaN ist kein gültiger Wert für eine Spalte.
      if (typeof condition === "number" && Number.isNaN(condition))
        throw new Error(`fakePrisma: ${table}.${key} is NaN`);
      if (comparable(row[key] ?? null) !== comparable(condition)) return false;
    }
    return true;
  }

  function project(table, row, { include = null, select = null } = {}) {
    const picked = {};
    const wanted = select ?? include ?? {};
    if (!select) Object.assign(picked, row);

    for (const [key, option] of Object.entries(wanted)) {
      if (!option) continue;
      if (key === "_count") {
        picked._count = {};
        for (const name of Object.keys(option.select ?? {})) {
          const relation = RELATIONS[table][name];
          picked._count[name] = rowsOf(relation.table).filter(
            (other) => other[relation.foreign] === row[relation.local]
          ).length;
        }
        continue;
      }
      const relation = RELATIONS[table]?.[key];
      if (!relation) {
        if (select) picked[key] = row[key] ?? null;
        else throw new Error(`fakePrisma: include ${table}.${key}`);
        continue;
      }
      const related = rowsOf(relation.table)
        .filter((other) => other[relation.foreign] === row[relation.local])
        .map((other) =>
          project(relation.table, other, option === true ? {} : option)
        );
      picked[key] = relation.many ? related : related[0] ?? null;
    }
    return picked;
  }

  function sorted(rows, orderBy) {
    if (!orderBy) return rows;
    const [[field, direction]] = Object.entries([].concat(orderBy)[0]);
    return [...rows].sort((a, b) => {
      const result =
        comparable(a[field]) < comparable(b[field])
          ? -1
          : comparable(a[field]) > comparable(b[field])
            ? 1
            : 0;
      return direction === "desc" ? -result : result;
    });
  }

  function insert(table, data) {
    const row = { ...(DEFAULTS[table]?.() ?? {}) };
    for (const [key, value] of Object.entries(data)) {
      const relation = RELATIONS[table]?.[key];
      if (!relation) {
        row[key] = value;
        continue;
      }
      // { workspace: { connect: { id } } }
      const target = value?.connect?.[relation.foreign];
      if (
        !rowsOf(relation.table).some(
          (other) => other[relation.foreign] === target
        )
      )
        throw new Error(`fakePrisma: no ${relation.table} to connect`);
      row[relation.local] = target;
    }
    counters[table] = Math.max(counters[table] ?? 0, row.id ?? 0);
    if (row.id === undefined) row.id = ++counters[table];
    rowsOf(table).push(row);
    return row;
  }

  function model(table) {
    const find = (where) =>
      rowsOf(table).filter((row) => matches(table, row, where));
    const one = (where) => {
      const [row] = find(where);
      if (!row) throw new Error(`fakePrisma: no ${table} record found`);
      return row;
    };
    return {
      findFirst: async ({ where, orderBy, ...shape } = {}) => {
        const [row] = sorted(find(where), orderBy);
        return row ? project(table, row, shape) : null;
      },
      // KIE-532: Die Limitprüfung liest die Markierung des Nachtrags
      // (system_settings.findUnique, MessageLedger.backfillState). Hier gibt
      // es keine: Das Zählerbuch gilt als nicht nachgetragen, es zählt die
      // Live-Zählung - wie in utils/chats/agentLimit.test.js.
      findUnique: async ({ where, ...shape } = {}) => {
        const [row] = find(where);
        return row ? project(table, row, shape) : null;
      },
      findMany: async ({ where, orderBy, take, skip, ...shape } = {}) => {
        let rows = sorted(find(where), orderBy);
        if (skip) rows = rows.slice(skip);
        if (take !== undefined && take !== null) rows = rows.slice(0, take);
        return rows.map((row) => project(table, row, shape));
      },
      count: async ({ where } = {}) => find(where).length,
      create: async ({ data }) => ({ ...insert(table, data) }),
      update: async ({ where, data }) => {
        const row = one(where);
        Object.assign(row, data);
        return { ...row };
      },
      delete: async ({ where }) => {
        const row = one(where);
        rowsOf(table).splice(rowsOf(table).indexOf(row), 1);
        return { ...row };
      },
      deleteMany: async ({ where } = {}) => {
        const doomed = find(where);
        tables[table] = rowsOf(table).filter((row) => !doomed.includes(row));
        return { count: doomed.length };
      },
      aggregate: async ({ where, _sum = {} } = {}) => ({
        _sum: Object.fromEntries(
          Object.keys(_sum).map((field) => [
            field,
            find(where).reduce((sum, row) => sum + (row[field] ?? 0), 0),
          ])
        ),
      }),
    };
  }

  const fixed = {
    /** Zeile anlegen (mit Schema-Vorgaben und laufender id). */
    __seed: (table, data = {}) => insert(table, data),
    /** Zeilen einer Tabelle (lebende Referenz). */
    __rows: (table) => rowsOf(table),
    __reset: () => {
      for (const table of Object.keys(tables)) delete tables[table];
      for (const table of Object.keys(counters)) delete counters[table];
      rawQueries.length = 0;
      fixed.__onRawQuery = () => [{}];
    },
    /** Gesendete $queryRaw-Aufrufe als lesbares SQL ("?" je gebundenem Wert). */
    __rawQueries: rawQueries,
    /** Antwort auf $queryRaw: (sql) => Zeilen. */
    __onRawQuery: () => [{}],
    $queryRaw: async (strings, ...values) => {
      const sql = flattenSql(strings, values);
      rawQueries.push(sql);
      return fixed.__onRawQuery(sql);
    },
    $transaction: async (operations) => Promise.all(operations),
  };

  const models = {};
  return new Proxy(fixed, {
    get: (target, property) => {
      if (property in target) return target[property];
      if (typeof property !== "string" || property === "then") return undefined;
      return (models[property] ??= model(property));
    },
    set: (target, property, value) => {
      target[property] = value;
      return true;
    },
  });
}

// Flacht einen $queryRaw-Aufruf zu lesbarem SQL ab: gebundene Werte werden zu
// "?", verschachtelte Prisma.sql-Fragmente rekursiv inline gesetzt.
function flattenSql(strings, values) {
  let out = "";
  strings.forEach((part, i) => {
    out += part;
    if (i < values.length) {
      const value = values[i];
      out +=
        value && Array.isArray(value.strings)
          ? flattenSql(value.strings, value.values)
          : "?";
    }
  });
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Registriert Routen an einer Ersatz-App und merkt sich je Route die ganze
 * Kette (Middlewares + Handler).
 * @param {(app: object) => void} register - z. B. embedManagementEndpoints
 * @returns {Object<string, Function[]>} - "POST /pfad" → Kette
 */
function collectRoutes(register) {
  const routes = {};
  const app = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (path, ...handlers) => {
          routes[`${String(method).toUpperCase()} ${path}`] =
            handlers.flat(Infinity);
        },
    }
  );
  register(app);
  return routes;
}

/**
 * Durchläuft die Kette einer Route wie Express: Jede Middleware entscheidet
 * mit next(), ob es weitergeht.
 * @param {Function[]} chain
 * @param {{params?: object, query?: object, body?: any, token?: string|null}} request
 * @returns {Promise<{statusCode: number, body: any, headers: object, sent: number, chunks: string[], destroyed: any}>}
 */
async function invoke(
  chain,
  { params = {}, query = {}, body = {}, token = null } = {}
) {
  if (!Array.isArray(chain)) throw new Error("Route ist nicht registriert");
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const request = {
    params,
    query,
    body,
    headers,
    header: (name) => headers[String(name).toLowerCase()],
  };

  const result = {
    statusCode: 200,
    body: undefined,
    headers: {},
    sent: 0,
    // Gestreamte Antwort (KIE-538): jedes write() ein Stück, in der
    // Reihenfolge des Schreibens; body ist danach der ganze Text.
    chunks: [],
    // Mit destroy() abgebrochene Verbindung: der Grund, sonst null.
    destroyed: null,
  };
  const response = {
    locals: {},
    status: (code) => {
      result.statusCode = code;
      return response;
    },
    sendStatus: (code) => {
      result.statusCode = code;
      result.sent += 1;
      return response;
    },
    json: (payload) => {
      // Wie über HTTP: Dates kommen als ISO-Zeichenkette beim Aufrufer an.
      result.body = JSON.parse(JSON.stringify(payload));
      result.sent += 1;
      return response;
    },
    send: (payload) => {
      result.body = payload;
      result.sent += 1;
      return response;
    },
    setHeader: (name, value) => {
      result.headers[name] = value;
    },
    write: (chunk) => {
      result.chunks.push(String(chunk));
      return true;
    },
    end: () => {
      if (result.chunks.length > 0 && result.body === undefined) {
        result.body = result.chunks.join("");
        result.sent += 1;
      }
      return response;
    },
    destroy: (error) => {
      result.destroyed = error ?? true;
      return response;
    },
  };

  for (const handler of chain) {
    let proceed = false;
    await handler(request, response, () => {
      proceed = true;
    });
    if (!proceed) break;
  }
  return result;
}

/**
 * Schaltet den Mehrbenutzermodus der Instanz (SystemSettings).
 * @param {object} prisma - der Prisma-Ersatz
 * @param {boolean} enabled
 */
function setMultiUserMode(prisma, enabled) {
  const settings = prisma.__rows("system_settings");
  const existing = settings.find((row) => row.label === "multi_user_mode");
  if (existing) existing.value = String(enabled);
  else
    prisma.__seed("system_settings", {
      label: "multi_user_mode",
      value: String(enabled),
    });
}

/**
 * Legt einen Nutzer an und liefert sein Sitzungs-Token (echtes JWT).
 * @param {object} prisma - der Prisma-Ersatz
 * @param {"admin"|"manager"|"default"} role
 * @param {number[]} [workspaceIds] - Mitgliedschaften (workspace_users)
 * @returns {{id: number, role: string, token: string}}
 */
function createUser(prisma, role, workspaceIds = []) {
  const { makeJWT } = require("../../../utils/http");
  const user = prisma.__seed("users", {
    username: `${role}-${prisma.__rows("users").length + 1}`,
    password: "x",
    role,
    suspended: 0,
  });
  for (const workspaceId of workspaceIds)
    prisma.__seed("workspace_users", {
      user_id: user.id,
      workspace_id: workspaceId,
    });
  return {
    id: user.id,
    role,
    token: makeJWT({ id: user.id, username: user.username }),
  };
}

module.exports = {
  createFakePrisma,
  collectRoutes,
  invoke,
  setMultiUserMode,
  createUser,
};
