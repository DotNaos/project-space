import { useAuth, useClerk, useSignIn, useUser } from '@clerk/react';
import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  ExternalLink,
  FolderKanban,
  GitBranch,
  GitPullRequestDraft,
  LoaderCircle,
  Play,
  RefreshCw,
  Rocket,
  Square,
  UserRound
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { projectSpaceClient, setProjectSpaceAuthTokenProvider } from '@/api/project-space-client';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
import { isClerkConfigured } from '@/auth/clerk-provider';
import { AccountMenu, type RailAccount } from '@/features/project-desktop/components/app-rail';
import type { PreviewHubCapacityCandidate, PreviewHubInventoryResult, PreviewHubMutationResult, PreviewHubRecord } from '@/shared/pull-request-preview-hub-api';
import { previewPullRequestNumberFromHostname } from '@/shared/preview-host';

type PreviewFilter = 'all' | 'passing' | 'failing' | 'draft';

const filterDefinitions: Array<{ id: PreviewFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'passing', label: 'Checks passing' },
  { id: 'failing', label: 'Checks failing' },
  { id: 'draft', label: 'Draft' }
];

function matchesFilter(preview: PreviewHubRecord, filter: PreviewFilter) {
  if (filter === 'passing') return preview.checksStatus === 'passing';
  if (filter === 'failing') return preview.checksStatus === 'failing';
  if (filter === 'draft') return Boolean(preview.isDraft);
  return true;
}

const checksStatusMeta: Record<NonNullable<PreviewHubRecord['checksStatus']>, { className: string; icon: typeof CircleCheck; label: string }> = {
  failing: { className: 'text-rose-300', icon: CircleX, label: 'Checks failing' },
  passing: { className: 'text-emerald-300', icon: CircleCheck, label: 'Checks passing' },
  pending: { className: 'text-amber-300', icon: Clock3, label: 'Checks pending' },
  unknown: { className: 'text-neutral-500', icon: CircleDashed, label: 'No checks reported' }
};

export function PreviewHubPage() {
  return <PreviewHubAuthBoundary>{(account) => <PreviewHubContent account={account} />}</PreviewHubAuthBoundary>;
}

function PreviewHubAuthBoundary({ children }: { children(account?: RailAccount): ReactNode }) {
  if (import.meta.env.VITE_PROJECT_SPACE_AUTH_DISABLED === '1') return <>{children(undefined)}</>;
  if (!isClerkConfigured()) return <HubLogin busy message="Project Space authentication is not configured." onSignIn={() => undefined} />;
  return <ClerkPreviewHubAuthBoundary>{children}</ClerkPreviewHubAuthBoundary>;
}

function ClerkPreviewHubAuthBoundary({ children }: { children(account?: RailAccount): ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const { signIn } = useSignIn();
  const { user } = useUser();
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    if (!isLoaded) return () => { active = false; };
    if (!isSignedIn) { setProjectSpaceAuthTokenProvider(null); setAuthenticated(false); return () => { active = false; }; }
    setProjectSpaceAuthTokenProvider(() => getToken());
    setAuthenticated(undefined);
    projectSpaceClient.getAuthSession().then((session) => { if (active) { setAuthenticated(session.authenticated); setMessage(session.authenticated ? '' : 'This account is not authorized.'); } }).catch(() => { if (active) { setAuthenticated(false); setMessage('Project Space could not verify this account.'); } });
    return () => { active = false; };
  }, [getToken, isLoaded, isSignedIn, user?.id]);
  const startSignIn = async () => {
    if (!signIn) return;
    setBusy(true); setMessage('');
    try {
      if (isSignedIn) await signOut();
      const { error } = await signIn.sso({ redirectCallbackUrl: '/sso-callback', redirectUrl: window.location.href, strategy: 'oauth_google' });
      if (error) { setBusy(false); setMessage(error.message || 'Could not start Google sign-in.'); }
    } catch (error) { setBusy(false); setMessage(error instanceof Error ? error.message : 'Could not start Google sign-in.'); }
  };
  if (authenticated) {
    const account: RailAccount = {
      email: user?.primaryEmailAddress?.emailAddress,
      imageUrl: user?.imageUrl,
      name: user?.fullName ?? undefined,
      onSignOut() { void signOut(); }
    };
    return <>{children(account)}</>;
  }
  return <HubLogin busy={busy || !isLoaded || (Boolean(isSignedIn) && authenticated === undefined)} message={message} onSignIn={() => void startSignIn()} />;
}

function HubLogin({ busy, message, onSignIn }: { busy: boolean; message?: string; onSignIn(): void }) {
  return <main className="grid min-h-screen place-items-center bg-app-canvas px-6 text-neutral-100"><div className="flex w-full max-w-sm flex-col items-center text-center"><div className="flex size-14 items-center justify-center rounded-2xl border border-neutral-800 bg-app-panel"><FolderKanban className="size-6" /></div><Text as="h1" className="mt-6 text-2xl font-semibold tracking-tight">Sign in to manage Previews</Text><Text as="p" className="mt-2 max-w-xs text-sm leading-relaxed text-neutral-400">The Preview hub is a trusted Project Space surface. Sign in before protected Preview inventory or actions are shown.</Text><Button fullWidth className="mt-8 rounded-xl bg-white text-neutral-950 hover:bg-neutral-200" isDisabled={busy} size="lg" onPress={onSignIn}>{busy ? 'Signing in…' : 'Continue with Google'}</Button>{message ? <Text as="p" className="mt-4 text-sm text-amber-300">{message}</Text> : null}</div></main>;
}

function PreviewHubContent({ account }: { account?: RailAccount }) {
  const [result, setResult] = useState<PreviewHubInventoryResult>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyPr, setBusyPr] = useState<number>();
  const [capacity, setCapacity] = useState<{ target: PreviewHubRecord; candidates: PreviewHubCapacityCandidate[]; revision: string }>();
  const [stopTarget, setStopTarget] = useState<PreviewHubRecord>();
  const [filter, setFilter] = useState<PreviewFilter>('all');
  const automaticOpenKey = useRef<string | undefined>(undefined);
  const previewPrFromHost = previewPullRequestNumberFromHostname(window.location.hostname);
  const selectedPr = Number(new URLSearchParams(window.location.search).get('pr') ?? '') || previewPrFromHost;
  const returnTarget = new URLSearchParams(window.location.search).get('return') ?? (previewPrFromHost ? `${window.location.pathname}${window.location.search}` : undefined);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setResult(await projectSpaceClient.getPullRequestPreviewHub()); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Preview inventory could not be loaded.'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const selected = useMemo(() => result?.previews.find((preview) => preview.pullRequestNumber === selectedPr), [result, selectedPr]);
  const openPreviews = useMemo(() => (result?.previews ?? []).filter((preview) => preview.pullRequestState === 'open'), [result]);
  const filterCounts = useMemo(() => Object.fromEntries(
    filterDefinitions.map(({ id }) => [id, openPreviews.filter((preview) => matchesFilter(preview, id)).length])
  ) as Record<PreviewFilter, number>, [openPreviews]);
  const filteredPreviews = useMemo(
    () => (result?.previews ?? []).filter((preview) => matchesFilter(preview, filter)),
    [result, filter]
  );
  const open = useCallback(async (target: PreviewHubRecord) => {
    if (!target.previewUrl) return;
    setBusyPr(target.pullRequestNumber); setError('');
    try {
      await projectSpaceClient.establishPullRequestPreviewAccess(target.pullRequestNumber);
      window.location.assign(
        returnTarget
          ? previewReturnToPreviewOrigin(returnTarget, target.pullRequestNumber)
          : target.previewUrl
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Preview access was not granted; the trusted hub kept you here.');
      setBusyPr(undefined);
    }
  }, [returnTarget]);
  useEffect(() => {
    if (
      !returnTarget ||
      !selected?.previewUrl ||
      selected.lifecycle !== 'online' ||
      !selected.allowedActions.includes('open')
    ) return;
    const key = `${selected.pullRequestNumber}:${selected.verifiedRunningHeadSha ?? ''}:${returnTarget}`;
    if (automaticOpenKey.current === key) return;
    automaticOpenKey.current = key;
    void open(selected);
  }, [open, returnTarget, selected]);
  async function start(target: PreviewHubRecord, replacement?: PreviewHubCapacityCandidate) {
    setBusyPr(target.pullRequestNumber); setError('');
    try {
      const response = await projectSpaceClient.startPullRequestPreview({
        inventoryRevision: replacement ? capacity?.revision : undefined,
        pullRequestNumber: target.pullRequestNumber,
        repositoryFullName: target.repositoryFullName,
        requestedHeadSha: target.requestedHeadSha,
        returnTarget,
        selectedReplacementPullRequestNumber: replacement?.pullRequestNumber,
        selectedReplacementRepositoryFullName: replacement?.repositoryFullName,
        selectedReplacementHeadSha: replacement?.requestedHeadSha
      });
      if (response.code === 'capacity_requires_choice') { setCapacity({ candidates: response.online, revision: response.inventoryRevision, target }); return; }
      if (response.code !== 'accepted') { setError(response.message); return; }
      await load();
      const pollUntilOnline = async () => {
        const next = await projectSpaceClient.getPullRequestPreviewHub();
        setResult(next);
        const online = next.previews.find((preview) => preview.pullRequestNumber === target.pullRequestNumber && preview.lifecycle === 'online' && preview.verifiedRunningHeadSha === target.requestedHeadSha);
        if (online?.previewUrl) {
          try {
            await projectSpaceClient.establishPullRequestPreviewAccess(target.pullRequestNumber);
            window.location.assign(returnTarget ? previewReturnToPreviewOrigin(returnTarget, target.pullRequestNumber) : online.previewUrl);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Preview access was not granted; the trusted hub kept you here.');
          }
          return;
        }
        if (next.previews.some((preview) => preview.pullRequestNumber === target.pullRequestNumber && preview.lifecycle === 'failed')) { setError('Preview start failed. The trusted hub kept you here with the exact failure state.'); return; }
        window.setTimeout(() => void pollUntilOnline(), 2_000);
      };
      void pollUntilOnline();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Preview start failed.'); }
    finally { setBusyPr(undefined); }
  }
  async function stop(target: PreviewHubRecord) {
    setBusyPr(target.pullRequestNumber); setError('');
    try { const response = await projectSpaceClient.stopPullRequestPreview({ pullRequestNumber: target.pullRequestNumber, repositoryFullName: target.repositoryFullName, requestedHeadSha: target.requestedHeadSha }); if (response.code !== 'accepted' && 'message' in response) setError(response.message); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Preview stop failed.'); } finally { setBusyPr(undefined); }
  }
  const statusLine = loading && !result
    ? 'Checking capacity…'
    : result
      ? `${result.onlineCount} of ${result.maxOnline} online · ${openPreviews.length} open pull request${openPreviews.length === 1 ? '' : 's'}`
      : 'Capacity unknown';

  return <main className="min-h-screen bg-app-canvas px-4 py-8 text-neutral-100 sm:px-8">
    <div className="mx-auto max-w-5xl">
      {account ? <div className="mb-3 flex justify-end"><AccountMenu account={account} placement="bottom end" /></div> : null}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800/80 pb-4">
        <div>
          <Text as="p" className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Project Space / trusted runtime</Text>
          <Text as="h1" className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Pull request Previews</Text>
        </div>
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span>{statusLine}</span>
          <Button aria-label="Refresh Preview inventory" isDisabled={loading} isIconOnly size="sm" variant="ghost" onPress={() => void load()}>
            <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
        </div>
      </header>
      {selected ? <div className="mt-5 border border-sky-400/30 bg-sky-400/5 px-4 py-3 text-sm text-sky-100">PR #{selected.pullRequestNumber} is selected. Project Space will open the requested app path after exact-head access is verified.</div> : null}
      {error ? <div className="mt-5 flex items-start gap-2 border border-rose-400/30 px-4 py-3 text-sm text-rose-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</div> : null}
      {loading && !result
        ? <div className="py-12 text-sm text-neutral-500">Loading authorized Preview inventory…</div>
        : result?.status !== 'available'
          ? <div className="py-12 text-sm text-amber-200">{previewInventoryStatusMessage(result?.status)}</div>
          : <>
            <div className="mt-6 flex flex-wrap gap-2">
              {filterDefinitions.map(({ id, label }) => <FilterChip active={filter === id} count={filterCounts[id]} id={id} key={id} label={label} onSelect={setFilter} />)}
            </div>
            <div className="mt-4 divide-y divide-neutral-800/80 border-y border-neutral-800/80">
              {result.previews.length === 0
                ? <div className="py-10 text-sm text-neutral-500">No open pull requests on this repository right now.</div>
                : filteredPreviews.length === 0
                  ? <div className="flex flex-col items-start gap-2 py-10 text-sm text-neutral-500">
                    <span>No pull requests match this filter.</span>
                    <Button size="sm" variant="ghost" onPress={() => setFilter('all')}>Clear filter</Button>
                  </div>
                  : filteredPreviews.map((preview) => <PreviewRow
                    busy={busyPr === preview.pullRequestNumber}
                    highlighted={preview.pullRequestNumber === selectedPr}
                    key={`${preview.repositoryFullName}:${preview.pullRequestNumber}`}
                    onOpen={() => void open(preview)}
                    onStart={() => void start(preview)}
                    onStop={() => setStopTarget(preview)}
                    preview={preview}
                  />)}
            </div>
          </>}
      {capacity ? <CapacityDialog busy={busyPr === capacity.target.pullRequestNumber} candidates={capacity.candidates} onCancel={() => setCapacity(undefined)} onConfirm={(candidate) => { setCapacity(undefined); void start(capacity.target, candidate); }} target={capacity.target} /> : null}
      {stopTarget ? <StopDialog busy={busyPr === stopTarget.pullRequestNumber} onCancel={() => setStopTarget(undefined)} onConfirm={() => { const target = stopTarget; setStopTarget(undefined); void stop(target); }} target={stopTarget} /> : null}
    </div>
  </main>;
}

function previewReturnToPreviewOrigin(value: string, pullRequestNumber: number) {
  if (value.length > 2_048 || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f\u007f]/.test(value)) return `https://pr-${pullRequestNumber}.projects.os-home.net/`;
  try {
    const target = new URL(value, `https://pr-${pullRequestNumber}.projects.os-home.net`);
    if (target.origin !== `https://pr-${pullRequestNumber}.projects.os-home.net` || target.hash) return `https://pr-${pullRequestNumber}.projects.os-home.net/`;
    return `${target.origin}${target.pathname}${target.search}`;
  } catch { return `https://pr-${pullRequestNumber}.projects.os-home.net/`; }
}

function previewInventoryStatusMessage(status: PreviewHubInventoryResult['status'] | undefined) {
  if (status === 'unauthorized') return 'This repository is not linked, or you do not have access to its trusted Preview inventory.';
  return 'Preview inventory is temporarily unavailable. Try refreshing in a moment.';
}

function FilterChip({ active, count, id, label, onSelect }: { active: boolean; count: number; id: PreviewFilter; label: string; onSelect(id: PreviewFilter): void }) {
  return <button
    aria-pressed={active}
    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
      active
        ? 'border-neutral-100 bg-neutral-100 text-neutral-950'
        : 'border-neutral-800 bg-transparent text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
    }`}
    onClick={() => onSelect(id)}
    type="button"
  >
    {label}
    <span className="opacity-70">({count})</span>
  </button>;
}

function StopDialog({ busy, onCancel, onConfirm, target }: { busy: boolean; onCancel(): void; onConfirm(): void; target: PreviewHubRecord }) {
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"><div aria-modal="true" className="w-full max-w-md border border-neutral-700 bg-app-panel p-5 shadow-2xl" role="dialog"><Text as="h2" className="text-lg font-semibold">Stop PR #{target.pullRequestNumber}?</Text><Text className="mt-2 text-sm text-neutral-400">This takes the Preview offline and keeps its registered images ready for a later start. No other Preview will be stopped.</Text><div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onPress={onCancel}>Cancel</Button><Button isDisabled={busy} variant="outline" onPress={onConfirm}>Stop Preview</Button></div></div></div>;
}

function PreviewRow({ busy, highlighted, onOpen, onStart, onStop, preview }: { busy: boolean; highlighted: boolean; onOpen(): void; onStart(): void; onStop(): void; preview: PreviewHubRecord }) {
  const label = preview.lifecycle === 'online'
    ? 'Online'
    : preview.lifecycle === 'ready'
      ? 'Ready · offline'
      : preview.lifecycle === 'not_deployed'
        ? 'Not deployed'
        : preview.lifecycle[0].toUpperCase() + preview.lifecycle.slice(1);
  const sha = preview.requestedHeadSha ? preview.requestedHeadSha.slice(0, 8) : 'commit unavailable';
  const canOpen = preview.allowedActions.includes('open') && Boolean(preview.previewUrl);
  const canStart = preview.allowedActions.includes('start');
  const canDeploy = preview.allowedActions.includes('deploy');
  const canStop = preview.allowedActions.includes('stop');
  const checks = preview.checksStatus ? checksStatusMeta[preview.checksStatus] : undefined;
  const ChecksIcon = checks?.icon;

  return <article className={`grid gap-4 px-1 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-2 ${highlighted ? 'bg-sky-400/5' : ''}`}>
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Text className="font-mono text-xs text-neutral-500">#{preview.pullRequestNumber}</Text>
        <Text className="truncate text-sm font-medium text-neutral-100">{preview.pullRequestTitle ?? 'Pull request Preview'}</Text>
        {preview.isDraft ? <Chip className="inline-flex items-center gap-1 rounded-full border border-neutral-700 px-2 py-0.5 text-neutral-400" size="sm"><GitPullRequestDraft className="size-3" />Draft</Chip> : null}
        {checks && ChecksIcon ? <span className={`inline-flex items-center gap-1 text-xs ${checks.className}`} title={checks.label}><ChecksIcon className="size-3.5" />{checks.label}</span> : null}
        <span className="text-xs text-neutral-400">{label}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
        {preview.author ? <span className="inline-flex items-center gap-1.5">
          {preview.author.avatarUrl
            ? <img alt="" className="size-4 rounded-full" src={preview.author.avatarUrl} />
            : <UserRound className="size-3.5" />}
          {preview.author.login}
        </span> : null}
        {preview.headBranch ? <span className="inline-flex items-center gap-1 font-mono"><GitBranch className="size-3.5" />{preview.headBranch}</span> : null}
        <span className="font-mono">{sha}</span>
        {preview.lastVerifiedAt ? <span>verified {new Date(preview.lastVerifiedAt).toLocaleString()}</span> : null}
        {preview.safeStorageBytes ? <span>{Math.round(preview.safeStorageBytes / 1024 / 1024)} MB stored</span> : null}
      </div>
      {preview.failureMessage ? <Text className="mt-2 block text-xs text-rose-200">{preview.failureMessage}</Text> : null}
    </div>
    <div className="flex flex-wrap gap-2 sm:justify-end">
      {canOpen ? <Button size="sm" variant="ghost" onPress={onOpen}><ExternalLink className="size-4" />Open</Button> : null}
      {canStop ? <Button isDisabled={busy} size="sm" variant="outline" onPress={onStop}><Square className="size-4" />Stop</Button> : null}
      {canStart ? <Button isDisabled={busy} size="sm" onPress={onStart}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}Start</Button> : null}
      {canDeploy ? <Button isDisabled={busy} size="sm" onPress={onStart}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Rocket className="size-4" />}Deploy preview</Button> : null}
      {!canStop && !canOpen && !canStart && !canDeploy ? <span className="inline-flex items-center gap-2 px-2 text-xs text-neutral-500"><LoaderCircle className="size-4 animate-spin" />{label}</span> : null}
    </div>
  </article>;
}

function CapacityDialog({ busy, candidates, onCancel, onConfirm, target }: { busy: boolean; candidates: PreviewHubCapacityCandidate[]; onCancel(): void; onConfirm(candidate: PreviewHubCapacityCandidate): void; target: PreviewHubRecord }) {
  const [selected, setSelected] = useState<number>();
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"><div aria-modal="true" className="w-full max-w-lg border border-neutral-700 bg-app-panel p-5 shadow-2xl" role="dialog"><Text as="h2" className="text-lg font-semibold">Choose a Preview to stop</Text><Text className="mt-2 text-sm text-neutral-400">All three runtime slots are online. Project Space will not choose a replacement automatically. Confirm one running PR before starting #{target.pullRequestNumber}.</Text><div className="mt-5 divide-y divide-neutral-800 border-y border-neutral-800">{candidates.map((candidate) => <label className="flex cursor-pointer items-center gap-3 py-3" key={`${candidate.repositoryFullName}:${candidate.pullRequestNumber}`}><input checked={selected === candidate.pullRequestNumber} name="replacement" onChange={() => setSelected(candidate.pullRequestNumber)} type="radio" /><span className="min-w-0"><span className="block text-sm text-neutral-100">#{candidate.pullRequestNumber}</span><span className="block truncate text-xs text-neutral-500">{candidate.requestedHeadSha.slice(0, 8)} · {candidate.lastActivityAt ? `used ${new Date(candidate.lastActivityAt).toLocaleString()}` : 'last use unknown'}</span></span></label>)}</div><div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onPress={onCancel}>Cancel</Button><Button isDisabled={busy || selected === undefined} onPress={() => { const candidate = candidates.find((entry) => entry.pullRequestNumber === selected); if (candidate) onConfirm(candidate); }}>Stop selected and start</Button></div></div></div>;
}
