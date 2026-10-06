# Shelfwise

Readers' advisory and collection development for public-library branch staff and indie-bookstore buyers,
grounded in [Qloo](https://qloo.com)'s cross-domain taste graph.

> **Built with AI coding assistance.** This project was written with Claude Code (Anthropic's AI coding
> assistant), directed and reviewed by a human. The code, tests and docs are open source under the MIT license.

> **Status: phase 1 (offline build).** Everything below was built and tested without a Qloo or Nebius key.
> It runs end to end on clearly-labelled **sample data**. Live Qloo and live model calls are wired up but have
> not been exercised yet; see [What is verified, and what is not](#what-is-verified-and-what-is-not).

## The problem

A patron says "I just finished *Severance*, what should I read next?" and the person at the desk has seconds,
a small budget, and a shelf that took years to build. The same question comes from the other direction when a
buyer has a few hundred dollars and has to decide what to order and what to put on the front table.

Catalogue tools answer these questions inside the book world: same author, same subject, same series.
Staff already know that is not how people actually move between a TV show, an album, a game and a novel.
That cross-domain taste signal is exactly what Qloo models.

## Who it is for

- Public-library branch staff doing readers' advisory and collection development on a small budget.
- Independent bookstore buyers deciding what to order and what to feature.

You enter a place, an optional audience, what patrons are into right now (shows, films, music, games,
podcasts, books) and an optional budget. Shelfwise plans and runs a visible multi-step Qloo workflow and hands
back three things you can use the same day:

1. **A bridge shelf**: printable "Loved *X*? Try *Y*" shelf-talker cards, several per page.
2. **A buy / feature list**: titles in rank order, each with its evidence (which signals it matched, where it
   ranked, local fit, and whether interest in the show or artist behind it is rising).
3. **Programme ideas**: two or three event or display ideas tied to the same evidence.

A follow-up chat re-runs the relevant Qloo calls ("make it for teens", "more translated fiction").
An **evidence trail** panel lists every tool call with its inputs, status and a summary of what came back.

## How Qloo is used, and why Shelfwise does not work without it

Shelfwise has no book catalogue, no circulation data and no embeddings of its own. Every title, score,
rank, local-fit value and trend direction that reaches the screen is read from a Qloo result.

| Step | Qloo tool | What it gives Shelfwise |
| --- | --- | --- |
| Resolve what patrons are into | entity resolution inside every tool; `qloo_describe` | Confirmed Qloo entities. Ambiguous names ("Dune": book or film?) come back as `needs_input` and the run pauses to ask the user. |
| Find books for each thing patrons love | `qloo_recommend` (`target_type: book`), one call **per signal** | Cross-domain recommendations: books that fans of a TV show, album or game also love. One signal per call means "Loved *X*? Try *Y*" is true by construction. |
| Rank for the audience | `qloo_rank` | Orders the shortlist for the chosen age band and place. |
| Check local fit | `qloo_where_popular`, `signal_location` | Whether the pick has heat near the library or shop, and a place-weighted recommendation. |
| Check trends | `qloo_trends` on the loved signals | Time series for the shows, films, artists or podcasts patrons love (Qloo has no trend data for books); Shelfwise computes rising / steady / fading itself from the points and shows it as "interest in X" next to the titles X returned. |
| Look for a bridging title | `qloo_compare_audiences` | A book both groups of fans reach. |

Also available to the model: `qloo_entity_tags`, `qloo_find_tags`, `qloo_audience_demographics`.
The exact input schemas, verified behaviours and the gaps against this product design are in
[`docs/qloo-tools.md`](docs/qloo-tools.md) (generated from the real harness with `npm run docs:tools`).

**What happens without Qloo:** nothing is shown. The no-invention guard (below) withholds any title that cannot
be traced to a Qloo result, and live mode never falls back to sample data or to the model's memory. If the keys
are missing the server answers "not configured".

### The language model

A Nemotron model on Nebius Token Factory plans the workflow, chooses tools, and writes short copy (the "why"
lines and programme text). It **never supplies titles or scores**:

- It selects books and signals by *reference* (`e12`) to entities that appeared in tool results.
- Titles, affinities, ranks, local fit and trend directions are joined in by the server from those same results.
- Its prose may name works only through `{e12}` placeholders. Quoted or emphasised names must match a returned
  name or the user's own words, and every number must appear in a Qloo result or in the user's input.
- A "Loved *X*? Try *Y*" pairing is accepted only if a Qloo call that used *X* as its signal returned *Y*.
- Anything that fails is withheld, the model gets one or two bounded chances to repair it, and the report says
  what was withheld.

## Architecture

```
 Browser (React, built to static files)
    |  POST /api/runs  ->  Server-Sent Events (plan, tool_call, tool_result, needs_input, report, ...)
    v
 Node 22 server (one process, node:http, serves API + built web app on one port)
    |-- per-IP rate limits, run queue (max concurrent runs), session store, request validation
    |-- agent loop (bounded steps and tool calls, retries only when `error.retryable`)
    |        |-- LLM client: OpenAI-compatible chat + tool calling  --> Nebius Token Factory (Nemotron)
    |        '-- QlooService: response cache, daily call budget, concurrency cap, per-call timeout
    |                 '-- MCP client (official SDK) --stdio--> one long-lived `qloo mcp` child process
    |                                                              (@qloo/qloo-harness) --> Qloo API
    '-- evidence store + no-invention guard (entity handles, joins, prose checks)
```

- **Qloo key stays on the server.** It is passed only to the `qloo mcp` child process, never to the browser,
  and the LLM key is never forwarded to the child.
- **One shared child process**, restarted on demand if it dies. At most `MAX_CONCURRENT_RUNS` agent runs execute at
  once; extra runs wait in a visible queue.
- **Pause and resume.** When Qloo needs a choice, the run ends with `needs_input`; the question and its candidates
  are kept server-side and the browser answers with a `resolution` request.
- **Bounded.** Max model turns and tool calls per request and per session; the final turn is forced to
  `submit_report`. Retries only for retryable errors.
- **Cache** keyed by tool plus normalised inputs (case, spacing, array order, schema defaults), only for `ok`
  and `empty` results, plus a global daily budget of real Qloo calls.
- **All six result statuses** (`ok`, `empty`, `needs_input`, `partial`, `degraded`, `error`) are handled and
  shown. Partial and degraded results are used but flagged as reduced confidence.
- **Sample-data mode** (`DEMO_FIXTURES=1`) uses clearly-marked placeholder fixtures and a rule-based planner when no
  LLM key is set. The UI says "Sample data — not live Qloo results" and every sample result is marked.

## Setup from a clean machine

Prerequisites: **Node.js 22.19 or newer** (22 LTS or later) and npm. Docker is optional.

```bash
git clone <this repository> shelfwise   # or unpack the archive
cd shelfwise
npm install
./dev.sh                                # sample-data mode: http://127.0.0.1:8790, no keys needed
```

`./dev.sh` builds the web app and starts the server with `DEMO_FIXTURES=1`.

**If your default Node is older than 22.19**, put a newer Node first on `PATH` for this shell only; nothing needs
to be installed or relinked globally. For example with Homebrew's `node@26` keg:

```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
node --version        # must print v22.19 or newer
```

`./dev.sh` does this for its own process automatically if it finds a newer Homebrew Node, and refuses to run
otherwise. `npm run <script>` commands use whatever `node` is first on `PATH`, so export it in your shell first.

### Live mode (needs keys)

```bash
cp .env.example .env     # then fill in QLOO_API_KEY and NEBIUS_API_KEY
npm run check:llm        # prints the model's supported_features and runs a tiny tool-calling round trip
./dev.sh live
```

- **Qloo:** `QLOO_API_KEY` is the key issued for the hackathon. It is read by the server and handed only to the
  local `qloo mcp` process.
- **Nebius Token Factory:** base URL `https://api.tokenfactory.nebius.com/v1/` (OpenAI-compatible, Bearer auth),
  default model `nvidia/nemotron-3-super-120b-a12b` (120B total / 12B active parameters, 256K context).
  An alternative is `nvidia/Nemotron-3-Ultra-550b-a55b`. Set `SHELFWISE_LLM_MODEL` to switch; copy the id exactly.
  Sources: Nebius Token Factory docs (quickstart and model catalog), checked 2026-10-02. Whether a given model
  supports tool calling is not stated in the docs; `npm run check:llm` tests it against your key.
- **Which variables Shelfwise reads.** The model key comes from `NEBIUS_API_KEY` and nothing else. Generic names
  such as `LLM_API_KEY` or `OPENAI_API_KEY` are deliberately ignored, because they often belong to another tool in
  the same shell and would otherwise be sent to Nebius as a Bearer token. The other model settings carry a
  `SHELFWISE_` prefix for the same reason (`SHELFWISE_LLM_BASE_URL`, `SHELFWISE_LLM_MODEL`,
  `SHELFWISE_LLM_TIMEOUT_MS`, `SHELFWISE_LLM_MAX_TOKENS`, `SHELFWISE_LLM_EXTRA_BODY`). `./dev.sh` names any such
  foreign variable it finds in your environment and says it is ignored.
- **`.env` does not override the environment.** The server reads `.env` with Node's `process.loadEnvFile()`, which
  leaves any variable that is already set in the environment alone, even if it is set to an empty string. If a
  value in `.env` seems to have no effect, check whether the same name is already exported in your shell or
  launcher.
- **Sample data with a real model.** In sample-data mode (`./dev.sh`, `DEMO_FIXTURES=1`) the planner is the
  scripted placeholder, which makes no network request. Only if `NEBIUS_API_KEY` is set does the same mode call the
  real model, on sample Qloo data. In that case the startup log, `/api/health` and the banner on the page all say so,
  and `./dev.sh` prints which planner it will use before it starts. Live mode always uses the real model and real
  Qloo data.
- Shelfwise does not send `parallel_tool_calls` and does not rely on JSON mode. It handles one or several tool
  calls per turn and parses the final report defensively (extract the JSON object, validate, one repair retry).

### Development

```bash
./dev.sh                 # API + built UI on :8790
./dev.sh web             # in a second terminal: Vite dev server with hot reload on :5173, proxying /api
npm run check            # type-check (server and web) and run all tests
npm test                 # tests only
npm run build            # build the web app (dist/web) and the server (dist/server)
npm start                # run the built server
npm run docs:tools       # regenerate docs/qloo-tools.md and the tool snapshot from the installed harness
```

`npm run docs:tools` starts the real `qloo mcp` without a key (no network) and records its `tools/list`.
A test fails if the committed snapshot drifts from the installed harness.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example) for the full annotated list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `QLOO_API_KEY` | | Qloo key, server side only. |
| `NEBIUS_API_KEY` | | Nebius Token Factory key. The only variable read for the model key. In sample-data mode, setting it makes the planner a real model. |
| `SHELFWISE_LLM_BASE_URL` | `https://api.tokenfactory.nebius.com/v1/` | Any OpenAI-compatible endpoint. |
| `SHELFWISE_LLM_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Model id. |
| `SHELFWISE_LLM_TIMEOUT_MS`, `SHELFWISE_LLM_MAX_TOKENS`, `SHELFWISE_LLM_EXTRA_BODY` | `90000`, `4096`, unset | Per-request timeout, output cap, and JSON merged into each request body. |
| `DEMO_FIXTURES` | unset | `1` = sample-data mode. Never enabled automatically. |
| `PORT` / `HOST` | `8790` / `127.0.0.1` | The Docker image sets `HOST=0.0.0.0`. |
| `TRUST_PROXY` | unset | Set only behind a proxy or tunnel you control; then the per-IP rate limit uses `CF-Connecting-IP`, else `X-Forwarded-For`. Otherwise those headers are ignored because clients can forge them. |
| `RATE_LIMIT_RUNS_PER_HOUR`, `RATE_LIMIT_MESSAGES_PER_HOUR` | `6`, `40` | Per-IP limits (new runs; follow-ups and answers). |
| `QLOO_DAILY_CALL_BUDGET` | `1500` | Global cap on real (uncached) Qloo calls per UTC day. |
| `MAX_CONCURRENT_RUNS`, `MAX_QUEUE` | `2`, `8` | Concurrent agent runs, and how many more may wait. |
| `AGENT_MAX_STEPS`, `AGENT_MAX_TOOL_CALLS` | `14`, `24` | Bounds per request. |

## Deploy with Docker

One image, one process, one port. The server serves the API and the built web app on `PORT` (default 8790),
bound to `0.0.0.0` inside the container. Keys come only from the runtime environment; nothing secret is in the
image, and `.env` is excluded by `.dockerignore`.

```bash
docker build -t shelfwise .

# live
docker run -d --name shelfwise --restart unless-stopped -p 8790:8790 \
  -e QLOO_API_KEY=... -e NEBIUS_API_KEY=... \
  -e TRUST_PROXY=1 \
  shelfwise

# sample-data mode, no keys
docker run --rm -p 8790:8790 -e DEMO_FIXTURES=1 shelfwise
```

- The image is `node:22-slim`, multi-stage (build the web app and server, then a runtime stage with production
  dependencies only), and runs as the non-root `node` user.
- `GET /healthz` returns `{"ok":true,"mode":"live"|"sample-data","mcp":{"up":true,"restarts":0}|null}` and is
  used by the image's `HEALTHCHECK`. If the `qloo mcp` child is down it tries to start it; `ok:false` (HTTP 503)
  means it cannot be started. `GET /api/health` additionally reports readiness (for example "QLOO_API_KEY is not
  set") and the active limits.
- Memory use is bounded by design: a single shared `qloo mcp` child and at most `MAX_CONCURRENT_RUNS` runs at a
  time. Actual memory use was not measured. The production `node_modules` is about 170 MB on disk, mostly the
  Qloo harness's own dependencies.
- Set `TRUST_PROXY` only when a reverse proxy or tunnel you control is in front. Check the model with
  `docker exec shelfwise node scripts/check-llm.mjs`.

## Safe use and limits

Shown in the app as one line: *Shelfwise shows aggregate taste affinities from Qloo, not information about
individual patrons.* In more detail:

- **No patron data.** The form rejects email addresses and phone numbers. Qloo's signals are aggregate.
- **Age bands are coarse.** Qloo's youngest audience band is "24 and younger"; it cannot separate children
  from teens from young adults. The "Teens and young adults" option says so in the report. Any age focus needs a place.
- **No author, ISBN, price, publisher or availability** comes from Qloo. The budget helper is arithmetic on the
  average price *you* type in; nothing is looked up.
- **No holdings or circulation data.** Shelfwise cannot know what you already own.
- **Place is free text.** Qloo does not disambiguate it ("Springfield"), so check the evidence trail.
- **One Shelfwise run fans out into several Qloo calls**, which is why runs are rate-limited and cached.
- **Public demo:** per-IP limits, a queue and a daily call budget protect the shared Qloo quota; when the budget
  is used up the demo says so and asks you to try again after 00:00 UTC.

## What is verified, and what is not

Verified in phase 1 (no keys): the whole flow in sample-data mode through the HTTP/SSE API; the real
`qloo mcp` harness starts and lists its tools from a clean production install; all agent-loop behaviour against
a fake MCP server process and a scripted model (all six statuses, `needs_input` pause and resume, retry rules,
step and call bounds, and the no-invention guard); rate limiting, queueing, caching, request validation. The web
app was driven in a real browser in sample-data mode: the ambiguity prompt and resume, the three artefacts, the
evidence trail, a follow-up that re-ran the tools, desktop and phone widths, and the print layout of the
shelf-talkers exported to PDF.

Not verified yet:

- Accessibility beyond automated checks: no screen-reader pass, and the shelf-talkers were exported to PDF but not
  sent to a physical printer.
- Real Qloo results. The sample fixtures are **placeholders** with invented affinities and trends; only the real
  tool *schemas* are real. The payload shapes of `where_popular` heatmaps, `trends` series, `compare_audiences`
  and explainability are read defensively and have not been checked against live responses.
- A live Nemotron model driving the loop. Tool-calling support per model is unconfirmed until `npm run check:llm`
  is run with a key. The sample-data planner is rule-based, not a language model.
- The Docker image has not been built on the machine this was developed on (the Docker daemon was not running).
  The Dockerfile's stages were reproduced by hand instead: a production-only install, the built `dist/`, started
  in sample and live-without-keys modes.
- Known advisories: `npm audit` reports 4 findings (2 moderate, 2 high) in `undici` and `brace-expansion` inside
  the dependency tree of `@qloo/qloo-harness` (via `@earendil-works/pi-coding-agent`). They are not in code
  Shelfwise imports itself. npm reports no fix for the `undici` ones; the `brace-expansion` one would need an
  `overrides` entry. Exploitability was not assessed.

## Project layout

```
src/shared/     types shared by server and web (the API and event contract)
src/qloo/       MCP client, cache, validation, QlooService, sample fixtures + the recorded tool schemas
src/agent/      agent loop, evidence store, no-invention guard, prompt, LLM client, sample-mode planner
src/server/     config, HTTP + SSE, rate limit, run queue, request validation, static serving
web/            React app (Vite), print styles for the shelf-talkers, and its own unit tests in web/test
scripts/        dump-tools.ts (writes docs/qloo-tools.md), check-llm.mjs
test/           node:test suites for the server and agent, and a fake `qloo mcp` server
docs/           qloo-tools.md: the tool schemas and gap analysis
```

## License

[MIT](LICENSE)
