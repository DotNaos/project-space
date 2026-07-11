import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent
} from 'react';
import { createPortal } from 'react-dom';
import { ImageUp, Loader2, RotateCcw, X } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import type {
  ProjectChatHumanProfileRecord,
  ProjectChatProfileUpdateRequest,
  ProjectChatProfileUpdateResult
} from '@/shared/project-chat-api';
import { prepareProjectChatAvatar } from '../project-chat-avatar';
import {
  PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH,
  projectChatProfileUpdateRequest
} from '../project-chat-model';
import { ParticipantVisual } from './participant-visual';

export function ProjectChatProfileDrawer({
  onClose,
  onSave,
  open,
  profile
}: {
  onClose(): void;
  onSave(request: ProjectChatProfileUpdateRequest): Promise<ProjectChatProfileUpdateResult>;
  open: boolean;
  profile?: ProjectChatHumanProfileRecord;
}) {
  const [avatarUpdate, setAvatarUpdate] = useState<string | null | undefined>();
  const [displayName, setDisplayName] = useState('');
  const [displayNameTouched, setDisplayNameTouched] = useState(false);
  const [error, setError] = useState('');
  const [isPreparingImage, setIsPreparingImage] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const preparationRef = useRef({ request: 0, session: 0 });
  const profileAvailable = Boolean(profile);

  useEffect(() => {
    preparationRef.current = {
      request: 0,
      session: preparationRef.current.session + 1
    };
    setIsPreparingImage(false);
    if (!open || !profile) {
      return;
    }
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setAvatarUpdate(undefined);
    setDisplayName(profile.displayName);
    setDisplayNameTouched(false);
    setError('');
    setIsSaving(false);
    const animationFrame = requestAnimationFrame(() => nameInputRef.current?.focus());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      preparationRef.current = {
        request: 0,
        session: preparationRef.current.session + 1
      };
      cancelAnimationFrame(animationFrame);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open, profileAvailable]);

  useEffect(() => {
    if (open && profile && !displayNameTouched && !isSaving) {
      setDisplayName(profile.displayName);
    }
  }, [displayNameTouched, isSaving, open, profile?.displayName]);

  if (!open || !profile || typeof document === 'undefined') {
    return null;
  }
  const activeProfile = profile;

  const avatarPreview = avatarUpdate === undefined
    ? activeProfile.avatarUrl
    : avatarUpdate ?? activeProfile.defaultAvatarUrl;
  const canResetAvatar = avatarUpdate !== null && (
    typeof avatarUpdate === 'string' || activeProfile.avatarSource === 'custom'
  );

  function close() {
    preparationRef.current = {
      request: 0,
      session: preparationRef.current.session + 1
    };
    setIsPreparingImage(false);
    onClose();
  }

  async function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) {
      return;
    }
    const session = preparationRef.current.session;
    const request = preparationRef.current.request + 1;
    preparationRef.current.request = request;
    setError('');
    setIsPreparingImage(true);
    try {
      const preparedAvatar = await prepareProjectChatAvatar(file);
      if (
        preparationRef.current.session === session &&
        preparationRef.current.request === request
      ) {
        setAvatarUpdate(preparedAvatar);
      }
    } catch (imageError) {
      if (
        preparationRef.current.session === session &&
        preparationRef.current.request === request
      ) {
        setError(imageError instanceof Error ? imageError.message : 'The image could not be prepared.');
      }
    } finally {
      if (
        preparationRef.current.session === session &&
        preparationRef.current.request === request
      ) {
        setIsPreparingImage(false);
      }
    }
  }

  async function save() {
    let request: ProjectChatProfileUpdateRequest | undefined;
    try {
      request = projectChatProfileUpdateRequest(
        activeProfile,
        displayName,
        displayNameTouched,
        avatarUpdate
      );
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : 'The display name is invalid.');
      nameInputRef.current?.focus();
      return;
    }
    if (!request) {
      close();
      return;
    }
    setError('');
    setIsSaving(true);
    try {
      await onSave(request);
      close();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Your profile could not be saved.');
    } finally {
      setIsSaving(false);
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !isSaving) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) {
      return;
    }
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )].filter((element) => !element.hasAttribute('hidden'));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal((
    <div
      aria-describedby="project-chat-profile-description"
      aria-label="Edit Project Chat profile"
      aria-modal="true"
      className="fixed inset-0 z-[90]"
      onKeyDown={handleDialogKeyDown}
      ref={dialogRef}
      role="dialog"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70"
        onClick={isSaving ? undefined : close}
      />
      <section className="absolute inset-x-0 bottom-0 flex max-h-[min(42rem,calc(100dvh-1rem))] flex-col rounded-t-2xl border-t border-neutral-800 bg-neutral-950 shadow-2xl shadow-black motion-safe:transition-transform motion-reduce:transition-none min-[760px]:inset-y-0 min-[760px]:right-0 min-[760px]:left-auto min-[760px]:max-h-none min-[760px]:w-[22rem] min-[760px]:rounded-none min-[760px]:border-t-0 min-[760px]:border-l">
        <header className="flex shrink-0 items-start gap-3 border-b border-neutral-800 px-5 py-4">
          <div className="min-w-0 flex-1">
            <Text as="h2" className="block text-sm font-semibold text-neutral-100">
              Your chat identity
            </Text>
            <Text id="project-chat-profile-description" className="mt-1 block text-xs leading-5 text-neutral-400">
              This name and photo appear on your human messages. Agent identities remain separate.
            </Text>
          </div>
          <Button
            aria-label="Close profile editor"
            className="size-9 min-h-0 shrink-0"
            isDisabled={isSaving}
            isIconOnly
            onPress={close}
            size="sm"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="flex items-center gap-4">
            <ParticipantVisual
              avatarUrl={avatarPreview}
              displayName={displayName || activeProfile.defaultDisplayName}
              role="human"
              size={64}
            />
            <div className="min-w-0 flex-1">
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-neutral-700 px-3 text-xs font-medium text-neutral-100 hover:border-neutral-500 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-white/70">
                {isPreparingImage
                  ? <Loader2 className="size-4 animate-spin" />
                  : <ImageUp className="size-4" />}
                {isPreparingImage ? 'Preparing…' : 'Upload photo'}
                <input
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  disabled={isPreparingImage || isSaving}
                  onChange={(event) => void chooseAvatar(event)}
                  type="file"
                />
              </label>
              <button
                className="mt-1.5 flex min-h-9 items-center gap-1.5 rounded text-[11px] text-neutral-400 hover:text-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 disabled:opacity-40"
                disabled={isPreparingImage || isSaving || !canResetAvatar}
                onClick={() => setAvatarUpdate(null)}
                type="button"
              >
                <RotateCcw className="size-3.5" />
                {activeProfile.defaultAvatarUrl ? 'Use account photo' : 'Remove photo'}
              </button>
            </div>
          </div>

          <div className="mt-6">
            <div className="flex items-baseline justify-between gap-3">
              <label className="text-xs font-medium text-neutral-200" htmlFor="project-chat-display-name">
                Display name
              </label>
              <span className="font-mono text-[10px] text-neutral-500">
                {displayName.length}/{PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH}
              </span>
            </div>
            <input
              aria-describedby="project-chat-display-name-help"
              autoComplete="name"
              className="mt-2 h-11 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
              id="project-chat-display-name"
              maxLength={PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH}
              onChange={(event) => {
                setDisplayName(event.currentTarget.value);
                setDisplayNameTouched(true);
              }}
              ref={nameInputRef}
              value={displayName}
            />
            <Text id="project-chat-display-name-help" className="mt-2 block text-[11px] leading-5 text-neutral-400">
              Your mention handle stays stable when this name changes.
            </Text>
            <button
              className="mt-1 flex min-h-9 items-center gap-1.5 rounded text-[11px] text-neutral-400 hover:text-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
              onClick={() => {
                setDisplayName(activeProfile.defaultDisplayName);
                setDisplayNameTouched(true);
              }}
              type="button"
            >
              <RotateCcw className="size-3.5" />
              Use account name
            </button>
          </div>

          {error ? (
            <p aria-live="assertive" className="mt-4 text-xs leading-5 text-red-300" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-neutral-800 px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <Button isDisabled={isSaving} onPress={close} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            isDisabled={isSaving || isPreparingImage || !displayName.trim()}
            onPress={() => void save()}
            size="sm"
            variant="primary"
          >
            {isSaving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save profile
          </Button>
        </footer>
      </section>
    </div>
  ), document.body);
}
