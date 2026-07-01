import { Button, Text } from '@/app/dotnaos-ui';
import { ArrowLeft, ChevronRight } from 'lucide-react';

export interface MainBreadcrumbItem {
  label: string;
  onPress?: () => void;
}

export function MainBreadcrumbs({
  items,
  onBack
}: {
  items: MainBreadcrumbItem[];
  onBack?: () => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="mb-5 flex min-w-0 items-center gap-3">
      {onBack ? (
        <Button aria-label="Back" isIconOnly size="sm" variant="ghost" onPress={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
      ) : null}
      <nav
        aria-label="Main breadcrumb"
        className="flex min-w-0 items-center gap-1 text-xs text-neutral-500"
      >
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1;
          const label = (
            <span className="block max-w-[16rem] truncate" title={item.label}>
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
                  className="min-w-0 rounded-md px-1.5 py-1 text-left transition hover:bg-neutral-900 hover:text-neutral-200"
                >
                  {label}
                </button>
              ) : (
                <Text
                  className={
                    isCurrent
                      ? 'min-w-0 px-1.5 py-1 text-neutral-300'
                      : 'min-w-0 px-1.5 py-1'
                  }
                >
                  {label}
                </Text>
              )}
            </span>
          );
        })}
      </nav>
    </div>
  );
}
