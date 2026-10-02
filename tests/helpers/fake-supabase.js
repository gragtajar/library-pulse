// @ts-check
/**
 * A small in-memory stand-in for the slice of the Supabase query builder the
 * backend uses: `from().select/insert/update/upsert/delete` with
 * `eq / in / not / is / gt / gte / order / limit`, awaited directly or finished with
 * `single()` / `maybeSingle()`. Rows live in plain arrays so a test can seed
 * them and assert on them afterwards.
 *
 * It does not resolve embedded relations (`slack_installations(...)`): seed
 * the nested object on the row when a test needs one.
 */

/**
 * @typedef {Record<string, any>} Row
 * @typedef {{ message: string, code?: string }} FakeError
 * @typedef {{
 *   tables: Record<string, Row[]>,
 *   unique: Record<string, string>,
 *   failCounts: boolean,
 *   failUpdates: boolean,
 *   from: (name: string) => FakeQuery,
 *   reset: (tables?: Record<string, Row[]>) => void,
 * }} FakeSupabase
 */

let nextId = 1;

class FakeQuery {
  /**
   * @param {string} table
   * @param {Row[]} rows
   * @param {FakeSupabase} db
   */
  constructor(table, rows, db) {
    this.table = table;
    this.rows = rows;
    this.db = db;
    /** @type {Array<(r: Row) => boolean>} */
    this.filters = [];
    /** @type {"select" | "insert" | "update" | "upsert" | "delete"} */
    this.op = "select";
    /** @type {Row | null} */
    this.payload = null;
    /** @type {string | null} */
    this.conflictKey = null;
    this.head = false;
    /** @type {number | null} */
    this.max = null;
  }

  /**
   * @param {string} [_columns]
   * @param {{ count?: string, head?: boolean }} [opts]
   */
  select(_columns, opts = {}) {
    if (this.op === "select") this.head = opts.head === true;
    return this;
  }

  /** @param {Row} row */
  insert(row) {
    this.op = "insert";
    this.payload = row;
    return this;
  }

  /** @param {Row} patch */
  update(patch) {
    this.op = "update";
    this.payload = patch;
    return this;
  }

  /**
   * @param {Row} row
   * @param {{ onConflict?: string }} [opts]
   */
  upsert(row, opts = {}) {
    this.op = "upsert";
    this.payload = row;
    this.conflictKey = opts.onConflict ?? null;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  /**
   * @param {string} column
   * @param {unknown} value
   */
  eq(column, value) {
    this.filters.push((r) => r[column] === value);
    return this;
  }

  /**
   * @param {string} column
   * @param {unknown[]} values
   */
  in(column, values) {
    this.filters.push((r) => values.includes(r[column]));
    return this;
  }

  /**
   * @param {string} column
   * @param {string} operator
   * @param {unknown} value
   */
  not(column, operator, value) {
    if (operator === "is" && value === null) this.filters.push((r) => r[column] != null);
    return this;
  }

  /**
   * @param {string} column
   * @param {string} value
   */
  gte(column, value) {
    this.filters.push((r) => String(r[column]) >= value);
    return this;
  }

  /**
   * @param {string} column
   * @param {string} value
   */
  gt(column, value) {
    this.filters.push((r) => String(r[column]) > value);
    return this;
  }

  /**
   * `is` compares with null/true/false (PostgREST's IS).
   * @param {string} column
   * @param {unknown} value
   */
  is(column, value) {
    this.filters.push((r) => (value === null ? r[column] == null : r[column] === value));
    return this;
  }

  order() {
    return this;
  }

  /** @param {number} n */
  limit(n) {
    this.max = n;
    return this;
  }

  async maybeSingle() {
    const { data, error } = await this.run();
    return { data: Array.isArray(data) ? (data[0] ?? null) : null, error };
  }

  async single() {
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    const row = Array.isArray(data) ? data[0] : null;
    return row
      ? { data: row, error: null }
      : { data: null, error: { message: "no rows returned", code: "PGRST116" } };
  }

  /**
   * @param {(value: any) => any} resolve
   * @param {(reason: unknown) => any} [reject]
   */
  then(resolve, reject) {
    return this.run().then(resolve, reject);
  }

  /** @param {Row} row */
  add(row) {
    const stored = {
      id: `row-${nextId++}`,
      created_at: new Date().toISOString(),
      ...row,
    };
    this.rows.push(stored);
    return stored;
  }

  /** @returns {Promise<{ data: Row[] | null, error: FakeError | null, count?: number | null }>} */
  async run() {
    const payload = this.payload ?? {};

    if (this.op === "insert") {
      const key = this.db.unique[this.table];
      if (key && this.rows.some((r) => r[key] === payload[key])) {
        return { data: null, error: { message: "duplicate key value", code: "23505" } };
      }
      return { data: [this.add(payload)], error: null };
    }

    if (this.op === "upsert") {
      const key = this.conflictKey;
      const hit = key ? this.rows.find((r) => r[key] === payload[key]) : undefined;
      if (hit) {
        Object.assign(hit, payload);
        return { data: [hit], error: null };
      }
      return { data: [this.add(payload)], error: null };
    }

    const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));

    if (this.op === "update") {
      if (this.db.failUpdates) return { data: null, error: { message: "update failed" } };
      for (const r of matched) Object.assign(r, payload);
      return { data: matched, error: null };
    }

    if (this.op === "delete") {
      for (const r of matched) this.rows.splice(this.rows.indexOf(r), 1);
      return { data: matched, error: null };
    }

    if (this.head) {
      if (this.db.failCounts)
        return { data: null, count: null, error: { message: "count failed" } };
      return { data: null, count: matched.length, error: null };
    }
    return { data: this.max == null ? matched : matched.slice(0, this.max), error: null };
  }
}

/**
 * @param {Record<string, Row[]>} [tables]
 * @returns {FakeSupabase}
 */
export function createFakeSupabase(tables = {}) {
  /** @type {FakeSupabase} */
  const db = {
    tables,
    // Columns with a UNIQUE constraint the handlers rely on.
    unique: { configurations: "figma_file_key", webhook_events: "event_key" },
    failCounts: false,
    failUpdates: false,
    from(name) {
      if (!db.tables[name]) db.tables[name] = [];
      return new FakeQuery(name, /** @type {Row[]} */ (db.tables[name]), db);
    },
    reset(next = {}) {
      db.tables = next;
      db.failCounts = false;
      db.failUpdates = false;
    },
  };
  return db;
}

/**
 * A minimal Vercel-style response that records what the handler did.
 *
 * @returns {{ statusCode: number, headers: Record<string, string>, body: any, setHeader: Function, status: Function, json: Function, send: Function, end: Function }}
 */
export function createFakeResponse() {
  /** @type {any} */
  const res = {
    statusCode: 200,
    headers: /** @type {Record<string, string>} */ ({}),
    body: undefined,
    /** @param {string} name @param {string} value */
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    /** @param {number} code */
    status(code) {
      res.statusCode = code;
      return res;
    },
    /** @param {unknown} body */
    json(body) {
      res.body = body;
      return res;
    },
    /** @param {unknown} body */
    send(body) {
      res.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}
