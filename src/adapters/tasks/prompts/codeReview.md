## Jira Issue: {{issueKey}} — {{summary}}

{{description}}
{{relatedSection}}{{commentsSection}}
{{codeChangeSection}}{{repoInstruction}}
## First: does this change actually do the job?

Before looking for defects, judge the change against the issue. A change
can be flawless code and still be the wrong change. Answer these first —
they are the most valuable part of the review:

- **Requirement coverage** — read the issue title and description as a
  specification. List what it asks for, and check each item against the
  diff. Is anything asked for simply not implemented? Say which part.
- **Right fix, right place** — does the change address the actual cause
  the issue describes, or does it patch a symptom while the real path is
  untouched? If the issue's problem could still occur through another code
  path the diff doesn't touch, that is a finding.
- **Business/flow logic** — walk the end-to-end flow this code sits in,
  not just the changed lines: what calls it, what it returns, what happens
  downstream, and what the user or caller ends up experiencing. Does the
  new behavior make sense in that flow? Are the conditions, ordering, and
  state transitions right for the business rule the issue describes?
- **Scope** — does the change do something the issue did not ask for, or
  quietly alter behavior beyond its stated purpose? Both directions matter:
  missing scope and extra scope.

When you cannot tell whether the issue's intent is met (e.g. the acceptance
criteria are ambiguous, or the deciding logic lives outside the diff), say
so explicitly and state what would settle it. That is more useful than
assuming it is fine.

## Then: how is it built?

Work through these dimensions and report only what actually applies — an
empty dimension needs no mention:

- **Correctness** — logic errors, off-by-one, wrong operator/comparison,
  unhandled null/empty/missing keys, type coercion surprises, incorrect
  control flow.
- **Edge cases** — the inputs nobody tested: empty collections, no match
  found, duplicates, zero/negative numbers, very large values, unicode,
  concurrent or repeated execution.
- **Error handling** — failures that are swallowed, caught too broadly, or
  surfaced to users as a crash. Anything that fails silently.
- **Security** — injection, unescaped output, authz/authn gaps, secrets in
  code or logs, unsafe deserialization, user input reaching a dangerous sink.
- **Data & backward compatibility** — API/response shape changes that break
  existing clients, schema or migration risk, changes that require data
  prepared in advance to be deployed safely.
- **Performance** — queries inside loops, N+1, unbounded result sets,
  needless repeated work on a hot path. Only when the impact is real.
- **Observability** — a failure path that leaves no log/metric to diagnose it.
- **Tests** — behavior changed with no accompanying test, or a test that
  can't fail.

Explicitly out of scope: formatting, naming preferences, import order, and
other style opinions. Do not report them.

{{contextReposSection}}{{clarificationsSection}}{{challengesSection}}{{revisionSection}}{{notesSection}}
## How to report each finding

Give every finding a severity, and use exactly these three levels — do not
invent your own:

- **blocking** — will cause incorrect behavior, data loss, a crash, a
  security hole, or a broken deploy — **or leaves the issue unsolved**:
  a requirement in the issue is not implemented, or the change fixes a
  symptom while the described problem can still occur. Must be fixed
  before merge.
- **major** — a real defect or risk that should be fixed, but the change
  could ship without it becoming an incident.
- **minor** — worth improving; safe to merge without it.

Report each finding in exactly this shape, and nothing more:

```
### <severity> — <file:line>

<one sentence: what is wrong>

<diff block: only the 1–5 lines that matter>

**Etki:** <one or two sentences: what breaks, and the condition that triggers it>
```

For a requirement/flow finding with no single line, put the flow or the
file that should have changed where `file:line` goes, and skip the diff
block if there is nothing to quote.

If a finding rests on something you could not verify, add one line in
exactly this form — the marker is parsed by the UI, so keep it literal:

```
[?] <a direct question whose answer would settle it>
```

Write it as a question a teammate can answer in a sentence ("Which
endpoint does the checkout screen call?"), not as a description of your
uncertainty. One `[?]` line per open question, at most one per finding.
Do not pad the finding with caveats beyond that.

**Search before you ask.** A `[?]` is a last resort, not a first reaction.
Before writing one, make a deliberate pass over every repository mounted
in your working directory — the changed ones *and* the other services
listed below — looking for the answer:

- Grep for the identifier at the centre of the doubt across all of them:
  the endpoint path, the field name, the function, the constant, the
  response key.
- Follow the call: if you don't know what a service returns, find where it
  builds that response, not just where it is called.
- Check the obvious non-code sources too — an OpenAPI/Swagger file, a
  README, a fixture, a test asserting the shape.

Only ask when that search genuinely comes up empty — when the answer lives
in a system that isn't checked out, in someone's head, or in runtime data
(production logs, a database row, a third-party response). If the answer
*is* in the code, state it as fact and drop the question.

## Output style

The reader is a busy engineer deciding whether to merge. Keep it tight:

- **No preamble.** Do not describe your method, your tools, what you could
  or could not access, or how you approached the review. Start with the
  summary.
- **Open with 1–3 sentences** saying what the change does and whether it
  solves the issue. Nothing else before the findings.
- **Three findings at most**, ordered by severity. If you find more, report
  the three that matter and drop the rest — a fourth minor nit costs the
  reader more than it's worth.
- **No repetition.** Say something once. Do not restate a finding in the
  summary and again in the verdict.
- **No filler sections** — no "additional observations", no "other notes",
  no bullet lists of things that are fine.
- Prefer plain sentences over nested bullets. Keep code quotes to the few
  lines that carry the point.

A good review is short enough to read in under a minute.

## Verdict

End with exactly one line — no closing paragraph before or after it:

`Verdict: Approve`
`Verdict: Request changes — <one sentence naming the blocking finding(s)>`

Major and minor findings alone do not block: report them, but still
Approve. If the diff is genuinely fine, say so in one sentence and Approve
— do not manufacture findings to look thorough.

## QA notes

After the verdict, add a short section headed **"QA için"** telling the
tester what to actually exercise. This is the part a QA engineer reads
instead of the code, so write it in their language, not the code's.

- **2–5 items, each one line.** Scenario first, then what should happen:
  *"Request a quote with an unmatched provider → the fallback icon should
  show, no empty slot."*
- **Only manual/functional checks** a person can run against the app —
  screens, endpoints, data states. Do not suggest unit tests here.
- **Lead with the risky paths**: the conditions your findings identified,
  and the flows this change can break indirectly (the caller, the screen
  downstream, the other endpoint that shares this data).
- **Include what to check when things go wrong**, not just the happy path —
  the empty/missing/mismatched case is usually where the change bites.
- If a finding means something cannot be verified until a config or data
  change lands, say so here as a precondition.

If the change genuinely has nothing a tester can exercise (pure refactor
with no behavior change), write one line saying that instead of inventing
test steps.
{{notesDisclosure}}{{languageInstruction}}
