import { useMemo, useState } from 'react';

import { Button, Input, Label, TextField } from 'heroui-native';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { ProjectInventory, ProjectInventoryItem } from '../../../data/project-inventory';

interface ProjectOverviewScreenProps {
  accountLabel: string;
  errorMessage: string | null;
  inventory: ProjectInventory;
  isRefreshing: boolean;
  onRefresh(): void;
  sourceLabel: string;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <View className="min-w-[96px] flex-1 border-r border-separator px-4 py-3 last:border-r-0">
      <Text className="text-2xl font-semibold text-foreground">{value}</Text>
      <Text className="mt-1 text-xs uppercase text-muted">{label}</Text>
    </View>
  );
}

function ProjectRow({ project }: { project: ProjectInventoryItem }) {
  return (
    <View className="border-b border-separator px-5 py-4">
      <View className="flex-row items-start justify-between gap-4">
        <View className="flex-1">
          <Text className="text-lg font-semibold text-foreground">{project.name}</Text>
          <Text className="mt-1 text-sm text-muted">{project.relativePath}</Text>
        </View>
        <View className="rounded-full bg-default px-3 py-1">
          <Text className="text-xs font-medium text-default-foreground">
            {project.dirty ? 'changed' : project.branch || 'clean'}
          </Text>
        </View>
      </View>

      <View className="mt-3 flex-row flex-wrap gap-2">
        {project.stack.length > 0 ? (
          project.stack.map((entry) => (
            <View key={entry} className="rounded-full bg-surface-secondary px-3 py-1">
              <Text className="text-xs text-surface-secondary-foreground">{entry}</Text>
            </View>
          ))
        ) : (
          <View className="rounded-full bg-surface-secondary px-3 py-1">
            <Text className="text-xs text-surface-secondary-foreground">Git project</Text>
          </View>
        )}
      </View>

      {project.lastCommit ? (
        <Text className="mt-3 text-sm leading-5 text-muted" numberOfLines={2}>
          {project.lastCommit}
        </Text>
      ) : null}

      {project.scripts.length > 0 ? (
        <Text className="mt-2 text-xs text-muted" numberOfLines={1}>
          scripts: {project.scripts.join(', ')}
        </Text>
      ) : null}
    </View>
  );
}

export function ProjectOverviewScreen({
  accountLabel,
  errorMessage,
  inventory,
  isRefreshing,
  onRefresh,
  sourceLabel,
}: ProjectOverviewScreenProps) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(inventory.projects.map((project) => project.category)))],
    [inventory.projects]
  );

  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return inventory.projects.filter((project) => {
      const categoryMatches =
        activeCategory === 'All' || project.category === activeCategory;
      const queryMatches =
        !normalizedQuery ||
        [
          project.name,
          project.relativePath,
          project.category,
          project.branch,
          project.stack.join(' '),
          project.lastCommit,
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery);

      return categoryMatches && queryMatches;
    });
  }, [activeCategory, inventory.projects, query]);

  const changedCount = inventory.projects.filter((project) => project.dirty).length;
  const mobileCount = inventory.projects.filter((project) =>
    project.stack.some((entry) => entry === 'React Native')
  ).length;

  const groupedProjects = useMemo(() => {
    const groups = new Map<string, ProjectInventoryItem[]>();
    for (const project of filteredProjects) {
      groups.set(project.category, [...(groups.get(project.category) ?? []), project]);
    }
    return Array.from(groups.entries());
  }, [filteredProjects]);

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 48 }}>
        <View className="px-5 pb-5 pt-7">
          <Text className="text-3xl font-semibold text-foreground">Project Space</Text>
          <Text className="mt-2 text-base leading-6 text-muted">
            Native overview of the projects on this workspace.
          </Text>
          <Text className="mt-3 text-sm text-muted">{accountLabel}</Text>
          <View className="mt-4 flex-row items-center justify-between gap-4">
            <View className="flex-1">
              <Text className="text-xs text-muted">
                {sourceLabel} · Updated {formatDate(inventory.generatedAt)}
              </Text>
            </View>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={isRefreshing}
              onPress={onRefresh}
            >
              {isRefreshing ? 'Refreshing' : 'Refresh'}
            </Button>
          </View>
          {errorMessage ? (
            <View className="mt-4 rounded-[18px] bg-surface-secondary px-4 py-3">
              <Text className="text-sm leading-5 text-muted">{errorMessage}</Text>
            </View>
          ) : null}
        </View>

        <View className="mx-5 flex-row overflow-hidden rounded-[18px] border border-separator bg-surface">
          <Stat label="Projects" value={inventory.projects.length} />
          <Stat label="Changed" value={changedCount} />
          <Stat label="Mobile" value={mobileCount} />
        </View>

        <View className="px-5 py-5">
          <TextField>
            <Label>Search projects</Label>
            <Input
              value={query}
              placeholder="Name, stack, branch, commit"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setQuery}
            />
          </TextField>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 20, paddingBottom: 8 }}
        >
          {categories.map((category) => (
            <Button
              key={category}
              size="sm"
              variant={category === activeCategory ? 'primary' : 'secondary'}
              onPress={() => setActiveCategory(category)}
            >
              {category}
            </Button>
          ))}
        </ScrollView>

        <View className="mt-4 border-t border-separator">
          {groupedProjects.length === 0 ? (
            <View className="px-5 py-10">
              <Text className="text-lg font-semibold text-foreground">No matches</Text>
              <Text className="mt-2 text-sm leading-6 text-muted">
                Adjust the search or switch back to all projects.
              </Text>
              <View className="mt-4">
                <Button variant="secondary" onPress={() => {
                  setQuery('');
                  setActiveCategory('All');
                }}>
                  Reset filters
                </Button>
              </View>
            </View>
          ) : (
            groupedProjects.map(([category, projects]) => (
              <View key={category}>
                <View className="bg-surface-secondary px-5 py-3">
                  <Text className="text-xs font-semibold uppercase text-muted">
                    {category} · {projects.length}
                  </Text>
                </View>
                {projects.map((project) => (
                  <Pressable key={project.path}>
                    <ProjectRow project={project} />
                  </Pressable>
                ))}
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}
