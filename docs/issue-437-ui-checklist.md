# Issue #437 UI follow-up checklist

This document is the working contract for the current prototype iteration. Work through it from top to bottom and keep the checkboxes truthful.

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

## Completion rule

The goal is complete only when every checkbox above is checked, the focused prototype tests and TypeScript check pass, the live prototype has been visually dogfooded, and the finished revision is committed and pushed.
