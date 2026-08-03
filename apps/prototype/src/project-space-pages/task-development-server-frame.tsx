import type { MockTask } from "./task-model";

export function TaskDevelopmentServerFrame({
  className = "",
  task,
}: {
  className?: string;
  task: MockTask;
}) {
  const parameters = new URLSearchParams({
    issue: String(task.number),
    machine: task.workspace?.machine ?? "workspace",
    title: task.title,
  });
  const source = `${import.meta.env.BASE_URL ?? "/prototype/desktop/"}dev-server-mock.html?${parameters}`;

  return (
    <iframe
      className={`block size-full border-0 bg-[#090909] ${className}`}
      loading="eager"
      sandbox="allow-scripts"
      src={source}
      title="Test development server"
    />
  );
}
