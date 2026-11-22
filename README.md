# Pi Durable ADLC

Pi Durable agents for the agentic development lifecycle, served over A2A: an
intake agent for the [`ipdelete/floe`](https://github.com/ipdelete/floe) backlog
and a spike investigator. They use
[`pi-durable-a2a`](https://github.com/ianphil/pi-durable-a2a).
This project is independent of Floe; Floe does not depend on it.

## Layout

```text
agent-host/          serves one agent definition as a persistent Durable conversation over A2A
agents/intake/       intake: Floe backlog and feature intake
agents/investigator/ investigator: bounded spikes on a given repo, in its own worktree
shared/              GitHub client/tools and intake's Bash guard
server.js            starts the agents
register.js          gateway registration (operator step)
```

An agent definition supplies its identity (name, port, card), instructions,
turn limit, working directory and extensions (tools and hooks). The host owns
everything else: state in `.agents/<name>/`, the listener token, the Durable
Harness, the A2A listener (with LiteLLM task forwarding) and ordered shutdown.
All agents are reached through A2A; there is no other HTTP API.

## Running

Requires Node.js 22.19.0+, Pi with a saved `/login`, GitHub CLI signed in with
permission to create issues in `ipdelete/floe`, and Tailscale connected (each
listener binds the machine's Tailscale address). Agents use `PI_PROVIDER` and
`PI_MODEL` when set; otherwise `github-copilot` / `gpt-6.2-sol`. `AGENT_MODEL`
overrides the model ID.

```sh
git clone https://github.com/ipdelete/pi-durable-adlc.git
cd pi-durable-adlc
npm ci --ignore-scripts
npm start
```

Each agent keeps one Durable conversation shared by all callers; one request runs
at a time and others are refused as busy. Tasks, results and accepted work live
in the agent's Durable store and survive restarts according to Durable's retry
policy. All foreground work in a conversation must come through A2A: Durable
1.6.0 only supports conversation-wide abort, so mixing other input in would make
cancellation unsafe. See the
[`pi-durable-a2a` semantics](https://github.com/ianphil/pi-durable-a2a#semantics).

## Intake (`intake`, port 8766)

Searches, reads and summarizes `ipdelete/floe` issues, checks a feature idea for
duplicates and files it with `create_feature_issue` when asked. Its `bash` tool
runs from this repository root under the [Bash guard](#bash-guard). Its
instructions forbid changing issues through `bash`, but the guard does not
enforce that. Submit only text suitable for a public issue. If filing errors,
check GitHub before retrying; there is no deduplication guarantee.

## Investigator (`investigator`, port 8767)

Runs one spike per request on the GitHub repository named in it (`owner/name`,
optionally a base branch and effort ID), and replies with a conclusion
(supported, rejected or inconclusive), evidence, artifacts, limitations and a
recommended next step. State the question, success criteria and limits in the
request.

It works in its own workspace, `.agents/investigator/workspace/` unless
`INVESTIGATOR_WORKSPACE` is set: it clones each repository once under `repos/`,
creates a worktree and branch per spike under `worktrees/`
(`<effort-id>-spike-<slug>`, or `spike-<slug>`), commits there and pushes the
branch without opening a pull request. Pushing needs the GitHub CLI login to
have write access and Git to use it (`gh auth setup-git`).

It has Pi's coding tools (`read`, `write`, `edit`, `bash`) and **no guard**: it
runs arbitrary code as the server's user, with its environment and credentials.
Contain it by deployment (a dedicated user or container, a scoped GitHub token,
no LiteLLM admin key on that account), not by hooks.

## Registration

```sh
npm run register -- intake          # or investigator; needs ~/.config/pi-a2a/admin-key
npm run withdraw -- intake          # removes the registration and its team grant
```

Registration uses LiteLLM's administrative key and runs as a separate operator
step, after the agent has started; the server never reads it. `LITELLM_URL`,
`LITELLM_ADMIN_KEY_FILE` and `LITELLM_TEAM_ID` override the fleet defaults.
Registrations here share one grant lock; run fleet registrations elsewhere one at
a time. Talk to an agent from Pi with the `pi-a2a` extension: register the Pi
session, then use `a2a_send` with the agent's name (`intake`, `investigator`).

**Anyone with a fleet gateway key can ask these agents to read files** they can
open, including the admin key file above and GitHub CLI credentials. Intake can
run `gh`, including `gh api` writes, with the server's GitHub login; the
investigator can run arbitrary code with that login.

## Upgrading

The `/intake` HTTP endpoint and the `floe-intake` name are gone; the agent is now
`intake`, with fresh state in `.agents/intake/`. Withdraw the old `floe-intake`
gateway registration (with the previous release's `npm run withdraw`), then
register `intake`. Old state in `.intake/` is no longer read; archive or delete it.

## Bash guard

`shared/bash-guard.js` provides the Pi Durable `beforeTool` hook applied to
intake's `bash` tool. Bash runs locally from this repository root, using the server's
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

## Tests

Run `npm test` from the repository root. The tests use the real Durable harness,
A2A listener (on loopback), Bash, Git, `gh --version` and shell helpers with
scripted models; they do not need a model login, Tailscale, or GitHub network
requests. The WASM dependency requires no native build or npm install scripts.
