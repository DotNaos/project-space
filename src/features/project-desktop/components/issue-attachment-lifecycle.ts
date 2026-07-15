import {
  mayHaveReachedRemote,
  type IssueAttachmentDraft
} from './issue-attachment-model';

export interface IssueAttachmentPreviewUrlApi {
  createObjectUrl(image: Blob): string;
  revokeObjectUrl(url: string): void;
}

export interface IssueAttachmentLifecycleSnapshot {
  previewUrls: Readonly<Record<string, string>>;
  retainedStoredAttachmentCount: number;
}

function storedAttachmentKey(attachment: IssueAttachmentDraft) {
  return `${attachment.repositoryKey}\u0000${attachment.attachmentId}`;
}

export class IssueAttachmentLifecycle {
  readonly #api: IssueAttachmentPreviewUrlApi;
  readonly #maxPreviewCount: number;
  readonly #previewUrls = new Map<string, string>();
  readonly #retainedStoredAttachments = new Set<string>();
  readonly #baselineStoredAttachmentUrls = new Set<string>();
  readonly #removedBaselineStoredAttachmentUrls = new Set<string>();

  constructor(api: IssueAttachmentPreviewUrlApi, maxPreviewCount = 10) {
    if (!Number.isSafeInteger(maxPreviewCount) || maxPreviewCount <= 0) {
      throw new Error('The attachment preview limit must be a positive integer.');
    }
    this.#api = api;
    this.#maxPreviewCount = maxPreviewCount;
  }

  addPreview(attachmentId: string, image: Blob) {
    const nextUrl = this.#api.createObjectUrl(image);
    if (!nextUrl) return false;

    const previousUrl = this.#previewUrls.get(attachmentId);
    if (previousUrl) {
      this.#api.revokeObjectUrl(previousUrl);
      this.#previewUrls.delete(attachmentId);
    } else if (this.#previewUrls.size >= this.#maxPreviewCount) {
      const oldest = this.#previewUrls.entries().next().value as
        | [string, string]
        | undefined;
      if (oldest) {
        this.#previewUrls.delete(oldest[0]);
        this.#api.revokeObjectUrl(oldest[1]);
      }
    }

    this.#previewUrls.set(attachmentId, nextUrl);
    return true;
  }

  observeTransition(
    previous: readonly IssueAttachmentDraft[],
    next: readonly IssueAttachmentDraft[]
  ) {
    const nextIds = new Set(next.map((attachment) => attachment.attachmentId));
    let changed = false;

    for (const attachment of previous) {
      if (nextIds.has(attachment.attachmentId)) continue;

      if (mayHaveReachedRemote(attachment)) {
        const previousSize = this.#retainedStoredAttachments.size;
        this.#retainedStoredAttachments.add(storedAttachmentKey(attachment));
        changed ||= this.#retainedStoredAttachments.size !== previousSize;
      }
      changed = this.removePreview(attachment.attachmentId) || changed;
    }

    return changed;
  }

  setBaselineStoredAttachmentUrls(urls: readonly string[]) {
    this.#baselineStoredAttachmentUrls.clear();
    this.#removedBaselineStoredAttachmentUrls.clear();
    for (const url of urls) this.#baselineStoredAttachmentUrls.add(url);
  }

  observeStoredAttachmentUrls(urls: readonly string[]) {
    const currentUrls = new Set(urls);
    const removed = new Set(
      Array.from(this.#baselineStoredAttachmentUrls).filter(
        (url) => !currentUrls.has(url)
      )
    );
    if (
      removed.size === this.#removedBaselineStoredAttachmentUrls.size
      && Array.from(removed).every((url) =>
        this.#removedBaselineStoredAttachmentUrls.has(url)
      )
    ) {
      return false;
    }

    this.#removedBaselineStoredAttachmentUrls.clear();
    for (const url of removed) this.#removedBaselineStoredAttachmentUrls.add(url);
    return true;
  }

  removePreview(attachmentId: string) {
    const previewUrl = this.#previewUrls.get(attachmentId);
    if (!previewUrl) return false;
    this.#previewUrls.delete(attachmentId);
    this.#api.revokeObjectUrl(previewUrl);
    return true;
  }

  reset() {
    const changed = this.#previewUrls.size > 0
      || this.#retainedStoredAttachments.size > 0
      || this.#baselineStoredAttachmentUrls.size > 0
      || this.#removedBaselineStoredAttachmentUrls.size > 0;
    for (const previewUrl of this.#previewUrls.values()) {
      this.#api.revokeObjectUrl(previewUrl);
    }
    this.#previewUrls.clear();
    this.#retainedStoredAttachments.clear();
    this.#baselineStoredAttachmentUrls.clear();
    this.#removedBaselineStoredAttachmentUrls.clear();
    return changed;
  }

  snapshot(): IssueAttachmentLifecycleSnapshot {
    return {
      previewUrls: Object.fromEntries(this.#previewUrls),
      retainedStoredAttachmentCount:
        this.#retainedStoredAttachments.size
        + this.#removedBaselineStoredAttachmentUrls.size
    };
  }
}
