import { useEffect, useMemo, useState } from 'react';
import { Bot, Boxes, Play, RefreshCw } from 'lucide-react';
import { Button, Chip, ScrollShadow, Surface, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ConnectorOverviewResult,
  MachineRecord,
  ScopeDevboxAgent,
  ScopeDevboxJobRecord,
  ScopeDevboxOverviewResult
} from '@/shared/project-space-api';

interface ScopeDevboxJobPanelProps {
  connector: ConnectorOverviewResult;
  projectName: string;
  targetPath: string;
}

const codexModels = [
  { id: 'gpt-5.3-codex-spark', label: 'Codex Spark' },
  { id: 'gpt-5.3-codex', label: 'Codex' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.5', label: 'GPT-5.5' }
];

const geminiModels = [
  { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
];

const overviewFallback: ScopeDevboxOverviewResult = {
  defaultAgent: 'codex',
  defaultModel: 'gpt-5.3-codex-spark',
  devboxRepo: {
    exists: false,
    path: ''
  },
  jobs: []
};

function jobTone(status: ScopeDevboxJobRecord['status']) {
  if (status === 'passed') return 'success';
  if (status === 'failed' || status === 'rejected') return 'danger';
  if (status === 'running') return 'primary';
  return 'secondary';
}

function defaultTask(projectName: string) {
  return `Work on ${projectName}. Stay inside the scoped writable files. If the scope is too small, write a breach request and stop.`;
}

function parseWritableFiles(value: string) {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function MachineOption({ machine }: { machine: MachineRecord }) {
  return (
    <option value={machine.id}>
      {machine.name} - {machine.connector.status}
    </option>
  );
}

export function ScopeDevboxJobPanel({
  connector,
  projectName,
  targetPath
}: ScopeDevboxJobPanelProps) {
  const [overview, setOverview] = useState<ScopeDevboxOverviewResult>(overviewFallback);
  const [machineId, setMachineId] = useState('');
  const [agent, setAgent] = useState<ScopeDevboxAgent>('codex');
  const [model, setModel] = useState('gpt-5.3-codex-spark');
  const [task, setTask] = useState(() => defaultTask(projectName));
  const [writableFiles, setWritableFiles] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [lastJob, setLastJob] = useState<ScopeDevboxJobRecord>();

  const modelOptions = agent === 'gemini' ? geminiModels : codexModels;
  const selectedMachine = useMemo(
    () => connector.machines.find((machine) => machine.id === machineId),
    [connector.machines, machineId]
  );
  const canStart =
    Boolean(targetPath) &&
    Boolean(machineId) &&
    Boolean(task.trim()) &&
    overview.devboxRepo.exists &&
    selectedMachine?.connector.status === 'local' &&
    !isBusy;

  useEffect(() => {
    setTask((current) => current || defaultTask(projectName));
  }, [projectName]);

  useEffect(() => {
    const preferredMachine =
      connector.machines.find((machine) => machine.connector.status === 'local') ??
      connector.machines[0];

    if (preferredMachine && !connector.machines.some((machine) => machine.id === machineId)) {
      setMachineId(preferredMachine.id);
    }
  }, [connector.machines, machineId]);

  useEffect(() => {
    setModel(modelOptions[0]?.id ?? '');
  }, [agent]);

  async function refresh() {
    const nextOverview = await projectSpaceClient
      .getScopeDevboxOverview()
      .catch(() => overviewFallback);
    setOverview(nextOverview ?? overviewFallback);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function startJob() {
    setIsBusy(true);
    try {
      const job = await projectSpaceClient.startScopeDevboxJob({
        agent,
        machineId,
        model,
        repoPath: targetPath,
        task,
        writableFiles: parseWritableFiles(writableFiles)
      });

      setLastJob(job);
      await refresh();
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <Surface variant="tertiary" className="grid gap-3 rounded-lg border border-slate-800 bg-black/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Boxes className="size-4 text-slate-400" />
        <Text className="truncate text-sm font-semibold text-slate-100">Scoped jobs</Text>
        <Chip size="sm" variant={overview.devboxRepo.exists ? 'primary' : 'secondary'}>
          {overview.devboxRepo.exists ? 'devbox linked' : 'devbox missing'}
        </Chip>
        {selectedMachine ? (
          <Chip size="sm" variant={selectedMachine.connector.status === 'local' ? 'primary' : 'secondary'}>
            {selectedMachine.connector.status}
          </Chip>
        ) : null}
        <Button className="ml-auto" size="sm" variant="ghost" onPress={() => void refresh()}>
          <RefreshCw className="size-4" />
        </Button>
      </div>

      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <select
          value={machineId}
          onChange={(event) => setMachineId(event.target.value)}
          className="min-h-9 min-w-0 rounded-lg border border-slate-800 bg-slate-950/80 px-3 text-sm text-slate-100 outline-none focus:border-slate-500"
        >
          {connector.machines.length === 0 ? <option value="">No machines</option> : null}
          {connector.machines.map((machine) => (
            <MachineOption key={machine.id} machine={machine} />
          ))}
        </select>
        <select
          value={agent}
          onChange={(event) => setAgent(event.target.value as ScopeDevboxAgent)}
          className="min-h-9 min-w-0 rounded-lg border border-slate-800 bg-slate-950/80 px-3 text-sm text-slate-100 outline-none focus:border-slate-500"
        >
          <option value="codex">Codex CLI</option>
          <option value="gemini">Gemini CLI</option>
        </select>
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className="min-h-9 min-w-0 rounded-lg border border-slate-800 bg-slate-950/80 px-3 text-sm text-slate-100 outline-none focus:border-slate-500"
        >
          {modelOptions.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      <textarea
        value={task}
        onChange={(event) => setTask(event.target.value)}
        rows={3}
        className="min-h-20 resize-y rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
      />

      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
        <input
          value={writableFiles}
          onChange={(event) => setWritableFiles(event.target.value)}
          placeholder="Writable files, e.g. src/app.tsx, tests/app.test.ts"
          className="min-h-9 min-w-0 rounded-lg border border-slate-800 bg-slate-950/80 px-3 text-sm text-slate-100 outline-none focus:border-slate-500"
        />
        <Button
          size="sm"
          variant="primary"
          isDisabled={!canStart}
          onPress={() => void startJob()}
        >
          <Play className="size-4" />
          Start job
        </Button>
      </div>

      {selectedMachine && selectedMachine.connector.status !== 'local' ? (
        <Text className="text-xs text-amber-300">
          This machine is selectable, but it needs an online Project Space connector before it can run scoped jobs.
        </Text>
      ) : null}

      {lastJob ? (
        <Surface variant="primary" className="rounded-md px-3 py-2 text-sm text-sky-100">
          {lastJob.message ?? `Job ${lastJob.status}`} · {lastJob.id}
        </Surface>
      ) : null}

      <ScrollShadow className="max-h-36" hideScrollBar>
        <div className="grid gap-2">
          {overview.jobs.slice(0, 5).map((job) => (
            <Surface
              key={job.id}
              variant="secondary"
              className="grid gap-1 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Bot className="size-4 shrink-0 text-slate-500" />
                <Text className="truncate text-sm text-slate-100">
                  {job.machineName ?? job.machineId} · {job.agent} · {job.model}
                </Text>
                <Chip className="ml-auto" color={jobTone(job.status)} size="sm" variant="secondary">
                  {job.status}
                </Chip>
              </div>
              <Text className="truncate text-xs text-slate-500">{job.repoPath}</Text>
              {job.message ? <Text className="text-xs text-slate-400">{job.message}</Text> : null}
            </Surface>
          ))}
          {overview.jobs.length === 0 ? (
            <Text className="text-xs text-slate-500">No scoped jobs yet.</Text>
          ) : null}
        </div>
      </ScrollShadow>
    </Surface>
  );
}
