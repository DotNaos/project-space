import { useCallback, useRef, useState } from "react";
import { Button, Modal, SearchField } from "@heroui/react";
import {
  ArrowUp,
  ChevronDown,
  HelpCircle,
  PanelLeft,
  Paperclip,
  PencilLine,
  Settings,
} from "lucide-react";
import type {
  PrototypeScenarioKind,
  PrototypeTheme,
} from "../../../src/shared/prototype-canvas";
import {
  ProjectFeaturePage,
  ProjectOverviewPage,
  projectPageItems,
  type ProjectPageId,
} from "./project-space-pages";

type ShellPageId = "new" | ProjectPageId;

export function projectSpaceShellBackground(theme: PrototypeTheme) {
  return theme === "light" ? "#efeee9" : "#151515";
}

interface ProjectFixture {
  counts: Partial<Record<ProjectPageId, number>>;
  name: string;
  owner: string;
}

export const projectFixtures: ProjectFixture[] = [
  {
    counts: { branches: 16, chats: 3, issues: 57 },
    name: "project-space",
    owner: "DotNaos",
  },
  {
    counts: { branches: 2, chats: 2, issues: 9 },
    name: "ui",
    owner: "DotNaos",
  },
  {
    counts: { branches: 2, chats: 2, issues: 9 },
    name: "design-space",
    owner: "DotNaos",
  },
  {
    counts: { branches: 5, chats: 1, issues: 18 },
    name: "project-cli",
    owner: "DotNaos",
  },
  {
    counts: { branches: 3, chats: 2, issues: 12 },
    name: "app-server",
    owner: "DotNaos",
  },
  {
    counts: { branches: 4, chats: 1, issues: 21 },
    name: "preview-runner",
    owner: "DotNaos",
  },
  {
    counts: { branches: 2, chats: 1, issues: 14 },
    name: "docs",
    owner: "DotNaos",
  },
  {
    counts: { branches: 1, chats: 2, issues: 7 },
    name: "moodle",
    owner: "oliverschuetz",
  },
  {
    counts: { branches: 2, chats: 1, issues: 11 },
    name: "dotfiles",
    owner: "oliverschuetz",
  },
  {
    counts: { branches: 6, chats: 3, issues: 24 },
    name: "prototype-lab",
    owner: "DotNaos",
  },
];
function SidebarNavItem({
  active,
  count,
  icon: Icon,
  label,
  onPress,
}: {
  active: boolean;
  count?: number;
  icon: (typeof projectPageItems)[number]["icon"];
  label: string;
  onPress(): void;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`group relative flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors duration-150 ${
        active
          ? "bg-current/[.08] font-medium text-current"
          : "text-current/55 hover:bg-current/[.04] hover:text-current/80"
      }`}
      onClick={onPress}
      type="button"
    >
      <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined ? null : (
        <span className="text-xs tabular-nums text-current/35">{count}</span>
      )}
    </button>
  );
}
function ProjectSelectorModal({
  currentProject,
  onSelect,
  portalContainer,
}: {
  currentProject: ProjectFixture;
  onSelect(project: ProjectFixture): void;
  portalContainer: HTMLElement | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const results = projectFixtures.filter((project) =>
    `${project.owner}/${project.name}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  return (
    <>
      <button
        aria-label={`Switch project, current project ${currentProject.name}`}
        aria-haspopup="dialog"
        className="flex h-10 w-full items-center gap-2 rounded-xl px-2 text-left transition-colors hover:bg-current/[.04]"
        data-testid="project-selector-trigger"
        onClick={() => setIsOpen(true)}
        type="button"
      >
        <ChevronDown aria-hidden className="size-3.5 text-current/40" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {currentProject.name}
        </span>
      </button>

      <Modal
        isOpen={isOpen}
        onOpenChange={(open) => {
          setIsOpen(open);
          if (!open) setQuery("");
        }}
      >
        <Modal.Backdrop
          UNSTABLE_portalContainer={portalContainer ?? undefined}
          className="z-[80] bg-black/70"
          style={{
            height: "var(--device-content-height)",
            overflow: "hidden",
            position: "absolute",
            width: "var(--device-content-width)",
          }}
          variant="blur"
        >
          <Modal.Container
            className="p-3 @3xl:p-6"
            placement="center"
            scroll="inside"
            size="sm"
          >
            <Modal.Dialog className="flex max-h-[calc(var(--device-content-height)_-_1.5rem)] min-h-0 flex-col overflow-hidden bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70 ring-1 ring-inset ring-white/10 @3xl:max-h-[min(34rem,calc(var(--device-content-height)_-_3rem))]">
              <Modal.CloseTrigger aria-label="Close project switcher" />
              <Modal.Header className="shrink-0 px-4 pb-2 pt-4 @3xl:px-5 @3xl:pt-5">
                <Modal.Heading className="text-base font-semibold">
                  Switch project
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="min-h-0 overflow-y-auto px-4 pb-2 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="space-y-0.5">
                  {results.map((project) => (
                    <button
                      className="flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-white/[.06]"
                      key={project.name}
                      onClick={() => {
                        onSelect(project);
                        setQuery("");
                        setIsOpen(false);
                      }}
                      type="button"
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/[.07] text-[10px] font-semibold text-neutral-300">
                        {project.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium leading-4">
                          {project.name}
                        </span>
                        <span className="block truncate text-[10px] leading-4 text-neutral-500">
                          {project.owner}
                        </span>
                      </span>
                      {project.name === currentProject.name ? (
                        <span className="shrink-0 text-[10px] text-neutral-500">
                          Current
                        </span>
                      ) : null}
                    </button>
                  ))}
                  {results.length === 0 ? (
                    <p className="px-3 py-8 text-center text-sm text-neutral-500">
                      No projects found
                    </p>
                  ) : null}
                </div>
              </Modal.Body>
              <Modal.Footer className="relative shrink-0 px-4 pb-[18px] pt-3 @3xl:pb-4">
                <div
                  aria-hidden
                  className="absolute inset-x-4 top-0 h-px bg-white/[.07]"
                />
                <SearchField
                  aria-label="Search projects"
                  fullWidth
                  onChange={setQuery}
                  value={query}
                  variant="secondary"
                >
                  <SearchField.Group className="h-10 border-neutral-800 bg-neutral-900">
                    <SearchField.SearchIcon className="size-4 text-neutral-400" />
                    <SearchField.Input placeholder="Search projects" />
                    <SearchField.ClearButton />
                  </SearchField.Group>
                </SearchField>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}

function ProjectSidebar({
  activePage,
  currentProject,
  onClose,
  onNewIssue,
  onPageChange,
  onProjectSelect,
  portalContainer,
}: {
  activePage: ShellPageId;
  currentProject: ProjectFixture;
  onClose(): void;
  onNewIssue(): void;
  onPageChange(page: ProjectPageId): void;
  onProjectSelect(project: ProjectFixture): void;
  portalContainer: HTMLElement | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <ProjectSelectorModal
            currentProject={currentProject}
            portalContainer={portalContainer}
            onSelect={onProjectSelect}
          />
        </div>
        <Button
          isIconOnly
          aria-label="Close sidebar"
          className="shrink-0 @3xl:hidden"
          size="sm"
          style={{ color: "inherit" }}
          variant="ghost"
          onPress={onClose}
        >
          <PanelLeft className="size-4" />
        </Button>
      </div>

      <div className="px-4">
        <button
          className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-sm text-current/75 transition-colors hover:bg-current/[.04] hover:text-current"
          onClick={onNewIssue}
          type="button"
        >
          <PencilLine aria-hidden className="size-4" strokeWidth={1.8} />
          <span>New issue</span>
        </button>
      </div>

      <nav
        aria-label="Project navigation"
        className="mt-4 min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <p className="px-3 pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-current/35">
          Project
        </p>
        {projectPageItems.map((item) => (
          <SidebarNavItem
            active={activePage === item.id}
            count={currentProject.counts[item.id]}
            icon={item.icon}
            key={item.id}
            label={item.label}
            onPress={() => onPageChange(item.id)}
          />
        ))}
      </nav>

      <div
        className="mx-4 mb-4 rounded-full bg-current/[.06] p-2"
        data-testid="sidebar-account-podium"
      >
        <div className="flex items-center gap-2 rounded-xl px-2 py-1.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-current/[.09] text-xs font-semibold">
            OS
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">Oli</span>
            <span className="block truncate text-[11px] text-current/40">
              Local workspace
            </span>
          </span>
          <Button
            isIconOnly
            aria-label="Help"
            size="sm"
            style={{ color: "inherit" }}
            variant="ghost"
          >
            <HelpCircle className="size-4" />
          </Button>
          <Button
            isIconOnly
            aria-label="Settings"
            size="sm"
            style={{ color: "inherit" }}
            variant="ghost"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ProjectSpaceHome({
  scenario,
  theme,
}: {
  scenario: PrototypeScenarioKind;
  theme: PrototypeTheme;
}) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null,
  );
  const [activePage, setActivePage] = useState<ShellPageId>("new");
  const [currentProject, setCurrentProject] = useState(projectFixtures[0]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [idea, setIdea] = useState("");
  const light = theme === "light";
  const project = currentProject;
  const shellBackground = projectSpaceShellBackground(theme);
  const capturePortalContainer = useCallback(
    (element: HTMLDivElement | null) => {
      const content = element?.closest<HTMLElement>(
        ".prototype-device__content",
      );
      setPortalContainer(content ?? element);
    },
    [],
  );

  const focusComposer = () => {
    setActivePage("new");
    setSidebarOpen(false);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };
  const sidebarProps = {
    activePage,
    currentProject: project,
    onClose: () => setSidebarOpen(false),
    onNewIssue: focusComposer,
    onPageChange: (page: ProjectPageId) => {
      setActivePage(page);
      setSidebarOpen(false);
    },
    onProjectSelect: setCurrentProject,
    portalContainer,
  };

  return (
    <div
      ref={capturePortalContainer}
      className={`relative flex size-full min-h-full overflow-hidden ${
        light ? "text-zinc-950" : "text-zinc-100"
      }`}
      data-testid="project-space-home"
      style={{ backgroundColor: shellBackground }}
    >
      <aside
        aria-label="Project sidebar"
        className="hidden w-72 shrink-0 @3xl:block"
        style={{ backgroundColor: shellBackground }}
      >
        <ProjectSidebar {...sidebarProps} />
      </aside>

      <aside
        aria-hidden={!sidebarOpen}
        aria-label="Project sidebar"
        className={`relative h-full shrink-0 overflow-hidden transition-[width] duration-500 ease-[cubic-bezier(.16,1,.3,1)] @3xl:hidden ${
          sidebarOpen ? "w-[calc(100%-2.75rem)]" : "w-0"
        }`}
        inert={!sidebarOpen}
      >
        <div
          className={`absolute inset-y-0 right-0 w-[calc(100cqw-2.75rem)] transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          style={{ backgroundColor: shellBackground }}
        >
          <ProjectSidebar {...sidebarProps} />
        </div>
      </aside>

      <main
        className={`relative isolate flex w-full min-w-0 shrink-0 flex-col overflow-hidden transition-[border-radius,margin,border-color,background-color] duration-500 ease-[cubic-bezier(.16,1,.3,1)] @3xl:my-0 @3xl:w-auto @3xl:flex-1 @3xl:shrink @3xl:rounded-none @3xl:border-l-0 ${
          sidebarOpen
            ? light
              ? "my-2 rounded-l-[2rem] border-l border-black/[.09] bg-[#fbfaf7]"
              : "my-2 rounded-l-[2rem] border-l border-white/[.12] bg-[#111111]"
            : `my-0 rounded-none ${
                light ? "bg-[#f8f7f3]" : "bg-[#0b0b0b]"
              }`
        }`}
        data-testid="mobile-main-card"
      >
        <button
          aria-hidden={!sidebarOpen}
          aria-label="Close sidebar"
          className={`absolute inset-0 z-40 @3xl:hidden ${
            sidebarOpen ? "pointer-events-auto" : "pointer-events-none"
          }`}
          onClick={() => setSidebarOpen(false)}
          tabIndex={sidebarOpen ? 0 : -1}
          type="button"
        />
        <header className="grid h-14 shrink-0 grid-cols-[32px_minmax(0,1fr)_32px] items-center gap-2 px-4 @3xl:hidden">
          {sidebarOpen ? (
            <span aria-hidden className="size-8 shrink-0" />
          ) : (
            <Button
              isIconOnly
              aria-label="Open sidebar"
              size="sm"
              style={{ color: "inherit" }}
              variant="ghost"
              onPress={() => setSidebarOpen(true)}
            >
              <PanelLeft className="size-5" />
            </Button>
          )}
          <button
            className="flex w-full items-center justify-center gap-1.5 text-sm font-medium"
            onClick={() => setSidebarOpen(true)}
            type="button"
          >
            <span className="max-w-40 truncate">{project.name}</span>
            <ChevronDown className="size-3.5 text-current/45" />
          </button>
          <Button
            isIconOnly
            aria-label="New issue"
            size="sm"
            style={{ color: "inherit" }}
            variant="ghost"
            onPress={focusComposer}
          >
            <PencilLine className="size-4" />
          </Button>
        </header>

        {activePage === "new" ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5">
              <div className="mb-[42px] grid size-[42px] place-items-center rounded-full border border-current/10 text-current/45 @3xl:size-10 @5xl:mb-10">
                <span className="text-sm font-semibold">PS</span>
              </div>
            </div>

            <div className="shrink-0 px-4 pb-5 @md:px-6 @md:pb-7 @3xl:px-10 @3xl:pb-9">
              <form
                className={`mx-auto w-full max-w-3xl rounded-3xl p-2 shadow-[0_16px_44px_rgba(0,0,0,.12)] ring-1 ring-inset ${
                  light
                    ? "bg-white ring-black/10"
                    : "bg-[#1c1c1c] ring-white/10"
                }`}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!idea.trim()) return;
                  setIdea("");
                }}
              >
                <textarea
                  ref={composerRef}
                  aria-label="Describe a feature or idea"
                  className="block max-h-36 min-h-14 w-full resize-none bg-transparent px-3 py-2 text-[15px] leading-6 outline-none placeholder:text-current/35"
                  placeholder="Describe a feature or idea"
                  rows={2}
                  value={idea}
                  onChange={(event) => setIdea(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey) return;
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }}
                />
                <div className="flex items-center justify-between gap-2 px-1 pb-1">
                  <Button
                    isIconOnly
                    aria-label="Attach context"
                    size="sm"
                    style={{ color: "inherit" }}
                    variant="ghost"
                  >
                    <Paperclip className="size-4" />
                  </Button>
                  <Button
                    isIconOnly
                    aria-label="Create issue"
                    className={idea.trim() ? "" : "opacity-45"}
                    isDisabled={!idea.trim()}
                    size="sm"
                    type="submit"
                    variant="primary"
                  >
                    <ArrowUp className="size-4" />
                  </Button>
                </div>
              </form>
              <p className="mx-auto mt-2 max-w-3xl px-3 text-center text-[10px] leading-4 text-current/30">
                Ideas become issues in {project.name}
              </p>
            </div>
          </>
        ) : activePage === "overview" ? (
          <div className="min-h-0 flex-1">
            <ProjectOverviewPage projectName={project.name} />
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <ProjectFeaturePage
              page={activePage}
              projectName={project.name}
              scenario={scenario}
            />
          </div>
        )}
      </main>
    </div>
  );
}
