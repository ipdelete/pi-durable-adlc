# Floe intake

`server.js` is the Intake agent. It takes a title and description, starts a Pi
Durable session, and asks the model to refine the draft and check for duplicates
before publishing to `ipdelete/floe`. The prompt coordinates two independent
tools: `search_features` and `create_feature_issue`.

Requires Node.js 22.19.0+, Pi with a saved `/login`, and GitHub CLI signed in
with permission to create issues in `ipdelete/floe`. Intake reuses `PI_PROVIDER`
and `PI_MODEL` when set; otherwise it uses `github-copilot` / `gpt-6.2-sol`.
`INTAKE_MODEL` can override the model ID.

```sh
cd tools/intake
npm ci --ignore-scripts
npm start
```

```sh
curl -sS http://127.0.0.1:8765/intake \
  -H 'Content-Type: application/json' \
  -d '{"title":"Skip workflow tasks","description":"Let a workflow skip a task based on an earlier result."}'
```

The local endpoint waits for the agent, then returns the session ID and either
`issue_url` (created) or `answer` (the agent's reply). Sessions are stored in
`.intake/`, and new issues include the session ID. Keep the service on loopback
and submit only text suitable for a public issue. If a request errors, check
GitHub before retrying; there is no automatic recovery or deduplication guarantee.
