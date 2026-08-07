import { useEffect, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';

import { CodexScreen, type CodexPanel } from './mobile-workflow-codex';
import {
  workflowPageLabels,
  type WorkflowIssue,
  type WorkflowPage,
} from './mobile-workflow-data';
import {
  BranchScreen,
  PullRequestScreen,
  WorktreeScreen,
} from './mobile-workflow-git';
import {
  IssueDetailScreen,
  IssueListScreen,
  IssueMapScreen,
} from './mobile-workflow-issues';
import {
  WorkflowOverlaySheet,
  type WorkflowOverlay,
} from './mobile-workflow-overlay';
import { DocsScreen, PreviewScreen } from './mobile-workflow-review';
import { WorkflowSidebar } from './mobile-workflow-sidebar';
import {
  WorkflowFooter,
  WorkflowHeader,
} from './mobile-workflow-ui';

const SIDEBAR_WIDTH = 310;

function WorkflowPageContent({
  codexPanel,
  page,
  setCodexPanel,
  setOverlay,
  setPage,
  showToast,
}: {
  codexPanel: CodexPanel;
  page: WorkflowPage;
  setCodexPanel(panel: CodexPanel): void;
  setOverlay(overlay: WorkflowOverlay): void;
  setPage(page: WorkflowPage): void;
  showToast(message: string): void;
}) {
  const onIssue = (issue: WorkflowIssue) => {
    if (issue.number === 300) {
      setPage('issue-detail');
      return;
    }
    setOverlay({ issue, kind: 'issue' });
  };
  if (page === 'issue-list') {
    return <IssueListScreen onIssue={onIssue} setPage={setPage} />;
  }
  if (page === 'issue-map') {
    return <IssueMapScreen onIssue={onIssue} setPage={setPage} />;
  }
  if (page === 'issue-detail') {
    return <IssueDetailScreen setPage={setPage} />;
  }
  if (page === 'codex') {
    return (
      <CodexScreen
        panel={codexPanel}
        setPage={setPage}
        setPanel={setCodexPanel}
        showToast={showToast}
      />
    );
  }
  if (page === 'worktree') {
    return <WorktreeScreen setPage={setPage} showToast={showToast} />;
  }
  if (page === 'branch') {
    return <BranchScreen setPage={setPage} showToast={showToast} />;
  }
  if (page === 'pull-request') {
    return <PullRequestScreen setPage={setPage} />;
  }
  if (page === 'docs') {
    return <DocsScreen setPage={setPage} showToast={showToast} />;
  }
  return <PreviewScreen setPage={setPage} showToast={showToast} />;
}

export function MobileWorkflowScreen() {
  const [page, setPageState] = useState<WorkflowPage>('issue-list');
  const [codexPanel, setCodexPanel] = useState<CodexPanel>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [overlay, setOverlay] = useState<WorkflowOverlay>();
  const [toast, setToast] = useState('');
  const sidebarProgress = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const setPage = (next: WorkflowPage) => {
    setPageState(next);
    setSidebarOpen(false);
    setOverlay(undefined);
  };
  const showToast = (message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  };

  useEffect(() => {
    Animated.spring(sidebarProgress, {
      bounciness: 0,
      speed: 18,
      toValue: sidebarOpen ? 1 : 0,
      useNativeDriver: false,
    }).start();
  }, [sidebarOpen, sidebarProgress]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    []
  );

  const sidebarTransform = sidebarProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [-SIDEBAR_WIDTH, 0],
  });
  const mainTransform = sidebarProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, SIDEBAR_WIDTH],
  });

  return (
    <View
      className="flex-1 overflow-hidden bg-black"
      style={{ position: 'relative' }}
    >
      <Animated.View
        style={{
          bottom: 0,
          left: 0,
          position: 'absolute',
          top: 0,
          transform: [{ translateX: sidebarTransform }],
          width: SIDEBAR_WIDTH,
          zIndex: 20,
        }}
      >
        <WorkflowSidebar
          onClose={() => setSidebarOpen(false)}
          onProject={() => {
            setSidebarOpen(false);
            setOverlay({ kind: 'project' });
          }}
          page={page}
          setPage={setPage}
        />
      </Animated.View>
      <Animated.View
        className="flex-1 bg-black"
        style={{ transform: [{ translateX: mainTransform }] }}
      >
        <WorkflowHeader
          onOpenInfo={() => setOverlay({ kind: 'info' })}
          onOpenSidebar={() => setSidebarOpen(true)}
          title={workflowPageLabels[page]}
        />
        <WorkflowPageContent
          codexPanel={codexPanel}
          page={page}
          setCodexPanel={setCodexPanel}
          setOverlay={setOverlay}
          setPage={setPage}
          showToast={showToast}
        />
        <WorkflowFooter
          onNewIssue={() => setOverlay({ kind: 'new-issue' })}
          onProject={() => setOverlay({ kind: 'project' })}
          onSearch={() => setOverlay({ kind: 'search' })}
        />
      </Animated.View>
      {overlay ? (
        <WorkflowOverlaySheet
          onClose={() => setOverlay(undefined)}
          onIssue={(issue) => {
            setOverlay(undefined);
            if (issue.number === 300) setPage('issue-detail');
            else showToast(`#${issue.number} opened from the Issue Board`);
          }}
          overlay={overlay}
          page={page}
          showToast={showToast}
        />
      ) : null}
      {toast ? (
        <View className="absolute bottom-4 left-4 right-4 z-[60] rounded-full bg-white px-5 py-3">
          <Text className="text-center text-xs font-semibold text-black">
            {toast}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
