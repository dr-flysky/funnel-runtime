# Funnel Runtime

A platform for running, versioning and analysing multi-step web funnels. Screens
are not hardcoded anywhere: the frontend renders whatever JSON config the backend
hands it, and the backend decides every transition.

It runs the supplied `funnel-v1.json` (`schemaVersion` 1.0) **natively** — the
JSON that is published is the JSON that is stored and executed, with no
translation layer in between.

**Stack:** TypeScript everywhere · React 18 + Vite · Node.js + Express · SQLite
via the built-in `node:sqlite` · Vitest. One repository, no third-party services,
no native build step.

---

## Quick start

```bash
npm install
npm run seed              # publish configs/funnel-v1.json
npm run dev               # API on :3000, client on :5173 (proxied)
```

Open <http://localhost:5173>.

| Route | What it is |
| --- | --- |
| `/` | the funnel itself |
| `/admin` | publish, activate and roll back versions |
| `/dashboard` | analytics |

`?variant=A|B` forces a variant (the config names this parameter in
`experiment.overrideQueryParam`); `?utm_campaign=…` tags a session.

### Fill it with data

```bash
npm run generate:traffic            # 140 synthetic sessions, deterministic
npm run generate:traffic -- 300 --seed=7
```

### Other commands

```bash
npm test              # 80 tests
npm run typecheck
npm run build         # bundle the client into dist/client
npm start             # single process serving API + built client on :3000
npm run publish -- configs/funnel-v2.example.json
npm run rollback      # roll back to the previously active version
```

Requires **Node 22.5+** for `node:sqlite`.

---

## The config schema

The supplied config drives everything. The engine implements its model directly:

| Config key | What the runtime does with it |
| --- | --- |
| `steps` | An object keyed by step id. Types: `info`, `number`, `single-select`, `multi-select`, `result`. |
| `experiment.variants[x].stepSequence` | The full ordered step list for that variant. **This is where ordering lives** — there are no per-step `next` pointers. |
| `experiment.variants[x].stepOverrides` | Deep-merged per-step patches (variant B's intro and priorities copy). |
| `experiment.variants[x].resultOverrides` | Deep-merged per-result patches (variant B's result titles and CTA). |
| `steps[x].visibleWhen` | A condition tree. A step whose predicate is false is simply not shown. |
| `resultRules` + `defaultResultId` | Ordered rules; first match wins, default catches the rest. |
| `validation.messages` | Error copy comes from the config. The engine never invents text when the config supplies it. |
| `progress.countVisibleOnly` / `excludeTypes` | The progress denominator: visible steps only, excluding `info` and `result`. |
| `session.ttlHours` | 72h. A session past its TTL is not resumed. |
| `events.allowed` | Which event names a version may emit, and the properties each carries. |
| `events.privacy.storeRawAnswers` | `false` — see **Privacy** below. |

### Branching by visibility, not by graph edges

This is the design decision that shapes the whole engine. A variant supplies a
linear `stepSequence`; a step carries `visibleWhen`; the visible path is the
sequence filtered by those predicates, recomputed from the current answers on
every request.

That model **cannot produce an unreachable step or a dangling pointer**, so the
engine needs no transition-repair logic and no reachability analysis. Changing an
earlier answer takes effect immediately — going back and switching `work_mode`
from `hybrid` to `remote` makes `office_days` disappear with no bookkeeping.

The one hazard it *does* have is ordering: a `visibleWhen` that reads an answer
collected **later** in its own variant's sequence silently evaluates against an
absent answer, and the step vanishes for everybody. `validateConfig` rejects that
at publish time, per variant, so it can never reach production.

---

## How the pieces fit

```
shared/funnel.ts     pure engine: variant resolution, visibility, result rules,
                     validation, progress, config validation. Imported by client,
                     server and tests, so navigation cannot drift between them.

server/versions.ts   immutable version store + the active-version pointer
server/sessions.ts   session lifecycle; the server owns navigation
server/events.ts     batch ingest: idempotent, partially-failing, order-agnostic
server/analytics.ts  aggregation over unique sessions
client/src/          funnel runner, admin, dashboard
```

The server is authoritative for navigation. The client sends an answer and is
told where it now is; it never computes the next step. That is what makes Back,
refresh and reopening the tab lossless — the browser holds nothing but a session
id.

---

## Data model

| Table | Purpose |
| --- | --- |
| `funnel_versions` | **Immutable.** One row per published version holding the full config JSON, plus `source_version` (the version the file declared for itself). |
| `funnel_active` | Mutable pointer: which version new sessions start on. |
| `version_activations` | Audit log of every publish / activate / rollback. |
| `sessions` | Pins `version_id`, `variant` and `experiment_id` at creation, plus UTM tags. |
| `session_state` | Current step, completion flag, resolved `result_id`. |
| `session_answers` | **Raw answers — this table only.** |
| `events` | The analytics store. `event_id` is the primary key. |
| `event_rejections` | Malformed events, kept rather than dropped silently. |
| `ingest_counters` | Running tallies of received / accepted / duplicate / rejected. |

Two decisions carry most of the weight:

**Config rows are immutable and sessions hold a foreign key to one.** Publishing
appends; it never rewrites. A session that started on v1 keeps resolving v1's
config forever, and a rollback is a pointer move rather than a migration. No
schema change is needed to publish a new version, because the version *is* data.
The platform's `version` column is authoritative for pinning; the file's own
`version` field is preserved separately as `source_version`.

**Navigation state is not a history stack.** Because the model is a linear
sequence plus visibility predicates, the previous step is *computed*
(`previousStepId`) rather than stored. There is no history to keep in sync with
the answers, so editing an earlier answer cannot leave a stale trail behind.

### Privacy

`events.privacy.storeRawAnswers: false` and `session.persistAnswers: true` are
both honoured, and they are not in conflict:

- Raw answers are written to `session_answers` and nowhere else. The funnel needs
  them — `visibleWhen` and `resultRules` read them.
- `answer_submitted` carries **only `answer_kind`**, exactly the one property the
  config declares for it. Not the chosen option, not the number, not a bucket. A
  test asserts the payload has that single key, so a future change that starts
  leaking values fails the suite rather than shipping.

---

## Event schema

Base properties on every event, matching `events.baseProperties`:
`event_id`, `session_id`, `client_timestamp` (+ a server timestamp),
`funnel_id`, `funnel_version`, `experiment_id`, `variant`, `step_id`,
`utm_source`, `utm_medium`, `utm_campaign`.

Per-event properties, exactly as declared:

| Event | Properties |
| --- | --- |
| `session_started` | — |
| `step_viewed` | `step_type`, `visible_step_index`, `visible_step_count` |
| `answer_submitted` | `answer_kind` |
| `step_completed` | `next_step_id` |
| `back_clicked` | `destination_step_id` |
| `result_viewed` | `result_id` |
| `cta_clicked` | `result_id`, `action` |

**The CTA performs its declared action.** Every result in the supplied config
names `expand_recommendation`, so the recommendation list is *withheld* until
the CTA is pressed — which is what makes `cta_clicked` a real conversion signal
rather than a decorative click, and what the primary metric is measuring. An
action the client does not implement still records the click and falls back to
revealing the recommendation, and `validateConfig` warns at publish time so a
dead button cannot ship unnoticed.

`funnel_version`, `variant`, `experiment_id` and the UTM tags are taken from the
**session row**, never from the request body, so a stale or tampered client
cannot mislabel its own events.

### Ingest invariants

`POST /api/events` takes `{ events: [...] }`, up to 500 at a time, and returns a
verdict per event — `accepted`, `duplicate` or `rejected`:

- **Deduplication** — `event_id` is the primary key; ingest is `INSERT OR IGNORE`.
  Resending is free.
- **Safe retry** — replaying a whole batch after a timeout is deduplication N
  times. The response is always 200 when the envelope parses, so a retrying
  client never spins on a permanently-bad payload.
- **Partial failure** — each event is validated on its own. A malformed sibling
  is rejected and recorded in `event_rejections`; the rest still land.
- **Version-scoped event names** — an event is accepted if the config version the
  session is pinned to declares it. A **new config version can introduce an event
  with no migration and no server change**; a session on an older version is
  correctly told the event is not declared for it.

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
against its neighbour in sequence order would be meaningless when `office_days`
is invisible to a third of users — much of the apparent "drop-off" would just be
people who were never shown it.

Derived from those:

- `dropOff` = `reached − completed`
- `reachFromStart` = `reached / startedSessions`
- `viewsPerSession` = total `step_viewed` / `reached` — surfaces repeat views
- `resultRate` = result sessions / started sessions
- `ctaCtrOnResult` = CTA sessions / result sessions
- `ctaClickRate` = CTA sessions / started sessions ← **primary metric**
- **Result distribution** — which of the four recommendations each session
  reached, from the `result_id` property, by unique session

**Step ordering in the report** is a genuine ambiguity: variants A and B order
their questions differently, so there is no single true order. The report takes
the first variant's sequence as the backbone and appends anything only other
variants or older versions ask, so no step's numbers ever silently vanish.

Segments re-run the same query with an extra filter, so `byVariant` and
`byVersion` always sum to `overall`. Sessions whose variant came from the
`?variant=` test hatch are **excluded by default**; pass `includeOverrides=true`
to see them.

The dashboard's **Data quality** panel reports duplicates suppressed, events that
arrived out of order (client sequence disagreeing with arrival order) and repeat
step views — evidence that the messy cases happened and were handled, not that
they were absent.

---

## The A/B experiment

**Assignment** is server-side and stable twice over: a pure function of
`(experiment.id, sessionId)` via FNV-1a, *and* persisted on the session row at
creation. Refresh, resume, a publish or a rollback can never move a session
between variants. This satisfies `assignment: "server"` and `sticky: true`.

### Hypothesis — `question-order-and-result-framing-v1`

Variant B changes two things at once:

1. **Order.** It leads with `work_mode` and `timezone_span` — two taps — and
   defers `team_size`, which requires typing a number.
2. **Result framing.** Result titles become outcome statements ("Your team is
   ready to reduce meetings" rather than "Async-native") and the CTA becomes
   specific ("See the 30-day action list" rather than "View the action list").

> **Hypothesis.** Opening with low-effort recognition questions rather than a
> numeric entry reduces first-question abandonment, and naming a concrete
> deliverable on the result screen converts more of the people who get there. We
> expect B to lift end-to-end click-through.

**Primary metric:** `cta_click_rate` — unique sessions with `cta_clicked` divided
by unique sessions with `session_started`.

It is the primary metric because it is the only one spanning the whole journey.
Per-step conversion can be gamed by moving a hard question later — which is
precisely what B does — and result-reaching can be gamed by asking less. Only
"started, and ultimately clicked through" captures whether the change produced
more genuinely engaged people.

**Guardrails.** `resultRate` (is B moving drop-off around rather than removing
it?) and the **result distribution** (B must not shift which recommendation
people receive — the questions are merely reordered, so the mix should be stable;
if it moves, the reordering is changing answers, not just their sequence).

Because B changes order *and* copy, a win does not attribute to one of them.
That is a deliberate trade for one experiment's worth of traffic, and a follow-up
would split them.

**On reading the numbers:** the dashboard shows a directional lift and says so. A
few hundred synthetic sessions is not a powered experiment, and the generator's
outcomes are random rather than modelled on the hypothesis — the plumbing is what
is demonstrated, not a result.

---

## Iteration 2

The real iteration-2 config has not been supplied yet. To prove the flow works
end to end, `configs/funnel-v2.example.json` is a **stand-in** derived from v1
that exercises exactly the three changes iteration 2 specifies:

- **a new conditional branch** — `meeting_load`, visible only when
  `async_maturity` is `low` or `medium`
- **a step removed for one variant** — variant B drops `tool_count` by omitting
  it from its `stepSequence`
- **a new event** — `help_opened`, declared in `events.allowed`

```bash
npm run publish -- configs/funnel-v2.example.json
npm run rollback
```

Verified by hand and by `tests/version-pinning.test.ts`:

| | |
| --- | --- |
| Sessions started before the publish | keep running on v1, including their config, and still advance |
| New sessions | start on v2 and see the new branch |
| Variant B on v2 | never sees `tool_count`; omission from a linear sequence cannot strand anyone |
| `help_opened` | accepted on v2, rejected on v1, with no migration |
| After rollback | new sessions get v1; v2 sessions stay on v2; **both versions' analytics remain** and are comparable |

Swapping in the real file should need no code change. Anything it exercises that
the engine lacks would be the interesting finding — the most likely candidates
are a new step `type`, a new condition `operator`, or a `resultSource` other than
`resultRules`.

---

## Tests

```bash
npm test    # 80 tests, ~1.5s
```

| File | Covers |
| --- | --- |
| `engine.test.ts` | variant resolution and deep merge, visibility branching, result rules, progress policy, config-supplied validation messages, answer-kind-only summaries |
| `version-pinning.test.ts` | version pinned per session; publish and rollback don't move live sessions |
| `ab-stability.test.ts` | variant stable across resume; override honoured; even split; per-variant configs |
| `event-ingest.test.ts` | dedup, batching, timeout replay, partial failure, session-sourced labels, version-scoped event names |
| `publish-rollback.test.ts` | publish, activate, roll back, audit trail, invalid configs refused |
| `analytics.test.ts` | hand-countable scenarios for every metric under duplicates, Back and out-of-order arrival |

The analytics tests deliberately build tiny scenarios where the right answer is
obvious by inspection — three sessions see a step, one gets past it, so drop-off
is two — rather than asserting whatever the implementation happens to return.

---

## Traffic generator

`scripts/generate-traffic.ts` boots the real app on an ephemeral port and drives
it over HTTP, so ingest, validation and navigation are genuinely exercised rather
than bypassed by writing rows directly. Seeded, so a given seed reproduces the
same traffic. Events carry exactly the properties the config declares.

It produces by construction: both variants; six UTM campaigns; every branch,
including the hidden `office_days` step and all four results; drop-off spread
across steps; Back-then-forward loops that create repeat step views; whole
batches resent after a simulated timeout; adjacent events swapped so they arrive
out of order; and malformed events mixed into valid batches.

A representative run of 140 sessions: ~2,700 events sent, ~250 duplicates
suppressed, ~27 malformed rejected with siblings intact, ~127 arriving out of
order, all four recommendations reached.

---

## Deployment

`Dockerfile` plus blueprints in `deploy/` for Render and Fly. Both mount a volume
at `/data` so the SQLite file survives deploys, and `scripts/seed-if-empty.ts`
publishes on first boot only — a redeploy never resets a live funnel.

```bash
docker build -t funnel-runtime .
docker run -p 3000:3000 -v funnel-data:/data funnel-runtime
```

Set `ADMIN_TOKEN` to require `x-admin-token` (or HTTP basic auth) on the mutating
admin routes. Unset, they are open — see the assumptions below.

---

## Known limitations and assumptions

**Confirmed with the client:**

1. **"No third-party services" does not ban hosting platforms** — confirmed, so
   Vercel / Render / Fly are in scope. The event pipeline, experiment assignment
   and storage are all built here regardless.

**Assumptions where the brief is still silent:**

2. **Rollback does not migrate live sessions.** The brief specifies behaviour for
   *publish* (old sessions continue on the old version) but not for *rollback*. I
   apply the same rule in both directions: a session never moves across configs,
   because the answers it already gave were validated against the config it
   started on.
3. **Variant is assigned per session**, matching `sticky: true` and the brief's
   "stable within the session". There is no cross-session user identity, so a
   returning visitor with cleared storage is a new session and may be re-bucketed.
4. **Session state is server-side, keyed by a session id in `localStorage`.**
   Refresh and reopening the tab resume perfectly; a different browser or device
   does not, since there is no account to tie sessions together.
5. **Admin and dashboard routes are unauthenticated by default** so the deployed
   URL can be reviewed without credentials. `ADMIN_TOKEN` gates the mutating
   routes when set. Not a production posture.
6. **Analytics counts sessions from `session_started` events**, not from session
   rows — the event pipeline is the source of truth.
7. **Override sessions are excluded from the experiment read-out by default.**
8. **The platform owns version numbering.** The file's own `version` field is
   recorded as `source_version` but the platform's sequence is what sessions pin
   to, so publishing the same file twice yields two distinct versions rather than
   a collision.
9. **Two characters in the supplied `funnel-v1.json` arrived mojibaked** —
   `"About 3â6 hours apart"` and `"Building your recommendationâ¦"`, a UTF-8
   transfer artifact. I restored them to `3–6` and `…`. Worth confirming the
   original file is clean at source.

**Genuine limitations:**

- **SQLite on one node.** Correct and fast here, but ingest is synchronous and
  single-writer; real volume would need a queue in front and a server-side
  database behind.
- **Analytics is computed per request.** Fine at this scale; production would
  pre-aggregate into a rollup table.
- **No significance testing.** The dashboard reports a directional lift and
  labels it as such.
- **The progress denominator can grow mid-funnel.** Answering `work_mode:
  hybrid` reveals `office_days`, taking the count from 6 to 7. That is the honest
  reading of `countVisibleOnly`, but it means the bar can step backwards. The
  alternative — assuming conditional steps *will* appear until ruled out — makes
  the bar jump the other way for the two-thirds of users who do see it. I chose
  the config-faithful reading; happy to flip it.
- **`client_seq` measures disorder but does not correct it.** By design —
  aggregation is order-independent, so there is nothing to correct.
- **No visual config editor**, per the brief.
- **The generator's outcomes are random, not modelled on the hypothesis.** It
  proves the pipeline, not the experiment.
- **`node:sqlite` requires Node 22.5+.** It is loaded through `createRequire`
  because Vite and Vitest resolve against builtin lists that predate it.

---

## Build timeline

**Iteration 1 (first pass, before the config arrived).** Built against a config
schema I designed myself, since the two referenced configs were not attached:
engine first, then schema, version store, sessions, ingest, analytics, traffic
generator, tests, client.

**Adapting to the supplied config.** When `funnel-v1.json` arrived its schema
differed substantially from my placeholder — steps keyed by id rather than an
array, `stepSequence` per variant instead of per-step `next` pointers,
`visibleWhen` instead of graph edges, four results selected by `resultRules`
instead of one, and config-supplied validation copy.

I rewrote the engine to speak that schema **natively** rather than adapting it
into my own shape. An adapter would have been faster and would have been the
wrong call: the config is the client's contract, and a translation layer is one
more thing to drift, plus it would have made the stored config not-quite the
published config — which is exactly what the version-pinning guarantee rests on.

The architecture survived intact. Version pinning, event idempotency, session
ownership of navigation and the aggregation rules are all schema-independent, so
the change was confined to `shared/funnel.ts`, the config-shaped edges of the
server, the renderers and the fixtures. The new model is *simpler*: branching by
visibility cannot dangle, so ~80 lines of transition-repair logic were deleted
outright.

**Iteration 2.** Pending the real config; the flow is proven with a stand-in.

## Working with AI agents

Built with Claude Code, driven as a single directed session rather than a fan-out
of parallel agents — every layer here depends on the one beneath it, so
coordination overhead would have exceeded the benefit.

- **Verification after each layer, not at the end.** The engine was smoke-tested
  against the real config before any server code touched it; ingest was proven
  with the generator before the dashboard was written.
- **Tests assert hand-derived values.** A test that asserts whatever the
  implementation returned would have locked in the parameter-order bug below.
- **Four bugs, and telling them apart is the skill.** Two were mine — a
  parameter-order mismatch in the analytics WHERE builder that silently zeroed
  every filtered segment, and a validation-message lookup that preferred the
  `required` key when this config supplies only `minSelections`, falling through
  to generic engine text. Two were bugs in my *tests* — a helper returning the
  wrong type, and assertions that assumed a variant when assignment is random.
- **One self-inflicted wound worth recording:** a SQL comment containing a
  backtick terminated the template literal holding the schema. Caught instantly
  by typecheck, which is the argument for running it after every edit rather than
  at the end.
