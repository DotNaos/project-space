# Issue #437 product UI roadmap

This document is the working contract for the current prototype iteration. Work through it from top to bottom and keep the checkboxes truthful.

## Product model

Project Space is the workflow and attention layer for building software. GitHub issues, branches, worktrees, pull requests, previews, and deployments remain visible where they provide control or explain a blocker, but they are not separate starting points for ordinary work.

```text
Project Space
├── Global
│   ├── Projects
│   ├── Machines
│   ├── Templates
│   │   └── Project Template
│   │       ├── Modules
│   │       ├── Libraries
│   │       ├── Configuration
│   │       └── Required pipelines
│   ├── Profile
│   └── Settings
│
└── Selected project
    ├── New task
    ├── Chat
    │   ├── Machine selector
    │   ├── Project manager thread in the main worktree
    │   └── Running work grouped by machine
    │       ├── Tasks
    │       ├── Agent runs
    │       └── Linked issues
    ├── Tasks
    │   ├── Task overview
    │   ├── Repository history
    │   └── Task detail
    │       ├── Issue and discussion
    │       ├── Branch and history
    │       ├── Agent runs
    │       ├── Pull request and review
    │       ├── Checks and Preview
    │       ├── Merge
    │       └── Deployment
    └── Repository
        ├── Branches
        │   └── Selected branch
        │       ├── History
        │       ├── Changes
        │       ├── Pull request
        │       └── Worktrees grouped by machine
        └── Template check
            ├── Modules
            ├── Libraries
            ├── Configuration
            └── Pipelines
```

### Naming contract

- **Task** is the project-level unit of intent: a feature, bug, idea, or other requested outcome.
- **Agent run** is one concrete Codex execution attached to a Task. It must not be called a Codex task in this UI.
- **Chat** is the persistent project-manager conversation in the selected machine's main worktree. It is not tied to one Task.
- **Repository** is the technical control surface across all Tasks and branches.
- **Workspace** or **worktree** is a machine-specific checkout of one branch and belongs in branch detail.
- **Template** is the global desired project contract. **Template check** validates a project's selected branch against that contract.

### Visibility rules

- Start normal work from **New task**, **Chat**, or **Tasks**.
- Show technical objects inside the Task lifecycle when they need a decision, explain a blocker, or are explicitly opened.
- Keep repository-wide history and branch control available through **Repository**.
- Never claim a lifecycle stage is ready, merged, deployed, or valid without matching evidence in the eventual real implementation.
- During this prototype phase, every state is explicitly labelled and backed by deterministic mock data; no mock action may imply that GitHub, a machine, CI, or production was actually changed.

## 1. Independent issue-board scrolling

- [x] Keep the Issues header and filters fixed inside the page.
- [x] Make every board column its own vertical scroll area.
- [x] Keep horizontal board scrolling separate from column scrolling.
- [x] Verify that scrolling one column does not move the page or the other columns.

Evidence: implemented and verified in commit `ff4598c`.

## 2. Merge Branches, Workspaces, and History

- [x] Inspect the current deployed Project Space branch, workspace, and history flows before redesigning them.
- [x] Remove Workspaces and History as separate top-level sidebar destinations.
- [x] Make Branches the single entry point for repository work.
- [x] Put branch history and the Git graph into the selected branch view.
- [x] Treat a workspace as a machine-specific checkout of the selected branch, not as a separate product area.
- [x] Group a selected branch's workspaces by machine.
- [x] Let each machine clone or check out the branch and expose its Git status, files, changes, and runtime state.

Evidence: the deployed product's 135-row Workspaces table and 63-branch History view were inspected first. The prototype now enters through Branches, opens an integrated commit history, groups checkouts under Local, os-pc, and os-yoga-unix, and continues into Files, Changes, and Runtime. A missing checkout can be created in place.

## 3. Stress-test the branch browser with realistic data

- [x] Load 20–30 representative current `DotNaos/project-space` branch names from GitHub as prototype fixtures.
- [x] Keep the branch list compact and usable with that realistic volume.
- [x] Add branch search and filters.
- [x] Show whether each branch has a pull request.
- [x] Show whether and where each branch is checked out on a machine.
- [x] Let the user open a branch and continue into its combined history/workspace detail view.
- [x] Verify the complete flow at desktop and phone widths in the live Portless prototype.

Evidence: 30 current branch names and their head revisions were loaded from GitHub; displayed PR numbers were checked against GitHub. Browser verification covered the compact desktop and phone lists, filters and metadata, the combined branch view, all three workspace tabs, independent scrolling, and creating a checkout on a previously unused machine.

## 4. Compact branch workspace list

- [x] Render every branch and every machine as one compact row.
- [x] Keep pull-request, checkout, workspace status, and open actions directly reachable without explanatory sub-rows.
- [x] Keep Compare and Refresh as full-width mobile actions.

Evidence: the phone branch browser now fits substantially more of the 30-branch fixture into one viewport while retaining PR and checkout state. Machine workspaces use one-line rows with icon actions. Branch and workspace navigation were exercised in the live prototype.

## 5. Simplify pull-request markers

- [x] Show only the pull-request number in merged PR markers.
- [x] Use a distinct purple merged icon instead of the open pull-request icon.
- [x] Verify the compact branch/workspace rows and PR markers at phone and desktop widths.

Evidence: the live issue board exposes merged links as `#427`, `#435`, `#425`, and `#404`; the rendered marker uses the violet tone and Git-merge icon. Phone and desktop screenshots were inspected after hot reload.

## 6. Establish the new navigation model

- [x] Replace issue-first product wording with Task wording in the primary prototype navigation.
- [x] Keep New task as the primary creation action.
- [x] Keep Chat as a first-class project destination.
- [ ] Model Chat as a persistent project-manager thread in a selected machine's main worktree.
- [ ] Show active Tasks, Agent runs, and linked issues grouped by machine inside Chat.
- [x] Add Repository as the project-wide technical control surface.
- [x] Keep branches, history, changes, pull requests, and machine worktrees inside Repository rather than as separate root destinations.
- [x] Add Templates to the global navigation and open the single Project Template directly.
- [x] Show modules, libraries, configuration, and required pipelines in the Project Template.
- [x] Add a project-level Template check under Repository for the selected branch.
- [x] Verify the navigation and hierarchy at desktop and phone widths.

Evidence: the sidebar now exposes only New task, Chat, Tasks, and Repository in the selected project, with Machines and Templates in a separate Global group. Overview and Deployments are no longer root destinations. Expanded mobile, expanded desktop, collapsed desktop, Templates navigation, and Repository navigation were exercised in the live Portless prototype. The global Project Template now defines 16 requirements across Modules, Libraries, Configuration, and Required pipelines. Repository validates that same contract against a selected branch: `main` reports 16 of 16 valid, while the mocked issue #437 branch reports 15 of 16 and isolates Signed release as the required attention. Both Template surfaces were visually verified at desktop and phone widths with no browser errors.

## 7. Build the complete mocked Task lifecycle

The next focused milestone is UI-only. It must be possible to dogfood the entire flow without GitHub, Codex, machine, CI, Preview, or deployment infrastructure. Mock state must survive navigation during the browser session.

### Task overview

- [x] Provide a compact Task list with meaningful lifecycle status instead of exposing raw issue state as the primary status.
- [x] Support useful grouping or filtering for Needs you, Active, and Done.
- [x] Keep repository history available as a separate tab within Tasks.
- [x] Let every Task open its complete lifecycle detail.

### Create a Task

- [x] Start from New task with a calm idea composer.
- [x] Allow a title, description, type, and optional labels to be entered with mocked data.
- [x] Show a clear review step before the mock Task is created.
- [x] Add the new Task to the overview and open its detail after creation.

### Task detail and discussion

- [x] Show the Task description as the primary content.
- [x] Include a comment timeline and a compact Markdown comment composer.
- [x] Keep Task metadata secondary and avoid repeating labels already expressed by the lifecycle.
- [x] Provide a direct GitHub issue link as mocked external context.

### Development lifecycle

- [x] Show the assigned branch and its current relationship to main.
- [x] Show Agent runs attached to the Task without calling them Tasks.
- [x] Allow the prototype to advance through explicit mocked stages: issue created, branch ready, development running, pull request open, checks running, Preview ready, review approved, merged, deploying, deployed.
- [x] Make the next meaningful action obvious and keep unavailable later actions gated.
- [x] Show a concise event timeline so the user can understand how the Task reached its current state.

### Pull request, Preview, and delivery

- [x] Show pull-request identity, current revision, review state, and checks when the mock pull request exists.
- [x] Let the user open a realistic mock Preview from the Task.
- [x] Let the user approve the exact mocked revision and visibly invalidate approval when the mocked revision changes.
- [x] Show merge only after the mocked required checks and review are complete.
- [x] Show deployment progress after merge and a final deployed state with mocked evidence.

### Dogfood matrix

- [x] Complete the happy path from New task through deployed.
- [x] Exercise a Task that needs user input.
- [x] Exercise a failed check and recovery.
- [x] Exercise a changed revision after approval.
- [x] Exercise a Preview that is unavailable and later becomes ready.
- [x] Navigate away and back without losing the in-session mock state.
- [x] Repeat the primary flow at desktop and phone widths through the live Portless prototype.

Evidence: created mocked Task #438 from the phone composer, reviewed it, advanced it through branch, local Agent run, pull request #439, checks, Preview, exact-revision approval, merge, deployment, and verified live state. A simulated revision change cleared the previous approval before the flow was completed again. Comment state survived navigation. Tasks #398 and #395 exercised failed-check and unavailable-Preview recovery. The overview, history, detail, and Preview were inspected at phone and desktop widths with no browser errors. Focused tests pass (24 tests), the broader prototype suite passes (117 tests), and the TypeScript project check passes.

## Later milestones

- [ ] Build the persistent project Chat experience with machine selection and coordination views.
- [x] Build the Repository control surface across branches and machine worktrees.
- [x] Build the global Project Template and project-level Template check.
- [ ] Replace mock transitions with real APIs only after the Task workflow has been dogfooded and accepted.

## Completion rule for the next milestone

The mocked Task milestone is complete only when every item in section 7 is checked, the focused prototype tests and TypeScript check pass, the live prototype has been visually dogfooded at desktop and phone widths, and the complete Task lifecycle can be used without touching real external systems.
