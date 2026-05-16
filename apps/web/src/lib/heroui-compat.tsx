import type { ComponentPropsWithoutRef } from 'react';

export * from '@heroui/react';

export function Text({ className, ...props }: ComponentPropsWithoutRef<'span'>) {
  return <span className={className} {...props} />;
}
