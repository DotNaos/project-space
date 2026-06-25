import { useMemo, useRef, useState } from 'react';

import { Button, Input, Label, TextField } from 'heroui-native';
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import type { ProjectIdea, SelectedProject } from '../../../domain/models';

interface ProjectWorkspaceScreenProps {
  projects: SelectedProject[];
  activeProjectId: number | null;
  ideasByRepositoryId: Record<string, ProjectIdea[]>;
  onProjectChange(projectId: number): void;
  onAddIdea(repositoryId: number, title: string, description: string): void;
  onManageProjects(): void;
  onSignOut(): void;
}

export function ProjectWorkspaceScreen({
  projects,
  activeProjectId,
  ideasByRepositoryId,
  onProjectChange,
  onAddIdea,
  onManageProjects,
  onSignOut,
}: ProjectWorkspaceScreenProps) {
  const { width } = useWindowDimensions();
  const listRef = useRef<FlatList<SelectedProject>>(null);
  const [isProjectListOpen, setIsProjectListOpen] = useState(false);
  const [isIdeaComposerOpen, setIsIdeaComposerOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [ideaTitle, setIdeaTitle] = useState('');
  const [ideaDescription, setIdeaDescription] = useState('');
  const [ideaError, setIdeaError] = useState<string | null>(null);

  const activeProject =
    projects.find((project) => project.repository.id === activeProjectId) ??
    projects[0] ??
    null;

  const groupedProjects = useMemo(() => {
    const query = projectSearchQuery.trim().toLowerCase();
    const filteredProjects = !query
      ? projects
      : projects.filter((project) =>
          `${project.repository.name} ${project.repository.fullName} ${project.groupName}`
            .toLowerCase()
            .includes(query)
        );

    const groups = new Map<string, SelectedProject[]>();

    for (const project of filteredProjects) {
      const key = project.groupName || 'Ungrouped';
      const existing = groups.get(key) ?? [];
      existing.push(project);
      groups.set(key, existing);
    }

    return [...groups.entries()];
  }, [projectSearchQuery, projects]);

  function scrollToProject(projectId: number) {
    const index = projects.findIndex(
      (project) => project.repository.id === projectId
    );

    if (index >= 0) {
      listRef.current?.scrollToIndex({ index, animated: true });
      onProjectChange(projectId);
    }
  }

  function submitIdea() {
    if (!activeProject) {
      return;
    }

    try {
      onAddIdea(activeProject.repository.id, ideaTitle, ideaDescription);
      setIdeaTitle('');
      setIdeaDescription('');
      setIdeaError(null);
      setIsIdeaComposerOpen(false);
    } catch (error) {
      setIdeaError(error instanceof Error ? error.message : 'Idea could not be saved.');
    }
  }

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-black/5 px-5 pb-4 pt-6">
        <Text className="text-2xl font-semibold text-foreground">
          {activeProject?.repository.name ?? 'Projects'}
        </Text>
        <Text className="mt-1 text-sm text-muted">
          {activeProject?.groupName || activeProject?.repository.fullName || ''}
        </Text>

        <View className="mt-4 flex-row gap-3">
          <Button variant="secondary" className="flex-1" onPress={onManageProjects}>
            Projects
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            onPress={() => setIsIdeaComposerOpen(true)}
          >
            New Idea
          </Button>
          <Button variant="ghost" className="flex-1" onPress={onSignOut}>
            Sign Out
          </Button>
        </View>
      </View>

      <FlatList
        ref={listRef}
        horizontal
        pagingEnabled
        data={projects}
        keyExtractor={(item) => String(item.repository.id)}
        showsHorizontalScrollIndicator={false}
        getItemLayout={(_, index) => ({
          length: width,
          offset: width * index,
          index,
        })}
        initialScrollIndex={Math.max(
          0,
          projects.findIndex((project) => project.repository.id === activeProjectId)
        )}
        onMomentumScrollEnd={(event) => {
          const nextIndex = Math.round(event.nativeEvent.contentOffset.x / width);
          const nextProject = projects[nextIndex];

          if (nextProject) {
            onProjectChange(nextProject.repository.id);
          }
        }}
        renderItem={({ item }) => {
          const ideas = ideasByRepositoryId[String(item.repository.id)] ?? [];

          return (
            <View style={{ width }} className="px-5 py-6">
              <ScrollView
                className="flex-1"
                contentContainerStyle={{ paddingBottom: 120, gap: 12 }}
              >
                {ideas.length === 0 ? (
                  <View className="rounded-[24px] bg-surface px-5 py-8">
                    <Text className="text-xl font-medium text-foreground">
                      No ideas yet
                    </Text>
                    <Text className="mt-2 text-base leading-6 text-muted">
                      Keep this screen minimal. Add the first idea when something worth
                      keeping appears.
                    </Text>
                  </View>
                ) : (
                  ideas.map((idea) => (
                    <View
                      key={idea.id}
                      className="rounded-[24px] bg-surface px-5 py-5"
                    >
                      <Text className="text-lg font-medium text-foreground">
                        {idea.title}
                      </Text>
                      {idea.description ? (
                        <Text className="mt-2 text-base leading-6 text-muted">
                          {idea.description}
                        </Text>
                      ) : null}
                    </View>
                  ))
                )}
              </ScrollView>
            </View>
          );
        }}
      />

      <View className="border-t border-black/5 bg-background px-5 py-4">
        <Button variant="outline" onPress={() => setIsProjectListOpen(true)}>
          {activeProject?.repository.name ?? 'Choose project'}
        </Button>
      </View>

      <Modal
        transparent
        animationType="fade"
        visible={isProjectListOpen}
        onRequestClose={() => setIsProjectListOpen(false)}
      >
        <Pressable
          className="flex-1 bg-black/35 px-5 py-10"
          onPress={() => setIsProjectListOpen(false)}
        >
          <Pressable
            className="mt-auto rounded-[28px] bg-surface px-5 py-5"
            onPress={() => {}}
          >
            <Text className="text-xl font-semibold text-foreground">
              Projects
            </Text>
            <View className="mt-4">
              <TextField>
                <Label>Search</Label>
                <Input
                  value={projectSearchQuery}
                  placeholder="Find a project"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setProjectSearchQuery}
                />
              </TextField>
            </View>

            <ScrollView className="mt-4 max-h-[360px]">
              <View className="gap-4">
                {groupedProjects.map(([groupName, groupedItems]) => (
                  <View key={groupName} className="gap-2">
                    <Text className="text-xs uppercase tracking-[1.5px] text-muted">
                      {groupName}
                    </Text>
                    {groupedItems.map((project) => (
                      <Button
                        key={project.repository.id}
                        variant={
                          project.repository.id === activeProjectId
                            ? 'primary'
                            : 'secondary'
                        }
                        onPress={() => {
                          scrollToProject(project.repository.id);
                          setIsProjectListOpen(false);
                          setProjectSearchQuery('');
                        }}
                      >
                        {project.repository.name}
                      </Button>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={isIdeaComposerOpen}
        onRequestClose={() => setIsIdeaComposerOpen(false)}
      >
        <Pressable
          className="flex-1 bg-black/35 px-5 py-10"
          onPress={() => setIsIdeaComposerOpen(false)}
        >
          <Pressable
            className="mt-auto rounded-[28px] bg-surface px-5 py-5"
            onPress={() => {}}
          >
            <Text className="text-xl font-semibold text-foreground">
              New idea
            </Text>

            <View className="mt-4 gap-4">
              <TextField isInvalid={Boolean(ideaError)}>
                <Label>Title</Label>
                <Input
                  value={ideaTitle}
                  placeholder="Short idea title"
                  onChangeText={setIdeaTitle}
                />
              </TextField>

              <TextField>
                <Label>Description</Label>
                <Input
                  value={ideaDescription}
                  placeholder="What is the idea?"
                  multiline
                  numberOfLines={5}
                  textAlignVertical="top"
                  onChangeText={setIdeaDescription}
                />
              </TextField>

              {ideaError ? (
                <View className="rounded-[18px] bg-[#fff1eb] px-4 py-3">
                  <Text className="text-sm font-medium text-[#8a2d0b]">
                    {ideaError}
                  </Text>
                </View>
              ) : null}
            </View>

            <View className="mt-5 flex-row gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onPress={() => {
                  setIdeaError(null);
                  setIsIdeaComposerOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" className="flex-1" onPress={submitIdea}>
                Save Idea
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
