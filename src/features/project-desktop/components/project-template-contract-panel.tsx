import {
  Boxes,
  CheckCircle2,
  CircleAlert,
  Library,
  Settings2,
  Workflow
} from 'lucide-react';
import { Chip, Text } from '@/app/dotnaos-ui';
import type { FullstackTemplateCheck, ProjectSpaceRecord } from '@/shared/project-space-api';

const templateGroups = [
  {
    icon: Boxes,
    title: 'Modules',
    items: [
      ['Frontend', 'React, Vite, and TypeScript'],
      ['Backend', 'Typed Node.js service boundaries'],
      ['CLI', 'Go command line application'],
      ['Documentation', 'Versioned MDX product documentation']
    ]
  },
  {
    icon: Library,
    title: 'Libraries',
    items: [
      ['HeroUI', 'Shared accessible interface components'],
      ['Tailwind CSS', 'Shared styling and design tokens'],
      ['Zod', 'Validation at external data boundaries'],
      ['Bun test', 'Frontend and service test coverage']
    ]
  },
  {
    icon: Settings2,
    title: 'Configuration',
    items: [
      ['Runtime', 'Bun package manager and JavaScript runtime'],
      ['Type safety', 'Strict TypeScript project references'],
      ['Logging', 'Structured logs with request identity'],
      ['Authentication', 'Protected application and privileged operations']
    ]
  },
  {
    icon: Workflow,
    title: 'Delivery',
    items: [
      ['Pull requests', 'Required local and remote checks'],
      ['PR Preview', 'Automatic exact-revision review deployment'],
      ['Release', 'One coherent signed release identity'],
      ['Production', 'Verified deployment with rollback path']
    ]
  }
] as const;

function validationPresentation(check?: FullstackTemplateCheck) {
  if (check?.status === 'implemented' || check?.status === 'template-source') {
    return {
      copy: `${check.score}% valid`,
      icon: CheckCircle2,
      className: 'text-emerald-300 bg-emerald-500/10'
    };
  }
  if (check?.status === 'partial') {
    return {
      copy: `${check.score}% valid · ${check.missing.length} gaps`,
      icon: CircleAlert,
      className: 'text-amber-300 bg-amber-500/10'
    };
  }
  return {
    copy: 'Validation not available',
    icon: CircleAlert,
    className: 'text-neutral-400 bg-neutral-800'
  };
}

export function ProjectTemplateContractPanel({
  project
}: {
  project: ProjectSpaceRecord;
}) {
  const validation = validationPresentation(project.fullstackTemplate);
  const ValidationIcon = validation.icon;

  return (
    <section className="border-b border-neutral-800/70 pb-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Text className="text-2xl font-semibold text-neutral-50">Project Template</Text>
          <Text className="mt-1 block max-w-2xl text-sm text-neutral-500">
            The required modules, libraries, configuration, and delivery guarantees for every project.
          </Text>
        </div>
        <Chip size="sm" variant="tertiary" className={`gap-1 border-0 ${validation.className}`}>
          <ValidationIcon className="size-3.5" />
          {validation.copy}
        </Chip>
      </header>

      <div className="mt-6 grid gap-x-8 gap-y-6 md:grid-cols-2">
        {templateGroups.map(({ icon: Icon, items, title }) => (
          <section key={title} className="min-w-0">
            <div className="flex items-center gap-2 border-b border-neutral-800/70 pb-2">
              <Icon className="size-4 text-neutral-500" />
              <Text className="text-sm font-semibold text-neutral-200">{title}</Text>
            </div>
            <dl className="divide-y divide-neutral-800/50">
              {items.map(([label, detail]) => (
                <div key={label} className="grid gap-1 py-2.5 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
                  <dt className="text-xs font-medium text-neutral-300">{label}</dt>
                  <dd className="text-xs leading-5 text-neutral-500">{detail}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </section>
  );
}
