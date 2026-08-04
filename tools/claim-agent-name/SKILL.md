---
name: claim-agent-name
description: Claim or preserve a clean, unique Codex agent display name through the installed Project CLI, hide machine-generated fallback codes, avoid names already used in visible Codex task titles, and immediately rename the current task. Use as the first workflow of every Codex task and whenever a task title must be rebuilt without changing its agent identity.
---

# Claim Agent Name

Complete this workflow before planning, repository inspection, implementation, or any other substantive action.

1. Use the Codex task-listing tool to list up to 50 visible tasks across available hosts.
2. Identify the current task by thread ID. Extract its current display name and the agent names from every other formatted title:
   - `#<issue-number>[/<task-number>] · <name> · ...`
   - `<name> · ...`
3. Accept only names matching `[A-Za-z][A-Za-z0-9-]*`. Ignore unstructured titles and deduplicate case-insensitively.
4. Run the bundled selector even if the current title already has a name. The selector owns the local lock while it invokes the installed CLI, so live local leases are excluded before the online claim is mutated and the machine-generated fallback code is never printed:

   `python3 <skill-dir>/scripts/select_display_name.py --project-cli project --thread-id <thread-id> --current-name <current-name> --used-name <other-name> ...`

   Pass each other visible name separately to `--used-name`. Pass the current display name only to `--current-name`. Never pass full task titles or include the current task's name among exclusions. The selector passes visible names and every other unexpired local lease to the CLI as exclusions under the same lock.
5. If task listing is unavailable, continue with the names already collected or no exclusions. Do not block name allocation.
6. Parse the selector's stdout as one JSON object. Require:
   - a non-empty `name` matching `[A-Za-z][A-Za-z0-9-]*`
   - `source` equal to `project-space` or `fallback`
   - a string `warning`
7. Trust the bundled selector to preserve or allocate the clean display name:
   - It removes a trailing machine code such as `-E34FY8`.
   - It preserves the current thread's clean name across restarts.
   - It holds a local file lock, checks other visible names and durable local reservations, and deterministically walks the complete clean-name pool until it finds a free name.
   - It reconciles before the Project Space claim, so an online allocation cannot silently steal an unexpired local reservation.
   - It reports clearly when no clean name remains. Never add a random code or numeric collision suffix.
8. When `source` is `fallback`, tell the user this warning verbatim once, then continue:

   `Project Space is not reachable. Wir haben jetzt einfach einen zufälligen Namen generiert, den du jetzt verwendest.`
9. If the command fails specifically with `no clean agent name remains available`, leave the task title unchanged, briefly report the exhausted pool, and continue the user's actual task. Name allocation must never block otherwise authorized work.
10. For any other command failure, malformed JSON, or invalid name, stop and report the Project CLI contract failure. Never invent a replacement name.
11. Immediately rename the current task with the Codex task-title tool:
   - Without an issue: `<name> · <short objective>`
   - With one visible task for the issue: `#<issue-number> · <name> · <short purpose>`
   - With multiple tasks for the issue: `#<issue-number>/<task-number> · <name> · <short purpose>`
   - Add the project name at the end only when needed to disambiguate projects.
12. Number issue tasks only when multiple tasks share that issue:
   - When a second task appears, rename the original to `/1` and use `/2` for the new task.
   - Preserve existing task numbers and assign later tasks the next unused positive number.
   - Never reuse a known task number after a task finishes.
13. Keep the same display name and issue-task number for the rest of the task. Later issue, objective, or project-title changes must preserve them unless the primary issue itself changes.

Do not call `project chat claim`; that command owns Project Chat role identities, not automatic task startup.
