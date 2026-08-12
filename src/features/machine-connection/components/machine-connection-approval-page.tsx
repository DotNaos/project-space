import { useAuth, useClerk, useSignIn } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  CircleX,
  Clock3,
  Laptop,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { isClerkConfigured } from "@/auth/clerk-provider";
import { Button, Chip, Surface, Text } from "@/app/dotnaos-ui";
import {
  type ApprovalStatus,
  isAuthenticationError,
  type MachineConnectionApproval,
  type MachineConnectionDecision,
  parseMachineConnectionApproval,
  parseMachineConnectionDecision,
  readMachineConnectionResponse,
  shouldRefreshAfterDecisionError,
} from "./machine-connection-approval-client";

const localAuthDisabled =
  import.meta.env.VITE_PROJECT_SPACE_AUTH_DISABLED === "1";

function requestPath(requestId: string, action?: "approve" | "deny") {
  const encodedId = encodeURIComponent(requestId);
  return `/api/machine-connections/${encodedId}/${action ?? "approval"}`;
}

async function machineConnectionRequest<Result>(
  requestId: string,
  token: string | null,
  parse: (payload: unknown) => Result,
  action?: MachineConnectionDecision,
) {
  const response = await fetch(requestPath(requestId, action), {
    headers: token
      ? { Accept: "application/json", Authorization: `Bearer ${token}` }
      : { Accept: "application/json" },
    method: action ? "POST" : "GET",
  });
  return readMachineConnectionResponse(
    response,
    parse,
    action
      ? "Could not update this machine connection request."
      : "Could not load this machine connection request.",
  );
}

function machinePlatform(machine: MachineConnectionApproval) {
  const operatingSystem = {
    darwin: "macOS",
    linux: "Linux",
    windows: "Windows",
  }[machine.operatingSystem];
  return `${operatingSystem} · ${machine.architecture}`;
}

function ApprovalFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-app-canvas px-6 py-12 text-neutral-100">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-20%] h-[28rem] w-[46rem] -translate-x-1/2 rounded-full bg-neutral-50/[0.05] blur-[130px]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-neutral-700/70 to-transparent" />
      </div>

      <div className="relative w-full max-w-xl">
        <a
          href="/environments/setup"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-neutral-500 transition hover:text-neutral-200"
        >
          <ChevronLeft className="size-4" />
          Environment setup
        </a>
        {children}
      </div>
    </main>
  );
}

function CenteredState({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: typeof LoaderCircle;
  title: string;
}) {
  return (
    <ApprovalFrame>
      <div
        aria-live="polite"
        className="flex flex-col items-center py-10 text-center"
        role="status"
      >
        <div className="flex size-14 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-950/70">
          <Icon className="size-6 text-neutral-200" strokeWidth={1.8} />
        </div>
        <Text
          as="h1"
          className="mt-6 text-2xl font-semibold tracking-tight text-neutral-50"
        >
          {title}
        </Text>
        <Text
          as="p"
          className="mt-2 max-w-md text-sm leading-6 text-neutral-400"
        >
          {description}
        </Text>
      </div>
    </ApprovalFrame>
  );
}

function ApprovalResult({
  status,
}: {
  status: Exclude<ApprovalStatus, "pending">;
}) {
  const result = {
    approved: {
      description:
        "Project Space approved this machine. Keep this page open until the terminal confirms that the connector is online.",
      icon: CheckCircle2,
      title: "Machine approved",
    },
    consumed: {
      description:
        "This approval was already used. The connected machine can now be managed from Project Space.",
      icon: CheckCircle2,
      title: "Machine connected",
    },
    denied: {
      description:
        "This machine was not connected. You can close this page and start a new request from the terminal.",
      icon: CircleX,
      title: "Connection denied",
    },
    expired: {
      description:
        "For safety, connection requests expire quickly. Run project connect again to create a fresh request.",
      icon: Clock3,
      title: "Request expired",
    },
  }[status];

  return (
    <CenteredState
      description={result.description}
      icon={result.icon}
      title={result.title}
    />
  );
}

function MachineApproval({
  getToken,
  onUseAnotherAccount,
  requestId,
}: {
  getToken(): Promise<string | null>;
  onUseAnotherAccount?: () => Promise<string | null>;
  requestId: string;
}) {
  const [machine, setMachine] = useState<MachineConnectionApproval | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [decision, setDecision] = useState<MachineConnectionDecision | null>(
    null,
  );
  const [isChangingAccount, setIsChangingAccount] = useState(false);
  const [message, setMessage] = useState("");
  const [requiresAuthentication, setRequiresAuthentication] = useState(false);

  const loadRequest = useCallback(async () => {
    setIsLoading(true);
    setMachine(null);
    setMessage("");
    setRequiresAuthentication(false);
    try {
      const token = await getToken();
      setMachine(
        await machineConnectionRequest(
          requestId,
          token,
          parseMachineConnectionApproval,
        ),
      );
    } catch (error) {
      setRequiresAuthentication(isAuthenticationError(error));
      setMessage(
        error instanceof Error ? error.message : "Could not load this request.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [getToken, requestId]);

  useEffect(() => {
    void loadRequest();
  }, [loadRequest]);

  async function useAnotherAccount() {
    if (!onUseAnotherAccount) return;
    setIsChangingAccount(true);
    setMessage("");
    try {
      const nextMessage = await onUseAnotherAccount();
      if (nextMessage) setMessage(nextMessage);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not restart sign-in.",
      );
    } finally {
      setIsChangingAccount(false);
    }
  }

  async function decide(action: MachineConnectionDecision) {
    setDecision(action);
    setMessage("");
    setRequiresAuthentication(false);
    try {
      const token = await getToken();
      const result = await machineConnectionRequest(
        requestId,
        token,
        (payload) => parseMachineConnectionDecision(payload, action),
        action,
      );
      setMachine((current) =>
        current ? { ...current, status: result.status } : current,
      );
    } catch (error) {
      if (shouldRefreshAfterDecisionError(error)) {
        await loadRequest();
        return;
      }
      setRequiresAuthentication(isAuthenticationError(error));
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not update this request.",
      );
    } finally {
      setDecision(null);
    }
  }

  if (isLoading) {
    return (
      <CenteredState
        description="Checking the short-lived request before showing any machine details."
        icon={LoaderCircle}
        title="Checking connection request"
      />
    );
  }

  if (!machine) {
    return (
      <ApprovalFrame>
        <div
          aria-live="assertive"
          className="flex flex-col items-center py-10 text-center"
          role="alert"
        >
          <TriangleAlert className="size-7 text-amber-300" />
          <Text as="h1" className="mt-5 text-2xl font-semibold text-neutral-50">
            Request unavailable
          </Text>
          <Text
            as="p"
            className="mt-2 max-w-md text-sm leading-6 text-neutral-400"
          >
            {message || "This connection request could not be loaded."}
          </Text>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button
              isDisabled={isChangingAccount}
              variant="outline"
              onPress={() => void loadRequest()}
            >
              Try again
            </Button>
            {requiresAuthentication && onUseAnotherAccount ? (
              <Button
                isDisabled={isChangingAccount}
                variant="primary"
                onPress={() => void useAnotherAccount()}
              >
                {isChangingAccount ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : null}
                Use another account
              </Button>
            ) : null}
          </div>
        </div>
      </ApprovalFrame>
    );
  }

  if (machine.status !== "pending") {
    return <ApprovalResult status={machine.status} />;
  }

  return (
    <ApprovalFrame>
      <div className="flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-950/70">
          <Laptop className="size-5 text-neutral-100" strokeWidth={1.8} />
        </div>
        <div>
          <Chip size="sm" variant="primary">
            Project Space machine connection
          </Chip>
          <Text
            as="h1"
            className="mt-2 text-3xl font-semibold tracking-tight text-neutral-50"
          >
            Approve this machine?
          </Text>
          <Text
            as="p"
            className="mt-2 max-w-lg text-sm leading-6 text-neutral-400"
          >
            Only approve if you started{" "}
            <span className="font-mono text-neutral-200">project connect</span>{" "}
            on this machine.
          </Text>
        </div>
      </div>

      <Surface className="mt-8 overflow-hidden rounded-xl" variant="secondary">
        <div className="border-b border-neutral-800 px-5 py-4">
          <Text as="p" className="text-lg font-medium text-neutral-50">
            {machine.name}
          </Text>
          <Text as="p" className="mt-1 font-mono text-xs text-neutral-500">
            {machine.hostname}
          </Text>
        </div>
        <dl className="grid gap-px bg-neutral-800 sm:grid-cols-2">
          <div className="bg-neutral-950/90 px-5 py-4">
            <dt className="text-xs text-neutral-500">Platform</dt>
            <dd className="mt-1 text-sm text-neutral-200">
              {machinePlatform(machine)}
            </dd>
          </div>
          <div className="bg-neutral-950/90 px-5 py-4">
            <dt className="text-xs text-neutral-500">Project CLI</dt>
            <dd className="mt-1 text-sm text-neutral-200">
              {machine.clientVersion}
            </dd>
          </div>
        </dl>
      </Surface>

      <div className="mt-5 flex items-start gap-2 text-xs leading-5 text-neutral-500">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-neutral-400" />
        Approval creates a separate, revocable machine identity. It does not
        copy your Project Space login to the CLI.
      </div>

      {message ? (
        <div
          aria-live="assertive"
          className="mt-5 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-sm text-amber-100"
          role="alert"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {message}
        </div>
      ) : null}

      {requiresAuthentication && onUseAnotherAccount ? (
        <div className="mt-4 flex justify-end">
          <Button
            isDisabled={decision !== null || isChangingAccount}
            variant="outline"
            onPress={() => void useAnotherAccount()}
          >
            {isChangingAccount ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : null}
            Use another account
          </Button>
        </div>
      ) : null}

      <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button
          isDisabled={decision !== null}
          variant="ghost"
          onPress={() => void decide("deny")}
        >
          {decision === "deny" ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : null}
          Deny
        </Button>
        <Button
          isDisabled={decision !== null}
          size="lg"
          variant="primary"
          onPress={() => void decide("approve")}
        >
          {decision === "approve" ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <ShieldCheck className="size-4" />
          )}
          Approve machine
        </Button>
      </div>
    </ApprovalFrame>
  );
}

function ClerkMachineApproval({ requestId }: { requestId: string }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const { signIn } = useSignIn();
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [message, setMessage] = useState("");

  async function startSignIn(useAnotherAccount = false) {
    if (!signIn) return "Project Space sign-in is not ready yet.";
    setIsRedirecting(true);
    setMessage("");
    try {
      if (useAnotherAccount) await signOut();
      const redirectUrl = `/machines/connect?request=${encodeURIComponent(requestId)}`;
      const { error } = await signIn.sso({
        redirectCallbackUrl: "/sso-callback",
        redirectUrl,
        strategy: "oauth_google",
      });
      if (error) {
        const nextMessage = error.message || "Could not start sign-in.";
        setMessage(nextMessage);
        setIsRedirecting(false);
        return nextMessage;
      }
    } catch (error) {
      const nextMessage =
        error instanceof Error ? error.message : "Could not start sign-in.";
      setMessage(nextMessage);
      setIsRedirecting(false);
      return nextMessage;
    }
    return null;
  }

  if (!isLoaded) {
    return (
      <CenteredState
        description="Preparing the secure Project Space sign-in."
        icon={LoaderCircle}
        title="Loading"
      />
    );
  }

  if (!isSignedIn) {
    return (
      <ApprovalFrame>
        <div className="flex flex-col items-center py-8 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-950/70">
            <ShieldCheck
              className="size-6 text-neutral-100"
              strokeWidth={1.8}
            />
          </div>
          <Text
            as="h1"
            className="mt-6 text-2xl font-semibold tracking-tight text-neutral-50"
          >
            Sign in to review this machine
          </Text>
          <Text
            as="p"
            className="mt-2 max-w-sm text-sm leading-6 text-neutral-400"
          >
            Machine details stay hidden until Project Space has authenticated
            your browser session.
          </Text>
          <Button
            className="mt-7"
            isDisabled={isRedirecting}
            size="lg"
            variant="primary"
            onPress={() => void startSignIn()}
          >
            {isRedirecting ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : null}
            {isRedirecting ? "Opening sign-in…" : "Continue with Google"}
          </Button>
          {message ? (
            <Text
              aria-live="assertive"
              as="p"
              className="mt-4 text-sm text-amber-200"
              role="alert"
            >
              {message}
            </Text>
          ) : null}
        </div>
      </ApprovalFrame>
    );
  }

  return (
    <MachineApproval
      getToken={getToken}
      requestId={requestId}
      onUseAnotherAccount={() => startSignIn(true)}
    />
  );
}

export function MachineConnectionApprovalPage({
  requestId,
}: {
  requestId: string;
}) {
  if (localAuthDisabled) {
    return (
      <MachineApproval
        getToken={() => Promise.resolve(null)}
        requestId={requestId}
      />
    );
  }

  if (!isClerkConfigured()) {
    return (
      <CenteredState
        description="Project Space login is not configured on this server, so this machine cannot be approved."
        icon={TriangleAlert}
        title="Login unavailable"
      />
    );
  }

  return <ClerkMachineApproval requestId={requestId} />;
}
