import { useEffect, useState, type Key, type ReactNode } from 'react';
import { Tabs } from '@heroui/react';
import { Bot, CircleDot, MessageCircle } from 'lucide-react';

export type ProjectTaskDetailTab = 'runner' | 'pipeline' | 'discussion';

const taskDetailTabs: Array<{
  icon: typeof Bot;
  id: ProjectTaskDetailTab;
  label: string;
}> = [
  { icon: Bot, id: 'runner', label: 'Runner' },
  { icon: CircleDot, id: 'pipeline', label: 'Pipeline' },
  { icon: MessageCircle, id: 'discussion', label: 'Discussion' }
];

export function ProjectTaskDetailTabs({
  discussion,
  pipeline,
  resetKey,
  runner
}: {
  discussion: ReactNode;
  pipeline: ReactNode;
  resetKey: string | number;
  runner: ReactNode;
}) {
  const [selectedTab, setSelectedTab] = useState<ProjectTaskDetailTab>('runner');

  useEffect(() => setSelectedTab('runner'), [resetKey]);

  return (
    <div>
      <div className="py-2">
        <Tabs
          aria-label="Task sections"
          selectedKey={selectedTab}
          variant="primary"
          onSelectionChange={(key: Key) => {
            if (key === 'runner' || key === 'pipeline' || key === 'discussion') {
              setSelectedTab(key);
            }
          }}
        >
          <Tabs.ListContainer className="w-full">
            <Tabs.List
              aria-label="Task sections"
              className="w-full rounded-full bg-current/[.045] p-0.5"
            >
              {taskDetailTabs.map(({ icon: Icon, id, label }) => (
                <Tabs.Tab
                  className="relative h-9 flex-1 rounded-full px-2 text-current/50 transition-colors aria-selected:text-current"
                  id={id}
                  key={id}
                >
                  <Tabs.Indicator className="rounded-full bg-current/[.10] shadow-none" />
                  <span className="relative z-10 inline-flex items-center gap-2">
                    <Icon aria-hidden className="size-4 shrink-0" />
                    <span>{label}</span>
                  </span>
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </div>

      <section aria-label="Runner" hidden={selectedTab !== 'runner'}>
        {runner}
      </section>
      <section aria-label="Pipeline" hidden={selectedTab !== 'pipeline'}>
        {pipeline}
      </section>
      <section aria-label="Discussion" hidden={selectedTab !== 'discussion'}>
        {discussion}
      </section>
    </div>
  );
}
