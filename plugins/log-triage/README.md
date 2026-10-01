# log-triage

Two read-only tools for INT log triage, used by the `/review-logs` and
`/investigate-log` commands and by the nightly log-triage agent.

| Tool | Does | Cannot |
|---|---|---|
| `mcp__triage__opensearch_search` | one `_search` against an INT log index, through the read-only OpenSearch proxy | choose the host, path or upstream method — all fixed |
| `mcp__triage__int_db_select` | one `SELECT` (or `WITH … SELECT`) against `int_tg_traded` / `int_tg_traded_pii`, through the credential-isolating PgBouncer | write; run more than one statement; reach a shell (the statement travels as an `execFile` argv element) |

The server holds **no credentials**. The OpenSearch basic auth lives in the Caddy
proxy and the database password in PgBouncer; this server only restricts the shape
of requests to endpoints the caller can already reach. It exists so the nightly
agent can run with no shell at all: structured arguments leave no command string
for injected log text to bend.

## Requirements

`opensearch-proxy:9200` and `int-db-proxy:6432` must be reachable — the devcontainer
sidecars, or their in-cluster equivalents in `agent/`. Override with
`OPENSEARCH_PROXY` and `INT_DB_PROXY` if they answer elsewhere.

## Install

```
claude plugin install log-triage@taurus-approved
```

Taurus policy allows MCP servers only from plugins in the `taurus-approved`
marketplace, and the plugin must also be listed in the managed `enabledPlugins`
settings — both are administered centrally.

## Tests

```
node --test "plugins/log-triage/*.test.mjs"
```

Vendored from `agent/mcp` in `taurusgroup/tg-traded`, where the sources and the
nightly log-triage agent that uses them live. Changes belong there first.
