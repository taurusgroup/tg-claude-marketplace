import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateSelect, buildSearchPath, validateDatabase, truncate } from './lib/validate.mjs'

const rejects = (sql, why) => {
    const result = validateSelect(sql)
    assert.equal(result.ok, false, `expected rejection (${why}): ${sql}`)
    assert.ok(result.reason, 'a rejection must say why')
}

const accepts = (sql) => {
    const result = validateSelect(sql)
    assert.equal(result.ok, true, `expected acceptance: ${sql} — ${result.reason}`)
}

test('rejects every statement that is not a SELECT', () => {
    for (const sql of [
        "UPDATE withdrawals SET status = 'STATUS_CANCELED'",
        'DELETE FROM withdrawals WHERE id = 1',
        "INSERT INTO withdrawals (id) VALUES ('x')",
        'UPSERT INTO withdrawals (id) VALUES (1)',
        'GRANT SELECT ON TABLE withdrawals TO claude',
        'CREATE TABLE t (id UUID)',
        'DROP TABLE withdrawals',
        'ALTER TABLE withdrawals ADD COLUMN x INT',
        'TRUNCATE withdrawals',
        'SET sql_safe_updates = false',
        'BACKUP DATABASE int_tg_traded TO \'s3://x\'',
    ]) {
        rejects(sql, 'writing statement')
    }
})

test('rejects statement stacking, however it is dressed up', () => {
    rejects('SELECT 1; UPDATE withdrawals SET status = 1', 'classic stack')
    rejects('SELECT 1;;', 'empty second statement')
    rejects("SELECT 1; -- UPDATE withdrawals SET status = 1", 'comment after stack')
    rejects('SELECT 1 /* ; DELETE FROM withdrawals */', 'comment-hidden')
    rejects('SELECT 1 -- harmless\nDELETE FROM withdrawals', 'newline after line comment')
})

test('rejects a CTE whose branch writes', () => {
    rejects('WITH x AS (DELETE FROM withdrawals RETURNING *) SELECT * FROM x', 'writing CTE')
    rejects('WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x', 'writing CTE')
})

test('accepts the queries the investigate-log skill actually needs', () => {
    accepts('SELECT 1')
    accepts('SELECT id, status, deleted_at FROM withdrawals WHERE id = \'00000000-0000-0000-0000-000000000000\'::uuid')
    accepts("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'withdrawals'")
    accepts('SELECT w.id FROM withdrawals w JOIN bank_accounts b ON b.id::text = w.bank_account_id')
    accepts('WITH recent AS (SELECT id FROM withdrawals WHERE created_at > now() - INTERVAL \'7 days\') SELECT count(*) FROM recent')
    accepts('  select   count(*)   from   withdrawals  ')
    accepts('SELECT id FROM withdrawals;')
})

test('rejects input that is not a single usable string', () => {
    rejects('', 'empty')
    rejects('   ', 'blank')
    rejects(undefined, 'missing')
    rejects(null, 'null')
    rejects(42, 'not a string')
    rejects('SELECT ' + 'x'.repeat(50000), 'absurdly long')
})

test('database names are an allowlist, not a parameter', () => {
    assert.equal(validateDatabase('int_tg_traded').ok, true)
    assert.equal(validateDatabase('int_tg_traded_pii').ok, true)
    assert.equal(validateDatabase('defaultdb').ok, false)
    assert.equal(validateDatabase('int_tg_traded?sslmode=require').ok, false)
    assert.equal(validateDatabase('int_tg_traded/../x').ok, false)
    assert.equal(validateDatabase('').ok, false)
})

test('the search path cannot be steered by the index argument', () => {
    const ok = buildSearchPath('int-vshn-zrh2-tg-tt.cmp.tg-traded*')
    assert.equal(ok.ok, true)
    assert.equal(ok.path, 'int-vshn-zrh2-tg-tt.cmp.tg-traded*/_search')

    for (const index of [
        '../_cluster/settings',
        'idx/_search&method=PUT',
        'idx?method=DELETE',
        'http://evil.invalid/idx',
        'idx\r\nHost: evil.invalid',
        'idx /_search',
        '',
        'x'.repeat(200),
    ]) {
        assert.equal(buildSearchPath(index).ok, false, `index must be refused: ${JSON.stringify(index)}`)
    }
})

test('output is capped with a visible marker', () => {
    const capped = truncate('x'.repeat(100), 20)
    assert.ok(capped.length < 100)
    assert.match(capped, /truncated/i, 'a silently shortened result is a misleading result')
    assert.equal(truncate('short', 20), 'short')
})
