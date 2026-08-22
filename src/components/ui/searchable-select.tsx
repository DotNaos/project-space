import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Container, Icon } from '@dotnaos/ui/base';

export interface SearchableSelectOption {
  label: string;
  value: string;
}

export interface SearchableSelectProps {
  accessibilityLabel: string;
  disabled?: boolean;
  fullWidth?: boolean;
  noOptionsLabel?: string;
  onValueChange(value: string): void;
  options: readonly SearchableSelectOption[];
  placeholder?: string;
  size?: 'sm' | 'md' | 'lg';
  value?: string;
}

const sizeClasses = {
  sm: { control: 'h-9 rounded-md px-9 text-xs', icon: 's' as const, option: 'min-h-9 rounded-md px-3 text-xs', width: 'w-48' },
  md: { control: 'h-10 rounded-lg px-10 text-sm', icon: 'm' as const, option: 'min-h-10 rounded-lg px-3 text-sm', width: 'w-56' },
  lg: { control: 'h-12 rounded-xl px-11 text-base', icon: 'm' as const, option: 'min-h-12 rounded-xl px-4 text-base', width: 'w-72' },
};

export function SearchableSelect({
  accessibilityLabel,
  disabled = false,
  fullWidth = true,
  noOptionsLabel = 'No matching options',
  onValueChange,
  options,
  placeholder = 'Search and select',
  size = 'md',
  value,
}: SearchableSelectProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(() => options.find((option) => option.value === value)?.label ?? '');
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedOption = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery));
  }, [options, query]);
  const sizeClass = sizeClasses[size];

  useEffect(() => {
    if (!open) setQuery(selectedOption?.label ?? '');
  }, [open, selectedOption?.label]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePress(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener('pointerdown', closeOnOutsidePress);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress);
  }, [open, selectedOption?.label]);

  function close() {
    setOpen(false);
    setQuery(selectedOption?.label ?? '');
  }

  function startSearch() {
    if (disabled || open) return;
    setQuery('');
    setActiveIndex(0);
    setOpen(true);
  }

  function selectOption(option: SearchableSelectOption) {
    onValueChange(option.value);
    setQuery(option.label);
    setOpen(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        startSearch();
        return;
      }
      if (filteredOptions.length === 0) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + direction + filteredOptions.length) % filteredOptions.length);
      return;
    }
    if (event.key === 'Enter' && open) {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option) selectOption(option);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab' && open) close();
  }

  return (
    <div ref={rootRef} className={`relative ${fullWidth ? 'w-full' : sizeClass.width}`}>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted">
          <Icon color="inherit" name="search" size={sizeClass.icon} />
        </span>
        <input
          ref={inputRef}
          aria-activedescendant={open && filteredOptions[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-label={accessibilityLabel}
          autoComplete="off"
          className={`w-full border border-border bg-control font-medium text-text outline-none transition-[background-color,border-color,box-shadow] placeholder:text-text-muted hover:bg-control-hover focus:border-accent focus:bg-bg-0 focus:ring-2 focus:ring-focus-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass.control}`}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onClick={startSearch}
          onFocus={startSearch}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          role="combobox"
          type="search"
          value={query}
        />
        <span className={`pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}>
          <Icon color="inherit" name="chevron-down" size={sizeClass.icon} />
        </span>
      </div>

      {open ? (
        <Container
          aria-label={`${accessibilityLabel} options`}
          className="absolute top-[calc(100%+0.5rem)] z-50 max-h-80 w-full overflow-y-auto rounded-lg p-1"
          id={listboxId}
          role="listbox"
          surface="overlay"
        >
          {filteredOptions.length > 0 ? filteredOptions.map((option, index) => {
            const active = activeIndex === index;
            const selected = option.value === value;
            return (
              <button
                aria-selected={selected}
                className={`flex w-full items-center justify-between gap-3 text-left text-text outline-none transition-colors ${sizeClass.option} ${active ? 'bg-control-active' : 'bg-transparent hover:bg-control-hover'}`}
                id={`${listboxId}-option-${index}`}
                key={option.value}
                onClick={() => selectOption(option)}
                onPointerEnter={() => setActiveIndex(index)}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span className="truncate">{option.label}</span>
                {selected ? <Icon color="inherit" name="check" size={sizeClass.icon} /> : null}
              </button>
            );
          }) : (
            <p className={`${sizeClass.option} flex items-center text-text-muted`}>{noOptionsLabel}</p>
          )}
        </Container>
      ) : null}
    </div>
  );
}
