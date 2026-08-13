import { useState } from 'react';
import { Button, Link } from '@heroui/react';
import { Check, Copy, Network } from 'lucide-react';

import type { AppMeta } from '@/shared/project-space-api';
import { copyText } from './clipboard';

export function RuntimeAccessLink({
  collapsed = false,
  runtime
}: {
  collapsed?: boolean;
  runtime?: AppMeta['runtime'];
}) {
  if (!runtime?.accessUrl) return null;

  const label = runtime.network === 'external' ? 'Tailscale' : 'This Mac';
  const displayUrl = compactUrl(runtime.accessUrl);

  if (collapsed) {
    return (
      <Link
        aria-label={`${label}: ${displayUrl}`}
        className="flex min-h-8 w-full items-center justify-center rounded-lg px-1 text-neutral-500 no-underline transition-colors hover:bg-white/[.04] hover:text-neutral-300"
        href={runtime.accessUrl}
        rel="noreferrer"
        target="_blank"
      >
        {runtime.network === 'external' ? <TailscaleIcon /> : <Network className="size-3.5" />}
      </Link>
    );
  }

  return <ExpandedRuntimeAccessLink displayUrl={displayUrl} label={label} runtime={runtime} />;
}

function ExpandedRuntimeAccessLink({
  displayUrl,
  label,
  runtime
}: {
  displayUrl: string;
  label: string;
  runtime: NonNullable<AppMeta['runtime']>;
}) {
  const [copied, setCopied] = useState(false);

  const copyUrl = async () => {
    if (await copyText(runtime.accessUrl ?? '')) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }
  };

  return (
    <div className="flex min-h-8 w-full items-center gap-1 rounded-lg px-2 text-neutral-500">
      {runtime.network === 'external' ? <TailscaleIcon /> : <Network className="size-3.5 shrink-0" />}
      <Link
        aria-label={`${label}: ${displayUrl}`}
        className="min-w-0 flex-1 truncate text-[10px] text-blue-400 underline-offset-2 hover:text-blue-300 hover:underline"
        href={runtime.accessUrl}
        rel="noreferrer"
        target="_blank"
      >
        {displayUrl}
      </Link>
      <Button
        isIconOnly
        aria-label={copied ? `${label} URL copied` : `Copy ${label} URL`}
        className="size-7 min-w-7 text-neutral-500 hover:text-neutral-200"
        size="sm"
        variant="ghost"
        onPress={() => void copyUrl()}
      >
        {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}

function TailscaleIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-3.5 shrink-0"
      data-testid="tailscale-logo"
      viewBox="0 0 48 48"
    >
      <g fill="currentColor" opacity="0.4">
        <circle cx="15" cy="15" r="3" />
        <circle cx="24" cy="15" r="3" />
        <circle cx="33" cy="15" r="3" />
        <circle cx="15" cy="33" r="3" />
        <circle cx="33" cy="33" r="3" />
      </g>
      <g fill="currentColor">
        <circle cx="15" cy="24" r="3" />
        <circle cx="24" cy="24" r="3" />
        <circle cx="33" cy="24" r="3" />
        <circle cx="24" cy="33" r="3" />
      </g>
    </svg>
  );
}

function compactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return value;
  }
}
