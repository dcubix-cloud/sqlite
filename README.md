# @dcubix/sqlite

SQLite over HTTP for dcubix databases, from Node, Bun, Deno or any server. It implements the
`D1Database` interface, so code written for Cloudflare D1, including Drizzle's and Kysely's D1
drivers, works unchanged.

The object `connect()` returns is what `env.DB` is inside a Cloudflare Worker: the same
methods, the same results, the same errors. It needs only `fetch`: Node.js 18 or later, Bun,
Deno, or a Worker.

```sh
npm install @dcubix/sqlite
```

An API key has full control of its database, so it belongs in server-side code. The endpoint
does not answer browsers on other origins.

```ts
import { connect } from '@dcubix/sqlite'

const db = connect({
  url: process.env.DCX_DB_URL,   // https://<id>.dcubix.dev, from the database's overview page
  token: process.env.DCX_DB_KEY, // an API key
})

const { results, meta } = await db
  .prepare('SELECT * FROM users WHERE id = ?')
  .bind(1)
  .all()
```

The package is ESM. `require()` loads it on Node.js 20.19 or later.

## With an ORM

Pass it to the ORM's own D1 driver. Nothing dcubix-specific is involved past `connect()`.

```ts
// Drizzle
import { drizzle } from 'drizzle-orm/d1'
import { migrate } from 'drizzle-orm/d1/migrator'

const orm = drizzle(connect({ url, token }))
await migrate(orm, { migrationsFolder: './drizzle' })
```

```ts
// Kysely
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'

const orm = new Kysely<Database>({ dialect: new D1Dialect({ database: connect({ url, token }) }) })
```

## What it supports

| | |
|---|---|
| `prepare(sql)` | ✓ |
| `.bind(...values)` | ✓ — returns a new statement; the original stays unbound |
| `.all()` `.run()` `.raw()` `.raw({ columnNames: true })` `.first()` `.first(column)` | ✓ |
| `batch([...statements])` | ✓ — one transaction: a statement that fails rolls back all of them |
| `exec(sql)` | ✓ — one statement per line; see [Running a migration file](#running-a-migration-file) |
| `withSession()` | not yet — throws |
| `dump()` | no — deprecated by D1 |

Values bind as they do on the binding: `null`, numbers, strings and booleans as they are;
`ArrayBuffer`, `Uint8Array` and `Uint8ClampedArray` as BLOBs; an array of numbers as D1 treats
one. `undefined`, `bigint`, `Date` and plain objects are refused in `bind()`, with D1's own
`D1_TYPE_ERROR`. BLOBs come back as arrays of bytes, as D1 returns them.

Other typed arrays and `DataView` are refused too, which the binding does not do. The binding
reads a typed array by its elements, not its bytes: an `Int16Array` is stored as text such as
`'1,-1'`, a `Float64Array` as zeroed bytes and a `DataView` as an empty BLOB. Pass
`new Uint8Array(view.buffer, view.byteOffset, view.byteLength)` to store a view's bytes.

## Errors

An error D1 raises — bad SQL, a constraint, a value it will not bind — is thrown exactly as
the binding throws it: a plain `Error` with D1's message and its `cause`.

An error the endpoint raises itself is a `DcubixError`, with the HTTP `status`:

| status | |
|---|---|
| 401 | the key is wrong, expired or revoked |
| 403 | the database is suspended |
| 404 | no database at this URL |
| 413 | the request, or the result, is over 16 MB — page with `LIMIT`/`OFFSET` |
| 503 | the request was stopped at a resource limit, most likely because its result was too large to return |

A 413 for a result, and a 503, both come after the statement ran: a write in it has been
written. Check before sending it again. A result is never returned in part.

A request that never gets an answer — the network failed, or the connection dropped — throws
whatever `fetch` threw. The statement may or may not have run. Nothing is retried for you,
because a write sent twice is applied twice.

## Running a migration file

`exec()` is D1's, and D1 reads its input one line per statement — Cloudflare documents it as
"queries separated by `\n`". A statement written across several lines, which is how drizzle-kit
and most tools write them, fails at its first line with `incomplete input`. D1's own binding
does the same; the endpoint passes `exec()` through unchanged.

For a migration file:

- **Drizzle:** `migrate(db, { migrationsFolder })` from `drizzle-orm/d1/migrator`.
- **Anything else:** split the file into statements and send them as one `batch()`, or one
  `POST /batch`. drizzle-kit marks every boundary with `--> statement-breakpoint` so that no
  SQL parsing is needed to do this.

  ```python
  import os, requests

  sql = open("drizzle/0001_add_posts.sql").read()
  statements = [s.strip() for s in sql.split("--> statement-breakpoint") if s.strip()]

  res = requests.post(
      f"{os.environ['DCX_DB_URL']}/batch",
      headers={"Authorization": f"Bearer {os.environ['DCX_DB_KEY']}"},
      json={"statements": [{"sql": s} for s in statements]},
  ).json()
  if not res["ok"]:
      raise RuntimeError(res["error"])
  ```

- **`exec()`** is for scripts written one statement per line.

Several statements passed to a single `prepare()` are not documented by D1. It usually runs
them and returns the last one's result, and sometimes refuses with `A SQL prepared statement
can only be executed once at a time` — on the binding as well as here. Use `batch()`.

## Transactions

As on the binding: `batch()` is the transaction. `BEGIN` is refused by D1, so an ORM's
`transaction()` API does not work here any more than it does on D1 itself.

## The HTTP API underneath

Each method is one `POST`, with `Authorization: Bearer <key>` and a JSON body. Every answer is
`{ "ok": true, "result": … }`, where `result` is exactly what the binding call returned, or
`{ "ok": false, "error": "…" }`.

| route | body | binding call |
|---|---|---|
| `/query` | `{ sql, params?, method?, columnNames?, column? }` | `prepare(sql).bind(...params)` then `method`: `all` (default), `run`, `raw`, `first` |
| `/batch` | `{ statements: [{ sql, params? }] }` | `batch(statements)` |
| `/exec` | `{ sql }` | `exec(sql)` |

A failure D1 raised also carries `"cause"` and `"d1": true`.

## License

MIT
