import type {
  GithubIdeaRecord,
  IdeaRecord,
  LocalIdeaDraftRecord
} from '@/shared/electron-api';

export interface IdeaQualityGate {
  hasDescription: boolean;
  hasIteration: boolean;
  hasTitle: boolean;
  isReady: boolean;
}

export interface IdeaPresentationRecord {
  createdAt: string;
  evolvesIdeaId?: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  githubLabels?: string[];
  githubState?: 'open' | 'closed';
  id: string;
  iteration: string;
  qualityGate: IdeaQualityGate;
  source: 'github' | 'local';
  title: string;
  updatedAt: string;
  body: string;
}

export interface EditableIdeaValues {
  body: string;
  evolvesIdeaId: string;
  iteration: string;
  title: string;
}

export function getIdeaQualityGate(values: {
  body: string;
  iteration: string;
  title: string;
}): IdeaQualityGate {
  const hasTitle = Boolean(values.title.trim());
  const hasDescription = Boolean(values.body.trim());
  const hasIteration = Boolean(values.iteration.trim());

  return {
    hasDescription,
    hasIteration,
    hasTitle,
    isReady: hasTitle && hasDescription && hasIteration
  };
}

export function toIdeaPresentationRecord(record: IdeaRecord): IdeaPresentationRecord {
  const qualityGate = getIdeaQualityGate(record);

  if (record.source === 'github') {
    return {
      body: record.body,
      createdAt: record.createdAt,
      evolvesIdeaId: record.evolvesIdeaId,
      githubIssueNumber: record.githubIssueNumber,
      githubIssueUrl: record.githubIssueUrl,
      githubLabels: record.githubLabels,
      githubState: record.githubState,
      id: record.id,
      iteration: record.iteration,
      qualityGate,
      source: 'github',
      title: record.title,
      updatedAt: record.updatedAt
    };
  }

  return {
    body: record.body,
    createdAt: record.createdAt,
    evolvesIdeaId: record.evolvesIdeaId,
    id: record.id,
    iteration: record.iteration,
    qualityGate,
    source: 'local',
    title: record.title,
    updatedAt: record.updatedAt
  };
}

export function toEditableIdeaValues(record?: IdeaPresentationRecord): EditableIdeaValues {
  return {
    body: record?.body ?? '',
    evolvesIdeaId: record?.evolvesIdeaId ?? '',
    iteration: record?.iteration ?? '',
    title: record?.title ?? ''
  };
}

export function applyIdeaValues(
  record: IdeaPresentationRecord,
  values: EditableIdeaValues
): IdeaPresentationRecord {
  const nextRecord = {
    ...record,
    body: values.body,
    evolvesIdeaId: values.evolvesIdeaId.trim() || undefined,
    iteration: values.iteration,
    title: values.title
  };

  return {
    ...nextRecord,
    qualityGate: getIdeaQualityGate(nextRecord)
  };
}

export function toLocalIdeaDraft(record: IdeaPresentationRecord): LocalIdeaDraftRecord {
  return {
    body: record.body,
    createdAt: record.createdAt,
    evolvesIdeaId: record.evolvesIdeaId,
    id: record.id,
    iteration: record.iteration,
    source: 'local',
    title: record.title,
    updatedAt: record.updatedAt
  };
}

export function toGithubIdea(record: IdeaPresentationRecord): GithubIdeaRecord {
  if (record.source !== 'github' || !record.githubIssueNumber || !record.githubIssueUrl) {
    throw new Error('Cannot convert a local draft into a GitHub idea payload.');
  }

  return {
    body: record.body,
    createdAt: record.createdAt,
    evolvesIdeaId: record.evolvesIdeaId,
    githubIssueNumber: record.githubIssueNumber,
    githubIssueUrl: record.githubIssueUrl,
    githubLabels: record.githubLabels ?? [],
    githubState: record.githubState ?? 'open',
    id: record.id,
    iteration: record.iteration,
    source: 'github',
    title: record.title,
    updatedAt: record.updatedAt
  };
}
