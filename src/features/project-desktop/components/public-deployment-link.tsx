import { ExternalLink } from 'lucide-react';

export function visibleDeploymentUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

export function PublicDeploymentLink({
  environmentName,
  href
}: {
  environmentName: string;
  href: string;
}) {
  const label = visibleDeploymentUrl(href);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${environmentName} deployment at ${label}`}
      className="inline-flex min-w-0 items-center gap-1 text-xs font-medium text-sky-400 underline-offset-2 hover:text-sky-300 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
      title={href}
    >
      <span className="truncate">{label}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}
