import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

type FigmaCaptureApi = {
  captureForDesign: (args: {
    captureId: string;
    endpoint: string;
    selector: string;
  }) => Promise<unknown>;
};

type FigmaWindow = Window &
  typeof globalThis & {
    figma?: FigmaCaptureApi;
  };

type FigmaCaptureButtonProps = {
  captureId?: string;
  endpoint?: string;
  selector?: string;
  label?: string;
  className?: string;
  style?: CSSProperties;
  captureScriptUrl?: string;
};

const DEFAULT_SCRIPT_URL = 'https://mcp.figma.com/mcp/html-to-design/capture.js';
const SCRIPT_SELECTOR = 'script[data-figma-capture="true"]';

let captureLoader: Promise<FigmaCaptureApi> | null = null;

function resetLoaderOnError(): void {
  captureLoader = null;
}

function resolveCaptureApi(figmaWindow: FigmaWindow): FigmaCaptureApi {
  const api = figmaWindow.figma?.captureForDesign ? figmaWindow.figma : null;

  if (!api) {
    throw new Error('capture.js did not expose window.figma.captureForDesign');
  }

  return api;
}

async function ensureCaptureApi(captureScriptUrl: string): Promise<FigmaCaptureApi> {
  if (captureLoader) {
    return captureLoader;
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Figma capture is only available in the browser.');
  }

  const figmaWindow = window as FigmaWindow;
  const existingApi = figmaWindow.figma?.captureForDesign;

  if (existingApi) {
    return figmaWindow.figma as FigmaCaptureApi;
  }

  captureLoader = new Promise<FigmaCaptureApi>((resolve, reject) => {
    try {
      const existingScript = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR);
      const handleReady = () => {
        try {
          resolve(resolveCaptureApi(figmaWindow));
        } catch (error) {
          resetLoaderOnError();
          reject(error);
        }
      };

      if (existingScript) {
        existingScript.addEventListener('load', handleReady, { once: true });
        existingScript.addEventListener(
          'error',
          () => {
            resetLoaderOnError();
            reject(new Error('Figma capture script failed to load.'));
          },
          { once: true }
        );
        return;
      }

      const script = document.createElement('script');
      script.src = captureScriptUrl;
      script.async = true;
      script.dataset.figmaCapture = 'true';
      script.onload = handleReady;
      script.onerror = () => {
        resetLoaderOnError();
        reject(new Error('Figma capture script failed to load.'));
      };
      document.head.appendChild(script);
    } catch (error) {
      resetLoaderOnError();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return captureLoader;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

function useFigmaCaptureReady(captureScriptUrl: string) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void ensureCaptureApi(captureScriptUrl)
      .then(() => {
        if (!cancelled) {
          setReady(true);
          setError(null);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setReady(false);
          setError(toErrorMessage(nextError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [captureScriptUrl]);

  return { error, ready };
}

const baseButtonStyle: CSSProperties = {
  position: 'fixed',
  right: '16px',
  bottom: '16px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  padding: '10px 14px',
  borderRadius: '999px',
  border: 'none',
  boxShadow: '0 10px 25px rgba(0,0,0,0.18)',
  background: 'white',
  color: '#111827',
  fontSize: '14px',
  fontWeight: 600,
  cursor: 'pointer',
  zIndex: 9999
};

const errorBubbleStyle: CSSProperties = {
  position: 'fixed',
  right: '16px',
  bottom: '70px',
  maxWidth: '280px',
  padding: '10px 12px',
  background: 'rgba(17,24,39,0.92)',
  color: 'white',
  borderRadius: '12px',
  fontSize: '13px',
  lineHeight: 1.4,
  boxShadow: '0 8px 20px rgba(0,0,0,0.25)',
  zIndex: 9999
};

const figmaMark = (
  <svg aria-hidden="true" viewBox="0 0 200 300" width="20" height="28">
    <path
      d="M50 300c27.6 0 50-22.4 50-50v-50H50c-27.6 0-50 22.4-50 50s22.4 50 50 50z"
      fill="#0acf83"
    />
    <path
      d="M0 150c0-27.6 22.4-50 50-50h50v100H50c-27.6 0-50 22.4-50 50z"
      fill="#a259ff"
    />
    <path
      d="M0 50C0 22.4 22.4 0 50 0h50v100H50C22.4 100 0 77.6 0 50z"
      fill="#f24e1e"
    />
    <path d="M100 0h50c27.6 0 50 22.4 50 50s-22.4 50-50 50h-50V0z" fill="#ff7262" />
    <path
      d="M200 150c0 27.6-22.4 50-50 50s-50-22.4-50-50 22.4-50 50-50 50 22.4 50 50z"
      fill="#1abcfe"
    />
  </svg>
);

export function FigmaCaptureButton({
  captureId = '',
  endpoint = '',
  selector = 'body',
  label = 'Capture to Figma',
  className,
  style,
  captureScriptUrl = DEFAULT_SCRIPT_URL
}: FigmaCaptureButtonProps) {
  const { ready, error: preloadError } = useFigmaCaptureReady(captureScriptUrl);
  const [clickError, setClickError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const combinedStyle = useMemo(() => ({ ...baseButtonStyle, ...style }), [style]);

  const handleClick = useCallback(async () => {
    setBusy(true);
    setClickError(null);

    try {
      const api = await ensureCaptureApi(captureScriptUrl);
      await api.captureForDesign({
        captureId,
        endpoint,
        selector
      });
    } catch (error) {
      setClickError(toErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [captureId, captureScriptUrl, endpoint, selector]);

  const disabled = busy || !ready;
  const errorMessage = preloadError ?? clickError;

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        style={combinedStyle}
        className={className}
        disabled={disabled}
        aria-label="Capture page to Figma"
        title={errorMessage ?? (disabled ? 'Preparing Figma capture...' : 'Capture current window into Figma')}
      >
        {figmaMark}
        <span>{busy ? 'Capturing...' : label}</span>
      </button>
      {errorMessage ? <div style={errorBubbleStyle}>{errorMessage}</div> : null}
    </>
  );
}

export function FigmaCaptureDevButton() {
  if (!import.meta.env.DEV) {
    return null;
  }

  return (
    <FigmaCaptureButton
      captureId={import.meta.env.VITE_FIGMA_CAPTURE_ID}
      endpoint={import.meta.env.VITE_FIGMA_CAPTURE_ENDPOINT}
      selector={import.meta.env.VITE_FIGMA_CAPTURE_SELECTOR || 'body'}
      captureScriptUrl={import.meta.env.VITE_FIGMA_CAPTURE_SCRIPT_URL}
    />
  );
}
