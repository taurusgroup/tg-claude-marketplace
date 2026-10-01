// Every check is a refusal, never a repair: the caller is a model reading
// attacker-influenced text, so "safe after cleanup" must not be a category.

const MAX_SQL_LENGTH = 20000

const DATABASES = new Set(['int_tg_traded', 'int_tg_traded_pii'])

const INDEX_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._*-]{0,127}$/

// Matched anywhere, string literals included: a parser clever enough to tell
// quoted from unquoted is the kind that gets outsmarted.
const WRITING_KEYWORDS = [
    'insert', 'update', 'delete', 'upsert', 'truncate', 'drop', 'create', 'alter',
    'grant', 'revoke', 'set', 'copy', 'import', 'export', 'backup', 'restore',
    'call', 'execute', 'prepare', 'begin', 'commit', 'rollback', 'into',
]

const reject = (reason) => ({ ok: false, reason })

export function validateSelect(sql) {
    if (typeof sql !== 'string') {
        return reject('sql must be a string')
    }

    const trimmed = sql.trim()

    if (trimmed === '') {
        return reject('sql is empty')
    }

    if (trimmed.length > MAX_SQL_LENGTH) {
        return reject(`sql exceeds ${MAX_SQL_LENGTH} characters`)
    }

    if (/--|\/\*|\*\//.test(trimmed)) {
        return reject('comments are not accepted; send the query without them')
    }

    const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '')

    if (withoutTrailingSemicolon.includes(';')) {
        return reject('only a single statement is accepted')
    }

    if (!/^(select|with)\b/i.test(withoutTrailingSemicolon)) {
        return reject('only SELECT (or WITH … SELECT) is accepted')
    }

    for (const keyword of WRITING_KEYWORDS) {
        if (new RegExp(`\\b${keyword}\\b`, 'i').test(withoutTrailingSemicolon)) {
            return reject(`"${keyword}" is not accepted in a read-only query`)
        }
    }

    return { ok: true, sql: withoutTrailingSemicolon }
}

export function validateDatabase(database) {
    if (typeof database !== 'string' || !DATABASES.has(database)) {
        return reject(`database must be one of: ${[...DATABASES].join(', ')}`)
    }

    return { ok: true, database }
}

export function buildSearchPath(index) {
    if (typeof index !== 'string' || !INDEX_PATTERN.test(index)) {
        return reject('index must be a plain index name or pattern')
    }

    return { ok: true, path: `${index}/_search` }
}

export function truncate(text, max) {
    if (text.length <= max) {
        return text
    }

    return `${text.slice(0, max)}\n… [truncated: ${text.length} characters total]`
}
