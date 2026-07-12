import type { ProjectChatMessage } from './contracts';

type Listener = (message: ProjectChatMessage) => void;

export class ProjectChatRealtimeHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(spaceId: string, message: ProjectChatMessage) {
    for (const listener of this.listeners.get(key(spaceId, message.channelId)) ?? []) {
      listener(message);
    }
  }

  subscribe(spaceId: string, channelId: string, listener: Listener) {
    const listenerKey = key(spaceId, channelId);
    const listeners = this.listeners.get(listenerKey) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(listenerKey, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(listenerKey);
      }
    };
  }
}

function key(spaceId: string, channelId: string) {
  return JSON.stringify([spaceId, channelId]);
}
