import { useState } from 'react';
import { Button, Card, Chip, Surface, Text } from '@/app/dotnaos-ui';
import {
  ArrowRight,
  CheckCircle2,
  Check,
  Copy,
  Download,
  ExternalLink,
  Github,
  Home,
  Network,
  Terminal
} from 'lucide-react';
import { MachineConnectionApprovalPage } from './machine-connection-approval-page';

const manualCommands = [
  '# Download one exact machine-tools archive from the release page',
  'tar -xzf project-space-machine-tools-darwin-arm64-vX.Y.Z.tar.gz',
  './project-space-machine-tools-darwin-arm64-vX.Y.Z/install.sh',
  '~/.local/bin/project connect'
];

function tokenClassName(token: string, isCommand: boolean) {
  if (/^https?:\/\//.test(token)) {
    return 'text-neutral-200 underline decoration-neutral-500/40 underline-offset-2';
  }

  if (isCommand) {
    return 'font-semibold text-neutral-100';
  }

  if (token.startsWith('--') || token.startsWith('-')) {
    return 'text-neutral-400';
  }

  if (/^[A-Z0-9_]+=/.test(token)) {
    return 'text-neutral-300';
  }

  if (/^\d+$/.test(token)) {
    return 'text-neutral-300';
  }

  if (token.includes('/') || token.startsWith('.')) {
    return 'text-neutral-300';
  }

  return 'text-neutral-200';
}

function HighlightedLine({ line }: { line: string }) {
  let commandSeen = false;

  return (
    <>
      {line.split(/(\s+)/).map((token, index) => {
        if (!token.trim()) {
          return <span key={`${token}:${index}`}>{token}</span>;
        }

        const isCommand = !commandSeen;
        commandSeen = true;

        return (
          <span key={`${token}:${index}`} className={tokenClassName(token, isCommand)}>
            {token}
          </span>
        );
      })}
    </>
  );
}

function CommandBlock({ commands }: { commands: string[] }) {
  const [copied, setCopied] = useState(false);
  const code = commands.join('\n');

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = code;
      textArea.setAttribute('readonly', '');
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      textArea.remove();
    }
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 1400);
  }

  return (
    <div className="rounded-lg border border-neutral-800 bg-black/35">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-3 py-2">
        <Text className="font-mono text-[11px] uppercase tracking-[0.16em] text-neutral-500">
          shell
        </Text>
        <Button size="sm" variant="ghost" className="text-neutral-300" onPress={() => void copyCode()}>
          {copied ? <Check className="size-4 text-emerald-300" /> : <Copy className="size-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="overflow-x-auto overflow-y-hidden p-3">
        <pre className="m-0 min-w-max whitespace-pre font-mono text-xs leading-5">
          {commands.map((line, index) => (
            <span key={`${line}:${index}`} className="block">
              <HighlightedLine line={line} />
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

function StepCard({
  children,
  icon: Icon,
  label,
  title
}: {
  children: React.ReactNode;
  icon: typeof Download;
  label: string;
  title: string;
}) {
  return (
    <Card
      variant="secondary"
      className="min-w-0 overflow-hidden border border-neutral-800 bg-neutral-950/70"
    >
      <Card.Header className="gap-3">
        <div className="flex items-center gap-2">
          <Surface
            variant="tertiary"
            className="flex size-9 items-center justify-center rounded-lg border border-neutral-800 bg-black/25"
          >
            <Icon className="size-4 text-neutral-300" />
          </Surface>
          <Chip size="sm" variant="secondary">
            {label}
          </Chip>
        </div>
        <Card.Title className="text-xl font-semibold tracking-tight text-neutral-50">
          {title}
        </Card.Title>
      </Card.Header>
      <Card.Content className="gap-3">{children}</Card.Content>
    </Card>
  );
}

function GraphRow({ from, to }: { from: string; to: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2">
      <Text className="truncate text-sm text-neutral-200">{from}</Text>
      <ArrowRight className="size-4 text-neutral-500" />
      <Text className="truncate text-sm text-neutral-200">{to}</Text>
    </div>
  );
}

export function ConnectorSetupPage() {
  const connectionRequestId = new URLSearchParams(window.location.search).get('request')?.trim();

  if (connectionRequestId) {
    return <MachineConnectionApprovalPage requestId={connectionRequestId} />;
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-app-canvas px-4 py-8 text-neutral-100 sm:px-8">
      <div className="mx-auto grid min-w-0 max-w-6xl gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <a
            href="/"
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2 text-sm text-neutral-300 transition hover:bg-neutral-900"
          >
            <Home className="size-4" />
            Project Space
          </a>
          <div className="flex flex-wrap gap-2">
            <a href="https://github.com/DotNaos/project-space" rel="noreferrer" target="_blank">
              <Button variant="outline">
                <Github className="size-4" />
                GitHub
              </Button>
            </a>
            <a
              href="https://github.com/DotNaos/project-space/releases/latest"
              rel="noreferrer"
              target="_blank"
            >
              <Button variant="secondary">
                <Download className="size-4" />
                Latest release
              </Button>
            </a>
          </div>
        </div>

        <section className="grid gap-4">
          <Chip size="sm" variant="primary" className="w-fit">
            Project Space Connector
          </Chip>
          <h1 className="max-w-4xl break-words text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">
            Connect this web UI to your Mac, VPS, and dev machines.
          </h1>
          <Text className="max-w-3xl text-base leading-7 text-neutral-400">
            The connector runs on each trusted machine. It gives Project Space a safe local
            endpoint for projects, Git, Codex, deployments, and backups without putting direct
            filesystem access inside the hosted web app.
          </Text>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <StepCard icon={Download} label="1" title="Get the pinned installer">
            <Text className="text-sm leading-6 text-neutral-400">
              Sign in, open Machines → Add machine, and copy the generated command. It names one
              exact release and checksum instead of downloading a mutable latest build.
            </Text>
            <a href="/machines" className="w-fit">
              <Button variant="outline">
                Open Machines
                <ArrowRight className="size-4" />
              </Button>
            </a>
          </StepCard>

          <StepCard icon={Network} label="2" title="Install and approve">
            <Text className="text-sm leading-6 text-neutral-400">
              Run only that pinned command. It installs the integrity-checked managed bundle and
              starts project connect, which opens a short-lived approval page and creates the
              protected machine identity. No inbound endpoint is required.
            </Text>
            <Text className="text-xs leading-5 text-neutral-500">
              If you install an exact release manually, finish with
              {' '}<span className="font-mono text-neutral-300">project connect</span>.
            </Text>
          </StepCard>

          <StepCard icon={Terminal} label="3" title="Use it from Project Space">
            <Text className="text-sm leading-6 text-neutral-400">
              Open the web UI normally. The machine appears only after your signed-in approval and
              key proof complete; no API URL override is required.
            </Text>
            <CommandBlock commands={['https://projects.os-home.net']} />
          </StepCard>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <Card
            variant="secondary"
            className="min-w-0 overflow-hidden border border-neutral-800 bg-neutral-950/70"
          >
            <Card.Header className="gap-3">
              <Card.Title className="text-xl font-semibold tracking-tight text-neutral-50">
                Manual download
              </Card.Title>
              <Card.Description className="text-sm text-neutral-400">
                Prefer the pinned command from Machines → Add machine. For a direct release test,
                download one exact versioned bundle and then run project connect.
              </Card.Description>
            </Card.Header>
            <Card.Content className="gap-3">
              <CommandBlock commands={manualCommands} />
              <a
                href="https://github.com/DotNaos/project-space/releases/latest"
                rel="noreferrer"
                target="_blank"
                className="inline-flex items-center gap-2 text-sm text-neutral-200 underline decoration-neutral-500/40 underline-offset-2 hover:text-neutral-50"
              >
                Open GitHub release downloads
                <ExternalLink className="size-4" />
              </a>
            </Card.Content>
          </Card>

          <Card
            variant="secondary"
            className="min-w-0 overflow-hidden border border-neutral-800 bg-neutral-950/70"
          >
            <Card.Header className="gap-3">
              <Card.Title className="text-xl font-semibold tracking-tight text-neutral-50">
                How the graph guides you
              </Card.Title>
              <Card.Description className="text-sm text-neutral-400">
                Project Space should route you to the next working node whenever one path is
                missing or blocked.
              </Card.Description>
            </Card.Header>
            <Card.Content className="gap-2">
              <GraphRow from="Hosted web UI" to="Pinned managed installer" />
              <GraphRow from="Project connect" to="Signed-in approval" />
              <GraphRow from="Machines repo" to="Available dev machines" />
              <GraphRow from="Private VPS platform" to="Deployments and backups" />
              <div className="mt-2 flex items-center gap-2 text-sm text-emerald-300">
                <CheckCircle2 className="size-4" />
                Missing links become visible next actions instead of dead ends.
              </div>
            </Card.Content>
          </Card>
        </section>
      </div>
    </main>
  );
}
