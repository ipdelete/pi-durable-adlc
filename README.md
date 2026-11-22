# Pi Durable ADLC

Pi Durable agents for the agentic development lifecycle. The current agents
handle feature intake and backlog work for [`ipdelete/floe`](https://github.com/ipdelete/floe).
This project is independent of Floe; Floe does not depend on it.

## Floe intake

`server.js` runs two Pi Durable agents for `ipdelete/floe`, sharing the same
GitHub tools and guarded `bash`:

- **`/intake`** (loopback): takes a title and description, refines the draft,
  checks for duplicates and publishes a feature request. Each request is its own
  Durable session.
- **The backlog agent** (A2A): one persistent conversation that other agents and
  people message about the backlog, through the fleet's LiteLLM A2A gateway. It
  uses [`pi-durable-a2a`](https://github.com/ianphil/pi-durable-a2a).

Requires Node.js 22.19.0+, Pi with a saved `/login`, GitHub CLI signed in with
permission to create issues in `ipdelete/floe`, and Tailscale connected (the
A2A listener binds the machine's Tailscale address). Intake reuses `PI_PROVIDER`
and `PI_MODEL` when set; otherwise it uses `github-copilot` / `gpt-6.2-sol`.
`INTAKE_MODEL` can override the model ID.

```sh
git clone https://github.com/ipdelete/pi-durable-adlc.git
cd pi-durable-adlc
npm ci --ignore-scripts
npm start
```

## `/intake`
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

## Backlog agent over A2A

`backlog.js` keeps one Durable conversation in `.intake/backlog/` and serves it
at `http://<tailscale-ip>:8766/a2a`. Its card is named `floe-intake`. It can
search, read and summarize issues, check a feature idea for duplicates and file
it with `create_feature_issue` when asked. Its instructions forbid changing
issues through `bash`, but the guard does not enforce that: see below.

Callers share the conversation; one request runs at a time and others are
refused as busy. Tasks, results and accepted work live in the same Durable store
and survive restarts according to Durable's retry policy. The host installs
`A2AExtension` before opening/resuming the harness and explicitly enables the
LiteLLM task-forwarding route alongside native `/a2a`.

All foreground work in this conversation must come through A2A: no independent
host submissions or automatic follow-up runs. `/intake` keeps its separate
conversations. Durable 1.6.0 only supports conversation-wide abort, so mixing
unrelated input into the backlog conversation would make cancellation unsafe.
See the [`pi-durable-a2a` semantics](https://github.com/ianphil/pi-durable-a2a#semantics).

When upgrading from the separate-database bridge, settle work and stop the old
listener first. Preserve `durable.sqlite`, the listener token and registration.
The former `a2a.sqlite` is not imported: old A2A task IDs start fresh, while the
Durable conversation's history remains. Archive the old A2A store if needed;
there is no automatic deletion or migration.

The listener's bearer token is created once in `.intake/backlog/listener-token`.
To make the agent discoverable, publish it in the fleet gateway once, after the
server has started:

```sh
npm run register   # needs ~/.config/pi-a2a/admin-key
npm run withdraw   # removes this registration and its team grant
```

Registration uses LiteLLM's administrative key and runs as a separate operator
step; the server never reads it. `LITELLM_URL`, `LITELLM_ADMIN_KEY_FILE` and
`LITELLM_TEAM_ID` override the fleet defaults. Run fleet registrations one at a
time. Talk to the agent from Pi with the `pi-a2a` extension: register the Pi
session, then use `a2a_send` with `floe-intake`.

**Anyone with a fleet gateway key can ask it to read files** that its helpers
can open, including the admin key file above and GitHub CLI credentials, and to
run `gh`, including `gh api` writes, with the server's GitHub login.

## Bash guard

`bash-guard.js` provides a Pi Durable `beforeTool` hook applied to both agents'
`bash` tools. Bash runs locally from this repository root, using the server's
inherited environment and GitHub CLI authentication. Bash and any helpers the
agent uses must be installed on the host.

The hook parses Bash with the prebuilt Tree-sitter WASM parser and blocks calls
it cannot understand or approve. It allows:

- `gh` with a literal built-in command: `issue`, `api`, `pr`, `search`, `project`,
  `label`, `repo`, `help`, `--help`, or `--version`.
- JSON/text helpers: `jq`, `grep`, `rg`, `head`, `tail`, `sort`, `uniq`, `cut`,
  `tr`, `wc`, `printf`, `echo`, and restricted `sed`/`awk`.
- Pipelines, sequential commands, `&&`/`||`, simple lowercase variable
  assignments, simple variable expansions, and recursively checked `$(...)`.
- Single-quoted heredoc delimiters for literal multiline input, output to
  `/dev/null`, and `2>&1`.

`sed` accepts one literal print/range (such as `-n 5,24p`) or
`s/old/new/g`-style substitution on stdin. `awk` accepts only literal field
selection, such as `'{print $2}'` or `'{print $1, $2}'`, on stdin. `rg` and
`sort` accept a limited set of literal options, excluding program-launching
options. `printf` requires a literal format and cannot assign variables.

Unknown executables, dynamic executable/gh command names, aliases/extensions,
environment assignments, loops, functions, background jobs, backticks, process
and arithmetic substitutions, and arbitrary file redirections are blocked.
Rejection messages tell the agent what to reformulate.

**This is a guardrail, not a sandbox or a GitHub authorization policy.** Allowed
commands can still read files through their arguments, and `gh api` can mutate
GitHub. The hook does not isolate the host, constrain credentials or repositories,
or control subprocesses launched internally by approved programs. Host binaries
and the inherited environment must be trusted. Other tools are unaffected.

Run the tests with `npm test` from the repository root. They use the real Durable
harness, Bash, `gh --version`, and shell helpers with a scripted model; they do
not need a model login or make GitHub network requests. The WASM dependency
requires no native build or npm install scripts.
