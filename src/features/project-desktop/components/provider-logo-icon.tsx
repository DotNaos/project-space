import type { SVGProps } from 'react';

import type { ProjectIssueProviderKind } from '@/shared/electron-api';

interface ProviderLogoIconProps extends SVGProps<SVGSVGElement> {
  kind: ProjectIssueProviderKind;
}

export function ProviderLogoIcon({ kind, ...props }: ProviderLogoIconProps) {
  if (kind === 'azure-devops') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
        <path
          d="M3.5 7.2 11.2 3v18l-7.7-2.3V7.2Zm9.2 1.1 7.8-4.3v15.2l-7.8-2.1V8.3Zm-8.2.1 6.7 3.1v5.8l-6.7-1.7V8.4Zm8.2 3.2 6.3-2.5v5.9l-6.3 1.7v-5.1Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (kind === 'github') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
        <path d="M12 .7a12 12 0 0 0-3.8 23.4c.6.1.8-.2.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.3-1.4-1.7-1.4-1.7-1.1-.8.1-.8.1-.8 1.2.1 1.9 1.3 1.9 1.3 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.6-1.4-5.6-6A4.7 4.7 0 0 1 6.4 9c-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.2 11.2 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2a4.7 4.7 0 0 1 1.2 3.3c0 4.7-2.9 5.7-5.7 6 .4.4.9 1 .9 2v3c0 .4.2.7.8.6A12 12 0 0 0 12 .7Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8v4m0 4h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
