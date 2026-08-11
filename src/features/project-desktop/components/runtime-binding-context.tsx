import { createContext, useContext, type ReactNode } from 'react';

import type { AppMeta } from '@/shared/project-space-api';

const RuntimeBindingContext = createContext<AppMeta['runtime']>(undefined);

export function RuntimeBindingProvider({
  children,
  runtime
}: {
  children: ReactNode;
  runtime: NonNullable<AppMeta['runtime']>;
}) {
  return (
    <RuntimeBindingContext.Provider value={runtime}>
      {children}
    </RuntimeBindingContext.Provider>
  );
}

export function useRuntimeBinding() {
  const runtime = useContext(RuntimeBindingContext);
  if (!runtime) throw new Error('Runtime binding evidence is unavailable.');
  return runtime;
}
