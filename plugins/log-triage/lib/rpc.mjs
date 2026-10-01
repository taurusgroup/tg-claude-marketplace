import { validateSelect, validateDatabase, buildSearchPath, truncate } from './validate.mjs'

const MAX_RESULT_CHARS = 60000

const TOOLS = [
    {
        name: 'opensearch_search',
        description:
            'Run a read-only _search against an INT log index through the read-only OpenSearch proxy. ' +
            'Takes the index (or index pattern) and the query body; the request shape, method and host are fixed.',
        inputSchema: {
            type: 'object',
            properties: {
                index: { type: 'string', description: 'Index or index pattern, e.g. int-vshn-zrh2-tg-tt.cmp.tg-traded*' },
                body: { type: 'object', description: 'The _search request body (query, aggs, size, sort, …)' },
            },
            required: ['index', 'body'],
        },
    },
    {
        name: 'int_db_select',
        description:
            'Run a single read-only SELECT against the INT CockroachDB through the credential-isolating proxy. ' +
            'Statements that are not a lone SELECT (or WITH … SELECT) are refused.',
        inputSchema: {
            type: 'object',
            properties: {
                database: { type: 'string', enum: ['int_tg_traded', 'int_tg_traded_pii'] },
                sql: { type: 'string', description: 'One SELECT statement' },
            },
            required: ['database', 'sql'],
        },
    },
]

const toolError = (id, message) => ({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: message }], isError: true },
})

const toolResult = (id, text) => ({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: truncate(text, MAX_RESULT_CHARS) }] },
})

export function createHandler({ runSql, httpPost, opensearchBase, dbHost }) {
    const search = async (id, args) => {
        const path = buildSearchPath(args?.index)

        if (!path.ok) {
            return toolError(id, path.reason)
        }

        if (args?.body === undefined || args.body === null || typeof args.body !== 'object') {
            return toolError(id, 'body must be the _search request body as an object')
        }

        // Fixed path, fixed upstream method: the only request the Caddy
        // read-only proxy allowlists, and the only one this tool can express.
        const url = `${opensearchBase}/api/console/proxy?path=${path.path}&method=GET`

        return toolResult(id, await httpPost(url, JSON.stringify(args.body)))
    }

    const select = async (id, args) => {
        const database = validateDatabase(args?.database)

        if (!database.ok) {
            return toolError(id, database.reason)
        }

        const sql = validateSelect(args?.sql)

        if (!sql.ok) {
            return toolError(id, sql.reason)
        }

        const url = `postgresql://claude@${dbHost}/${database.database}?sslmode=disable`

        return toolResult(id, await runSql(['sql', '--url', url, '--format=records', '-e', sql.sql]))
    }

    return async function handle(message) {
        const { id, method, params } = message ?? {}

        if (typeof method === 'string' && method.startsWith('notifications/')) {
            return null
        }

        switch (method) {
            case 'initialize':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: params?.protocolVersion ?? '2025-06-18',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'triage', version: '1.0.0' },
                    },
                }

            case 'ping':
                return { jsonrpc: '2.0', id, result: {} }

            case 'tools/list':
                return { jsonrpc: '2.0', id, result: { tools: TOOLS } }

            case 'tools/call':
                try {
                    switch (params?.name) {
                        case 'opensearch_search':
                            return await search(id, params?.arguments)
                        case 'int_db_select':
                            return await select(id, params?.arguments)
                        default:
                            return toolError(id, `unknown tool: ${params?.name}`)
                    }
                } catch (err) {
                    return toolError(id, `tool failed: ${err.message}`)
                }

            default:
                return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } }
        }
    }
}
