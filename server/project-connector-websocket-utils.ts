const filesystemCommandTimeoutMs = 8_000;

export function sendConnectorJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export async function drainConnectorWebSocket(
  socket: WebSocket,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {}
) {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const timeoutMs = options.timeoutMs ?? 250;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Connector WebSocket drain timing is invalid.');
  }
  const deadline = Date.now() + timeoutMs;
  while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 0 &&
      Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return socket.readyState === WebSocket.OPEN && socket.bufferedAmount === 0;
}

export async function sendConnectorJsonAndDrain(
  socket: WebSocket,
  payload: unknown,
  options?: { pollIntervalMs?: number; timeoutMs?: number }
) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return drainConnectorWebSocket(socket, options);
}

export function settleConnectorCommandWithin<T>(promise: Promise<T>, fallback: T) {
  return new Promise<T>((resolve) => {
    const timeout = setTimeout(() => resolve(fallback), filesystemCommandTimeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      () => {
        clearTimeout(timeout);
        resolve(fallback);
      }
    );
  });
}
