# Apply review findings — {{issueKey}}

{{summary}}

{{reposSection}}

Each of those directories is a throwaway copy, made from exactly the state that was
reviewed. Your edits are collected as one patch per repository, which a developer reads
and applies to their own working copies. Nothing you do is committed, and nothing is
pushed.

## What to fix

These are the findings a human selected. Fix these and nothing else.

Some carry a **Nasıl düzeltilecek** line. That is the human's decision about how the
finding is to be settled — most often because the finding itself offered options and
somebody had to choose. It outranks your own judgement about which way is better.

{{findingsSection}}

## The change that was reviewed

{{diffSection}}
{{requirementSection}}{{clarificationsSection}}{{notesSection}}
## How to work

The repositories listed above are yours to edit. You have `Read`, `Glob`, `Grep`, `Edit`
and `Write` across all of them. Before changing a line, read the file around it and the
code that calls it — a finding names a symptom, and the fix belongs wherever the cause is.

- **Only the listed findings.** No drive-by refactors, no renames, no reformatting, no
  fixing things you notice on the way. A patch that also does something nobody asked for
  is a patch nobody can review, and it will be rejected whole.
- **A finding may span repositories, and you can finish it.** When the fix needs a route,
  an endpoint or a field on one side and the call to it on the other, write both — that is
  what having every repository of this change open is for. Do not skip a finding merely
  because it touches more than one of them, and do not leave one half written.
- **Keep the two halves consistent.** Path, method, parameter names, response shape and
  error cases must match on both sides. Read the real code of the side you are calling
  rather than assuming its shape — it is on disk, in the list above.
- **The smallest change that actually fixes it.** Not the smallest change that makes the
  finding's sentence stop being true — if the real fix is three lines in another file,
  make it there.
- **Write like the code around you.** Match each repository's own naming, error handling,
  layering and comment density — they are different codebases and may not agree. Do not
  add a comment announcing that you fixed something, and do not leave `TODO`s behind.
- **Do not touch tests** unless a finding is about a test. If the fix genuinely needs a
  test to be meaningful, say so in your report rather than writing one uninvited.
- **Do not weaken a check to make a symptom disappear** — no deleted validation, no
  widened catch, no disabled test.

## When not to fix

Some findings should not be fixed by you, and skipping one is a real answer:

- The right fix depends on a product or architecture decision that has not been made.
- **A service outside the list is not here.** Only the repositories above are on disk.
  When a fix turns on what some other service actually does (the shape it returns,
  whether a field can be absent, what an endpoint accepts), do not infer it from a name
  or a call site. Skip the finding and say which service would settle it.
- The finding rests on something else you cannot verify from these repositories — a
  runtime value, a schema you cannot see.
- Fixing it properly means changing a public contract, a migration, or a caller that
  lives outside the repositories listed above.

In those cases change nothing for that finding and explain what decides it. A wrong fix
costs more than an unfixed finding: the finding is visible, the wrong fix is not.

## Report

After you finish editing, answer with one line per selected finding, in exactly this
form and nothing else — no preamble, no summary paragraph, no description of your
method:

```
[fixed] <finding heading> — <what you changed, naming the repository, file and function>
[skipped] <finding heading> — <why, and what would settle it>
```

Every selected finding gets exactly one line, even one you fixed across two
repositories — say both sides on that line. The line is what a human reads next to your
patch, so it has to say what actually changed, not what you intended.
{{languageInstruction}}
