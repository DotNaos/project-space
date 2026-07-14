import { useEffect, useRef, useState } from 'react';

import { loadGitHubIssueAttachmentContent } from '../../../api/github-issue-attachment-content-client';

const maximumActiveLoads = 2;
const maximumQueuedLoads = 16;
let activeLoads = 0;
const queuedLoads: Array<() => void> = [];
const inFlightLoads = new Map<string, Promise<Blob>>();

function schedulePrivateImageLoad(task: () => Promise<Blob>) {
  return new Promise<Blob>((resolve, reject) => {
    const start = () => {
      activeLoads += 1;
      void Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeLoads -= 1;
          queuedLoads.shift()?.();
        });
    };

    if (activeLoads < maximumActiveLoads) {
      start();
      return;
    }
    if (queuedLoads.length >= maximumQueuedLoads) {
      reject(new Error('Too many issue images are waiting to load.'));
      return;
    }
    queuedLoads.push(start);
  });
}

export function loadPrivateIssueAttachmentOnce(
  key: string,
  load: () => Promise<Blob>
) {
  const current = inFlightLoads.get(key);
  if (current) return current;

  const promise = schedulePrivateImageLoad(load);
  inFlightLoads.set(key, promise);
  const clear = () => {
    if (inFlightLoads.get(key) === promise) inFlightLoads.delete(key);
  };
  void promise.then(clear, clear);
  return promise;
}

function useNearViewport() {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '320px 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { elementRef, nearViewport };
}

const imageClassName =
  'my-2 max-h-[36rem] max-w-full rounded-lg border border-neutral-800 object-contain';

export function AuthenticatedIssueAttachment({
  alt,
  markdownUrl,
  repositoryFullName
}: {
  alt: string;
  markdownUrl: string;
  repositoryFullName: string;
}) {
  const requestKey = `${repositoryFullName}\n${markdownUrl}`;
  const { elementRef, nearViewport } = useNearViewport();
  const [image, setImage] = useState<{
    failed?: boolean;
    requestKey: string;
    src?: string;
  }>({ requestKey });

  useEffect(() => {
    if (!nearViewport) return;
    let active = true;
    let objectUrl: string | undefined;
    setImage({ requestKey });

    void loadPrivateIssueAttachmentOnce(requestKey, () =>
      loadGitHubIssueAttachmentContent(markdownUrl, repositoryFullName)
    ).then((content) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(content);
      setImage({ requestKey, src: objectUrl });
    }).catch(() => {
      if (active) setImage({ failed: true, requestKey });
    });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [markdownUrl, nearViewport, repositoryFullName, requestKey]);

  const current = image.requestKey === requestKey ? image : { requestKey };
  return (
    <span ref={elementRef} className="my-2 block text-neutral-500">
      {current.src ? (
        <img
          alt={alt}
          className={imageClassName}
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={current.src}
        />
      ) : current.failed ? (
        `${alt} (image unavailable)`
      ) : (
        alt
      )}
    </span>
  );
}

export function ExternalIssueMarkdownImage({ alt, src }: { alt: string; src: string }) {
  const [loadRequested, setLoadRequested] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) return <span>{alt} (image unavailable)</span>;
  if (!loadRequested) {
    return (
      <button
        type="button"
        className="my-2 block rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-left text-xs text-neutral-400 transition hover:border-neutral-700 hover:text-neutral-200"
        onClick={() => setLoadRequested(true)}
      >
        Load external image: {alt}
      </button>
    );
  }

  return (
    <img
      alt={alt}
      className={imageClassName}
      decoding="async"
      loading="lazy"
      referrerPolicy="no-referrer"
      src={src}
      onError={() => setFailed(true)}
    />
  );
}
