export interface ProjectInventoryItem {
  branch: string;
  category: string;
  dirty: boolean;
  lastCommit: string;
  name: string;
  path: string;
  relativePath: string;
  remote: string;
  scripts: string[];
  stack: string[];
  updatedAt: string | null;
}

export interface ProjectInventory {
  generatedAt: string;
  projectsRoot: string;
  projects: ProjectInventoryItem[];
}

export const PROJECT_INVENTORY: ProjectInventory = {
  "generatedAt": "2026-05-17T12:14:25.751Z",
  "projectsRoot": "/Users/oli/projects",
  "projects": [
    {
      "branch": "feature/overlay-hmr",
      "category": "Agents",
      "dirty": true,
      "lastCommit": "2026-03-12 IOS app, watchos app, and codex integration",
      "name": "agent-companion",
      "path": "/Users/oli/projects/agent-companion",
      "relativePath": "agent-companion",
      "remote": "https://github.com/DotNaos/agent-companion.git",
      "scripts": [
        "build",
        "lint",
        "lint:fix",
        "logs:clean",
        "profile:desktop",
        "dev",
        "test",
        "typecheck"
      ],
      "stack": [
        "Vite"
      ],
      "updatedAt": "2026-03-20T08:10:41.181Z"
    },
    {
      "branch": "main",
      "category": "Agents",
      "dirty": false,
      "lastCommit": "2026-03-13 Add Architecture",
      "name": "agent-harness",
      "path": "/Users/oli/projects/agent-harness",
      "relativePath": "agent-harness",
      "remote": "https://github.com/DotNaos/agent-harness.git",
      "scripts": [],
      "stack": [],
      "updatedAt": "2026-03-12T14:24:49.949Z"
    },
    {
      "branch": "main",
      "category": "Agents",
      "dirty": true,
      "lastCommit": "2026-04-19 Enforce portless for agent-hub dev",
      "name": "agent-toolkit",
      "path": "/Users/oli/projects/agent-toolkit",
      "relativePath": "agent-toolkit",
      "remote": "https://github.com/DotNaos/agent-toolkit.git",
      "scripts": [],
      "stack": [
        "Go"
      ],
      "updatedAt": "2026-05-02T20:32:52.427Z"
    },
    {
      "branch": "main",
      "category": "Agents",
      "dirty": false,
      "lastCommit": "2026-04-09 Refine whiteboard canvas and icon assets",
      "name": "agent-whiteboard",
      "path": "/Users/oli/projects/agent-whiteboard",
      "relativePath": "agent-whiteboard",
      "remote": "https://github.com/DotNaos/agent-whiteboard.git",
      "scripts": [],
      "stack": [
        "Go",
        "Native app"
      ],
      "updatedAt": "2026-04-09T09:07:41.848Z"
    },
    {
      "branch": "agents/agent-toolkit-skill-creation",
      "category": "Agents",
      "dirty": true,
      "lastCommit": "2026-04-23 feat(skills): add agent-toolkit-skill",
      "name": "agents-agent-toolkit-skill-creation",
      "path": "/Users/oli/projects/agent-toolkit.worktrees/agents-agent-toolkit-skill-creation",
      "relativePath": "agent-toolkit.worktrees/agents-agent-toolkit-skill-creation",
      "remote": "https://github.com/DotNaos/agent-toolkit.git",
      "scripts": [],
      "stack": [
        "Go"
      ],
      "updatedAt": "2026-04-23T10:10:16.180Z"
    },
    {
      "branch": "main",
      "category": "Agents",
      "dirty": true,
      "lastCommit": "2026-03-15 Clarify German TTS spelling",
      "name": "sona",
      "path": "/Users/oli/projects/sona",
      "relativePath": "sona",
      "remote": "https://github.com/DotNaos/sona.git",
      "scripts": [],
      "stack": [
        "Go"
      ],
      "updatedAt": "2026-03-16T23:42:21.999Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": true,
      "lastCommit": "2026-04-18 feat: add github dev environments skill",
      "name": "@dotnaos/project-toolkit",
      "path": "/Users/oli/projects/project-toolkit/base",
      "relativePath": "project-toolkit/base",
      "remote": "https://github.com/DotNaos/project-toolkit.git",
      "scripts": [
        "clean",
        "build",
        "typecheck",
        "dev"
      ],
      "stack": [
        "Go"
      ],
      "updatedAt": "2026-05-02T20:32:57.071Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": true,
      "lastCommit": "2026-03-15 Bootstrap repo workflow and toolkit scaffolding",
      "name": "base",
      "path": "/Users/oli/projects/pluto/base",
      "relativePath": "pluto/base",
      "remote": "https://github.com/DotNaos/pluto.git",
      "scripts": [],
      "stack": [],
      "updatedAt": "2026-03-15T11:29:43.255Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": true,
      "lastCommit": "2026-03-08 Improve browser access guidance for capture",
      "name": "figma-capture-for-chrome",
      "path": "/Users/oli/projects/figma-capture-for-chrome",
      "relativePath": "figma-capture-for-chrome",
      "remote": "https://github.com/DotNaos/figma-capture-for-chrome.git",
      "scripts": [
        "build",
        "package",
        "typecheck"
      ],
      "stack": [
        "Tailwind"
      ],
      "updatedAt": "2026-03-24T19:02:47.282Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": true,
      "lastCommit": "2026-04-09 Add local bridge server and Tailwind plugin UI",
      "name": "figma-dev-bridge",
      "path": "/Users/oli/projects/figma-dev-bridge",
      "relativePath": "figma-dev-bridge",
      "remote": "",
      "scripts": [
        "build",
        "bridge:daemon",
        "bridge:daemon:start",
        "bridge:daemon:stop",
        "bridge:daemon:status",
        "bridge:server",
        "bridge:cli",
        "lint"
      ],
      "stack": [],
      "updatedAt": "2026-04-10T09:46:06.447Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": false,
      "lastCommit": "2026-05-16 Preserve local learning notes",
      "name": "fullstack-learning",
      "path": "/Users/oli/projects/fullstack-learning",
      "relativePath": "fullstack-learning",
      "remote": "https://github.com/DotNaos/fullstack-learning.git",
      "scripts": [],
      "stack": [],
      "updatedAt": "2026-02-16T01:24:43.000Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": false,
      "lastCommit": "2026-05-16 Run template Docker checks on Ubuntu",
      "name": "fullstack-template",
      "path": "/Users/oli/projects/fullstack-template",
      "relativePath": "fullstack-template",
      "remote": "https://github.com/DotNaos/fullstack-template.git",
      "scripts": [],
      "stack": [
        "Go"
      ],
      "updatedAt": "2026-05-16T20:15:01.608Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": true,
      "lastCommit": "2026-04-04 Fix desktop release workflow",
      "name": "healinghuman",
      "path": "/Users/oli/projects/healinghuman",
      "relativePath": "healinghuman",
      "remote": "https://github.com/DotNaos/healinghuman.git",
      "scripts": [
        "build:frontend",
        "build:node",
        "frontend:dev",
        "prepare:icon",
        "prepare:electron-dev-icon",
        "postinstall",
        "typecheck",
        "test"
      ],
      "stack": [
        "React",
        "Electron",
        "Vite",
        "Tailwind"
      ],
      "updatedAt": "2026-04-06T22:28:32.697Z"
    },
    {
      "branch": "master",
      "category": "Apps",
      "dirty": true,
      "lastCommit": "2026-05-09 motan: Added a script to export motan data as a CSV file",
      "name": "klipper",
      "path": "/Users/oli/projects/pendulum-stepper-poc/vendor/klipper",
      "relativePath": "pendulum-stepper-poc/vendor/klipper",
      "remote": "https://github.com/Klipper3d/klipper.git",
      "scripts": [],
      "stack": [],
      "updatedAt": "2026-05-13T18:12:47.429Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": true,
      "lastCommit": "2026-05-02 npx kittylitter",
      "name": "litter-full",
      "path": "/Users/oli/projects/litter-poc/src-artefakte/litter-full",
      "relativePath": "litter-poc/src-artefakte/litter-full",
      "remote": "https://github.com/dnakov/litter.git",
      "scripts": [],
      "stack": [],
      "updatedAt": "2026-05-02T21:10:21.281Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": false,
      "lastCommit": "2026-05-16 Use DotNaos UI components",
      "name": "llm-scope-devbox",
      "path": "/Users/oli/projects/llm-scope-devbox",
      "relativePath": "llm-scope-devbox",
      "remote": "https://github.com/DotNaos/llm-scope-devbox.git",
      "scripts": [
        "dev",
        "dev:raw",
        "build",
        "preview",
        "typecheck",
        "scope:build",
        "scope:run",
        "scope:codex"
      ],
      "stack": [
        "Vite",
        "Tailwind"
      ],
      "updatedAt": "2026-05-16T20:18:26.310Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": false,
      "lastCommit": "2024-01-30 ROS Websocket ( unstable) und Refactoring",
      "name": "next-app-template",
      "path": "/Users/oli/projects/onix-cam",
      "relativePath": "onix-cam",
      "remote": "https://github.com/DotNaos/onix-cam.git",
      "scripts": [
        "dev",
        "build",
        "start",
        "lint"
      ],
      "stack": [
        "React",
        "Next.js",
        "Tailwind"
      ],
      "updatedAt": "2026-04-12T13:11:56.767Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": true,
      "lastCommit": "2026-02-23 Add local stack auth smoke fixes (#3)",
      "name": "os",
      "path": "/Users/oli/projects/aryazos/aryazos",
      "relativePath": "aryazos/aryazos",
      "remote": "https://github.com/DotNaos/aryazos.git",
      "scripts": [
        "prepare",
        "dev",
        "dev:control-pane",
        "dev:study",
        "docker:ensure",
        "proxy:up",
        "proxy:down",
        "infra:up"
      ],
      "stack": [],
      "updatedAt": "2026-03-21T19:38:41.757Z"
    },
    {
      "branch": "detached",
      "category": "Apps",
      "dirty": false,
      "lastCommit": "",
      "name": "os",
      "path": "/Users/oli/projects/aryazos/aryazos.worktrees/copilot-worktree-2026-02-23T21-11-12",
      "relativePath": "aryazos/aryazos.worktrees/copilot-worktree-2026-02-23T21-11-12",
      "remote": "",
      "scripts": [
        "prepare",
        "dev",
        "dev:control-pane",
        "dev:e2e-ui",
        "dev:study",
        "docker:ensure",
        "proxy:up",
        "proxy:down"
      ],
      "stack": [],
      "updatedAt": "2026-02-23T21:23:56.734Z"
    },
    {
      "branch": "feature/001-foundation",
      "category": "Apps",
      "dirty": true,
      "lastCommit": "2026-03-17 Refactor: Rename backend view files to .tsx and enable JSX compilation in tsconfig",
      "name": "pluto",
      "path": "/Users/oli/projects/pluto/iteration-001-foundation",
      "relativePath": "pluto/iteration-001-foundation",
      "remote": "https://github.com/DotNaos/pluto.git",
      "scripts": [
        "build",
        "build:web",
        "dev",
        "dev:desktop",
        "dev:raw",
        "dev:master",
        "dev:host",
        "dev:web"
      ],
      "stack": [
        "React",
        "Electron",
        "Vite",
        "Tailwind"
      ],
      "updatedAt": "2026-05-07T14:48:01.042Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": true,
      "lastCommit": "2026-05-02 Add SSD cleanup proposal to Mac performance skill",
      "name": "skills",
      "path": "/Users/oli/projects/skills",
      "relativePath": "skills",
      "remote": "https://github.com/DotNaos/skills.git",
      "scripts": [],
      "stack": [],
      "updatedAt": "2026-05-02T20:28:21.943Z"
    },
    {
      "branch": "main",
      "category": "Apps",
      "dirty": false,
      "lastCommit": "2026-05-08 fix windows webview build",
      "name": "zero-native",
      "path": "/Users/oli/projects/zero-native",
      "relativePath": "zero-native",
      "remote": "https://github.com/vercel-labs/zero-native.git",
      "scripts": [],
      "stack": [],
      "updatedAt": "2026-05-09T07:17:52.980Z"
    },
    {
      "branch": "main",
      "category": "Knowledge",
      "dirty": false,
      "lastCommit": "2026-04-09 Refine diary reader UI",
      "name": "diary",
      "path": "/Users/oli/projects/diary",
      "relativePath": "diary",
      "remote": "https://github.com/DotNaos/diary.git",
      "scripts": [
        "dev",
        "dev:raw",
        "build",
        "preview",
        "agentation:mcp",
        "astro"
      ],
      "stack": [
        "React",
        "Tailwind"
      ],
      "updatedAt": "2026-04-09T19:33:41.685Z"
    },
    {
      "branch": "main",
      "category": "Knowledge",
      "dirty": true,
      "lastCommit": "2026-03-29 Add problem abstraction notes",
      "name": "idea-space",
      "path": "/Users/oli/projects/idea-space",
      "relativePath": "idea-space",
      "remote": "https://github.com/DotNaos/idea-space.git",
      "scripts": [],
      "stack": [],
      "updatedAt": "2026-03-29T14:31:47.835Z"
    },
    {
      "branch": "main",
      "category": "Knowledge",
      "dirty": true,
      "lastCommit": "2026-02-22 Bump version to 1.0.4",
      "name": "notes-hydrogen",
      "path": "/Users/oli/projects/notes-hydrogen",
      "relativePath": "notes-hydrogen",
      "remote": "https://github.com/DotNaos/notes-hydrogen.git",
      "scripts": [
        "format",
        "lint",
        "typecheck:node",
        "typecheck:web",
        "typecheck",
        "prep:desktop-packaging",
        "start",
        "dev"
      ],
      "stack": [
        "React",
        "Electron",
        "Vite",
        "Tailwind"
      ],
      "updatedAt": "2026-03-24T19:02:45.770Z"
    },
    {
      "branch": "main",
      "category": "Mobile",
      "dirty": false,
      "lastCommit": "2026-05-03 Add GitHub Release vendor artifact workflow",
      "name": "@dotnaos/codex-mobile-runtime",
      "path": "/Users/oli/projects/codex-mobile-runtime",
      "relativePath": "codex-mobile-runtime",
      "remote": "https://github.com/DotNaos/codex-mobile-runtime.git",
      "scripts": [
        "sync:vendor:poc",
        "package:vendor",
        "publish:vendor",
        "install:vendor"
      ],
      "stack": [
        "Native app"
      ],
      "updatedAt": "2026-05-03T16:29:11.245Z"
    },
    {
      "branch": "main",
      "category": "Mobile",
      "dirty": true,
      "lastCommit": "2026-04-17 Initial commit",
      "name": "@todo-graph/mobile",
      "path": "/Users/oli/projects/todo-graph/apps/mobile",
      "relativePath": "todo-graph/apps/mobile",
      "remote": "",
      "scripts": [
        "start",
        "android",
        "ios",
        "web",
        "typecheck"
      ],
      "stack": [
        "React Native",
        "React"
      ],
      "updatedAt": "2026-04-18T07:57:28.763Z"
    },
    {
      "branch": "main",
      "category": "Mobile",
      "dirty": true,
      "lastCommit": "2026-05-02 fix: harden OAuth PKCE and moodle scanner flow",
      "name": "codex-mobile-poc",
      "path": "/Users/oli/projects/litter-poc/mobile-codex-poc",
      "relativePath": "litter-poc/mobile-codex-poc",
      "remote": "",
      "scripts": [
        "start",
        "start:go",
        "prebuild:ios",
        "android",
        "ios",
        "web",
        "dev:logs"
      ],
      "stack": [
        "React Native",
        "React",
        "Native app"
      ],
      "updatedAt": "2026-05-03T16:02:57.784Z"
    },
    {
      "branch": "main",
      "category": "Mobile",
      "dirty": true,
      "lastCommit": "2026-05-06 Build expiry-first meal flow",
      "name": "daily",
      "path": "/Users/oli/projects/daily",
      "relativePath": "daily",
      "remote": "https://github.com/DotNaos/daily.git",
      "scripts": [
        "dev",
        "dev:raw",
        "dev:native",
        "dev:direct",
        "build",
        "lint",
        "typecheck",
        "db:migrate"
      ],
      "stack": [
        "React Native",
        "React",
        "Native app"
      ],
      "updatedAt": "2026-05-16T11:17:51.531Z"
    },
    {
      "branch": "main",
      "category": "Mobile",
      "dirty": true,
      "lastCommit": "2026-04-03 Initial commit",
      "name": "MacOSTodoPoc",
      "path": "/Users/oli/projects/MacOSTodoPoc",
      "relativePath": "MacOSTodoPoc",
      "remote": "",
      "scripts": [
        "android",
        "ios",
        "macos",
        "lint",
        "postinstall",
        "start",
        "test"
      ],
      "stack": [
        "React Native",
        "React",
        "Tailwind",
        "Native app"
      ],
      "updatedAt": "2026-04-04T17:44:57.240Z"
    },
    {
      "branch": "connector-release-v0.2.0",
      "category": "Project Space",
      "dirty": true,
      "lastCommit": "2026-05-13 Polish connector code blocks",
      "name": "project-space",
      "path": "/Users/oli/projects/project-space/project-space",
      "relativePath": "project-space/project-space",
      "remote": "https://github.com/DotNaos/project-space.git",
      "scripts": [
        "dev",
        "dev:electron",
        "build",
        "build:connector:macos-arm64",
        "build:electron",
        "check",
        "connector:serve",
        "connector:status"
      ],
      "stack": [
        "React",
        "Electron",
        "Vite",
        "Tailwind"
      ],
      "updatedAt": "2026-05-14T08:34:05.572Z"
    },
    {
      "branch": "codex/worktrees-ideas",
      "category": "Project Space",
      "dirty": true,
      "lastCommit": "2026-03-31 Fix GitHub ideas loading and app packaging",
      "name": "project-space",
      "path": "/Users/oli/projects/project-space/project-space-worktrees-ideas",
      "relativePath": "project-space/project-space-worktrees-ideas",
      "remote": "https://github.com/DotNaos/project-space.git",
      "scripts": [
        "dev",
        "dev:op",
        "build",
        "check",
        "test",
        "package:mac",
        "preview"
      ],
      "stack": [
        "React",
        "Electron",
        "Vite",
        "Tailwind"
      ],
      "updatedAt": "2026-04-24T08:30:13.617Z"
    },
    {
      "branch": "codex/fullstack-architecture",
      "category": "Project Space",
      "dirty": false,
      "lastCommit": "2026-05-16 Fix release workflow signing guard",
      "name": "project-space",
      "path": "/Users/oli/projects/project-space/ps-fullstack-architecture",
      "relativePath": "project-space/ps-fullstack-architecture",
      "remote": "https://github.com/DotNaos/project-space.git",
      "scripts": [
        "dev",
        "web:dev",
        "web:build",
        "check",
        "backend:check",
        "backend:build",
        "desktop:macos:build",
        "desktop:macos:bundle"
      ],
      "stack": [
        "Docker"
      ],
      "updatedAt": "2026-05-16T21:08:59.978Z"
    },
    {
      "branch": "codex/main-wip",
      "category": "Project Space",
      "dirty": true,
      "lastCommit": "2026-03-18 Bootstrap desktop shell foundation",
      "name": "project-space",
      "path": "/Users/oli/projects/project-space/ps-main-wip-worktree",
      "relativePath": "project-space/ps-main-wip-worktree",
      "remote": "https://github.com/DotNaos/project-space.git",
      "scripts": [
        "dev",
        "build",
        "check",
        "preview"
      ],
      "stack": [
        "React",
        "Electron",
        "Vite",
        "Tailwind"
      ],
      "updatedAt": "2026-03-29T21:41:12.776Z"
    },
    {
      "branch": "codex/mobile-browser",
      "category": "Project Space",
      "dirty": true,
      "lastCommit": "2026-03-18 Bootstrap desktop shell foundation",
      "name": "project-space",
      "path": "/Users/oli/projects/project-space/ps-mobile-worktree-final",
      "relativePath": "project-space/ps-mobile-worktree-final",
      "remote": "https://github.com/DotNaos/project-space.git",
      "scripts": [
        "dev",
        "build",
        "check",
        "preview"
      ],
      "stack": [
        "React",
        "Electron",
        "Vite",
        "Tailwind"
      ],
      "updatedAt": "2026-03-29T21:39:07.725Z"
    },
    {
      "branch": "main",
      "category": "UI / Design",
      "dirty": false,
      "lastCommit": "2026-04-09 Split Storybook into minimal component stories",
      "name": "@dotnaos/react-components",
      "path": "/Users/oli/projects/react-components",
      "relativePath": "react-components",
      "remote": "https://github.com/DotNaos/react-components.git",
      "scripts": [
        "build",
        "clean",
        "copy:css",
        "typecheck",
        "storybook",
        "build-storybook",
        "build-storybook:ci"
      ],
      "stack": [
        "React",
        "Vite",
        "Tailwind"
      ],
      "updatedAt": "2026-04-26T14:02:53.927Z"
    },
    {
      "branch": "main",
      "category": "UI / Design",
      "dirty": false,
      "lastCommit": "2026-04-18 Save",
      "name": "bun-react-template",
      "path": "/Users/oli/projects/designer-hydrogen",
      "relativePath": "designer-hydrogen",
      "remote": "https://github.com/DotNaos/designer-hydrogen.git",
      "scripts": [
        "dev",
        "companion",
        "build",
        "preview"
      ],
      "stack": [
        "React",
        "Vite",
        "Tailwind"
      ],
      "updatedAt": "2026-04-18T09:55:31.826Z"
    },
    {
      "branch": "fix-publish-workflow",
      "category": "UI / Design",
      "dirty": false,
      "lastCommit": "2026-05-16 Fix publish workflow package checks",
      "name": "ui",
      "path": "/Users/oli/projects/ui",
      "relativePath": "ui",
      "remote": "https://github.com/DotNaos/ui.git",
      "scripts": [
        "build",
        "dev",
        "dev:docs",
        "dev:playground",
        "docs",
        "playground",
        "figma:build",
        "figma:lint"
      ],
      "stack": [],
      "updatedAt": "2026-05-16T00:24:44.348Z"
    },
    {
      "branch": "codex/strict-ui-namespaces",
      "category": "UI / Design",
      "dirty": true,
      "lastCommit": "2026-05-16 Fix publish workflow package checks",
      "name": "ui",
      "path": "/Users/oli/projects/ui-strict-worktree",
      "relativePath": "ui-strict-worktree",
      "remote": "https://github.com/DotNaos/ui.git",
      "scripts": [
        "build",
        "dev",
        "dev:docs",
        "dev:playground",
        "docs",
        "playground",
        "figma:build",
        "figma:lint"
      ],
      "stack": [],
      "updatedAt": "2026-05-16T20:30:24.459Z"
    },
    {
      "branch": "main",
      "category": "VPS / Runtime",
      "dirty": false,
      "lastCommit": "2026-05-16 Fix private Homebrew download strategy",
      "name": "fullstack-template-smoke",
      "path": "/Users/oli/projects/fullstack-template-smoke",
      "relativePath": "fullstack-template-smoke",
      "remote": "https://github.com/DotNaos/fullstack-template-smoke.git",
      "scripts": [
        "dev",
        "web:dev",
        "web:build",
        "check",
        "backend:check",
        "backend:build",
        "desktop:macos:build",
        "desktop:macos:bundle"
      ],
      "stack": [
        "Docker"
      ],
      "updatedAt": "2026-05-16T20:31:17.560Z"
    },
    {
      "branch": "main",
      "category": "VPS / Runtime",
      "dirty": false,
      "lastCommit": "2026-05-12 Add initial machine setup model",
      "name": "machines",
      "path": "/Users/oli/projects/machines",
      "relativePath": "machines",
      "remote": "https://github.com/DotNaos/machines.git",
      "scripts": [],
      "stack": [],
      "updatedAt": "2026-05-12T18:17:37.928Z"
    },
    {
      "branch": "main",
      "category": "VPS / Runtime",
      "dirty": true,
      "lastCommit": "2026-04-04 Add local admin control plane and setup flow",
      "name": "private-vps-platform",
      "path": "/Users/oli/projects/private-vps-platform",
      "relativePath": "private-vps-platform",
      "remote": "https://github.com/DotNaos/private-vps-platform.git",
      "scripts": [],
      "stack": [
        "Go",
        "Ansible"
      ],
      "updatedAt": "2026-05-11T21:42:38.849Z"
    },
    {
      "branch": "main",
      "category": "VPS / Runtime",
      "dirty": false,
      "lastCommit": "2026-05-08 Initial service simulator framework",
      "name": "service-sim",
      "path": "/Users/oli/projects/service-sim",
      "relativePath": "service-sim",
      "remote": "",
      "scripts": [],
      "stack": [
        "Go",
        "Docker"
      ],
      "updatedAt": "2026-05-14T09:26:44.501Z"
    }
  ]
};
