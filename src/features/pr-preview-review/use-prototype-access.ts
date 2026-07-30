import { useEffect, useState } from 'react';

import {
  establishPrototypeAccess,
  prototypeAccessTargetUrl
} from '@/api/prototype-access-client';
import { projectSpaceClient } from '@/api/project-space-client';
import type { PrototypeReviewTarget } from './prototype-review-model';

const prototypeAccessRenewalMs = 20_000;

export function usePrototypeAccess(
  target: PrototypeReviewTarget | undefined,
  pullRequestNumber: number | undefined,
  changeId: string | undefined
) {
  const [state, setState] = useState<
    { error?: string; targetUrl?: string }
  >({});

  useEffect(() => {
    let active = true;
    let renewalTimer: number | undefined;
    setState({});
    if (!target || !pullRequestNumber) return () => {
      active = false;
    };
    const targetUrl = changeId
      ? prototypeAccessTargetUrl(target.url, changeId)
      : undefined;
    if (target.source === 'development-override') {
      setState(
        targetUrl
          ? { targetUrl }
          : { error: 'Choose an exact changelog Change before opening this prototype.' }
      );
      return () => {
        active = false;
      };
    }
    if (target.source === 'live') {
      const verifySession = async () => {
        try {
          const session = await projectSpaceClient.getAuthSession();
          if (!active) return;
          if (!session.authenticated) {
            setState({ error: 'Sign in before opening this live prototype.' });
            return;
          }
          if (!targetUrl) {
            setState({ error: 'Choose an exact changelog Change before opening this prototype.' });
            return;
          }
          setState({ targetUrl });
          renewalTimer = window.setTimeout(
            () => void verifySession(),
            prototypeAccessRenewalMs
          );
        } catch (error) {
          if (!active) return;
          setState({
            error: error instanceof Error
              ? error.message
              : 'Project Space could not verify this live prototype session.'
          });
        }
      };
      void verifySession();
      return () => {
        active = false;
        if (renewalTimer !== undefined) window.clearTimeout(renewalTimer);
      };
    }
    if (!changeId) {
      setState({ error: 'Choose an exact changelog Change before opening this prototype.' });
      return () => {
        active = false;
      };
    }
    const grant = async () => {
      try {
        await establishPrototypeAccess(target.url, pullRequestNumber, changeId, target.surfaceKind);
        if (!active) return;
        if (!targetUrl) {
          setState({ error: 'Project Space refused an untrusted prototype identity.' });
          return;
        }
        setState({ targetUrl });
        renewalTimer = window.setTimeout(() => void grant(), prototypeAccessRenewalMs);
      } catch (error) {
        if (!active) return;
        setState({
          error: error instanceof Error
            ? error.message
            : 'Project Space could not authorize this prototype.'
        });
      }
    };
    void grant();
    return () => {
      active = false;
      if (renewalTimer !== undefined) window.clearTimeout(renewalTimer);
    };
  }, [changeId, pullRequestNumber, target?.source, target?.surfaceKind, target?.url]);

  return state;
}
