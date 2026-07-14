import {
  FolderKanban,
  House,
  LogOut,
  MessageSquare,
  Settings
} from 'lucide-react';
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger,
  Surface,
  Text,
  Tooltip
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import { SidebarToggleButton } from './sidebar-toggle-button';

export type AppSection = 'home' | 'chat' | 'projects' | 'settings';

export interface RailAccount {
  email?: string;
  imageUrl?: string;
  name?: string;
  onSignOut(): void;
}

interface RailItemProps {
  icon: typeof House;
  isActive: boolean;
  label: string;
  onPress(): void;
  testId?: string;
}

function RailItem({ icon: Icon, isActive, label, onPress, testId }: RailItemProps) {
  return (
    <Tooltip delay={400}>
      <Tooltip.Trigger>
        <Button
          aria-label={label}
          data-testid={testId}
          isIconOnly
          variant={isActive ? 'secondary' : 'ghost'}
          onPress={onPress}
          className={cn(
            'h-10 w-10 min-w-0 rounded-xl px-0',
            !isActive && 'text-neutral-500 hover:text-neutral-200'
          )}
        >
          <Icon className="size-4" strokeWidth={1.9} />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content showArrow placement="right">
        <Tooltip.Arrow />
        {label}
      </Tooltip.Content>
    </Tooltip>
  );
}

function AccountMenu({ account }: { account: RailAccount }) {
  const initial = (account.name ?? account.email ?? '?').trim().charAt(0).toUpperCase() || '?';

  return (
    <Dropdown>
      <DropdownTrigger
        aria-label="Account"
        className="h-10 w-10 min-w-0 overflow-hidden rounded-full px-0"
      >
        {account.imageUrl ? (
          <img
            src={account.imageUrl}
            alt=""
            className="size-8 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-full bg-neutral-800 text-sm font-semibold text-neutral-200">
            {initial}
          </span>
        )}
      </DropdownTrigger>
      <DropdownPopover
        offset={8}
        placement="right bottom"
        className="rounded-2xl"
        style={{ minWidth: '15rem', width: '15rem' }}
      >
        <DropdownMenu aria-label="Account" className="w-full p-1">
          <DropdownItem
            key="identity"
            isDisabled
            className="rounded-xl"
            textValue={account.email ?? 'Account'}
          >
            <div className="min-w-0">
              {account.name ? (
                <Text className="block truncate text-sm font-medium text-neutral-200">
                  {account.name}
                </Text>
              ) : null}
              <Text className="block truncate text-xs text-neutral-500">
                {account.email ?? 'Signed in'}
              </Text>
            </div>
          </DropdownItem>
          <DropdownItem
            key="sign-out"
            onPress={account.onSignOut}
            className="rounded-xl px-3 py-2.5 text-neutral-300 data-[hover=true]:bg-neutral-800/90 data-[hover=true]:text-neutral-50"
            textValue="Sign out"
          >
            <div className="flex items-center gap-2">
              <LogOut className="size-4" />
              <Text className="text-sm text-current">Sign out</Text>
            </div>
          </DropdownItem>
        </DropdownMenu>
      </DropdownPopover>
    </Dropdown>
  );
}

interface AppRailProps {
  account?: RailAccount;
  activeSection: AppSection;
  hasContextPanel: boolean;
  isContextPanelOpen: boolean;
  onOpenChat(): void;
  onOpenHome(): void;
  onOpenProjects(): void;
  onOpenSettings(): void;
  onToggleContextPanel(): void;
}

export function AppRail({
  account,
  activeSection,
  hasContextPanel,
  isContextPanelOpen,
  onOpenChat,
  onOpenHome,
  onOpenProjects,
  onOpenSettings,
  onToggleContextPanel
}: AppRailProps) {
  return (
    <Surface
      variant="secondary"
      className="relative z-50 flex min-h-0 flex-col items-center gap-1 overflow-visible rounded-none border-r border-neutral-800/60 bg-app-sidebar px-2 pb-3"
    >
      <div className="app-drag flex h-14 w-full shrink-0 items-center justify-center">
        {hasContextPanel ? (
          <div className="app-no-drag">
            <SidebarToggleButton
              isOpen={isContextPanelOpen}
              left={0}
              top={0}
              position="static"
              onToggle={onToggleContextPanel}
            />
          </div>
        ) : null}
      </div>

      <nav aria-label="Primary" className="app-no-drag flex flex-col items-center gap-1.5">
        <RailItem
          icon={House}
          isActive={activeSection === 'home'}
          label="Home"
          testId="sidebar-home"
          onPress={onOpenHome}
        />
        <RailItem
          icon={MessageSquare}
          isActive={activeSection === 'chat'}
          label="Chat"
          testId="sidebar-chat"
          onPress={onOpenChat}
        />
        <RailItem
          icon={FolderKanban}
          isActive={activeSection === 'projects'}
          label="Projects"
          testId="sidebar-projects"
          onPress={onOpenProjects}
        />
      </nav>

      <div className="flex-1" />

      <div className="app-no-drag flex flex-col items-center gap-2">
        <RailItem
          icon={Settings}
          isActive={activeSection === 'settings'}
          label="Settings"
          testId="sidebar-settings"
          onPress={onOpenSettings}
        />
        {account ? <AccountMenu account={account} /> : null}
      </div>
    </Surface>
  );
}
