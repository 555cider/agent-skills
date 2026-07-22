# Provider protocol and privacy boundary

The local deterministic provider is always available and is the default.
Providers improve extraction, reconciliation, and embeddings; they never own
memory state or activation decisions.

## OpenAI provider

```bash
export AGENT_MEMORY_PROVIDER=openai
export OPENAI_API_KEY='...'
export AGENT_MEMORY_OPENAI_MODEL=gpt-5.6-luna
export AGENT_MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

The key is read only from the environment. Extraction uses the Responses API
with strict Structured Outputs, low reasoning effort, and `store=false`.
Embeddings use the configured embeddings model.

The external allowlist is constructed from scratch:

- redacted user prompt;
- redacted final assistant response;
- tool name;
- redacted command;
- numeric exit status.

It never includes raw tool output, local evidence output, file contents, cwd,
absolute paths, credentials, email, phone number, or the compressed journal.

`AGENT_MEMORY_SEMANTIC_RECALL=1` opts into query-time embeddings. Without it,
prompt hooks remain entirely local even when extraction uses a provider.

Embeddings are produced by the background worker, which backfills every
active/provisional record missing a current-model vector — explicit remembers
included. The sqlite-vec index is fixed at 1,536 dimensions; vectors with
other dimensions are stored but not indexed. After changing
`AGENT_MEMORY_EMBEDDING_MODEL`, run `agent-memory reindex` so the vector index
is rebuilt from stored embeddings.

## Command provider

```bash
export AGENT_MEMORY_PROVIDER=command
export AGENT_MEMORY_PROVIDER_COMMAND='/absolute/path/to/provider --flag'
export AGENT_MEMORY_PROVIDER_TIMEOUT=30
```

The executable receives one JSON object on stdin:

```json
{
  "schema": "agent-memory.provider.request.v2",
  "operation": "extract",
  "payload": {}
}
```

Operations:

- `extract`: payload contains only redacted allowlisted events; result is
  `{"candidates": [...]}`.
- `reconcile`: payload contains one candidate and a bounded list of current
  structured records; result is `{"action":"create|drop","candidate":{...}}`.
- `embed`: payload contains `texts` and `model`; result is a vector array or
  `{"vectors": [...]}`.

Response:

```json
{
  "schema": "agent-memory.provider.response.v2",
  "result": {}
}
```

Nonzero exit, timeout, malformed JSON, wrong schema, or an `error` field is a
retryable provider failure. After five job attempts it becomes a dead letter.
Local memories already extracted during a failed attempt remain deduplicated,
and FTS/trigram recall continues.
