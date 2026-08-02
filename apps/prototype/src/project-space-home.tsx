import { useCallback, useState } from "react";
import { Button } from "@heroui/react";
import {
  ChevronDown,
  PanelLeft,
  PencilLine,
} from "lucide-react";
import type {
  PrototypeScenarioKind,
  PrototypeTheme,
} from "../../../src/shared/prototype-canvas";
import {
  NewTaskPage,
  ProjectFeaturePage,
  ProjectTaskDetailPage,
  ProjectOverviewPage,
  type ProjectPageId,
} from "./project-space-pages";
import { useMockTasks } from "./project-space-pages/use-mock-tasks";
import {
  ProjectSidebar,
  projectFixtures,
} from "./project-space-sidebar";

export { projectFixtures } from "./project-space-sidebar";

type ShellPageId = "new" | ProjectPageId;

export function projectSpaceShellBackground(theme: PrototypeTheme) {
  return theme === "light" ? "#efeee9" : "#151515";
}

export function projectSpaceCanvasBackground(theme: PrototypeTheme) {
  return theme === "light" ? "#f7f5f0" : "#0a0a0a";
}

export function ProjectSpaceHome({
  scenario,
  theme,
}: {
  scenario: PrototypeScenarioKind;
  theme: PrototypeTheme;
}) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null,
  );
  const [activePage, setActivePage] = useState<ShellPageId>("new");
  const [currentProject, setCurrentProject] = useState(projectFixtures[0]);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [selectedTaskNumber, setSelectedTaskNumber] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { createTask, dispatchTask, tasks } = useMockTasks();
  const light = theme === "light";
  const project = currentProject;
  const selectedTask = selectedTaskNumber === null
    ? undefined
    : tasks.find((task) => task.number === selectedTaskNumber);
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
    setSelectedTaskNumber(null);
    setSidebarOpen(false);
  };
  const sidebarProps = {
    activePage,
    currentProject: project,
    onClose: () => setSidebarOpen(false),
    onNewIssue: focusComposer,
    onPageChange: (page: ProjectPageId) => {
      setActivePage(page);
      setSelectedTaskNumber(null);
      setSidebarOpen(false);
    },
    onProjectSelect: (nextProject: (typeof projectFixtures)[number]) => {
      setCurrentProject(nextProject);
      setSelectedTaskNumber(null);
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
            aria-label="New task"
            size="sm"
            style={{ color: "inherit" }}
            variant="ghost"
            onPress={focusComposer}
          >
            <PencilLine className="size-4" />
          </Button>
        </header>

        {activePage === "issues" && selectedTask ? (
          <div className="min-h-0 flex-1">
            <ProjectTaskDetailPage
              onAction={(action) => dispatchTask(selectedTask.number, action)}
              onBack={() => setSelectedTaskNumber(null)}
              projectName={project.name}
              task={selectedTask}
            />
          </div>
        ) : activePage === "new" ? (
          <NewTaskPage
            projectName={project.name}
            onCreate={(input) => {
              const task = createTask(input);
              setActivePage("issues");
              setSelectedTaskNumber(task.number);
            }}
          />
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
              onNavigate={(page) => setActivePage(page)}
              onNewTask={focusComposer}
              onTaskOpen={setSelectedTaskNumber}
              page={activePage}
              projectName={project.name}
              scenario={scenario}
              tasks={tasks}
            />
          </div>
        )}
      </main>
    </div>
  );
}
