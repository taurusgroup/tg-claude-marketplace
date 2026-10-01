import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const server = fileURLToPath(new URL('./triage-server.mjs', import.meta.url))

// The other suites test the handler directly; only this one catches a broken
// stdio loop, which is otherwise silent until 23:00.
const exchange = (requests) =>
    new Promise((resolve, reject) => {
        const child = spawn('node', [server], { stdio: ['pipe', 'pipe', 'pipe'] })

        let out = ''
        let err = ''

        child.stdout.on('data', (chunk) => {
            out += chunk
        })
        child.stderr.on('data', (chunk) => {
            err += chunk
        })
        child.on('error', reject)
        child.on('close', () => resolve({ out, err }))

        for (const request of requests) {
            child.stdin.write(`${JSON.stringify(request)}\n`)
        }

        child.stdin.end()
    })

const parseLines = (out) =>
    out
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))

test('the server speaks MCP over stdio', async () => {
    const { out, err } = await exchange([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])

    const responses = parseLines(out)

    assert.equal(responses.length, 2, `one response per request, none for the notification: ${out}${err}`)
    assert.equal(responses[0].result.serverInfo.name, 'triage')
    assert.deepEqual(
        responses[1].result.tools.map((t) => t.name).sort(),
        ['int_db_select', 'opensearch_search'],
    )
})

test('malformed input is answered, not fatal', async () => {
    const { out } = await exchange([])

    assert.equal(out.trim(), '', 'no input, no output')

    const child = await new Promise((resolve, reject) => {
        const proc = spawn('node', [server], { stdio: ['pipe', 'pipe', 'pipe'] })

        let collected = ''

        proc.stdout.on('data', (chunk) => {
            collected += chunk
        })
        proc.on('error', reject)
        proc.on('close', () => resolve(collected))

        proc.stdin.write('this is not json\n')
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`)
        proc.stdin.end()
    })

    const responses = parseLines(child)

    assert.equal(responses[0].error.code, -32700)
    assert.equal(responses[1].id, 7, 'the server survives a bad line and answers the next one')
})

test('a tool call that cannot reach its upstream reports the failure', async () => {
    const child = spawn('node', [server], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, OPENSEARCH_PROXY: 'http://opensearch-proxy.invalid:9200' },
    })

    const collected = await new Promise((resolve, reject) => {
        let out = ''

        child.stdout.on('data', (chunk) => {
            out += chunk
        })
        child.on('error', reject)
        child.on('close', () => resolve(out))

        child.stdin.write(
            `${JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'opensearch_search',
                    arguments: { index: 'int-test*', body: { size: 0 } },
                },
            })}\n`,
        )
        child.stdin.end()
    })

    const [response] = parseLines(collected)

    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /tool failed/i)
})
