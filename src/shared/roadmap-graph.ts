import type {
  RoadmapGraph,
  RoadmapGraphEdge,
  RoadmapGraphNode,
  RoadmapGraphNodeReference,
  RoadmapGraphNodeState,
  RoadmapIssueNode,
  RoadmapResult
} from './roadmap-api';
import { roadmapDependencyCycle, roadmapIssueKey } from './roadmap-model';

const maximumGraphPaths = 100_000;

function referenceKey(reference: RoadmapGraphNodeReference) {
  return `${reference.repository.toLowerCase()}#${reference.number}`;
}

function nodeReference(issue: RoadmapIssueNode['issue']): RoadmapGraphNodeReference {
  return {
    number: issue.number,
    repository: issue.fullName
  };
}

function compareReferences(
  left: RoadmapGraphNodeReference,
  right: RoadmapGraphNodeReference
) {
  const repository = left.repository.toLowerCase().localeCompare(
    right.repository.toLowerCase(),
    'en'
  );
  if (repository !== 0) return repository;
  const exactRepository = left.repository.localeCompare(right.repository, 'en');
  return exactRepository || left.number - right.number;
}

function comparePaths(
  left: readonly RoadmapGraphNodeReference[],
  right: readonly RoadmapGraphNodeReference[]
) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareReferences(
      left[index] as RoadmapGraphNodeReference,
      right[index] as RoadmapGraphNodeReference
    );
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function graphNodeState(
  node: RoadmapIssueNode,
  activeIssueKeys: ReadonlySet<string>
): RoadmapGraphNodeState {
  if (node.state === 'closed') return 'DONE';
  if (activeIssueKeys.has(roadmapIssueKey(node.issue))) return 'ACTIVE';
  return node.availability === 'ready' ? 'READY' : 'WAIT';
}

function graphPaths(
  nodes: readonly RoadmapGraphNode[],
  edges: readonly RoadmapGraphEdge[]
) {
  const references = new Map(nodes.map((node) => [
    referenceKey(node),
    { number: node.number, repository: node.repository }
  ]));
  const incoming = new Map(nodes.map((node) => [referenceKey(node), 0]));
  const outgoing = new Map<string, RoadmapGraphNodeReference[]>();
  for (const edge of edges) {
    const fromKey = referenceKey(edge.from);
    const toKey = referenceKey(edge.to);
    outgoing.set(fromKey, [...(outgoing.get(fromKey) ?? []), edge.to]);
    incoming.set(toKey, (incoming.get(toKey) ?? 0) + 1);
  }
  outgoing.forEach((targets) => targets.sort(compareReferences));
  const roots = nodes
    .filter((node) => incoming.get(referenceKey(node)) === 0)
    .map((node) => references.get(referenceKey(node)) as RoadmapGraphNodeReference)
    .sort(compareReferences);
  const paths: RoadmapGraphNodeReference[][] = [];
  const walk = (
    current: RoadmapGraphNodeReference,
    path: RoadmapGraphNodeReference[]
  ) => {
    const targets = outgoing.get(referenceKey(current)) ?? [];
    if (targets.length === 0) {
      if (paths.length >= maximumGraphPaths) {
        throw new Error('The roadmap has too many complete dependency paths to render safely.');
      }
      paths.push(path);
      return;
    }
    for (const target of targets) {
      walk(target, [...path, target]);
    }
  };
  for (const root of roots) walk(root, [root]);
  return paths.sort(comparePaths);
}

export function buildRoadmapGraph(result: RoadmapResult): RoadmapGraph {
  if (result.status !== 'connected') {
    throw new Error(result.message ?? 'The roadmap is not connected to GitHub.');
  }
  if (roadmapDependencyCycle(result.dependencies)) {
    throw new Error('The roadmap dependency graph contains a cycle.');
  }
  const activeIssueKeys = new Set(
    result.plan.items
      .filter((item) => item.plannedState === 'active')
      .map((item) => roadmapIssueKey(item.issue))
  );
  const nodes = result.issues
    .map<RoadmapGraphNode>((node) => ({
      ...nodeReference(node.issue),
      state: graphNodeState(node, activeIssueKeys),
      title: node.title,
      ...(node.issue.url ? { url: node.issue.url } : {})
    }))
    .sort(compareReferences);
  const nodesByIssueKey = new Map(
    result.issues.map((node) => [
      roadmapIssueKey(node.issue),
      nodes.find((candidate) => (
        referenceKey(candidate) === referenceKey(nodeReference(node.issue))
      ))
    ])
  );
  const edgeMap = new Map<string, RoadmapGraphEdge>();
  for (const dependency of result.dependencies) {
    const from = nodesByIssueKey.get(roadmapIssueKey(dependency.blocker));
    const to = nodesByIssueKey.get(roadmapIssueKey(dependency.blocked));
    if (!from || !to) {
      throw new Error('The roadmap dependency graph refers to an issue that was not loaded.');
    }
    const edge = {
      from: { number: from.number, repository: from.repository },
      satisfied: from.state === 'DONE',
      to: { number: to.number, repository: to.repository }
    };
    edgeMap.set(`${referenceKey(edge.from)}>${referenceKey(edge.to)}`, edge);
  }
  const edges = [...edgeMap.values()].sort((left, right) => (
    compareReferences(left.from, right.from)
    || compareReferences(left.to, right.to)
  ));
  return {
    dependencyFreshness: result.dependencySync,
    edges,
    graphRevision: result.graphRevision,
    nodes,
    paths: graphPaths(nodes, edges),
    repository: result.repository.fullName
  };
}
