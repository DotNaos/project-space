import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Chip, Icon, Input, Text } from '@dotnaos/ui/base';

import {
  isProjectSpaceApiRequestAllowed,
  refreshProjectSpaceAuthToken,
  resolveProjectSpaceApiBaseUrl
} from '../../../api/project-space-client';
import { Terminal, type TerminalHandle } from '../../../components/ui/terminal';
import type { HostsDeviceDescriptor } from './hosts-device-model';

type SshState = 'disconnected' | 'connecting' | 'connected' | 'error';

function terminalBaseUrl() {
  const currentUrl = new URL(window.location.href);
  return resolveProjectSpaceApiBaseUrl(
    currentUrl.toString(),
    import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL
  ) || currentUrl.origin;
}

function statusLabel(state: SshState) {
  if (state === 'connected') return 'Connected';
  if (state === 'connecting') return 'Connecting';
  if (state === 'error') return 'Connection failed';
  return 'Disconnected';
}

export function HostsDeviceSshTerminal({ device }: { device: HostsDeviceDescriptor }) {
  const terminalRef = useRef<TerminalHandle | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ cols: 100, rows: 28 });
  const stateRef = useRef<SshState>('disconnected');
  const [state, setState] = useState<SshState>('disconnected');
  const [message, setMessage] = useState('No SSH connection is active.');
  const [username, setUsername] = useState('');
  const canConnect = device.kind === 'tailnet' && device.status === 'available' &&
    Boolean(device.address) && Boolean(username.trim());

  function updateState(next: SshState) {
    stateRef.current = next;
    setState(next);
  }

  useEffect(() => {
    const stored = window.localStorage.getItem('project-space:ssh-username');
    if (stored) setUsername(stored);
    return () => {
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  const disconnect = useCallback(() => {
    socketRef.current?.close(1000, 'Disconnected by user.');
    socketRef.current = null;
    updateState('disconnected');
    setMessage('SSH session disconnected.');
  }, []);

  const connect = useCallback(async () => {
    if (!canConnect || socketRef.current) return;
    updateState('connecting');
    setMessage('Checking the local Tailnet device and SSH trust...');
    terminalRef.current?.reset();
    terminalRef.current?.write('Opening client-owned SSH session...\r\n');

    try {
      const url = new URL(
        `/api/client/tailnet/devices/${encodeURIComponent(device.name)}/ssh`,
        terminalBaseUrl()
      );
      if (!isProjectSpaceApiRequestAllowed(window.location.href, url.toString())) {
        throw new Error('Project Space refused a client SSH connection to an untrusted origin.');
      }
      const sessionToken = await refreshProjectSpaceAuthToken();
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const protocols = sessionToken
        ? ['project-space', `project-space-auth.${sessionToken}`]
        : ['project-space'];
      const socket = new WebSocket(url, protocols);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'connect', username: username.trim() }));
      });
      socket.addEventListener('message', (event) => {
        let payload: {
          address?: string;
          data?: string;
          deviceName?: string;
          exitCode?: number;
          message?: string;
          signal?: number;
          type?: string;
        };
        try {
          payload = JSON.parse(String(event.data)) as typeof payload;
        } catch {
          terminalRef.current?.write(String(event.data));
          return;
        }
        if (payload.type === 'output' && typeof payload.data === 'string') {
          terminalRef.current?.write(payload.data);
        } else if (payload.type === 'connected') {
          window.localStorage.setItem('project-space:ssh-username', username.trim());
          updateState('connected');
          setMessage(`Connected directly to ${payload.deviceName ?? device.name} at ${payload.address ?? device.address}.`);
          const { cols, rows } = sizeRef.current;
          socket.send(JSON.stringify({ cols, rows, type: 'resize' }));
          terminalRef.current?.focus();
        } else if (payload.type === 'error') {
          updateState('error');
          setMessage(payload.message ?? 'The SSH session could not start.');
          terminalRef.current?.write(`\r\n${payload.message ?? 'SSH connection failed.'}\r\n`);
        } else if (payload.type === 'exit') {
          terminalRef.current?.write(
            `\r\n[SSH session exited: ${payload.exitCode ?? payload.signal ?? 'closed'}]\r\n`
          );
          updateState('disconnected');
          setMessage(`SSH session exited with ${payload.exitCode ?? payload.signal ?? 'an unknown status'}.`);
        }
      });
      socket.addEventListener('close', (event) => {
        if (socketRef.current === socket) socketRef.current = null;
        if (stateRef.current === 'connecting') {
          const reason = event.reason || 'The SSH session closed before authentication completed.';
          updateState('error');
          setMessage(reason);
          terminalRef.current?.write(`\r\n${reason}\r\n`);
        } else if (stateRef.current === 'connected') {
          updateState('disconnected');
          setMessage('SSH session disconnected.');
        }
      });
      socket.addEventListener('error', () => {
        updateState('error');
        setMessage('The local SSH bridge could not be reached.');
      });
    } catch (error) {
      socketRef.current = null;
      updateState('error');
      setMessage(error instanceof Error ? error.message : 'The SSH session could not start.');
    }
  }, [canConnect, device.address, device.name, username]);

  function sendInput(data: string) {
    const socket = socketRef.current;
    if (state === 'connected' && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ data, type: 'input' }));
    }
  }

  function resize(cols: number, rows: number) {
    sizeRef.current = { cols, rows };
    const socket = socketRef.current;
    if (state === 'connected' && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ cols, rows, type: 'resize' }));
    }
  }

  if (device.kind !== 'tailnet') {
    return (
      <section className="grid min-h-80 place-items-center rounded-xl bg-bg-1 px-6 text-center ring-1 ring-border/70">
        <div className="max-w-md space-y-3">
          <Icon color="muted" name="terminal" size="l" />
          <Text level={2} size="s" text="Provider-managed terminal" variant="heading" />
          <Text color="muted" size="s" text="GitHub Codespaces access must use its provider-owned connection instead of a fabricated Host SSH route." />
        </div>
      </section>
    );
  }

  return (
    <section aria-label="SSH terminal" className="flex min-h-[30rem] flex-col overflow-hidden rounded-xl bg-bg-0 ring-1 ring-border/70">
      <div className="flex flex-col gap-3 bg-bg-2/80 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Icon color={state === 'connected' ? 'accent' : 'muted'} name="terminal" size="s" />
          <span className="truncate font-mono text-xs text-text-muted">{device.name}{device.address ? ` · ${device.address}` : ''}</span>
          <Chip label={statusLabel(state)} size="sm" tone={state === 'connected' ? 'success' : state === 'error' ? 'danger' : 'default'} variant="soft" />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 sm:w-44">
            <Input
              accessibilityLabel="SSH username"
              disabled={state === 'connecting' || state === 'connected'}
              fullWidth
              onValueChange={setUsername}
              placeholder="SSH username"
              size="sm"
              value={username}
            />
          </div>
          <Button
            disabled={state === 'connecting' || (!canConnect && state !== 'connected')}
            icon={state === 'connected' ? 'close' : 'terminal'}
            label={state === 'connected' ? 'Disconnect' : 'Connect'}
            onPress={state === 'connected' ? disconnect : () => void connect()}
            variant={state === 'connected' ? 'ghost' : 'primary'}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-bg-0">
        <Terminal
          ref={terminalRef}
          accessibilityLabel={`SSH terminal for ${device.name}`}
          className="min-h-[24rem]"
          onData={sendInput}
          onError={(error) => {
            updateState('error');
            setMessage(error.message);
          }}
          onResize={resize}
        />
      </div>
      <div className="flex flex-col gap-1 bg-bg-1 px-4 py-2 text-xs text-text-muted sm:flex-row sm:items-center sm:justify-between">
        <span>{message}</span>
        <span>Trusts a new device key once, rejects later key changes, and uses the local SSH agent. Passwords and private keys never enter Project Space.</span>
      </div>
    </section>
  );
}
