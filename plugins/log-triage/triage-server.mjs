#!/usr/bin/env node
// The two read paths the log-triage skills need, so the agent can run with no
// shell: structured arguments leave no command string for injected text to bend.
import { createInterface } from 'node:readline'
import { execFile } from 'node:child_process'

import { createHandler } from './lib/rpc.mjs'

const OPENSEARCH_BASE = process.env.OPENSEARCH_PROXY ?? 'http://opensearch-proxy:9200'
const DB_HOST = process.env.INT_DB_PROXY ?? 'int-db-proxy:6432'
const TIMEOUT_MS = Number(process.env.TRIAGE_TIMEOUT_MS ?? 60000)
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

const runSql = (args) =>
    new Promise((resolve, reject) => {
        // execFile, never exec: argv elements are never parsed by a shell.
        execFile(
            'cockroach',
            args,
            { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
            (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(stderr.trim() || err.message))

                    return
                }

                resolve(stdout)
            },
        )
    })

const httpPost = async (url, body) => {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    const text = await res.text()

    if (!res.ok) {
        throw new Error(`proxy returned ${res.status}: ${text.slice(0, 500)}`)
    }

    return text
}

const handle = createHandler({
    runSql,
    httpPost,
    opensearchBase: OPENSEARCH_BASE,
    dbHost: DB_HOST,
})

const respond = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

createInterface({ input: process.stdin }).on('line', async (line) => {
    if (line.trim() === '') {
        return
    }

    let message

    try {
        message = JSON.parse(line)
    } catch {
        respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })

        return
    }

    const response = await handle(message)

    if (response) {
        respond(response)
    }
})
