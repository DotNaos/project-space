import { useEffect, useMemo, useState } from 'react';

import { Button, Checkbox, Input, Label, TextField } from 'heroui-native';
import { ScrollView, Text, View } from 'react-native';

import type { GitHubRepository, SelectedProject } from '../../../domain/models';

interface ProjectSelectionScreenProps {
  repositories: GitHubRepository[];
  selectedProjects: SelectedProject[];
  isLoading: boolean;
  errorMessage: string | null;
  onRefresh(): void;
  onContinue(projects: SelectedProject[]): void;
  onCancel(): void;
}

export function ProjectSelectionScreen({
  repositories,
  selectedProjects,
  isLoading,
  errorMessage,
  onRefresh,
  onContinue,
  onCancel,
}: ProjectSelectionScreenProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [workingProjects, setWorkingProjects] = useState<SelectedProject[]>(selectedProjects);

  useEffect(() => {
    setWorkingProjects(selectedProjects);
  }, [selectedProjects]);

  const filteredRepositories = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    if (!query) {
      return repositories;
    }

    return repositories.filter((repository) =>
      `${repository.name} ${repository.fullName} ${repository.description ?? ''}`
        .toLowerCase()
        .includes(query)
    );
  }, [repositories, searchQuery]);

  function toggleRepository(repository: GitHubRepository, isSelected: boolean) {
    setWorkingProjects((current) => {
      const exists = current.some(
        (project) => project.repository.id === repository.id
      );

      if (isSelected && !exists) {
        return [...current, { repository, groupName: '' }];
      }

      if (!isSelected) {
        return current.filter((project) => project.repository.id !== repository.id);
      }

      return current;
    });
  }

  function updateGroupName(repositoryId: number, groupName: string) {
    setWorkingProjects((current) =>
      current.map((project) =>
        project.repository.id === repositoryId
          ? { ...project, groupName }
          : project
      )
    );
  }

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-black/5 px-5 pb-4 pt-6">
        <Text className="text-3xl font-semibold text-foreground">
          Choose your projects
        </Text>
        <Text className="mt-2 text-base leading-6 text-muted">
          Tick the repositories you want. If you want groups, just give the selected
          repo a group name.
        </Text>

        <View className="mt-4 gap-3">
          <TextField>
            <Label>Search repositories</Label>
            <Input
              value={searchQuery}
              placeholder="Search by name"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setSearchQuery}
            />
          </TextField>
        </View>

        <View className="mt-4 flex-row gap-3">
          <Button variant="outline" className="flex-1" onPress={onCancel}>
            Back
          </Button>
          <Button variant="secondary" className="flex-1" onPress={onRefresh}>
            Refresh Repos
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            isDisabled={workingProjects.length === 0}
            onPress={() => {
              onContinue(
                workingProjects.map((project) => ({
                  ...project,
                  groupName: project.groupName.trim(),
                }))
              );
            }}
          >
            Continue
          </Button>
        </View>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 20, gap: 12 }}>
        {isLoading ? (
          <Text className="text-base text-muted">Loading repositories…</Text>
        ) : null}

        {errorMessage ? (
          <View className="rounded-[20px] bg-[#fff1eb] px-4 py-4">
            <Text className="text-sm font-medium text-[#8a2d0b]">{errorMessage}</Text>
          </View>
        ) : null}

        {filteredRepositories.map((repository) => {
          const selectedProject = workingProjects.find(
            (project) => project.repository.id === repository.id
          );
          const isSelected = Boolean(selectedProject);

          return (
            <View
              key={repository.id}
              className="rounded-[24px] bg-surface px-4 py-4"
            >
              <View className="flex-row items-start gap-4">
                <Checkbox
                  isSelected={isSelected}
                  onSelectedChange={(nextValue) =>
                    toggleRepository(repository, nextValue)
                  }
                />

                <View className="flex-1 gap-2">
                  <Text className="text-lg font-medium text-foreground">
                    {repository.name}
                  </Text>
                  <Text className="text-sm text-muted">{repository.fullName}</Text>
                  {repository.description ? (
                    <Text className="text-sm leading-6 text-muted">
                      {repository.description}
                    </Text>
                  ) : null}
                  {isSelected ? (
                    <TextField>
                      <Label>Group name</Label>
                      <Input
                        value={selectedProject?.groupName ?? ''}
                        placeholder="Optional"
                        autoCapitalize="words"
                        onChangeText={(value) =>
                          updateGroupName(repository.id, value)
                        }
                      />
                    </TextField>
                  ) : null}
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
