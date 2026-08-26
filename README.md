# auto-reviewer

A generic AI-powered automation pipeline with an interactive web UI. Today's
wiring: **you open the UI, refresh a list of Jira issues in "Code Review",
pick one, watch it diff the linked GitLab branch against main/master and
generate an AI review live — then you click Approve or Reject.** Nothing
runs on its own; nothing gets written back to Jira without your click.

The point of this project isn't just that one flow — it's the architecture
underneath it. Every stage is an interface; `config/config.yaml` picks which
implementation of each stage runs. Swapping today's flow for a different
automation means writing one or two small adapter files and changing a few
lines in `config.yaml` — the pipeline engine itself doesn't change.

## Three ways to run it

| Mode | Command | Behavior |
|---|---|---|
| **Desktop app (recommended)** | `npm run app` | The UI in an Electron shell, with a tray icon and system notifications when a review is ready. Same behavior as below — nothing automatic, you approve. See [Desktop app](#desktop-app). |
| Interactive UI | `npm run ui` | Nothing automatic. Open `http://localhost:4321`, refresh the list, pick an issue, watch the steps live, approve/reject yourself. |
| Headless/automatic | `npm run dev` | The original background daemon: polls Jira and the approval channel on a timer with no page to look at. Only makes sense with `consoleApproval` or `slackReaction` wired (see below) — `webApproval` has no UI to click in this mode. |

## Architecture

```
Trigger.poll() → ContextCollector[].collect() → AiTask.run() → ApprovalChannel.request() → (approval) → Action.execute()
```

| Stage | Interface (`src/core/types.ts`) | Today's implementation |
|---|---|---|
| Trigger | `Trigger.poll()` | `JiraStatusPollTrigger` — searches Jira via JQL for `status = "Code Review"` (edit the JQL in `config/config.yaml`) |
| Context | `ContextCollector.collect()` | `JiraIssueContext` (issue + linked GitLab branch name via Jira's dev-status API), `GitlabBranchDiffContext` (diffs that branch against the repo's default branch — no merge request needed) |
| AI task | `AiTask.run()` | `CodeReviewTask` — builds a prompt from context, calls an `LlmProvider`. See `mcpCodeReviewTask.ts` for an alternate implementation sketch using the Claude Agent SDK + MCP servers instead of REST clients — same interface, drop-in swap. |
| LLM | `LlmProvider.generate()` | `claudeCli` (**default**) — shells out to the `claude` CLI in print mode, so it uses your Claude Code subscription's included usage rather than pay-per-token API credits. `anthropic` — calls the API directly via `@anthropic-ai/sdk`, needs a funded `ANTHROPIC_API_KEY` (billed separately from any subscription). |
| Approval | `ApprovalChannel.requestApproval()` / `.checkPending()` | `webApproval` (**default**) — the web UI's Approve/Reject buttons, no auto-approve, ever. `consoleApproval` — logs and auto-approves, no human gate (only for quick headless tests). `slackReaction` — posts to Slack, reads back a ✅/❌ reaction. Swap via `wiring.approval` in config.yaml. |
| Action | `Action.execute()` | `JiraCommentAction` — posts the approved review as a Jira comment (currently a **dry run** — logs what it would post instead of calling the API; see the file to re-enable) |

`src/core/pipeline.ts` exposes both operating modes on the same engine:

- `start()` — the headless mode's two `setInterval` loops (trigger poll +
  approval poll).
- `runOne(event)` / `resolveApprovals()` — what the web UI calls on demand:
  run one issue through context → AI task → approval-request, and resolve
  any approvals that now have a decision.

`src/core/stateStore.ts` tracks which issues have been queued and which
approvals are still pending (used by both modes). `src/core/reviewStore.ts`
persists the **per-issue review state** the UI displays — `idle` →
`running` → `awaiting_approval` → `approved`/`rejected` → `posted` — to
`data/reviews.json`, so a page refresh or server restart doesn't lose it.
It also keeps a capped **history**: re-reviewing an issue archives the
previous review (with the outcome it reached) instead of discarding it, so
the UI can show what the reviewer said last time alongside the new run.

> The JSON stores load their file into memory once at construction, so they
> assume a single writer. Running two processes against the same `data/`
> directory will have them clobber each other's writes.
`src/core/progressBus.ts` fans out the step-by-step log lines both modes
produce; the web UI subscribes to it over Server-Sent Events for the live
step panel.

`src/core/registry.ts` is where `config.yaml`'s `wiring` block gets resolved
into concrete adapter instances — it's the one place that knows every
adapter's name.

## What one review actually does

From clicking **İncele** to a comment on the issue. Everything above the
dashed line is preparation; the model only sees what has been gathered.

```
        ┌──────────────────────────────────────────────┐
        │  You pick an issue and press İncele          │
        │  (or autoPrepare sees a new one arrive)      │
        └───────────────────────┬──────────────────────┘
                                ▼
                      ┌───────────────────┐
                      │  ReviewQueue      │  one at a time — every review
                      │  position 0? run  │  mutates the shared repo cache,
                      │  else: queued     │  so two at once read each
                      └─────────┬─────────┘  other's checkouts
                                ▼
   ╔════════════════ gather (no model involved yet) ════════════════╗
   ║                                                                ║
   ║  jiraIssueContext                                              ║
   ║    ├─ issue: title, description                                ║
   ║    ├─ comments  ──► acceptance criteria, changes asked before   ║
   ║    ├─ related   ──► parent / links, background only             ║
   ║    └─ dev-panel ──► which GitLab branches are linked            ║
   ║                                                                ║
   ║  gitlabBranchDiffContext                                       ║
   ║    ├─ diff each linked branch vs its base                      ║
   ║    ├─ check the changed repos out AT the task branch            ║
   ║    └─ put every other cached repo BACK on its default branch    ║
   ║         └─ so context is merged code, never someone's WIP       ║
   ╚═══════════════════════════════┬════════════════════════════════╝
                                   ▼
                        ┌────────────────────┐
                        │  codeReview task   │  builds one prompt from:
                        │  buildPrompt()     │  diff + issue + comments +
                        └──────────┬─────────┘  notes + your answers,
                                   │            objections and revisions
- - - - - - - - - - - - - - - - - -│- - - - - - - - - - - - - - - - - - - -
                                   ▼
                    ┌──────────────────────────┐
                    │  claude -p               │  read-only: Read/Glob/Grep
                    │  stream-json             │  scoped to the checkouts.
                    │  every tool call ──────► │  Its own MCP servers are
                    │  the step log            │  off; it cannot write, run
                    └──────────────┬───────────┘  commands, or reach the net
                                   ▼
                    ┌──────────────────────────┐
                    │  splitReview()           │  [?]  → open questions
                    │  markers come out here   │  [note] → applied notes
                    └──────────────┬───────────┘  [withdrawn] → dropped
                                   ▼                (none of these reach Jira)
                        ┌────────────────────┐
                        │  awaiting_approval │  ◄── STOPS HERE. Always.
                        └─────────┬──────────┘
                                  │
        ┌─────────────────────────┴─────────────────────────┐
        ▼                                                   ▼
   You approve                                         You reject
        │                                                   │
        ▼                                                   ▼
  comment on the issue                            comment + your reason
  status → approveStatus                          status → rejectStatus
  assign → the developer                          assign → the developer
        │                                                   │
        └──────────────────────┬────────────────────────────┘
                               ▼
                 the developer is whoever held the issue
                 BEFORE it entered review — read from the
                 changelog, not from the current assignee
                 (which by then is the reviewer)
```

**Nothing skips the stop.** `applyChanges` gates every Jira write, and even
with it on, the comment and the transition happen only after a click. The
approve/reject handlers now verify the write actually landed and report an
error rather than claiming success.

**When the review is wrong**, three routes feed the next run, and they are
not the same thing:

| You say | Marker | What the next run does |
|---|---|---|
| Answer an open question | `[?]` | Treats your answer as fact and stops asking |
| Dispute a finding | — | Re-reads the code, then withdraws it or defends it with evidence |
| Ask for a change to the review | — | Follows it — but verifies any claim about the code first |

## Adding a new automation

1. Write the adapter(s) you need under `src/adapters/**`, implementing the
   relevant interface from `src/core/types.ts`.
2. Register it under a name in the matching map in `src/core/registry.ts`.
3. Reference that name from `config/config.yaml`'s `wiring` block.

Nothing in `pipeline.ts`, `stateStore.ts`, `reviewStore.ts`, or the web
server needs to change — they only know about the five interfaces, never a
concrete adapter.

## Where the backend lives

The address ships with the build, not with a settings screen:

| Build | Backend |
|---|---|
| `npm run app`, `npm run ui` (default) | `http://localhost:4322` |
| `REVIFY_ENV=production npm run build` | the deployed service |

It is a property of the build, not a preference: a reviewer has no way to
know the address, no reason to care, and every chance to mistype it.
`REVIFY_API_URL` overrides both — an operator's escape hatch for a staging
box, not something the app surfaces.

The app opens on a sign-in screen. Reviews still run on your machine
against your own credentials; the backend only knows who you are, who is on
your team, and who owes whom a review. If it cannot be reached and you have
signed in before, the app opens anyway with a warning — locking someone out
of their own machine's reviews because a server is down would trade real
availability for no real safety.

## Continuous integration

| Pipeline | Builds | Runs |
|---|---|---|
| `.github/workflows/app.yml` | the app: typecheck, tests, smoke, and macOS/Linux installers on every push to `master` | GitHub Actions, no secrets — fork pull requests run it in full |
| `Jenkinsfile` | **only** the API: vet, race tests, static Linux binary, deploy | Jenkins, deploy gated on `main` + an explicit parameter |

They ship to different places on different schedules — the API is one
binary on one server, the app is installers people download — so they are
two pipelines rather than one with a lot of `when`.

## Desktop app

```bash
npm run app          # build + launch the Electron shell
```

Same server, same page — hosted in Electron so it can do the two things a
browser tab cannot:

- **Tray.** Closing the window hides it; the app keeps watching. The tray
  shows how many reviews are waiting on you (also on the macOS dock badge),
  and its menu opens the window, opens the page in a real browser, or quits.
- **Notifications.** One when a review is ready for your decision, one when
  a run fails, and a silent one when auto-prepare picks up a new issue.
  Clicking a notification opens that issue. Only the first makes a sound —
  a chime for every issue the watcher notices would train you to ignore the
  ones that actually wait on a decision.

The server runs inside the Electron process rather than as a child: review
events reach the notifier directly, and there is one lifecycle instead of
two, so quitting the app also kills any review in flight. It listens on a
random loopback port, so it never collides with `npm run ui`.

The renderer is sandboxed with no Node access. It renders model output, and
model output is not trusted.

### Updates

The app checks GitHub releases 15 seconds after start and every six hours.
A new version downloads in the background and then waits — a banner offers
**Kur ve yeniden başlat**.

Nothing installs itself, and the server refuses to restart while a review is
running or queued: a restart kills the `claude` process and loses work that
cannot be resumed. The update can wait; the review cannot.

| Platform | What happens |
|---|---|
| Linux (AppImage) | Downloads and installs on click |
| macOS | Notices the new version and opens the download page |

macOS is not a limitation of the updater but of the build: Squirrel refuses
to apply an update to an unsigned app, and releases are unsigned because
signing certificates are secrets that fork pull requests must never see.
Signing (plus the `zip` target, already configured) is all that stands
between the current state and one-click updates there.

Packaging (optional, needs `npm i -D electron-builder`):

```bash
npm run app:pack     # unpacked app in release/
npm run app:dist     # installer (.dmg / AppImage)
```

Neither `.env` nor `config/config.yaml` is bundled — both are read from the
working directory, so handing someone the app never hands them your
credentials.

## Setup

```bash
npm install
cp .env.example .env                              # Jira + GitLab credentials
cp config/config.example.yaml config/config.yaml  # your JQL and workflow status names
npm run build
npm run ui              # interactive mode — open http://localhost:4321
# or: npm run dev        # headless/automatic mode
```

Neither `.env` nor `config/config.yaml` is in the repo. The first holds
credentials; the second holds your JQL, project keys and workflow status
names, plus `jira.applyChanges` — the switch that decides whether this
writes to real issues. Both ship as `.example` files with writes turned
**off**, so a fresh clone can't touch anyone's Jira until you say so.

`.env` holds secrets (Jira/GitLab credentials; Slack only if you switch
`wiring.approval` to `slackReaction`). `config/config.yaml` holds pipeline
wiring, JQL, poll intervals, and the review language — no secrets.
`UI_PORT` env var overrides the web UI's port (default `4321`).

### Backup

The `⤓` button in the top bar exports everything this tool has produced —
reviews, history, answers, objections, notes, queue state — as one JSON
file, and imports it back. Credentials are never included.

Import replaces the local data outright. It refuses while a review is
running, and it copies the current files to `*.before-import-<timestamp>`
first, so importing the wrong file is recoverable. `config.yaml` travels in
the bundle but is never written by an import — the switch that decides
whether this writes to Jira should not change behind a file picker.

The export contains verbatim Jira text and diffs. Treat the file the way
you would treat the issues themselves.

### The review standard

What the reviewer is asked to do lives in
`src/adapters/tasks/prompts/codeReview.md` (the task) and
`codeReviewTask.ts` (the role). It defines:

- **Dimensions** to work through: correctness, edge cases, error handling,
  security, data & backward compatibility, performance, observability,
  tests. Style/formatting/naming is explicitly out of scope.
- **Three severities** — `blocking` / `major` / `minor` — and an
  instruction not to invent others (left to itself, the model makes some up).
- **Evidence per finding**: a `file:line`, a before → after quote from the
  diff, and the concrete condition that triggers the problem.
- **A verdict line**: `Verdict: Approve` or `Verdict: Request changes — …`.
  Only blocking findings block.

### Project notes (the learning curve)

Standing decisions like *"don't flag missing tests in this project"* are
kept in `data/reviewNotes.json` and managed from the UI. A note is either
**global** (every review) or **repo-scoped** (one GitLab project), so a
convention that's deliberate in one codebase doesn't leak into another.

Notes are never applied silently: the prompt requires the review to end
with an **"Uygulanan notlar" / "Applied notes"** section listing each note
it applied and what it did *not* report because of it. A note that would
suppress something genuinely dangerous (data loss, a security hole) is
overridden — the reviewer reports it anyway and says it overlaps a note.

### What the reviewer can and cannot do

When a repo checkout is available, the `claude` CLI is invoked with
`--tools "Read,Glob,Grep"` (the flag that actually restricts the tool set)
plus `--strict-mcp-config`. Without both, the reviewer would keep
`Bash`/`Write`/`Edit`/`Agent` *and* whatever MCP servers you have connected
— `--allowed-tools` alone only pre-approves tools, it does not remove them.
Each run also passes `--no-session-persistence` so a review is a standalone
answer rather than an addendum to a previous one.

### Reading what the model was told

Every run writes the exact text it sent — the system prompt and the user turn
— to `<data>/prompts/`, and the **Adımlar** tab shows one collapsed card per
run (the review's, and one per repository the fix touched). A review is an
argument, and a strange one is only judgeable against what the model was
actually given: which note was in force, whether the diff arrived whole,
whether a finding's instruction really went in.

It lives beside `reviews.json` rather than inside it because a prompt carries
the whole diff again plus the issue and its comments; folding it into the
record would roughly double a file that is rewritten in full every time a
queue position moves. `/api/reviews/:key/detail` therefore lists only the kinds
and sizes — the text has its own endpoint and is fetched when a card is
opened. Clearing a task deletes its prompts with it.

### Fixing what the review found

The review says what is wrong; **Düzelt…** turns the findings you pick into
a patch. It is a separate run with a separate prompt
(`src/adapters/tasks/prompts/codeFix.md`), and it deliberately stops at a
patch:

1. Pick the findings — blocking and major are checked by default, minors are
   listed but off. A patch nobody asked for is noise in someone's working
   copy. A finding you have **disputed** (Doğrulama → itiraz) is also off, and
   shown with your objection: an objection only takes effect on the next
   review, and until then writing code to satisfy a finding you called wrong
   would be the tool arguing with you. Naming it explicitly still fixes it —
   the default is a default, not a veto. A pending "Review'i düzelt" request
   is flagged the same way; neither is sent to the fixer, because both argue
   with the review's wording rather than with the code.
2. Say how, where it matters. Each finding gets an optional **"nasıl
   düzeltilsin?"** box. The reviewer is told to give options rather than
   invent an answer when the right fix turns on something it cannot see
   ("kuyruk sırası garanti ediliyorsa X; edilmiyorsa Y") — that leaves a
   decision outstanding, and this box is the only channel that reaches the
   patch. It goes into the prompt directly under the finding it settles, as a
   decision the fixer may not weigh against its own reading. An objection
   prefills it, because people write "1. seçenek yapılmalı" in that box and
   losing it is how a human's call silently fails to reach the code.
3. Every repository the change touches gets a **throwaway clone** of the
   reviewed checkout (`src/core/fixWorkspace.ts`), committed as a baseline so
   the diff afterwards means *the fix* and nothing else. For a directory
   review the uncommitted work travels into the clone too — that half is what
   was reviewed.
4. **One run, with all of those workspaces open**, using
   `--tools "Read,Glob,Grep,Edit,Write"` — no `Bash`, no `WebFetch`, and
   nothing mounted that is not a throwaway workspace, so a stray edit cannot
   land in the repo cache and poison later reviews.

   **Commit and push are impossible, not discouraged.** The tool set contains
   nothing that runs a command, so there is no `git` to invoke — and
   `assertCannotExecute` refuses to launch the CLI at all if one is ever
   added to the list, rather than quietly handing a model a shell in
   somebody's checkout. Two further checks stand behind it: `extractFixPatch`
   fails loudly if HEAD has moved off the baseline commit (a commit would
   move the change out of the working tree and the run would report
   "nothing changed" for work that changed a dozen files), and `applyFixPatch`
   refuses any patch whose paths are absolute, climb out of the repository,
   or reach into `.git`. One run rather than one
   per repository because a finding can span services: a route on one side
   and the call to it on the other cannot be written by two agents that
   cannot see each other's work. It also removes the need to guess which
   repository a finding belongs to — the fixer has them all and reads the
   paths itself.

   Only repositories the change already touches are opened. A service it
   never touched sits on its default branch, so a patch made there would be
   against `master` while the change lives on a feature branch — and adding
   code to a service nobody touched is a scope decision for a human, not
   something to infer.
   Its prompt carries the selected findings, that repo's diff, **the ask as
   the review read it** (description + comments, see below), the team's
   answers to any `[?]` questions, and the project notes — framed as binding
   on the code it writes, not merely on what gets reported. It is told the
   other services are *not* readable, so a cross-service fix is skipped
   rather than guessed at.
5. `git diff` becomes the patch, the workspace is deleted, and the patch
   waits on the **Yama** tab with the fixer's line-per-finding report of
   what it changed and what it refused to guess at.
6. **Uygula** applies it with `git apply --3way` to a directory *you* name —
   your own working copy, never the repo cache — and leaves it
   **uncommitted**. The path is remembered per project for next time.

The fix never runs in the repo cache: every review hard-resets the repos it
touches, so an edit left there is destroyed by the next run. It never writes
to your working copy on its own either — applying is always a separate
click. Re-reviewing an issue drops its patch, since a patch built from
findings that no longer exist would undo work that was just done.

Requires the `claudeCli` provider (`config.yaml` → `wiring.llm`): the
Anthropic API provider has no file tools, and the button says so rather than
running for minutes and producing an empty patch.

**The ask travels with the review, and is not re-read.** `core/requirement.ts`
stores the issue's description and comments on the review record as the
reviewer read them, and the fix prompt uses that copy. A fix exists to make a
*finding* true, and the finding came out of one particular reading of the
requirement; handing the fixer newer prose introduces a second interpretation,
where the finding argues one thing and the fixer reads another. If the ticket
has genuinely moved, the answer is to review it again — which replaces the
findings and the stored text together, and drops the patch. Two side effects
worth having: the fix path makes no Jira call (so it cannot half-fail on an
expired token), and the comment formatting rules — the 1500-character cap and
the deliberate absence of author names — live in one place instead of once per
prompt.

Because the fixer sees the whole ticket text, the prompt fences it: *"this is
background for the findings, not a list of work — implement nothing from it
that no selected finding names."* Without that line, adding this context would
buy scope creep instead of correctness.

### How long a run may take

Two timers, not one (`config.yaml` → `review`):

- **`idleTimeoutMs`** (default 10 min) — no output at all for this long and
  the process is treated as wedged and killed.
- **`runTimeoutMs`** (default 45 min) — an absolute ceiling behind it.

"Stuck" and "slow" are different things, and a single cap on total duration
gets both wrong. A fix that reads across three repositories and writes both
halves of a cross-service change is legitimately long; killing it at ten
minutes throws away the work *and* the subscription usage it cost. Meanwhile a
genuinely wedged process — one that hangs at minute two — is not detected any
sooner for having a short cap, it just sits there until the cap expires.

What separates them is silence: the CLI narrates every tool call on stdout, so
a run that is working says so continuously. The idle timer is reset by any
byte of output, stderr included. The absolute ceiling stays because silence
cannot catch the other failure — a model looping over tool calls forever,
chattering the whole way. A run can always be stopped by hand from the UI, so
raise `runTimeoutMs` freely for a large monorepo.

### Review language

`config/config.yaml` → `review.language` sets the language the AI writes
the review in (a plain language name — `Turkish`, `English`, `German`, …).
Code identifiers, file paths, and quoted diff snippets always stay in their
original form. The instruction is applied both in the system prompt and as
the last line of the user prompt — the template itself is English, and in
practice the model follows the trailing user-turn instruction most reliably.

`ANTHROPIC_API_KEY` is optional: if unset, `@anthropic-ai/sdk` falls back to
an existing `ant auth login` / Claude Code session on this machine.

### Branch ↔ Jira issue mapping

`JiraIssueContext` reads the issue's "Development" panel (Jira's dev-status
API) for a linked GitLab branch — this requires Jira's GitLab integration to
already be picking up your branches (e.g. because the branch name contains
the issue key). `GitlabBranchDiffContext` then resolves the branch's
repository from that link (no static GitLab project config needed), looks
up the repo's default branch, and diffs `defaultBranch...featureBranch` via
GitLab's compare API.

## Testing

```bash
npm test
```

Unit tests cover the pure/testable parts: Jira search-URL building, GitLab
project-path parsing, the code-review prompt builder, and the state store's
dedup/pending-approval logic. HTTP calls (Jira, GitLab, Anthropic) and the
web server routes are not covered by these tests — they'd need mocking or
an HTTP-level test harness, which the MVP intentionally skips in favor of
manually exercising the UI (below).

## Using the UI

1. `npm run ui`, open `http://localhost:4321`.
2. Click **↻ Listeyi yenile** — this runs `trigger.poll()` (read-only JQL
   search) and lists matching issues with their current review state.
3. Click **İncele** on one — this starts `runOne()` for that issue. The
   step panel streams live: context collectors running, branch found (or
   not), diff size, AI review generated, "awaiting your approval".
4. Once the review appears, read it and click **✅ Onayla** or **❌ Reddet**.
   Approving calls `resolveApprovals()`, which runs the `Action` (currently
   dry-run logged, see `src/adapters/actions/jiraCommentAction.ts` to make
   it real) and flips the state to `posted`.

Re-running is always available — the button reads **İncele**, **Yeniden
incele**, or **Yeniden başlat** depending on the current state, and works
even on a record stuck in `running` because the server was restarted
mid-review. The previous review moves into **Önceki incelemeler** rather
than being lost, so you can compare runs (e.g. after adding a note).
