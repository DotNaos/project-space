import { createContext, useContext, type ReactNode } from 'react';
import type { CodexSessionsController } from './codex-sessions-controller';

interface CodexSessionsInventoryContextValue {
  controller: CodexSessionsController;
  machineIds: string[];
}

const CodexSessionsInventoryContext = createContext<
  CodexSessionsInventoryContextValue | undefined
>(undefined);

export function CodexSessionsInventoryProvider({
  children,
  controller,
  machineIds
}: CodexSessionsInventoryContextValue & { children: ReactNode }) {
  return (
    <CodexSessionsInventoryContext.Provider value={{ controller, machineIds }}>
      {children}
    </CodexSessionsInventoryContext.Provider>
  );
}

export function useCodexSessionsInventory() {
  return useContext(CodexSessionsInventoryContext);
}
