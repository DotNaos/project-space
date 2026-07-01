import {
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Text
} from '@/app/dotnaos-ui';
import { ChevronRight } from 'lucide-react';

export interface SidebarBreadcrumbItem {
  label: string;
  onPress?: () => void;
}

export function SidebarBreadcrumbs({ items }: { items: SidebarBreadcrumbItem[] }) {
  return (
    <nav
      aria-label="Sidebar breadcrumb"
      className="flex min-w-0 items-center gap-1 text-xs text-neutral-500"
    >
      {items.map((item, index) => {
        const isCurrent = index === items.length - 1;
        const content = (
          <span className="block max-w-[13rem] truncate" title={item.label}>
            {item.label}
          </span>
        );

        return (
          <span key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <ChevronRight className="size-3 shrink-0 text-neutral-700" strokeWidth={1.8} />
            ) : null}
            {item.onPress && !isCurrent ? (
              <button
                type="button"
                onClick={item.onPress}
                className="min-w-0 rounded-md px-1 py-0.5 text-left transition hover:bg-neutral-800/70 hover:text-neutral-200"
              >
                {content}
              </button>
            ) : (
              <Text
                className={
                  isCurrent ? 'min-w-0 px-1 py-0.5 text-neutral-300' : 'min-w-0 px-1 py-0.5'
                }
              >
                {content}
              </Text>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function SidebarSearch({
  label,
  onChange,
  placeholder,
  value
}: {
  label: string;
  onChange(value: string): void;
  placeholder: string;
  value: string;
}) {
  return (
    <SearchField aria-label={label} value={value} onChange={onChange} className="mb-3">
      <SearchFieldGroup className="rounded-lg bg-neutral-900/90">
        <SearchFieldSearchIcon />
        <SearchFieldInput className="text-sm" placeholder={placeholder} spellCheck={false} />
        <SearchFieldClearButton />
      </SearchFieldGroup>
    </SearchField>
  );
}
