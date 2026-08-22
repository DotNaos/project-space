import { Icon } from '@dotnaos/ui/base';

export function describeOperatingSystem(value: string | undefined) {
  const normalized = value?.trim().toLocaleLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'darwin' || normalized === 'macos' || normalized === 'ios' || normalized === 'ipados') {
    return {
      brand: 'apple' as const,
      label: normalized === 'ios' ? 'iOS' : normalized === 'ipados' ? 'iPadOS' : 'macOS'
    };
  }
  if (normalized === 'windows') return { brand: 'windows' as const, label: 'Windows' };
  if (normalized === 'linux' || normalized === 'wsl' || normalized === 'ubuntu') {
    return { brand: 'ubuntu' as const, label: 'Linux' };
  }
  return value ? { label: value } : undefined;
}

export function OperatingSystem({ value }: { value?: string }) {
  const system = describeOperatingSystem(value);
  if (!system) return null;
  const brand = 'brand' in system ? system.brand : undefined;

  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-xs text-text">
      {brand ? (
        <Icon.Brand
          appearance={brand === 'apple' ? 'monochrome' : 'color'}
          color={brand === 'apple' ? 'text' : undefined}
          name={brand}
          size="m"
        />
      ) : null}
      <span className="truncate">{system.label}</span>
    </span>
  );
}
