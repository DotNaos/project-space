# Product Brain Dump

## Product Thesis

`project-space` is a desktop application for running one software project as an operational workspace.

The product is not a code editor, not a terminal wrapper, and not a file explorer. It is the desktop layer above those tools. It gives structure to project execution and launches external tools from the right workflow context.

## The Core Problem

A real project is bigger than a repository tree.

People work across:

- iterations
- features
- tasks
- worktrees
- issue documents
- local runtimes
- integration back into a shared branch

Current tools split this across many surfaces:

- file explorer in the IDE
- git branches and worktrees
- terminal tabs
- markdown notes
- local dev servers
- manual copy or patch transfer between branches

`project-space` should unify that into one project-centered desktop.

## What The Product Is

- one project per screen
- workflow-first navigation
- task and worktree centered
- local-first
- desktop-first
- orchestration layer for external tools

## What The Product Is Not

- not a replacement IDE
- not a file browser
- not a cloud project manager
- not an AI-first product
- not a generic launcher dashboard

## Core Hierarchy

- Project
- Sprint
- Feature
- Task
- Worktree
- Issue documents

This hierarchy is the primary navigation model.

## Core Interaction Model

The user lands in a single project desktop.

From there the user can:

1. move through the workflow tree
2. select a task
3. see the active worktree context for that task
4. open the external tools needed for execution
5. track progress in issue markdown attached to the worktree
6. later integrate or transfer changes back into the iteration branch

## External Tools

The app will launch, but not replace:

- IDE
- Terminal
- Git tooling
- Dev server

The app should know why a tool is opened and from which worktree context it is opened.

## Worktree Model

The naming convention stays explicit:

- iteration branch: `iteration/{N}`
- feature branch or worktree branch: `iteration/{N}/{feature-name}`

The worktree is not just a branch checkout. It is the execution context for a task.

## Issue Documents

Each worktree can own markdown issue documents.

Those documents are intended to hold:

- task framing
- acceptance checklist
- implementation notes
- open follow-ups
- integration notes

The MVP does not need editing or persistence yet, but the model should assume that issue docs are first-class project artifacts.

## Future Product Capabilities

These belong to the product direction, but not the first MVP implementation:

- automatic worktree discovery
- markdown loading and saving
- local runtime sessions
- transfer of edits between worktrees via selected hunks
- conflict preflight validation
- local integration request flow into the iteration branch

## MVP Cut

The MVP should be much smaller than the broader vision.

The current MVP target is:

- exactly one local project screen
- no fake second project
- no fake multi-project switcher
- a workflow explorer on the left
- a main panel for the selected workflow node
- visible worktree context
- visible issue document placeholder
- visible quick actions for external tools
- placeholder launch behavior only

## MVP UI Principles

- reduce surface area
- avoid placeholder panels that do not help the core concept
- keep the workflow tree visible at all times
- keep the selected task and worktree context obvious
- prefer one strong layout over many secondary cards

## MVP Non-Goals

- no real git integration
- no real worktree creation
- no runtime orchestration
- no patch parsing
- no integration flow implementation
- no database
- no auth
- no AI features
