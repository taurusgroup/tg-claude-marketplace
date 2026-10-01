import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHandler } from './lib/rpc.mjs'

const stub = () => {
    const calls = []

    return {
        calls,
        fn: async (...args) => {
            calls.push(args)

            return 'stub result'
        },
    }
}

const build = (overrides = {}) => {
    const sql = stub()
    const http = stub()

    const handler = createHandler({
        runSql: sql.fn,
        httpPost: http.fn,
        opensearchBase: 'http://opensearch-proxy:9200',
        dbHost: 'int-db-proxy:6432',
        ...overrides,
    })

    return { handler, sql, http }
}

const call = (handler, name, args) =>
    handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

test('initialize announces the server and echoes the client protocol version', async () => {
    const { handler } = build()

    const res = await handler({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
    })

    assert.equal(res.result.serverInfo.name, 'triage')
    assert.equal(res.result.protocolVersion, '2025-06-18')
    assert.ok(res.result.capabilities.tools)
})

test('notifications get no response at all', async () => {
    const { handler } = build()

    assert.equal(await handler({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
})

test('tools/list offers exactly the two read paths', async () => {
    const { handler } = build()

    const res = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = res.result.tools.map((t) => t.name).sort()

    assert.deepEqual(names, ['int_db_select', 'opensearch_search'])

    for (const tool of res.result.tools) {
        assert.ok(tool.description, `${tool.name} needs a description`)
        assert.equal(tool.inputSchema.type, 'object')
    }
})

test('opensearch_search issues the one request shape the read-only proxy allows', async () => {
    const { handler, http } = build()

    const res = await call(handler, 'opensearch_search', {
        index: 'int-vshn-zrh2-tg-tt.cmp.tg-traded*',
        body: { size: 0, query: { match_all: {} } },
    })

    assert.equal(http.calls.length, 1)

    const [url, body] = http.calls[0]
    assert.equal(
        url,
        'http://opensearch-proxy:9200/api/console/proxy?path=int-vshn-zrh2-tg-tt.cmp.tg-traded*/_search&method=GET',
    )
    assert.deepEqual(JSON.parse(body), { size: 0, query: { match_all: {} } })
    assert.equal(res.result.isError, undefined)
    assert.equal(res.result.content[0].text, 'stub result')
})

test('opensearch_search refuses an index that tries to steer the request', async () => {
    const { handler, http } = build()

    const res = await call(handler, 'opensearch_search', { index: '../_cluster/settings', body: {} })

    assert.equal(res.result.isError, true)
    assert.equal(http.calls.length, 0, 'a refused call must not reach the proxy at all')
})

test('int_db_select runs a SELECT as argv, never as a shell string', async () => {
    const { handler, sql } = build()

    const res = await call(handler, 'int_db_select', {
        database: 'int_tg_traded',
        sql: "SELECT id FROM withdrawals WHERE status = 'STATUS_EXECUTED'",
    })

    assert.equal(sql.calls.length, 1)

    const [args] = sql.calls[0]
    assert.ok(Array.isArray(args), 'arguments must be an argv array')
    assert.ok(
        args.includes("SELECT id FROM withdrawals WHERE status = 'STATUS_EXECUTED'"),
        'the statement travels as one argv element',
    )
    assert.ok(
        args.some((a) => a.includes('postgresql://claude@int-db-proxy:6432/int_tg_traded')),
        'the connection string is built here, not by the caller',
    )
    assert.equal(res.result.content[0].text, 'stub result')
})

test('int_db_select refuses to write, without consulting the database', async () => {
    const { handler, sql } = build()

    for (const bad of [
        { database: 'int_tg_traded', sql: 'UPDATE withdrawals SET status = 1' },
        { database: 'int_tg_traded', sql: 'SELECT 1; DELETE FROM withdrawals' },
        { database: 'defaultdb', sql: 'SELECT 1' },
    ]) {
        const res = await call(handler, 'int_db_select', bad)

        assert.equal(res.result.isError, true, JSON.stringify(bad))
    }

    assert.equal(sql.calls.length, 0)
})

test('shell metacharacters in sql are data, not syntax', async () => {
    const { handler, sql } = build()

    await call(handler, 'int_db_select', {
        database: 'int_tg_traded',
        sql: "SELECT 'x$(id)`whoami`' AS literal",
    })

    assert.equal(sql.calls.length, 1)
    assert.ok(sql.calls[0][0].includes("SELECT 'x$(id)`whoami`' AS literal"))
})

test('oversized results are capped rather than flooding the context', async () => {
    const { handler } = build({ runSql: async () => 'y'.repeat(200000) })

    const res = await call(handler, 'int_db_select', { database: 'int_tg_traded', sql: 'SELECT 1' })

    assert.ok(res.result.content[0].text.length < 200000)
    assert.match(res.result.content[0].text, /truncated/i)
})

test('an upstream failure is reported, not swallowed', async () => {
    const { handler } = build({
        runSql: async () => {
            throw new Error('connection refused')
        },
    })

    const res = await call(handler, 'int_db_select', { database: 'int_tg_traded', sql: 'SELECT 1' })

    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /connection refused/)
})

test('unknown tools and methods fail cleanly', async () => {
    const { handler } = build()

    const unknownTool = await call(handler, 'run_command', { cmd: 'env' })
    assert.equal(unknownTool.result.isError, true)

    const unknownMethod = await handler({ jsonrpc: '2.0', id: 9, method: 'resources/list' })
    assert.equal(unknownMethod.error.code, -32601)
})
