// Offline tests: a fake fetch records each request and answers with a canned envelope.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, DcubixError } from '../src/index.ts'

type Sent = { url: string; init: RequestInit; body: any }

function fake(answer: (sent: Sent) => { status?: number; body: unknown } = () => ({ body: { ok: true, result: null } })) {
  const sent: Sent[] = []
  const fetch = async (url: string, init: RequestInit) => {
    const entry = { url, init, body: JSON.parse(String(init.body)) }
    sent.push(entry)
    const { status = 200, body } = answer(entry)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
  return { sent, db: connect({ url: 'https://abcd.dcubix.dev//', token: 'dcx_db_k_0123456789ab.secret', fetch }) }
}

test('each method posts to its route with the key and the statement', async () => {
  const { sent, db } = fake()
  await db.prepare('SELECT ?').bind(1).all()
  await db.prepare('SELECT 1').run()
  await db.prepare('SELECT 1').raw()
  await db.prepare('SELECT 1').raw({ columnNames: true })
  await db.prepare('SELECT 1').first()
  await db.prepare('SELECT 1 AS a').first('a')
  await db.batch([db.prepare('SELECT ?').bind('x')])
  await db.exec('SELECT 1')

  assert.equal(sent[0].url, 'https://abcd.dcubix.dev/query')
  assert.equal((sent[0].init.headers as Record<string, string>).Authorization, 'Bearer dcx_db_k_0123456789ab.secret')
  assert.equal(sent[0].init.method, 'POST')
  assert.deepEqual(sent.map((s) => s.body), [
    { sql: 'SELECT ?', params: [1], method: 'all' },
    { sql: 'SELECT 1', params: [], method: 'run' },
    { sql: 'SELECT 1', params: [], method: 'raw', columnNames: false },
    { sql: 'SELECT 1', params: [], method: 'raw', columnNames: true },
    { sql: 'SELECT 1', params: [], method: 'first' },
    { sql: 'SELECT 1 AS a', params: [], method: 'first', column: 'a' },
    { statements: [{ sql: 'SELECT ?', params: ['x'] }] },
    { sql: 'SELECT 1' },
  ])
  assert.deepEqual(sent.map((s) => s.url.slice(s.url.lastIndexOf('/'))), ['/query', '/query', '/query', '/query', '/query', '/query', '/batch', '/exec'])
})

test('bind() returns a new statement and leaves the original unbound', async () => {
  const { sent, db } = fake()
  const base = db.prepare('SELECT ?')
  const bound = base.bind(1)
  assert.notEqual(bound, base)
  await base.all()
  await bound.all()
  assert.deepEqual(sent.map((s) => s.body.params), [[], [1]])
})

test('values travel as the binding takes them', async () => {
  const { sent, db } = fake()
  const slice = new Uint8Array(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2)
  await db.prepare('x').bind(null, 0, 1.5, 'é', true, false, new Uint8Array([0, 255]).buffer, slice, new Uint8ClampedArray([7]), [256, -1]).all()
  assert.deepEqual(sent[0].body.params, [null, 0, 1.5, 'é', true, false, [0, 255], [2, 3], [7], [256, -1]])
})

test('values the binding refuses, or would store wrongly, are refused in bind()', () => {
  const { db } = fake()
  const refused: [string, unknown, string][] = [
    ['undefined', undefined, "Type 'undefined' not supported for value 'undefined'"],
    ['bigint', 10n, "Type 'bigint' not supported for value '10'"],
    ['Date', new Date(0), "Type 'object' not supported for value '" + String(new Date(0)) + "'"],
    ['object', { a: 1 }, "Type 'object' not supported for value '[object Object]'"],
    ['string array', ['a'], "Type 'object' not supported for value 'a'"],
    ['Int8Array', new Int8Array([1, -1]), "Type 'object' not supported for value '1,-1'"],
    ['Int16Array', new Int16Array([1]), "Type 'object' not supported for value '1'"],
    ['Float64Array', new Float64Array([1.5]), "Type 'object' not supported for value '1.5'"],
    ['DataView', new DataView(new ArrayBuffer(2)), "Type 'object' not supported for value '[object DataView]'"],
  ]
  for (const [name, value, reason] of refused) {
    assert.throws(() => db.prepare('x').bind(value), (err: any) => {
      assert.equal(err.constructor, Error, name)
      assert.equal(err.message, `D1_TYPE_ERROR: ${reason}`, name)
      assert.equal(err.cause.message, reason, name)
      assert.equal(Object.keys(err).includes('cause'), false, `${name}: cause is not enumerable`)
      return true
    })
  }
  assert.throws(() => db.prepare('x').bind(Symbol('s')), { name: 'TypeError', message: 'Cannot convert a Symbol value to a string' })
  assert.throws(() => db.prepare('x').bind(Object.create(null)), TypeError)
})

test('a D1 failure is thrown as D1 throws it: a plain Error with its cause', async () => {
  const { db } = fake(() => ({ status: 400, body: { ok: false, error: 'D1_ERROR: no such table: t: SQLITE_ERROR', cause: 'no such table: t: SQLITE_ERROR', d1: true } }))
  await assert.rejects(db.prepare('SELECT * FROM t').all(), (err: any) => {
    assert.equal(err.constructor, Error)
    assert.equal(err.message, 'D1_ERROR: no such table: t: SQLITE_ERROR')
    assert.equal(err.cause.message, 'no such table: t: SQLITE_ERROR')
    return true
  })
})

test('a failure the endpoint raises is a DcubixError with the HTTP status', async () => {
  for (const [status, error] of [[401, 'Invalid credentials'], [403, 'This database is suspended'], [404, 'Database not found'], [413, 'too large'], [503, 'stopped at a resource limit']] as const) {
    const { db } = fake(() => ({ status, body: { ok: false, error } }))
    await assert.rejects(db.prepare('SELECT 1').all(), (err: any) => {
      assert.ok(err instanceof DcubixError)
      assert.equal(err.name, 'DcubixError')
      assert.equal(err.status, status)
      assert.equal(err.message, error)
      return true
    })
  }
})

test('an answer that is not JSON is a DcubixError naming the status', async () => {
  const { db } = fake(() => ({ status: 502, body: '<html>Bad gateway</html>' }))
  await assert.rejects(db.prepare('SELECT 1').all(), (err: any) => err instanceof DcubixError && err.status === 502 && /not JSON/.test(err.message))
})

test('an envelope without a message still reports the status', async () => {
  const { db } = fake(() => ({ status: 500, body: { ok: false } }))
  await assert.rejects(db.prepare('SELECT 1').all(), { name: 'DcubixError', message: 'The database endpoint answered HTTP 500.' })
})

test('results come back as the endpoint sent them', async () => {
  const result = { success: true, results: [{ a: 1 }], meta: { changes: 0 } }
  const { db } = fake(() => ({ body: { ok: true, result } }))
  assert.deepEqual(await db.prepare('SELECT 1 AS a').all(), result)
})

test('a network failure surfaces as the fetch error', async () => {
  const db = connect({ url: 'https://abcd.dcubix.dev', token: 't', fetch: async () => { throw new TypeError('fetch failed') } })
  await assert.rejects(db.prepare('SELECT 1').all(), { name: 'TypeError', message: 'fetch failed' })
})

test('batch() refuses statements from another connection, and sends an empty list as it is', async () => {
  const one = fake(), two = fake()
  assert.throws(() => one.db.batch([two.db.prepare('SELECT 1')]), { name: 'TypeError' })
  assert.throws(() => one.db.batch([{} as any]), { name: 'TypeError' })
  await one.db.batch([])
  assert.deepEqual(one.sent[0].body, { statements: [] })
})

test('withSession() throws and dump() rejects', async () => {
  const { db } = fake()
  assert.throws(() => db.withSession(), /not supported over HTTP/)
  await assert.rejects(db.dump(), /deprecated/)
})

test('statements carry nothing enumerable', () => {
  const { db } = fake()
  assert.deepEqual(Object.keys(db.prepare('SELECT ?').bind(1)), [])
  assert.deepEqual(Object.keys(db), [])
})
