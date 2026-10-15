/**
 * SQLite over HTTP for a dcubix database, through D1's `D1Database` interface.
 *
 * Anything written against D1's binding takes the object `connect()` returns and works
 * unchanged: Drizzle's D1 driver, Kysely's D1 dialect, or plain `prepare().bind().all()`.
 * Each call is one request to the database's endpoint, and returns what D1's binding returns:
 * the same rows, the same `meta`, the same errors.
 *
 * Parameters are checked here, synchronously in `bind()`, the way the binding checks them.
 * JSON would otherwise change what some of them mean on the way: `undefined` would arrive as
 * null and a Date as a string, where the binding refuses both.
 */

// ---------------------------------------------------------------------------
// D1's types, restated so no Cloudflare types package is needed to use this one.
// ---------------------------------------------------------------------------

export interface D1Meta {
  duration: number
  size_after: number
  rows_read: number
  rows_written: number
  last_row_id: number
  changed_db: boolean
  changes: number
  served_by_region?: string
  served_by_colo?: string
  served_by_primary?: boolean
  timings?: { sql_duration_ms: number }
  total_attempts?: number
}

export interface D1Response {
  success: true
  meta: D1Meta & Record<string, unknown>
  error?: never
}

export type D1Result<T = unknown> = D1Response & { results: T[] }

export interface D1ExecResult {
  count: number
  duration: number
}

export type D1SessionConstraint = 'first-primary' | 'first-unconstrained'
export type D1SessionBookmark = string

export interface D1DatabaseSession {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  getBookmark(): D1SessionBookmark | null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failure the endpoint reported itself — the credential, the database's status, or the size
 * of a request or its result. Nothing D1 raises arrives as one of these: D1's own errors are
 * plain `Error`s with a `cause`, exactly as the binding raises them.
 */
export class DcubixError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'DcubixError'
    this.status = status
  }
}

/**
 * An error shaped like D1's: a plain `Error`, with `cause` as its own non-enumerable property —
 * what `new Error(message, { cause })` produces, assigned by hand so this runs on a lib or
 * runtime older than ES2022 as well.
 */
function d1Error(message: string, cause?: string | null): Error {
  const error = new Error(message)
  if (cause) {
    Object.defineProperty(error, 'cause', {
      value: new Error(cause),
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }
  return error
}

type Envelope =
  | { ok: true; result: unknown }
  | { ok: false; error?: string; cause?: string | null; d1?: boolean }

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * The part of `fetch` this package calls, declared here so its types need neither the DOM lib
 * nor Node's. The global `fetch` of any runtime fits it.
 */
export type Fetch = (
  input: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>

class Transport {
  readonly #base: string
  readonly #token: string
  readonly #fetch: Fetch

  constructor(url: string, token: string, fetchImpl: Fetch) {
    this.#base = url.replace(/\/+$/, '')
    this.#token = token
    this.#fetch = fetchImpl
  }

  async post(path: '/query' | '/batch' | '/exec', body: unknown): Promise<unknown> {
    const response = await this.#fetch(this.#base + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    // Every answer the endpoint gives is JSON. A body that will not parse came from something
    // in between, so there is no message in it worth reading.
    let payload: Envelope
    try {
      payload = (await response.json()) as Envelope
    } catch {
      throw new DcubixError(
        `The database endpoint answered HTTP ${response.status} with a body that is not JSON.`,
        response.status,
      )
    }

    if (payload && payload.ok === true) return payload.result

    const message = payload?.error ?? `The database endpoint answered HTTP ${response.status}.`
    if (payload?.d1) throw d1Error(message, payload.cause)
    throw new DcubixError(message, response.status)
  }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * One value as `bind()` accepts it, in the form it travels.
 *
 * The same rules as the binding: null, numbers, strings and booleans pass as they are; an
 * ArrayBuffer, a Uint8Array and a Uint8ClampedArray become BLOBs, sent as the list of their
 * bytes, which is also how D1 returns a BLOB; an array of numbers travels as it is and the
 * binding applies its own rule to it. Everything else is refused with the binding's own error
 * and message.
 *
 * One deliberate difference: other typed arrays and DataView are refused. The binding reads
 * a typed array by its elements rather than its bytes, so only these two always store what
 * they hold. An Int8Array with a negative element or an Int16Array becomes text such as
 * '1,-1'; a Float32Array or Float64Array becomes zeroed bytes; a DataView becomes an empty
 * BLOB. Code that passes one loses data on D1, and an error here says so.
 */
function toWire(value: unknown): unknown {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) return Array.from(value)
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return value

  // A template literal, as the binding uses: it throws a TypeError for a Symbol and for an
  // object with no way to become a primitive, and the binding lets that error through.
  const reason = `Type '${type}' not supported for value '${value}'`
  throw d1Error(`D1_TYPE_ERROR: ${reason}`, reason)
}

// ---------------------------------------------------------------------------
// Statements and the database
// ---------------------------------------------------------------------------

type Wire = { transport: Transport; sql: string; params: unknown[] }

/** What each statement carries, kept off the object so nothing about it is enumerable. */
const wire = new WeakMap<D1PreparedStatement, Wire>()

export class D1PreparedStatement {
  readonly #transport: Transport

  constructor(transport: Transport, sql: string, params: unknown[]) {
    this.#transport = transport
    wire.set(this, { transport, sql, params })
  }

  /** A new statement with these values bound; this one is left as it was, as D1 leaves it. */
  bind(...values: unknown[]): D1PreparedStatement {
    const { sql } = wire.get(this) as Wire
    return new D1PreparedStatement(this.#transport, sql, values.map(toWire))
  }

  first<T = unknown>(colName: string): Promise<T | null>
  first<T = Record<string, unknown>>(): Promise<T | null>
  first<T>(colName?: string): Promise<T | null> {
    return this.#query('first', colName === undefined ? {} : { column: colName }) as Promise<T | null>
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.#query('run') as Promise<D1Result<T>>
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.#query('all') as Promise<D1Result<T>>
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    return this.#query('raw', { columnNames: options?.columnNames === true }) as Promise<T[]>
  }

  #query(method: 'first' | 'run' | 'all' | 'raw', extra: Record<string, unknown> = {}) {
    const { sql, params } = wire.get(this) as Wire
    return this.#transport.post('/query', { sql, params, method, ...extra })
  }
}

export class D1Database {
  readonly #transport: Transport

  constructor(transport: Transport) {
    this.#transport = transport
  }

  prepare(query: string): D1PreparedStatement {
    return new D1PreparedStatement(this.#transport, query, [])
  }

  /** One transaction, as D1's batch() is: a statement that fails rolls back all of them. */
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const list = statements.map((statement) => {
      const carried = wire.get(statement)
      if (!carried || carried.transport !== this.#transport) {
        throw new TypeError('batch() takes statements prepared on this same database.')
      }
      return { sql: carried.sql, params: carried.params }
    })
    return this.#transport.post('/batch', { statements: list }) as Promise<D1Result<T>[]>
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.#transport.post('/exec', { sql: query }) as Promise<D1ExecResult>
  }

  /**
   * Not available over HTTP yet. D1 sessions route reads to replicas and carry a bookmark
   * between requests; neither exists on this path, and an object that accepted a constraint
   * while honouring none of it would be worse than this error.
   */
  withSession(_constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    throw new Error('withSession() is not supported over HTTP yet.')
  }

  /** Deprecated by D1, and only ever meaningful on its alpha databases. */
  dump(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('dump() is not supported: D1 deprecated it.'))
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  /** The database's endpoint, as its overview page shows it: `https://<id>.dcubix.dev`. */
  url: string
  /** An API key (`dcx_db_…`). It has full control of the database. */
  token: string
  /**
   * Replaces the global fetch — for a runtime without one, or to add request options such
   * as `credentials: 'omit'` in a browser. Called once per statement or batch.
   */
  fetch?: Fetch
}

/**
 * A `D1Database` for one dcubix database.
 *
 * ```ts
 * import { drizzle } from 'drizzle-orm/d1'
 * import { connect } from '@dcubix/sqlite'
 *
 * const db = drizzle(connect({ url: process.env.DCX_DB_URL!, token: process.env.DCX_DB_KEY! }))
 * ```
 */
export function connect(options: ConnectOptions): D1Database {
  // Looked up on each call rather than captured, so a fetch installed after connect() is used.
  const fetchImpl: Fetch =
    options.fetch ?? ((input, init) => (globalThis as unknown as { fetch: Fetch }).fetch(input, init))
  return new D1Database(new Transport(options.url, options.token, fetchImpl))
}
