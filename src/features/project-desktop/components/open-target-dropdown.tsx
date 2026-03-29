import { cn } from '@/lib/utils';
import type { LauncherAppRecord } from '@/shared/electron-api';
import {
    Button,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownPopover,
    DropdownTrigger,
    Text,
} from '@heroui/react';
import { Check, ChevronDown } from 'lucide-react';

interface OpenTargetDropdownProps {
    apps: LauncherAppRecord[];
    disabled?: boolean;
    onOpen(): void;
    onSelectApp(appId: string): void;
    selectedApp?: LauncherAppRecord;
    selectedAppLabel?: string;
}

const appIconSizeClass = 'h-8 w-8';

function AppIcon({
    app,
    className,
}: {
    app?: LauncherAppRecord;
    className?: string;
}) {
    const iconSource = app?.iconDataUrl ?? app?.iconUrl;

    if (iconSource) {
        return (
            <img
                src={iconSource}
                alt=""
                className={cn(
                    `${appIconSizeClass} shrink-0 rounded-lg object-contain`,
                    className,
                )}
            />
        );
    }

    return (
        <span
            className={cn(
                `flex ${appIconSizeClass} shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-xs font-semibold text-zinc-300`,
                className,
            )}>
            {app?.label.slice(0, 1).toUpperCase() ?? '?'}
        </span>
    );
}

function TriggerAppIcon({ app }: { app?: LauncherAppRecord }) {
    const iconSource = app?.iconDataUrl ?? app?.iconUrl;

    if (iconSource) {
        return (
            <span className="flex aspect-square h-8 w-8 items-center justify-center rounded-lg">
                <img
                    src={iconSource}
                    alt=""
                    className="aspect-square h-8 w-8 shrink-0 object-contain"
                />
            </span>
        );
    }

    return <AppIcon app={app} className={appIconSizeClass} />;
}

export function OpenTargetDropdown({
    apps,
    disabled = false,
    onOpen,
    onSelectApp,
    selectedApp,
    selectedAppLabel,
}: OpenTargetDropdownProps) {
    const currentApp =
        selectedApp ??
        (selectedAppLabel
            ? { appName: '', id: '', label: selectedAppLabel }
            : undefined);

    return (
        <div className="flex items-center">
            <div className="flex items-center rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
                <Button
                    variant="ghost"
                    isDisabled={disabled || !currentApp}
                    onPress={onOpen}
                    className="h-11 min-w-[140px] justify-start gap-3 rounded-xl border-0 bg-transparent px-3 text-zinc-100 hover:bg-zinc-900/55">
                    <TriggerAppIcon app={currentApp} />
                    <Text className="truncate text-sm font-medium">
                        {currentApp?.label ?? 'Choose app'}
                    </Text>
                </Button>

                <Dropdown>
                    <DropdownTrigger isDisabled={disabled || apps.length === 0}>
                        <div
                            className={cn(
                                'flex h-11 w-11 min-w-0 items-center justify-center rounded-xl text-zinc-400 transition',
                                disabled || apps.length === 0
                                    ? 'opacity-40'
                                    : 'hover:bg-zinc-900/55 hover:text-zinc-100'
                            )}
                        >
                            <ChevronDown className="h-4 w-4" strokeWidth={1.9} />
                        </div>
                    </DropdownTrigger>

                    <DropdownPopover
                        offset={8}
                        placement="bottom end"
                        className="rounded-2xl">
                        <DropdownMenu
                            aria-label="Target apps"
                            className="min-w-[240px] p-1">
                            {apps.length === 0 ? (
                                <DropdownItem
                                    key="loading"
                                    isDisabled
                                    className="rounded-xl text-zinc-500"
                                    textValue="Loading apps">
                                    <Text className="text-sm text-zinc-500">
                                        Loading apps...
                                    </Text>
                                </DropdownItem>
                            ) : null}
                            {apps.map((app) => {
                                const active = selectedApp?.id === app.id;

                                return (
                                    <DropdownItem
                                        key={app.id}
                                        onPress={() => onSelectApp(app.id)}
                                        className={cn(
                                            'rounded-xl px-3 py-2.5 text-zinc-300 data-[hover=true]:bg-zinc-800/90 data-[hover=true]:text-zinc-50',
                                            active && 'bg-zinc-800/90 text-zinc-50',
                                        )}
                                        textValue={app.label}>
                                        <div className="flex w-full items-center gap-3">
                                            <AppIcon app={app} />
                                            <div className="min-w-0 flex-1">
                                                <Text className="truncate text-sm font-medium text-current">
                                                    {app.label}
                                                </Text>
                                            </div>
                                            <span className="flex w-4 justify-center">
                                                {active ? (
                                                    <Check
                                                        className="h-3.5 w-3.5 text-zinc-300"
                                                        strokeWidth={2.2}
                                                    />
                                                ) : null}
                                            </span>
                                        </div>
                                    </DropdownItem>
                                );
                            })}
                        </DropdownMenu>
                    </DropdownPopover>
                </Dropdown>
            </div>
        </div>
    );
}
