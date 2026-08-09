import { LogOut } from 'lucide-react';
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger,
  Text
} from '@/app/dotnaos-ui';

export interface RailAccount {
  email?: string;
  imageUrl?: string;
  name?: string;
  onSignOut(): void;
}

export function AccountMenu({
  account,
  placement = 'right bottom'
}: {
  account: RailAccount;
  placement?: string;
}) {
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
        placement={placement}
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
