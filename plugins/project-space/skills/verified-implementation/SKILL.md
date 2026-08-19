---
name: verified-implementation
description: Use whenever changing code to implement a feature, fix a bug, preserve behavior during a refactor, or otherwise claim a requested software change is complete. Requires an executable baseline, failing regression or specification tests where feasible, test-driven implementation, realistic runtime verification, meaningful edge-case checks, and evidence that the requested end state actually works before stopping.
---

# Verified Implementation

## Objective

Implementation is not completion. Verified behavior is completion.

Optimize for reaching and proving the requested end state, not for finishing the response as early as possible.

A task is complete only when the requested behavior has been implemented and there is concrete evidence that it works at the relevant layers.

## Completion contract

Every implementation task ends in exactly one of these states:

- `DONE`: the requested end state is implemented and verified.
- `BLOCKED`: completion is impossible because of a concrete external blocker that the agent cannot remove.

Do not stop at an intermediate milestone simply because:

- code has been written;
- the project compiles;
- one focused test passes;
- a plausible implementation exists;
- a first verification attempt failed;
- more commands, investigation, or debugging are still required.

Do not ask for permission to continue between normal implementation steps. Continue until `DONE` or genuinely `BLOCKED`.

## 1. Understand the requested behavior

Before changing implementation code:

- Re-read the original task, issue, or user request.
- Identify the observable end state that must exist when the work is complete.
- Locate the relevant execution path and existing tests.
- Turn vague requirements into explicit acceptance criteria.
- Identify meaningful variants, edge cases, failure paths, integrations, and neighboring behavior that could regress.

Do not begin fixing or implementing while the expected behavior is still materially unclear if the repository or available tools can resolve that uncertainty.

## 2. Establish an executable baseline

Prove the current state before implementing the change.

Choose the cheapest reliable verification layer that demonstrates the behavior:

1. existing automated test;
2. focused unit test;
3. integration test;
4. end-to-end test;
5. smoke test through the real entry point;
6. manual reproduction when automation is not practical.

For a bug, reproduce the reported failure.

For a new feature, demonstrate that the requested capability is absent by writing an executable specification or test that cannot pass before the feature exists.

For a behavior-preserving refactor, capture the current expected behavior with existing or new tests before restructuring it.

Record what proves the baseline. Do not infer the baseline only from reading code.

## 3. Prove RED where a regression/specification test is meaningful

Before changing the implementation, add or select a test that expresses the expected behavior whenever the change can reasonably be automated.

Run it and confirm that it fails for the expected reason.

A useful RED state means:

- the assertion describes externally meaningful behavior;
- the failure is caused by the missing or incorrect behavior being changed;
- the test would catch a regression later;
- the test is not coupled unnecessarily to implementation details.

If the test fails for an unrelated setup error, fix the test harness or environment first. That is not a valid RED state.

If an automated test is genuinely impractical, define the executable smoke/manual verification that will be used later and state why automation is not appropriate.

## 4. Implement through RED -> GREEN

Make the smallest correct implementation change that satisfies the specification.

Iterate as needed:

`RED -> implementation -> GREEN -> refactor`

Rules:

- Do not weaken, skip, delete, or rewrite a valid regression test merely to obtain GREEN.
- Do not change expected behavior to match an accidental implementation.
- Re-run the focused test after each relevant change.
- Keep unrelated cleanup out of the change unless it is required to reach the requested end state.
- Treat failed attempts as diagnostic information, not as a reason to stop.

## 5. Exercise the real behavior

A green focused test is necessary evidence, not sufficient evidence.

Verify the feature or fix through the highest practical layer that resembles actual use.

Examples:

- UI: run the app and exercise the relevant flow in a real browser or supported UI harness.
- API: start the relevant service and make the actual request.
- CLI: run the real command with representative input.
- Persistence: verify write, read, reload/restart behavior where relevant.
- Integration: exercise both sides of the boundary instead of testing only a mock.
- Build/configuration: run the real build, validation, migration, or configuration command affected by the change.

Prefer actual execution over code inspection whenever the behavior can be run.

## 6. Actively try to disprove the implementation

After the happy path works, ask:

> Is there any reasonable way the requested result could still be broken?

Check the meaningful cases for this change, based on risk rather than an arbitrary fixed count. Consider where relevant:

- boundary inputs;
- empty or missing state;
- repeated actions and idempotency;
- invalid input and error handling;
- loading, retry, cancellation, or partial-failure states;
- reload/restart/persistence behavior;
- alternate branches of the same user flow;
- integration boundaries;
- nearby behavior that could regress.

Do not claim exhaustive verification when exhaustive verification is impossible. Verify every case that is reasonably important for the requested behavior.

## 7. Run relevant regression checks

Run the checks that are proportionate to the affected scope, such as:

- focused tests;
- related test suites;
- integration or end-to-end tests;
- type checking;
- linting;
- build;
- package/project validation commands;
- smoke tests through the actual runtime.

A check that cannot be run must be called out explicitly. Do not silently replace an unavailable high-value verification step with a weaker one.

## 8. Audit completion against the original request

Before reporting completion, re-read the original task or issue and map each requirement to concrete evidence.

For every acceptance criterion, be able to answer:

- What changed to satisfy it?
- What command, test, or runtime interaction proves it?
- What result was observed?

If any required criterion lacks evidence, continue working.

## Anti-premature-completion rules

- Never optimize for producing a finished-looking response. Optimize for a verified result.
- Never use "the code looks correct" as evidence that behavior works.
- Never assume wiring, state propagation, persistence, routing, configuration, or integration works without exercising it when it is relevant.
- Do not stop because the remaining work is inconvenient, repetitive, or requires debugging the test setup.
- Do not hand routine next steps back to the user when the agent has the tools and authority to perform them.
- Do not declare success while known relevant failures remain unexplained.
- Do not invent test results, runtime behavior, command output, or coverage.

## When `BLOCKED` is valid

Use `BLOCKED` only for a concrete external condition that prevents completion, for example:

- required credentials or permissions are unavailable;
- an external service is unavailable and no local substitute can verify the behavior;
- required hardware is inaccessible;
- a genuinely required product decision or input cannot be derived from the task, repository, or existing conventions.

Before using `BLOCKED`:

- attempt all reasonable work that does not depend on the blocker;
- identify the exact blocker;
- provide the command, error, or other evidence that demonstrates it;
- state precisely what remains unverified or unfinished because of it.

Agent fatigue, elapsed effort, response length, or reaching an intermediate milestone are never blockers.

## Final report

Keep the final report concise and evidence-based. Include:

- the implemented behavior or root cause addressed;
- the important change made;
- the regression/specification test and its RED -> GREEN result when applicable;
- the realistic runtime or integration verification performed;
- the meaningful edge/regression cases checked;
- any verification that could not be performed;
- final status: `DONE` or `BLOCKED`.
