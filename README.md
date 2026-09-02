# Funnel Runtime

A small platform for running, versioning and analysing multi-step web funnels.
Screens are not hardcoded anywhere — the frontend renders whatever JSON config
the backend hands it, and the backend decides every transition.

**Stack:** TypeScript everywhere · React 18 + Vite · Node.js + Express ·
SQLite via the built-in `node:sqlite` · Vitest. One repository, no third-party
services, no native build step.

---

## Quick start

```bash
npm install
npm run seed              # publish the two iteration-1 configs
npm run dev               # API on :3000, client on :5173 (proxied)
```

Open <http://localhost:5173>.

| Route | What it is |
| --- | --- |
| `/` | the funnel itself |
| `/admin` | publish, activate and roll back versions |
| `/dashboard` | analytics |

Add `?funnel=cardmatch` to any route to switch funnels, `?variant=B` to force a
variant, and `?utm_campaign=…` to tag a session.

### Fill it with data

```bash
npm run generate:traffic          # 140 synthetic sessions, deterministic
npm run generate:traffic -- 300 --seed=7
```

Then reload `/dashboard`.

### Other commands

```bash
npm test              # 64 tests
npm run typecheck
npm run build         # bundle the client into dist/client
npm start             # single process serving API + built client on :3000
npm run publish:v2    # publish the iteration-2 config
npm run rollback      # roll back to the previously active version
```

Production runs one process: `npm run build && npm start` serves the API and
the built client together on `PORT` (default 3000).

---

## How the pieces fit

```
shared/funnel.ts     pure engine: transitions, variant resolution, validation,
                     progress, config validation. Imported by client, server
                     and tests, so navigation cannot drift between them.

server/versions.ts   immutable version store + the active-version pointer
server/sessions.ts   session lifecycle; the server owns navigation
server/events.ts     batch ingest: idempotent, partially-failing, order-agnostic
server/analytics.ts  aggregation over unique sessions
client/src/          funnel runner, admin, dashboard
```

The server is authoritative for navigation. The client sends an answer and is
told where it now is; it never computes the next step itself. That is what makes
Back, refresh and reopening the tab lossless — the browser holds nothing but a
session id.

---

## Data model

| Table | Purpose |
| --- | --- |
| `funnel_versions` | **Immutable.** One row per published version, holding the full config JSON. Never updated. |
| `funnel_active` | Mutable pointer: which version new sessions start on, per funnel. |
| `version_activations` | Audit log of every publish / activate / rollback. |
| `sessions` | Pins `version_id` **and** `variant` at creation, plus UTM tags. |
| `session_state` | Current step, history stack, completion flag. |
| `session_answers` | **Raw answers — this table only.** |
| `events` | The analytics store. `event_id` is the primary key. |
| `event_rejections` | Malformed events, kept rather than dropped silently. |
| `ingest_counters` | Running tallies of received / accepted / duplicate / rejected. |

Two design decisions carry most of the weight:

**Config rows are immutable and sessions hold a foreign key to one.** Publishing
appends; it never rewrites. So a session that started on v1 keeps resolving v1's
config forever, and a rollback is a pointer move rather than a migration. No
schema change is needed to publish a new version, because the version *is* data.

**Raw answers live outside the analytics store.** `session_answers` holds what
the user actually typed. Events carry only a sanitised summary: for selects, the
option ids (which come from the config, not the user), and for free numeric
input, a coarse bucket like `"10800-20600"` rather than the figure itself. The
funnel still works — the engine reads `session_answers` for branching — but the
analytics tables never receive the underlying values.

---

## Event schema

Every event carries:

| Field | Notes |
| --- | --- |
| `event_id` | Client-generated. The idempotency key. |
| `session_id` | |
| `type` | |
| `step_id` | Nullable (`session_started` has none). |
| `client_ts`, `server_ts` | Both stored; neither is trusted for ordering. |
| `client_seq` | The client's own counter, used only to *measure* disorder. |
| `version`, `variant` | **Taken from the session row, never from the payload.** |
| `utm_*` | Likewise copied from the session. |
| `props_json` | Event-specific extras. |
| `synthetic` | Marks generator traffic. |

Core types: `session_started`, `step_viewed`, `answer_submitted`,
`step_completed`, `back_clicked`, `result_viewed`, `cta_clicked`.

### Ingest invariants

`POST /api/events` takes `{ events: [...] }`, up to 500 at a time, and returns a
verdict per event — `accepted`, `duplicate` or `rejected`:

- **Deduplication** — `event_id` is the primary key; ingest is `INSERT OR IGNORE`.
  Resending is free.
- **Safe retry** — replaying a whole batch after a timeout is just deduplication
  N times. The response is always 200 when the envelope parses, so a retrying
  client never spins on a permanently-bad payload.
- **Partial failure** — each event is validated on its own. A malformed sibling
  is rejected and recorded in `event_rejections`; the rest still land.
- **Open event types** — any `[a-z][a-z0-9_]{2,63}` type is accepted. This is why
  iteration 2 could introduce `help_opened` with **no schema change and no server
  change** — only a new config.

Version and variant are deliberately read from the session row rather than the
request body, so a stale or tampered client cannot mislabel its own events.

---

## Aggregation rules

Three rules, applied everywhere in `server/analytics.ts`:

**1. Count sessions, not events.** Every metric is `COUNT(DISTINCT session_id)`.
A user who re-views a step ten times, or whose client retries a batch, moves no
metric.

**2. Never read events as a sequence.** Nothing sorts by timestamp to decide what
happened. An event that arrives late lands in exactly the same set as one that
arrives on time, so out-of-order delivery is not a special case.

**3. Per-step conversion is `step_completed / step_viewed`.** The server only
emits `step_completed` when it actually advanced the user, so this is a true
step-to-step conversion that stays correct under branching. Comparing a step
against its neighbour in array order would be meaningless when users take
different paths — half the "drop-off" would just be people on another branch.

Derived from those:

- `dropOff` = `reached − completed` — saw the step, never got past it
- `reachFromStart` = `reached / startedSessions` — the cumulative funnel view
- `viewsPerSession` = total `step_viewed` / `reached` — surfaces repeat views
- `resultRate` = result sessions / started sessions
- `ctaCtrOnResult` = CTA sessions / result sessions
- `ctaClickRate` = CTA sessions / started sessions ← **the primary metric**

Segments are computed by re-running the same query with an extra filter, so
`byVariant` and `byVersion` always sum to `overall`. Sessions whose variant came
from the `?variant=` test hatch are **excluded by default** (`variant_source =
'assigned'`), so manual QA cannot contaminate the experiment read-out; pass
`includeOverrides=true` to see them.

The dashboard's **Data quality** panel exists so the numbers can be trusted: it
reports how many duplicates were suppressed, how many events arrived out of
order (client sequence disagreeing with arrival order), and how many repeat step
views occurred. Those are evidence that the messy cases happened and were
handled, not that they were absent.

---

## The A/B experiment

**Assignment** is server-side and stable twice over: it is a pure function of
`(experimentKey, sessionId)` via FNV-1a, *and* the result is persisted on the
session row at creation. Refresh, resume, a publish or a rollback can never move
a session between variants. `?variant=A|B` overrides it for testing and is
recorded as `variant_source = 'override'`.

### Hypothesis (v1, `amount_first_v1`)

> Variant B asks for the loan amount immediately after the intro, before any
> qualifying question. A low-effort, high-intent question should create
> commitment earlier and reduce drop-off on the income step, lifting end-to-end
> completion. Variant A keeps the conventional order: purpose first, amount later.

**Primary metric:** `cta_click_rate` — unique sessions with `cta_clicked` divided
by unique sessions with `session_started`.

It is the primary metric because it is the only one that spans the whole journey.
Per-step conversion can be gamed by moving a hard question later; reaching the
result can be gamed by removing questions. Only "started and ultimately clicked
through" captures whether the reordering produced more genuinely engaged users.

**Guardrail:** `resultRate`. If B lifts CTA clicks while pushing result-reaching
down, the change is shuffling drop-off rather than removing it.

### Iteration 2 (`amount_first_v2`)

B additionally drops the `preferences` step, testing whether cutting the last
non-essential question lifts click-through. Variant A is unchanged, which keeps
the control comparable across both versions.

**On reading the numbers:** the dashboard shows a directional lift and says so.
A few hundred synthetic sessions is not a powered experiment, and the generator's
outcomes are random rather than modelled on the hypothesis — the plumbing is what
is being demonstrated, not a real result.

---

## Iteration 2, end to end

The new config adds a conditional branch (`refinance_details`, reached when the
goal is debt consolidation), removes `preferences` for variant B, and introduces
the `help_opened` event.

```bash
npm run publish:v2     # or click Publish on /admin
npm run rollback       # or click Roll back
```

What happens, verified by `tests/version-pinning.test.ts` and by hand:

| | |
| --- | --- |
| Sessions started before the publish | keep running on v1, including their config, and can still advance |
| New sessions | start on v2 and see the refinance branch |
| Variant B on v2 | never sees `preferences`; the engine repairs `employment → preferences` into `employment → result` automatically |
| `help_opened` | stored and reported with no migration |
| After rollback | new sessions get v1; v2 sessions stay on v2; **both versions' analytics remain** and are comparable side by side |

Removing a step is the interesting case. `resolveVariantConfig` drops it and then
rewrites every transition that pointed at it, following the removed step's own
default target until it reaches a surviving step. Without that, variant B would
have had a dangling `goto` and users would have fallen off the end of the funnel.
`validateConfig` rejects a config where that repair cannot resolve, so a broken
version can never become active.

---

## Progress under branching

The progress indicator counts only steps *this* user can reach: the history they
have walked, plus a forward simulation from the current step using their own
answers. Choosing "income below 2000" removes the credit and employment
questions from the total immediately, rather than showing a denominator the user
will never reach.

Where a branch is not yet decided the engine takes the first rule as a
deterministic estimate, so the bar does not flicker between renders.

---

## Tests

```bash
npm test    # 64 tests, ~1.5s
```

| File | Covers |
| --- | --- |
| `version-pinning.test.ts` | version pinned per session; publish and rollback don't move live sessions |
| `ab-stability.test.ts` | variant stable across resume; override honoured; even split; per-variant configs |
| `event-ingest.test.ts` | dedup, batching, timeout replay, partial failure, session-sourced labels |
| `publish-rollback.test.ts` | publish, activate, roll back, audit trail, invalid configs refused |
| `analytics.test.ts` | hand-countable scenarios for every metric under duplicates, Back and out-of-order arrival |
| `engine.test.ts` | branching, variant resolution and repair, progress, validation, answer sanitisation |

The analytics tests deliberately build tiny scenarios where the right answer is
obvious by inspection — three sessions see a step, one gets past it, so drop-off
is two — rather than asserting whatever the implementation happens to return.

---

## Traffic generator

`scripts/generate-traffic.ts` boots the real app on an ephemeral port and drives
it over HTTP, so ingest, validation and navigation are genuinely exercised rather
than bypassed by writing rows directly. It is seeded, so a given seed reproduces
the same traffic.

It produces, by construction: both variants; six UTM campaigns; every branch
including the business and low-income paths; drop-off spread across steps;
Back-then-forward loops that create repeat step views; whole batches resent after
a simulated timeout; adjacent events swapped so they arrive out of order; and
malformed events mixed into otherwise-valid batches.

A representative run of 140 sessions: ~2,300 events sent, ~375 duplicates
suppressed, ~30 malformed rejected with siblings intact, ~130 events arriving out
of order.

---

## Deployment

`Dockerfile` plus blueprints in `deploy/` for Render and Fly. Both mount a volume
at `/data` so the SQLite file survives deploys, and `scripts/seed-if-empty.ts`
publishes the iteration-1 configs on first boot only — a redeploy never resets a
live funnel.

```bash
docker build -t funnel-runtime .
docker run -p 3000:3000 -v funnel-data:/data funnel-runtime
```

Set `ADMIN_TOKEN` to require `x-admin-token` (or HTTP basic auth) on the mutating
admin routes. Unset, they are open — see the assumptions below.

---

## Build timeline

Built in one continuous session, in this order. Wall-clock times are for the
reviewer to weigh against the 48-hour budget; the sequence is what mattered.

**Iteration 1**

1. **Engine first, before any I/O.** `shared/funnel.ts` — transitions, variant
   resolution, validation, progress — written and smoke-tested against the
   configs standalone. Everything downstream depends on it being right, and it is
   pure, so it was cheap to verify early.
2. **Schema.** Designed around the two hard requirements (immutable versions,
   idempotent events) rather than around the screens. Both invariants are
   enforced by constraints, not by application code.
3. **Server:** version store → sessions → ingest → analytics, each verified
   against the previous layer before moving on.
4. **Traffic generator before the UI.** This was the highest-leverage ordering
   decision: it gave a realistic dataset to develop the dashboard against, and it
   immediately exposed two analytics bugs that a hand-clicked session would not
   have — a parameter-order mismatch that silently zeroed every filtered segment,
   and the result screen leaking into the step table.
5. **Tests**, then **client**.

**Iteration 2**

6. Wrote `v2-quickcash.json` (new branch, step removed for variant B, new event),
   published it, verified in-flight v1 sessions were unaffected, rolled back, and
   confirmed both versions' analytics survived.

The step-removal case drove a real engine change: transitions pointing at a
removed step now get rewritten to that step's own onward target, and
`validateConfig` refuses to publish a config where that cannot resolve.

## Working with AI agents

Built with Claude Code, driven as a single directed session rather than a fan-out
of parallel agents — at this size, coordination overhead would have exceeded the
benefit, and every layer here depends on the one beneath it.

What that looked like in practice:

- **Verification after each layer, not at the end.** Every stage was exercised
  before the next was built — the engine against real configs, ingest against the
  generator, analytics against hand-countable fixtures. The two bugs found were
  caught by running the thing, not by reading it.
- **Tests assert hand-derived values.** In `analytics.test.ts` the scenarios are
  deliberately tiny — three sessions see a step, one gets past it, so drop-off is
  two — because a test that asserts whatever the implementation returned would
  have happily locked in the parameter-order bug.
- **Two bugs were mine, two were the tests'.** When the suite first ran, two
  failures were genuine test errors (a helper returning the wrong type, and a
  test that assumed variant A when assignment is random) rather than source bugs.
  Both are noted here because telling those apart is the actual skill.

Every design decision in this README — the immutability rule, the
`completed/viewed` conversion definition, the rollback policy, the raw-answer
split — is one I can defend and would defend differently if the constraints
changed.

## Known limitations and assumptions

**Assumptions I made where the brief was silent.** Each is a real decision; happy
to change any of them:

1. **"No third-party services" means no external SaaS for analytics, feature
   flags or data** — not "no hosting". The event pipeline, experiment assignment
   and storage are all built here. A public URL has to run somewhere.
2. **Rollback does not migrate live sessions.** The brief specifies behaviour for
   *publish* (old sessions continue on the old version) but not for *rollback*. I
   apply the same rule in both directions: a session never moves across configs,
   because the answers it already gave were validated against the config it
   started on. Forcing it onto another version could strand it on a step that no
   longer exists.
3. **Variant is assigned per session**, matching the brief's "stable within the
   session". There is no cross-session user identity, so a returning visitor with
   cleared storage is a new session and may be re-bucketed.
4. **Session state is server-side, keyed by a session id in `localStorage`.**
   Refresh and reopening the tab resume perfectly; a different browser or device
   does not, since there is no user account to tie sessions together.
5. **The admin and dashboard routes are unauthenticated by default** so the
   deployed URL can be reviewed without credentials. `ADMIN_TOKEN` gates the
   mutating routes when set. This is not a production posture.
6. **Analytics counts sessions from `session_started` events**, not from session
   rows — the event pipeline is the source of truth, so a session that never
   emitted anything does not appear.
7. **Override sessions are excluded from the experiment read-out by default**, so
   manual QA does not skew the comparison.
8. **I wrote the configs.** The brief refers to two configs supplied with the
   assignment; they were not attached, so I authored `v1-quickcash.json` and
   `v1-cardmatch.json` (two different funnels, to show the runtime is not tuned
   to one) plus `v2-quickcash.json` for iteration 2. Swapping in the intended
   configs should need no code change — anything they exercise that the engine
   lacks would be the interesting finding.

**Genuine limitations:**

- **SQLite on one node.** Correct and fast here, but ingest is synchronous and
  single-writer; real volume would need a queue in front and a server-side
  database behind.
- **Analytics is computed on every request.** Fine at this scale (a few thousand
  events, sub-millisecond); a production version would pre-aggregate into a
  rollup table.
- **No significance testing.** The dashboard reports a directional lift and
  labels it as such. Adding a proper test would need a real traffic model.
- **`client_seq` measures disorder but does not correct it.** By design —
  aggregation is order-independent, so there is nothing to correct. It exists so
  the dashboard can *show* that out-of-order traffic arrived.
- **No visual config editor**, per the brief. Configs are published from JSON
  files or the API.
- **The generator's outcomes are random, not modelled on the hypothesis.** It
  proves the pipeline, not the experiment.
- **`node:sqlite` requires Node 22.5+.** It is loaded through `createRequire`
  because Vite and Vitest resolve against builtin lists that predate it.
