import { useMemo } from 'react';
import { ArrowLeft, FileText, Info } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import type { MachineFileSystemFileResult } from '@/shared/project-space-api';
import { formatExplorerFileSize, formatExplorerModifiedDate } from './explorer-file-format';
import { homePathLabel } from './machine-explorer-model';

export function MachineExplorerFileViewer({
  file,
  homePath,
  onBack
}: {
  file: MachineFileSystemFileResult;
  homePath: string;
  onBack(): void;
}) {
  const lines = useMemo(() => (file.content ?? '').split('\n'), [file.content]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="sm" variant="ghost" onPress={onBack}>
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <FileText className="size-4 shrink-0 text-neutral-400" />
          <div className="min-w-0">
            <Text className="block truncate text-sm font-semibold text-neutral-100">{file.name}</Text>
            <Text className="block truncate text-xs text-neutral-500">
              {formatExplorerFileSize(file.sizeBytes)} · {formatExplorerModifiedDate(file.modifiedAt)}
            </Text>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onPress={() => void navigator.clipboard?.writeText(homePathLabel(file.path, homePath))}
        >
          Copy path
        </Button>
      </div>

      {file.status === 'error' ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div className="max-w-md">
            <Info className="mx-auto mb-3 size-5 text-amber-300" />
            <Text className="block text-sm font-medium text-neutral-200">File cannot be displayed</Text>
            <Text className="mt-1 block text-xs text-neutral-500">
              {file.message ?? 'This file is unavailable.'}
            </Text>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-black/25 font-mono text-[12px] leading-5">
          <div className="min-w-max py-3">
            {lines.map((line, index) => (
              <div key={`${index}-${line.slice(0, 24)}`} className="flex min-h-5">
                <span className="w-14 shrink-0 select-none border-r border-neutral-800 pr-3 text-right text-neutral-700">
                  {index + 1}
                </span>
                <span className="whitespace-pre px-4 text-neutral-300">{line || ' '}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-2 text-xs text-neutral-500">
        <span>{file.truncated ? 'Preview truncated at 5,000 lines.' : 'File contents are read-only.'}</span>
        <span>{lines.length} lines</span>
      </div>
    </div>
  );
}
