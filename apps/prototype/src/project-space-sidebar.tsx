import { useState } from "react";
import { Button, Modal, SearchField } from "@heroui/react";
import {
  ChevronDown,
  HelpCircle,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  Settings,
} from "lucide-react";

import {
  projectPageItems,
  type ProjectPageId,
} from "./project-space-pages";

export interface ProjectFixture {
  counts: Partial<Record<ProjectPageId, number>>;
  name: string;
  owner: string;
}

export const projectFixtures: ProjectFixture[] = [
  { counts: { branches: 16, chats: 3, issues: 57 }, name: "project-space", owner: "DotNaos" },
  { counts: { branches: 2, chats: 2, issues: 9 }, name: "ui", owner: "DotNaos" },
  { counts: { branches: 2, chats: 2, issues: 9 }, name: "design-space", owner: "DotNaos" },
  { counts: { branches: 5, chats: 1, issues: 18 }, name: "project-cli", owner: "DotNaos" },
  { counts: { branches: 3, chats: 2, issues: 12 }, name: "app-server", owner: "DotNaos" },
  { counts: { branches: 4, chats: 1, issues: 21 }, name: "preview-runner", owner: "DotNaos" },
  { counts: { branches: 2, chats: 1, issues: 14 }, name: "docs", owner: "DotNaos" },
  { counts: { branches: 1, chats: 2, issues: 7 }, name: "moodle", owner: "oliverschuetz" },
  { counts: { branches: 2, chats: 1, issues: 11 }, name: "dotfiles", owner: "oliverschuetz" },
  { counts: { branches: 6, chats: 3, issues: 24 }, name: "prototype-lab", owner: "DotNaos" },
];

export const projectPageGroups: Array<{
  ids: ProjectPageId[];
  label: string;
}> = [
  { ids: ["overview", "issues", "branches", "workspaces"], label: "Work" },
  { ids: ["chats", "codex", "history"], label: "Collaborate" },
  { ids: ["machines", "deployments", "template"], label: "Operate" },
];

function SidebarNavItem({
  active,
  collapsed,
  count,
  icon: Icon,
  label,
  onPress,
}: {
  active: boolean;
  collapsed: boolean;
  count?: number;
  icon: (typeof projectPageItems)[number]["icon"];
  label: string;
  onPress(): void;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      aria-label={label}
      className={`group relative flex h-10 w-full items-center rounded-xl text-left text-sm transition-[background-color,color,scale] duration-150 active:scale-[.96] ${
        collapsed ? "justify-center px-0" : "gap-3 px-3"
      } ${
        active
          ? "bg-current/[.08] font-medium text-current"
          : "text-current/55 hover:bg-current/[.04] hover:text-current/80"
      }`}
      onClick={onPress}
      title={collapsed ? label : undefined}
      type="button"
    >
      <Icon aria-hidden className="size-4 shrink-0" strokeWidth={active ? 2 : 1.8} />
      {collapsed ? null : <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && count !== undefined ? (
        <span className="text-xs tabular-nums text-current/35">{count}</span>
      ) : null}
    </button>
  );
}

function ProjectSelectorModal({
  collapsed,
  currentProject,
  onSelect,
  portalContainer,
}: {
  collapsed: boolean;
  currentProject: ProjectFixture;
  onSelect(project: ProjectFixture): void;
  portalContainer: HTMLElement | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const results = projectFixtures.filter((project) =>
    `${project.owner}/${project.name}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <button
        aria-label={`Switch project, current project ${currentProject.name}`}
        aria-haspopup="dialog"
        className={`flex h-10 w-full items-center rounded-xl transition-colors hover:bg-current/[.04] ${
          collapsed ? "justify-center px-0" : "gap-2 px-2 text-left"
        }`}
        data-testid="project-selector-trigger"
        onClick={() => setIsOpen(true)}
        title={collapsed ? currentProject.name : undefined}
        type="button"
      >
        {collapsed ? (
          <span className="text-xs font-semibold uppercase tracking-[-.04em]">
            {currentProject.name.slice(0, 2)}
          </span>
        ) : (
          <>
            <ChevronDown aria-hidden className="size-3.5 text-current/40" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {currentProject.name}
            </span>
          </>
        )}
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
          <Modal.Container className="p-3 @3xl:p-6" placement="center" scroll="inside" size="sm">
            <Modal.Dialog className="flex max-h-[calc(var(--device-content-height)_-_1.5rem)] min-h-0 flex-col overflow-hidden bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70 ring-1 ring-inset ring-white/10 @3xl:max-h-[min(34rem,calc(var(--device-content-height)_-_3rem))]">
              <Modal.CloseTrigger aria-label="Close project switcher" />
              <Modal.Header className="shrink-0 px-4 pb-2 pt-4 @3xl:px-5 @3xl:pt-5">
                <Modal.Heading className="text-base font-semibold">Switch project</Modal.Heading>
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
                        <span className="block truncate text-[13px] font-medium leading-4">{project.name}</span>
                        <span className="block truncate text-[10px] leading-4 text-neutral-500">{project.owner}</span>
                      </span>
                      {project.name === currentProject.name ? (
                        <span className="shrink-0 text-[10px] text-neutral-500">Current</span>
                      ) : null}
                    </button>
                  ))}
                  {results.length === 0 ? (
                    <p className="px-3 py-8 text-center text-sm text-neutral-500">No projects found</p>
                  ) : null}
                </div>
              </Modal.Body>
              <Modal.Footer className="relative shrink-0 px-4 pb-[18px] pt-3 @3xl:pb-4">
                <div aria-hidden className="absolute inset-x-4 top-0 h-px bg-white/[.07]" />
                <SearchField aria-label="Search projects" fullWidth onChange={setQuery} value={query} variant="secondary">
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

export function ProjectSidebar({
  activePage,
  collapsed = false,
  currentProject,
  onClose,
  onCollapsedChange,
  onNewIssue,
  onPageChange,
  onProjectSelect,
  portalContainer,
}: {
  activePage: "new" | ProjectPageId;
  collapsed?: boolean;
  currentProject: ProjectFixture;
  onClose(): void;
  onCollapsedChange?(collapsed: boolean): void;
  onNewIssue(): void;
  onPageChange(page: ProjectPageId): void;
  onProjectSelect(project: ProjectFixture): void;
  portalContainer: HTMLElement | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex items-center gap-2 pb-3 pt-4 ${collapsed ? "flex-col px-2" : "px-4"}`}>
        <div className={`min-w-0 ${collapsed ? "order-2 w-full" : "flex-1"}`}>
          <ProjectSelectorModal
            collapsed={collapsed}
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
        {onCollapsedChange ? (
          <Button
            isIconOnly
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={collapsed ? "order-1" : "shrink-0"}
            size="sm"
            style={{ color: "inherit" }}
            variant="ghost"
            onPress={() => onCollapsedChange(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </Button>
        ) : null}
      </div>

      <div className={collapsed ? "px-2" : "px-4"}>
        <button
          aria-label="New issue"
          className={`flex h-10 w-full items-center rounded-xl text-sm text-current/75 transition-[background-color,color,scale] hover:bg-current/[.04] hover:text-current active:scale-[.96] ${
            collapsed ? "justify-center px-0" : "gap-3 px-3"
          }`}
          onClick={onNewIssue}
          title={collapsed ? "New issue" : undefined}
          type="button"
        >
          <PencilLine aria-hidden className="size-4" strokeWidth={1.8} />
          {collapsed ? null : <span>New issue</span>}
        </button>
      </div>

      <nav
        aria-label="Project navigation"
        className={`mt-3 min-h-0 flex-1 overflow-y-auto pb-4 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
          collapsed ? "px-2" : "px-4"
        }`}
      >
        {projectPageGroups.map((group, groupIndex) => (
          <div className={groupIndex === 0 ? "" : collapsed ? "mt-2" : "mt-5"} key={group.label}>
            {collapsed ? (
              groupIndex === 0 ? null : <div aria-hidden className="mx-3 mb-2 h-px bg-current/[.06]" />
            ) : (
              <p className="px-3 pb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-current/30">
                {group.label}
              </p>
            )}
            {group.ids.map((id) => {
              const item = projectPageItems.find((candidate) => candidate.id === id);
              if (!item) return null;
              return (
                <SidebarNavItem
                  active={activePage === item.id}
                  collapsed={collapsed}
                  count={currentProject.counts[item.id]}
                  icon={item.icon}
                  key={item.id}
                  label={item.label}
                  onPress={() => onPageChange(item.id)}
                />
              );
            })}
          </div>
        ))}
      </nav>

      <div
        className={`${collapsed ? "mx-2 p-1" : "mx-4 p-2"} mb-4 rounded-full bg-current/[.06]`}
        data-testid="sidebar-account-podium"
      >
        <div className={`flex items-center rounded-full ${collapsed ? "justify-center" : "gap-2 px-2 py-1.5"}`}>
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-current/[.09] text-xs font-semibold" title={collapsed ? "Oli · Local workspace" : undefined}>
            OS
          </span>
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">Oli</span>
                <span className="block truncate text-[11px] text-current/40">Local workspace</span>
              </span>
              <Button isIconOnly aria-label="Help" size="sm" style={{ color: "inherit" }} variant="ghost">
                <HelpCircle className="size-4" />
              </Button>
              <Button isIconOnly aria-label="Settings" size="sm" style={{ color: "inherit" }} variant="ghost">
                <Settings className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
