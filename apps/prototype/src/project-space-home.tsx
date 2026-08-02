import { useCallback, useRef, useState } from "react";
import { Button } from "@heroui/react";
import {
  ArrowUp,
  ChevronDown,
  PanelLeft,
  Paperclip,
  PencilLine,
} from "lucide-react";
import type {
  PrototypeScenarioKind,
  PrototypeTheme,
} from "../../../src/shared/prototype-canvas";
import {
  ProjectFeaturePage,
  ProjectIssueDetailPage,
  ProjectOverviewPage,
  prototypeIssueByNumber,
  type ProjectPageId,
  type PrototypeIssueViewMode,
} from "./project-space-pages";
import {
  ProjectSidebar,
  projectFixtures,
} from "./project-space-sidebar";

export { projectFixtures } from "./project-space-sidebar";

type ShellPageId = "new" | ProjectPageId;

export function projectSpaceShellBackground(theme: PrototypeTheme) {
  return theme === "light" ? "#efeee9" : "#151515";
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
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [issueViewMode, setIssueViewMode] = useState<PrototypeIssueViewMode>("board");
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [idea, setIdea] = useState("");
  const light = theme === "light";
  const project = currentProject;
  const selectedIssue = selectedIssueNumber === null
    ? undefined
    : prototypeIssueByNumber(selectedIssueNumber);
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
    setSelectedIssueNumber(null);
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
      setSelectedIssueNumber(null);
      setSidebarOpen(false);
    },
    onProjectSelect: (nextProject: (typeof projectFixtures)[number]) => {
      setCurrentProject(nextProject);
      setSelectedIssueNumber(null);
    },
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
        className={`hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(.16,1,.3,1)] @3xl:block ${
          desktopSidebarCollapsed ? "w-[4.5rem]" : "w-72"
        }`}
        style={{ backgroundColor: shellBackground }}
      >
        <ProjectSidebar
          {...sidebarProps}
          collapsed={desktopSidebarCollapsed}
          onCollapsedChange={setDesktopSidebarCollapsed}
        />
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

        {activePage === "issues" && selectedIssue ? (
          <div className="min-h-0 flex-1">
            <ProjectIssueDetailPage
              issue={selectedIssue}
              onBack={() => setSelectedIssueNumber(null)}
              projectName={project.name}
            />
          </div>
        ) : activePage === "new" ? (
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
            <ProjectOverviewPage
              onNavigate={(page) => setActivePage(page)}
              onNewIssue={focusComposer}
              projectName={project.name}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <ProjectFeaturePage
              issueViewMode={issueViewMode}
              onIssueOpen={(number) => setSelectedIssueNumber(number)}
              onIssueViewModeChange={setIssueViewMode}
              onNavigate={(page) => setActivePage(page)}
              onNewIssue={focusComposer}
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
