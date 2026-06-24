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

const homebrewCommands = [
  'brew tap DotNaos/project-space https://github.com/DotNaos/project-space.git',
  'brew install project-space-connector',
  'brew services start project-space-connector'
];

const manualCommands = [
  'curl -L https://github.com/DotNaos/project-space/releases/latest/download/project-space-connector-darwin-arm64.tar.gz -o project-space-connector.tar.gz',
  'tar -xzf project-space-connector.tar.gz',
  './project-space-connector'
];

const tailscaleCommands = [
  'tailscale status',
  'tailscale serve --bg --yes 4173',
  'tailscale serve status --json'
];

function tokenClassName(token: string, isCommand: boolean) {
  if (/^https?:\/\//.test(token)) {
    return 'text-sky-300 underline decoration-sky-500/40 underline-offset-2';
  }

  if (isCommand) {
    return 'text-emerald-300';
  }

  if (token.startsWith('--') || token.startsWith('-')) {
    return 'text-violet-300';
  }

  if (/^[A-Z0-9_]+=/.test(token)) {
    return 'text-amber-300';
  }

  if (/^\d+$/.test(token)) {
    return 'text-fuchsia-300';
  }

  if (token.includes('/') || token.startsWith('.')) {
    return 'text-sky-200';
  }

  return 'text-slate-200';
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
    <div className="rounded-lg border border-slate-800 bg-black/35">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-3 py-2">
        <Text className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500">
          shell
        </Text>
        <Button size="sm" variant="ghost" className="text-slate-300" onPress={() => void copyCode()}>
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
    <Card variant="secondary" className="border border-slate-800 bg-slate-950/70">
      <Card.Header className="gap-3">
        <div className="flex items-center gap-2">
          <Surface
            variant="tertiary"
            className="flex size-9 items-center justify-center rounded-lg border border-slate-800 bg-black/25"
          >
            <Icon className="size-4 text-slate-300" />
          </Surface>
          <Chip size="sm" variant="secondary">
            {label}
          </Chip>
        </div>
        <Card.Title className="text-xl font-semibold tracking-tight text-slate-50">
          {title}
        </Card.Title>
      </Card.Header>
      <Card.Content className="gap-3">{children}</Card.Content>
    </Card>
  );
}

function GraphRow({ from, to }: { from: string; to: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
      <Text className="truncate text-sm text-slate-200">{from}</Text>
      <ArrowRight className="size-4 text-slate-500" />
      <Text className="truncate text-sm text-slate-200">{to}</Text>
    </div>
  );
}

export function ConnectorSetupPage() {
  return (
    <main className="min-h-screen bg-app-canvas px-8 py-8 text-slate-100">
      <div className="mx-auto grid max-w-6xl gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <a
            href="/"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-900"
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
          <h1 className="max-w-4xl text-4xl font-semibold tracking-tight text-slate-50">
            Connect this web UI to your Mac, VPS, and dev machines.
          </h1>
          <Text className="max-w-3xl text-base leading-7 text-slate-400">
            The connector runs on each trusted machine. It gives Project Space a safe local
            endpoint for projects, Git, terminal commands, Codex, Tailscale, deployments, and
            backups without putting direct filesystem access inside the hosted web app.
          </Text>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <StepCard icon={Download} label="1" title="Install">
            <Text className="text-sm leading-6 text-slate-400">
              Homebrew is the preferred path on macOS. It installs the connector command and can
              run it as a background service.
            </Text>
            <CommandBlock commands={homebrewCommands} />
          </StepCard>

          <StepCard icon={Network} label="2" title="Expose through Tailscale">
            <Text className="text-sm leading-6 text-slate-400">
              Keep the connector private to your tailnet. Tailscale Serve gives the Vercel UI an
              HTTPS endpoint that still stays inside your private network.
            </Text>
            <CommandBlock commands={tailscaleCommands} />
          </StepCard>

          <StepCard icon={Terminal} label="3" title="Use it from Project Space">
            <Text className="text-sm leading-6 text-slate-400">
              Open the web UI and point it at the connector endpoint. Local app mode can use
              localhost; hosted mode should use the Tailscale HTTPS URL.
            </Text>
            <CommandBlock
              commands={[
                'https://project-space-mu.vercel.app',
                'https://project-space-mu.vercel.app/?projectSpaceApi=https://your-machine.tailnet.ts.net'
              ]}
            />
          </StepCard>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <Card variant="secondary" className="border border-slate-800 bg-slate-950/70">
            <Card.Header className="gap-3">
              <Card.Title className="text-xl font-semibold tracking-tight text-slate-50">
                Manual download
              </Card.Title>
              <Card.Description className="text-sm text-slate-400">
                Use this when Homebrew is not available or you want to test a release directly.
              </Card.Description>
            </Card.Header>
            <Card.Content className="gap-3">
              <CommandBlock commands={manualCommands} />
              <a
                href="https://github.com/DotNaos/project-space/releases/latest"
                rel="noreferrer"
                target="_blank"
                className="inline-flex items-center gap-2 text-sm text-sky-300"
              >
                Open GitHub release downloads
                <ExternalLink className="size-4" />
              </a>
            </Card.Content>
          </Card>

          <Card variant="secondary" className="border border-slate-800 bg-slate-950/70">
            <Card.Header className="gap-3">
              <Card.Title className="text-xl font-semibold tracking-tight text-slate-50">
                How the graph guides you
              </Card.Title>
              <Card.Description className="text-sm text-slate-400">
                Project Space should route you to the next working node whenever one path is
                missing or blocked.
              </Card.Description>
            </Card.Header>
            <Card.Content className="gap-2">
              <GraphRow from="Vercel web UI" to="Connector install page" />
              <GraphRow from="Connector" to="Tailscale private endpoint" />
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
