import type { ProjectChatMessage } from './contracts';

type Listener = (message: ProjectChatMessage) => void;

export class ProjectChatRealtimeHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(message: ProjectChatMessage) {
    for (const listener of this.listeners.get(message.channelId) ?? []) {
      listener(message);
    }
  }

  subscribe(channelId: string, listener: Listener) {
    const listeners = this.listeners.get(channelId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(channelId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(channelId);
      }
    };
  }
}
