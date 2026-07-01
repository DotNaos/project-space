import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ElementType,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type Key,
  type ReactNode
} from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import {
  Scrollable
} from '@dotnaos/react-ui';
import { cn } from '@/lib/utils';

type UiVariant = 'primary' | 'secondary' | 'tertiary' | 'outline' | 'ghost' | 'transparent';
type UiSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  fullWidth?: boolean;
  isDisabled?: boolean;
  isIconOnly?: boolean;
  onPress?: () => void;
  size?: UiSize;
  variant?: UiVariant | 'danger';
}

const buttonVariantClass: Record<string, string> = {
  danger: 'border-red-500/30 bg-red-500/15 text-red-100 hover:bg-red-500/25',
  ghost: 'border-transparent bg-transparent text-neutral-300 hover:bg-neutral-800/70 hover:text-neutral-50',
  outline: 'border-neutral-700 bg-transparent text-neutral-200 hover:bg-neutral-800/70 hover:text-neutral-50',
  primary: 'border-transparent bg-neutral-100 text-neutral-900 hover:bg-white',
  secondary: 'border-transparent bg-neutral-800/80 text-neutral-100 hover:bg-neutral-700/90',
  tertiary: 'border-transparent bg-black/20 text-neutral-200 hover:bg-neutral-900/70',
  transparent: 'border-transparent bg-transparent text-neutral-300 hover:bg-neutral-800/60'
};

const buttonSizeClass: Record<UiSize, string> = {
  lg: 'min-h-11 px-4 text-sm',
  md: 'min-h-10 px-3 text-sm',
  sm: 'min-h-8 px-2.5 text-xs'
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    fullWidth = false,
    isDisabled = false,
    isIconOnly = false,
    onClick,
    onPress,
    size = 'md',
    type = 'button',
    variant = 'secondary',
    ...props
  },
  ref
) {
  return (
    <button
      {...props}
      ref={ref}
      disabled={isDisabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onPress?.();
        }
      }}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border font-medium transition disabled:pointer-events-none disabled:opacity-50',
        buttonVariantClass[variant],
        buttonSizeClass[size],
        fullWidth && 'w-full',
        isIconOnly && 'aspect-square px-0',
        className
      )}
    >
      {children}
    </button>
  );
});

interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  variant?: UiVariant;
}

const surfaceVariantClass: Record<UiVariant, string> = {
  ghost: 'bg-transparent',
  outline: 'border border-neutral-800 bg-transparent',
  primary: 'border border-neutral-700 bg-neutral-800/40',
  secondary: 'border border-neutral-800 bg-neutral-950/55',
  tertiary: 'border border-neutral-800 bg-black/20',
  transparent: 'bg-transparent'
};

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { children, className, variant = 'secondary', ...props },
  ref
) {
  return (
    <div
      {...props}
      ref={ref}
      className={cn(surfaceVariantClass[variant], className)}
    >
      {children}
    </div>
  );
});

type CardRoot = typeof Surface & {
  Content: typeof CardContent;
  Description: typeof CardDescription;
  Footer: typeof CardFooter;
  Header: typeof CardHeader;
  Title: typeof CardTitle;
};

const CardBase = forwardRef<HTMLDivElement, SurfaceProps>(function Card(
  { className, variant = 'secondary', ...props },
  ref
) {
  return (
    <Surface
      {...props}
      ref={ref}
      variant={variant}
      className={cn('flex flex-col rounded-lg', className)}
    />
  );
});

function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('flex flex-col px-5 pt-5', className)} />;
}

function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('flex flex-col px-5 py-4', className)} />;
}

function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('flex items-center px-5 pb-5', className)} />;
}

function CardTitle({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('leading-tight', className)} />;
}

function CardDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('text-sm text-neutral-400', className)} />;
}

export const Card = Object.assign(CardBase, {
  Content: CardContent,
  Description: CardDescription,
  Footer: CardFooter,
  Header: CardHeader,
  Title: CardTitle
}) as CardRoot;

interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  color?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md';
  variant?: UiVariant | 'soft';
}

export function Chip({
  children,
  className,
  color,
  size = 'md',
  variant = 'secondary',
  ...props
}: ChipProps) {
  const tone = color === 'success' ? 'success' : color === 'warning' ? 'warning' : color === 'danger' ? 'danger' : 'default';

  return (
    <span
      {...props}
      data-tone={tone}
      className={cn(
        'inline-flex items-center whitespace-nowrap text-xs font-medium text-neutral-400',
        variant === 'primary' && 'text-neutral-100',
        size === 'sm' && 'text-[11px]',
        className
      )}
    >
      {children}
    </span>
  );
}

interface TextProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
}

export function Text({ as: Component = 'span', className, ...props }: TextProps) {
  return <Component {...props} className={cn('min-w-0 break-words', className)} />;
}

interface ScrollShadowProps extends HTMLAttributes<HTMLDivElement> {
  hideScrollBar?: boolean;
}

export function ScrollShadow({ children, className, hideScrollBar, ...props }: ScrollShadowProps) {
  return (
    <Scrollable
      {...props}
      direction="vertical"
      className={cn(hideScrollBar && 'scrollbar-hide', className)}
    >
      {children}
    </Scrollable>
  );
}

interface TabsContextValue {
  selectedKey?: Key;
  onSelectionChange?: (key: Key) => void;
}

const TabsContext = createContext<TabsContextValue>({});
const TabContext = createContext<{ selected: boolean }>({ selected: false });

interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  onSelectionChange?: (key: Key) => void;
  selectedKey?: Key;
  variant?: UiVariant;
}

export function Tabs({ children, onSelectionChange, selectedKey, ...props }: TabsProps) {
  const value = useMemo(() => ({ selectedKey, onSelectionChange }), [onSelectionChange, selectedKey]);

  return (
    <TabsContext.Provider value={value}>
      <div {...props}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabList(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} role="tablist" />;
}

interface TabProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'id'> {
  id: string;
}

export function Tab({ children, className, id, ...props }: TabProps) {
  const { selectedKey, onSelectionChange } = useContext(TabsContext);
  const selected = selectedKey === id;

  return (
    <TabContext.Provider value={{ selected }}>
      <button
        {...props}
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={(event) => {
          props.onClick?.(event);
          if (!event.defaultPrevented) {
            onSelectionChange?.(id);
          }
        }}
        className={cn(
          'relative inline-flex min-h-8 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-neutral-500 transition hover:text-neutral-200 aria-selected:bg-neutral-800/80 aria-selected:text-neutral-100',
          className
        )}
      >
        {children}
      </button>
    </TabContext.Provider>
  );
}

export function TabIndicator() {
  const { selected } = useContext(TabContext);
  return selected ? <span className="absolute inset-x-3 bottom-1 h-px rounded-full bg-neutral-200" /> : null;
}

export function TabSeparator() {
  return null;
}

interface ButtonGroupProps extends HTMLAttributes<HTMLDivElement> {
  size?: UiSize;
  variant?: UiVariant;
}

export function ButtonGroup({ className, ...props }: ButtonGroupProps) {
  return <div {...props} className={cn('inline-flex items-center overflow-hidden', className)} />;
}

interface DropdownContextValue {
  close(): void;
  open: boolean;
  setOpen(open: boolean): void;
}

const DropdownContext = createContext<DropdownContextValue | null>(null);

export function Dropdown({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ close: () => setOpen(false), open, setOpen }), [open]);

  return (
    <DropdownContext.Provider value={value}>
      <div className="relative inline-flex">{children}</div>
    </DropdownContext.Provider>
  );
}

interface DropdownTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  isDisabled?: boolean;
}

export function DropdownTrigger({
  children,
  className,
  isDisabled,
  ...props
}: DropdownTriggerProps) {
  const dropdown = useContext(DropdownContext);

  return (
    <button
      {...props}
      type="button"
      disabled={isDisabled}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          dropdown?.setOpen(!dropdown.open);
        }
      }}
      className={cn(
        'inline-flex items-center justify-center border border-neutral-700 bg-transparent text-neutral-200 transition hover:bg-neutral-800/70 disabled:pointer-events-none disabled:opacity-50',
        className
      )}
    >
      {children}
    </button>
  );
}

interface DropdownPopoverProps extends HTMLAttributes<HTMLDivElement> {
  offset?: number;
  placement?: string;
}

export function DropdownPopover({
  children,
  className,
  offset = 6,
  placement,
  style,
  ...props
}: DropdownPopoverProps) {
  const dropdown = useContext(DropdownContext);

  if (!dropdown?.open) {
    return null;
  }

  return (
    <div
      {...props}
      className={cn(
        'absolute right-0 z-50 min-w-max rounded-lg border border-neutral-800/50 bg-neutral-950 p-1 shadow-2xl shadow-black/50',
        placement?.includes('top') ? 'bottom-full' : 'top-full',
        className
      )}
      style={{ marginTop: placement?.includes('top') ? undefined : offset, marginBottom: placement?.includes('top') ? offset : undefined, ...style }}
    >
      {children}
    </div>
  );
}

export function DropdownMenu(props: HTMLAttributes<HTMLDivElement> & { 'aria-label'?: string }) {
  return <div {...props} role="menu" />;
}

interface DropdownItemProps extends HTMLAttributes<HTMLButtonElement> {
  isDisabled?: boolean;
  onPress?: () => void;
  textValue?: string;
}

export function DropdownItem({
  children,
  className,
  isDisabled,
  onPress,
  textValue: _textValue,
  ...props
}: DropdownItemProps) {
  const dropdown = useContext(DropdownContext);

  return (
    <button
      {...props}
      type="button"
      disabled={isDisabled}
      role="menuitem"
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          onPress?.();
          dropdown?.close();
        }
      }}
      className={cn(
        'w-full rounded-md px-3 py-2 text-left text-sm text-neutral-300 transition hover:bg-neutral-800 hover:text-neutral-50 disabled:pointer-events-none disabled:text-neutral-500',
        className
      )}
    >
      {children}
    </button>
  );
}

interface TooltipContextValue {
  open: boolean;
  setOpen(open: boolean): void;
}

const TooltipContext = createContext<TooltipContextValue | null>(null);

function TooltipRoot({ children }: { children: ReactNode; delay?: number }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);

  return (
    <TooltipContext.Provider value={value}>
      <span className="relative inline-block max-w-full">{children}</span>
    </TooltipContext.Provider>
  );
}

function TooltipTrigger({ children, className }: HTMLAttributes<HTMLSpanElement>) {
  const tooltip = useContext(TooltipContext);

  return (
    <span
      className={className}
      onFocus={() => tooltip?.setOpen(true)}
      onBlur={() => tooltip?.setOpen(false)}
      onPointerEnter={() => tooltip?.setOpen(true)}
      onPointerLeave={() => tooltip?.setOpen(false)}
    >
      {children}
    </span>
  );
}

function TooltipContent({
  children,
  className,
  placement: _placement,
  showArrow: _showArrow
}: HTMLAttributes<HTMLDivElement> & { placement?: string; showArrow?: boolean }) {
  const tooltip = useContext(TooltipContext);

  if (!tooltip?.open) {
    return null;
  }

  return (
    <span
      className={cn(
        'absolute left-full top-1/2 z-50 ml-2 min-w-48 -translate-y-1/2 rounded-lg border border-neutral-800/50 bg-neutral-950 px-3 py-2 text-xs text-neutral-300 shadow-2xl shadow-black/50',
        className
      )}
    >
      {children}
    </span>
  );
}

function TooltipArrow() {
  return null;
}

export const Tooltip = Object.assign(TooltipRoot, {
  Arrow: TooltipArrow,
  Content: TooltipContent,
  Trigger: TooltipTrigger
});

interface SearchFieldContextValue {
  onChange(value: string): void;
  value: string;
}

const SearchFieldContext = createContext<SearchFieldContextValue | null>(null);

interface SearchFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  onChange(value: string): void;
  value: string;
}

export function SearchField({ children, onChange, value, ...props }: SearchFieldProps) {
  const contextValue = useMemo(() => ({ onChange, value }), [onChange, value]);

  return (
    <SearchFieldContext.Provider value={contextValue}>
      <div {...props}>{children}</div>
    </SearchFieldContext.Provider>
  );
}

export function SearchFieldGroup(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('flex min-w-0 items-center gap-2 px-3 py-2', props.className)} />;
}

export function SearchFieldSearchIcon() {
  return <Search className="size-4 shrink-0 text-neutral-500" />;
}

export const SearchFieldInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function SearchFieldInput({ className, ...props }, ref) {
    const field = useContext(SearchFieldContext);

    return (
      <input
        {...props}
        ref={ref}
        value={field?.value ?? ''}
        onChange={(event) => field?.onChange(event.target.value)}
        className={cn('min-w-0 flex-1 bg-transparent text-neutral-100 outline-none placeholder:text-neutral-500', className)}
      />
    );
  }
);

export function SearchFieldClearButton() {
  const field = useContext(SearchFieldContext);

  if (!field?.value) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => field.onChange('')}
      className="inline-flex size-6 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
    >
      <X className="size-3.5" />
    </button>
  );
}

interface ToggleButtonGroupProps<T extends string> extends HTMLAttributes<HTMLDivElement> {
  disallowEmptySelection?: boolean;
  isDetached?: boolean;
  onSelectionChange(value: Set<T>): void;
  selectedKeys: Set<T>;
  selectionMode?: string;
  size?: UiSize;
}

const ToggleGroupContext = createContext<{
  selectedKeys: Set<string>;
  toggle(value: string): void;
} | null>(null);

export function ToggleButtonGroup<T extends string>({
  children,
  className,
  disallowEmptySelection: _disallowEmptySelection,
  isDetached: _isDetached,
  onSelectionChange,
  selectedKeys,
  selectionMode: _selectionMode,
  size: _size,
  ...props
}: ToggleButtonGroupProps<T>) {
  const contextValue = useMemo(
    () => ({
      selectedKeys: new Set(Array.from(selectedKeys, String)),
      toggle(value: string) {
        onSelectionChange(new Set([value]) as Set<T>);
      }
    }),
    [onSelectionChange, selectedKeys]
  );

  return (
    <ToggleGroupContext.Provider value={contextValue}>
      <div {...props} className={cn('inline-flex items-center', className)}>
        {children}
      </div>
    </ToggleGroupContext.Provider>
  );
}

interface ToggleButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  id: string;
  isIconOnly?: boolean;
  variant?: UiVariant;
}

export function ToggleButton({
  children,
  className,
  id,
  isIconOnly: _isIconOnly,
  variant: _variant,
  ...props
}: ToggleButtonProps) {
  const group = useContext(ToggleGroupContext);
  const selected = group?.selectedKeys.has(id) ?? false;

  return (
    <button
      {...props}
      type="button"
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          group?.toggle(id);
        }
      }}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-500 transition hover:bg-neutral-800/70 hover:text-neutral-200',
        selected && 'bg-neutral-800 text-neutral-100',
        className
      )}
    >
      {children}
    </button>
  );
}

interface AccordionContextValue {
  expandedKeys: Set<string>;
  toggle(key: string): void;
}

const AccordionContext = createContext<AccordionContextValue | null>(null);
const AccordionItemContext = createContext<{ id: string; open: boolean } | null>(null);

interface AccordionProps extends HTMLAttributes<HTMLDivElement> {
  allowsMultipleExpanded?: boolean;
  expandedKeys?: Set<Key>;
  onExpandedChange?: (keys: Set<Key>) => void;
}

function AccordionRoot({
  allowsMultipleExpanded = false,
  children,
  expandedKeys,
  onExpandedChange,
  ...props
}: AccordionProps) {
  const keys = useMemo(() => new Set(Array.from(expandedKeys ?? [], String)), [expandedKeys]);
  const value = useMemo(
    () => ({
      expandedKeys: keys,
      toggle(key: string) {
        const next = new Set(allowsMultipleExpanded ? keys : []);
        if (keys.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        onExpandedChange?.(next);
      }
    }),
    [allowsMultipleExpanded, keys, onExpandedChange]
  );

  return (
    <AccordionContext.Provider value={value}>
      <div {...props}>{children}</div>
    </AccordionContext.Provider>
  );
}

function AccordionItem({ children, id }: { children: ReactNode; id: string }) {
  const accordion = useContext(AccordionContext);
  const open = accordion?.expandedKeys.has(id) ?? false;

  return (
    <AccordionItemContext.Provider value={{ id, open }}>
      <div>{children}</div>
    </AccordionItemContext.Provider>
  );
}

function AccordionHeading(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} />;
}

function AccordionTrigger({ children, className, ...props }: HTMLAttributes<HTMLButtonElement>) {
  const accordion = useContext(AccordionContext);
  const item = useContext(AccordionItemContext);

  return (
    <button
      {...props}
      type="button"
      data-expanded={item?.open ? 'true' : 'false'}
      onClick={() => item && accordion?.toggle(item.id)}
      className={cn('flex w-full items-center justify-between gap-2', className)}
    >
      {children}
    </button>
  );
}

function AccordionIndicator({ className }: HTMLAttributes<HTMLSpanElement>) {
  const item = useContext(AccordionItemContext);

  return (
    <ChevronDown
      className={cn('size-4 transition-transform', item?.open && 'rotate-180', className)}
    />
  );
}

function AccordionPanel({ children }: { children: ReactNode }) {
  const item = useContext(AccordionItemContext);
  return item?.open ? <div>{children}</div> : null;
}

function AccordionBody(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} />;
}

export const Accordion = Object.assign(AccordionRoot, {
  Body: AccordionBody,
  Heading: AccordionHeading,
  Indicator: AccordionIndicator,
  Item: AccordionItem,
  Panel: AccordionPanel,
  Trigger: AccordionTrigger
});

interface ListBoxContextValue {
  onAction?: (key: Key) => void;
  selectedKeys?: Set<Key>;
}

const ListBoxContext = createContext<ListBoxContextValue>({});
const SelectContext = createContext<{
  close(): void;
  onChange(value: string | null): void;
  open: boolean;
  placeholder?: string;
  selectedLabel?: string;
  setOpen(open: boolean): void;
  value: string | null;
} | null>(null);

interface ListBoxProps extends HTMLAttributes<HTMLDivElement> {
  disallowEmptySelection?: boolean;
  onAction?: (key: Key) => void;
  selectedKeys?: Set<Key>;
  selectionMode?: string;
}

export function ListBox({
  children,
  className,
  disallowEmptySelection: _disallowEmptySelection,
  onAction,
  selectedKeys,
  selectionMode: _selectionMode,
  ...props
}: ListBoxProps) {
  const value = useMemo(() => ({ onAction, selectedKeys }), [onAction, selectedKeys]);

  return (
    <ListBoxContext.Provider value={value}>
      <div {...props} role="listbox" className={className}>
        {children}
      </div>
    </ListBoxContext.Provider>
  );
}

interface ListBoxItemProps extends HTMLAttributes<HTMLButtonElement> {
  id: string;
  textValue?: string;
}

export function ListBoxItem({
  children,
  className,
  id,
  textValue: _textValue,
  ...props
}: ListBoxItemProps) {
  const listBox = useContext(ListBoxContext);
  const select = useContext(SelectContext);
  const selected = listBox.selectedKeys?.has(id) || select?.value === id;

  return (
    <button
      {...props}
      type="button"
      role="option"
      aria-selected={selected}
      data-selected={selected ? 'true' : 'false'}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          listBox.onAction?.(id);
          select?.onChange(id);
          select?.close();
        }
      }}
      className={cn('block w-full text-left', className)}
    >
      {children}
    </button>
  );
}

export function Label({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...props} className={cn('block truncate text-sm font-medium text-current', className)}>
      {children}
    </span>
  );
}

interface SelectProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  onChange(value: string | null): void;
  placeholder?: string;
  value: string | null;
  variant?: UiVariant;
}

function SelectRoot({
  children,
  className,
  onChange,
  placeholder,
  value,
  variant: _variant,
  ...props
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<string | undefined>();
  const contextValue = useMemo(
    () => ({
      close: () => setOpen(false),
      onChange(nextValue: string | null) {
        onChange(nextValue);
        setSelectedLabel(undefined);
      },
      open,
      placeholder,
      selectedLabel,
      setOpen,
      value
    }),
    [onChange, open, placeholder, selectedLabel, value]
  );

  return (
    <SelectContext.Provider value={contextValue}>
      <div {...props} className={cn('relative', className)}>
        {children}
      </div>
    </SelectContext.Provider>
  );
}

function SelectTrigger({ children, className, ...props }: HTMLAttributes<HTMLButtonElement>) {
  const select = useContext(SelectContext);

  return (
    <button
      {...props}
      type="button"
      onClick={() => select?.setOpen(!select.open)}
      className={cn('flex w-full items-center gap-2', className)}
    >
      {children}
    </button>
  );
}

function SelectValue({
  children,
  className
}: {
  children(value: { isPlaceholder: boolean }): ReactNode;
  className?: string;
}) {
  const select = useContext(SelectContext);
  const isPlaceholder = !select?.value;

  return <span className={className}>{children({ isPlaceholder })}</span>;
}

function SelectIndicator({ className }: HTMLAttributes<HTMLSpanElement>) {
  const select = useContext(SelectContext);

  return (
    <ChevronDown
      className={cn('size-4 transition-transform', select?.open && 'rotate-180', className)}
    />
  );
}

function SelectPopover({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const select = useContext(SelectContext);

  if (!select?.open) {
    return null;
  }

  return (
    <div
      {...props}
      className={cn('absolute left-0 top-full z-50 mt-2 p-1 shadow-2xl', className)}
    >
      {children}
    </div>
  );
}

export const Select = Object.assign(SelectRoot, {
  Indicator: SelectIndicator,
  Popover: SelectPopover,
  Trigger: SelectTrigger,
  Value: SelectValue
});
