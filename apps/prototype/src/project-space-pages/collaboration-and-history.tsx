import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import { ProjectHistoryWorkbench } from "./history-workbench";
export { ProjectChatsPage } from "./project-chat";

export function ProjectHistoryPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  return <ProjectHistoryWorkbench projectName={projectName} scenario={scenario} />;
}
