import type { ReactNode } from "react";
import { Button, SearchField } from "@heroui/react";
import { Search } from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";

export type PageTone = "danger" | "info" | "muted" | "success" | "warning";

const toneClasses: Record<PageTone, string> = {
  danger: "bg-red-500/10 text-red-400",
  info: "bg-blue-500/10 text-blue-400",
  muted: "bg-current/[.06] text-current/45",
  success: "bg-emerald-500/10 text-emerald-400",
  warning: "bg-amber-500/10 text-amber-400",
};

export function PageStatus({ children, tone = "muted" }: {
  children: ReactNode;
  tone?: PageTone;
}) {
  return (
    <span className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-[11px] font-medium ${toneClasses[tone]}`}>
      {children}
    </span>
  );
}

export function PageScaffold({
  action,
  children,
  description,
  projectName,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  description: string;
  projectName: string;
  title: string;
}) {
  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col px-5 pb-6 pt-4 @md:px-8 @md:pb-8 @md:pt-7 @3xl:px-10 @5xl:px-12 @5xl:pt-10">
      <header className="flex shrink-0 items-end justify-between gap-5 border-b border-current/[.08] pb-5 @md:pb-6">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-current/35">{projectName}</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] @md:text-[28px]">
            {title}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-5 text-current/45">
            {description}
          </p>
        </div>
        {action ? <div className="hidden shrink-0 @md:block">{action}</div> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
    </section>
  );
}

export function PageSearch({
  onChange,
  placeholder,
  value,
}: {
  onChange(value: string): void;
  placeholder: string;
  value: string;
}) {
  return (
    <SearchField
      aria-label={placeholder}
      className="w-full @md:max-w-sm"
      fullWidth
      onChange={onChange}
      value={value}
      variant="secondary"
    >
      <SearchField.Group className="h-9 border-current/[.08] bg-current/[.04]">
        <Search aria-hidden className="size-3.5 text-current/35" />
        <SearchField.Input className="text-sm" placeholder={placeholder} />
        <SearchField.ClearButton />
      </SearchField.Group>
    </SearchField>
  );
}

export function PageFilter({
  active,
  children,
  onPress,
}: {
  active: boolean;
  children: ReactNode;
  onPress(): void;
}) {
  return (
    <button
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[.96] ${
        active
          ? "bg-current/[.1] text-current"
          : "text-current/45 hover:bg-current/[.05] hover:text-current/70"
      }`}
      onClick={onPress}
      type="button"
    >
      {children}
    </button>
  );
}

export function PageState({
  emptyCopy,
  scenario,
}: {
  emptyCopy: string;
  scenario: PrototypeScenarioKind;
}) {
  if (scenario !== "empty" && scenario !== "offline") return null;
  return (
    <div className="grid min-h-52 place-items-center border-b border-current/[.08] px-6 text-center">
      <div>
        <p className="text-sm font-medium">
          {scenario === "offline" ? "Development destination unavailable" : "Nothing here yet"}
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-xs leading-5 text-current/40">
          {scenario === "offline"
            ? "This local prototype will reconnect when its development destination is available."
            : emptyCopy}
        </p>
      </div>
    </div>
  );
}

export function PagePrimaryAction({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <Button size="sm" variant="primary">
      {icon}
      {children}
    </Button>
  );
}

export function SectionHeading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 pb-2.5">
      <h2 className="text-xs font-medium text-current/45">
        {children}
      </h2>
      {meta ? <div className="text-[11px] text-current/30">{meta}</div> : null}
    </div>
  );
}
