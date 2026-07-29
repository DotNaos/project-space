import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateGitHubIssueAttachment } from './github-issue-attachment-validation';
import { writeJson } from './project-space-http-response';

const ATTACHMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAXIMUM_ATTACHMENTS_PER_TURN = 3;
const ATTACHMENT_TTL_MS = 30 * 60 * 1000;

interface AttachmentRecord {
  expiresAt: number;
  mediaType: 'image/jpeg' | 'image/png';
  path: string;
}

export type PrototypeReviewCodexImagesHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<boolean>;

export class PrototypeReviewCodexImageStore {
  private readonly attachments = new Map<string, AttachmentRecord>();
  private readonly deleteRootOnClose: boolean;
  private readonly root: Promise<string>;

  constructor(
    private readonly authorize: () => Promise<void>,
    private readonly now = () => Date.now(),
    persistentRoot?: string
  ) {
    this.deleteRootOnClose = !persistentRoot;
    this.root = persistentRoot
      ? mkdir(persistentRoot, { mode: 0o700, recursive: true }).then(() => persistentRoot)
      : mkdtemp(join(tmpdir(), 'project-space-codex-images-'));
  }

  readonly handleRequest: PrototypeReviewCodexImagesHandler = async (
    request,
    response,
    url
  ) => {
    const match = url.pathname.match(
      /^\/api\/prototype-review\/codex-images(?:\/([0-9a-f-]+))?$/
    );
    if (!match) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await this.authorize();
      await this.removeExpired();
      const attachmentId = match[1];
      if (request.method === 'POST' && !attachmentId) {
        rejectQuery(url);
        const mediaType = imageMediaType(request.headers['content-type']);
        const bytes = await readBody(request);
        const validated = await validateGitHubIssueAttachment({
          bytes,
          declaredMediaType: mediaType
        });
        if (validated.mediaType !== 'image/png' && validated.mediaType !== 'image/jpeg') {
          throw new ImageRequestError(400, 'Only PNG and JPEG images are supported.');
        }
        const id = randomUUID();
        const root = await this.root;
        const path = join(root, `${id}.${validated.extension}`);
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        this.attachments.set(id, {
          expiresAt: this.now() + ATTACHMENT_TTL_MS,
          mediaType: validated.mediaType,
          path
        });
        writeJson(response, 201, {
          id,
          mediaType: validated.mediaType,
          previewUrl: `/api/prototype-review/codex-images/${id}`
        });
        return true;
      }
      if (request.method === 'GET' && attachmentId) {
        rejectQuery(url);
        const attachment = await this.require(attachmentId);
        const bytes = await readFile(attachment.path);
        response.statusCode = 200;
        response.setHeader('Content-Length', String(bytes.byteLength));
        response.setHeader('Content-Type', attachment.mediaType);
        response.end(bytes);
        return true;
      }
      if (request.method === 'DELETE' && attachmentId) {
        rejectQuery(url);
        await this.remove(attachmentId);
        response.statusCode = 204;
        response.end();
        return true;
      }
      throw new ImageRequestError(405, 'Method not allowed.');
    } catch (error) {
      const known = error instanceof ImageRequestError ? error : undefined;
      writeJson(response, known?.statusCode ?? 400, {
        error: known?.message ?? 'The image could not be attached.'
      });
      return true;
    }
  };

  async resolve(attachmentIds: readonly string[]) {
    if (
      attachmentIds.length === 0 ||
      attachmentIds.length > MAXIMUM_ATTACHMENTS_PER_TURN ||
      new Set(attachmentIds).size !== attachmentIds.length
    ) {
      throw new Error('The image attachments are invalid.');
    }
    await this.authorize();
    await this.removeExpired();
    return Promise.all(attachmentIds.map(async (id) => (await this.require(id)).path));
  }

  async close() {
    this.attachments.clear();
    if (this.deleteRootOnClose) {
      await rm(await this.root, { force: true, recursive: true });
    }
  }

  private async require(id: string) {
    if (!ATTACHMENT_ID_PATTERN.test(id)) {
      throw new ImageRequestError(404, 'Image not found.');
    }
    const cached = this.attachments.get(id);
    if (cached?.expiresAt && cached.expiresAt > this.now()) return cached;
    if (cached) {
      this.attachments.delete(id);
      await rm(cached.path, { force: true });
      throw new ImageRequestError(404, 'Image not found.');
    }
    const root = await this.root;
    for (const extension of ['png', 'jpg', 'jpeg'] as const) {
      const path = join(root, `${id}.${extension}`);
      try {
        const metadata = await stat(path);
        const expiresAt = metadata.mtimeMs + ATTACHMENT_TTL_MS;
        if (expiresAt <= this.now()) {
          await rm(path, { force: true });
          break;
        }
        const attachment: AttachmentRecord = {
          expiresAt,
          mediaType: extension === 'png' ? 'image/png' : 'image/jpeg',
          path
        };
        this.attachments.set(id, attachment);
        return attachment;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new ImageRequestError(404, 'Image not found.');
  }

  private async remove(id: string) {
    const attachment = await this.require(id);
    this.attachments.delete(id);
    await rm(attachment.path, { force: true });
  }

  private async removeExpired() {
    const now = this.now();
    for (const [id, attachment] of this.attachments) {
      if (attachment.expiresAt > now) continue;
      this.attachments.delete(id);
      await rm(attachment.path, { force: true });
    }
    const root = await this.root;
    for (const name of await readdir(root)) {
      if (!/^[0-9a-f-]{36}\.(?:jpe?g|png)$/.test(name)) continue;
      const path = join(root, name);
      try {
        const metadata = await stat(path);
        if (metadata.mtimeMs + ATTACHMENT_TTL_MS <= now) {
          await rm(path, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

class ImageRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAXIMUM_ATTACHMENT_BYTES) {
      throw new ImageRequestError(413, 'The image is larger than 5 MB.');
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new ImageRequestError(400, 'The image is empty.');
  return Buffer.concat(chunks);
}

function imageMediaType(value: string | string[] | undefined) {
  if (Array.isArray(value)) throw new ImageRequestError(400, 'The image type is invalid.');
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') {
    throw new ImageRequestError(400, 'Only PNG and JPEG images are supported.');
  }
  return mediaType;
}

function rejectQuery(url: URL) {
  if ([...url.searchParams].length > 0) {
    throw new ImageRequestError(400, 'The image request contains unsupported parameters.');
  }
}
