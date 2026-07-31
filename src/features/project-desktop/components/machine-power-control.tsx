import { useEffect, useState } from 'react';
import { LoaderCircle, Power } from 'lucide-react';

import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Chip } from '@/app/dotnaos-ui';
import type { MachinePowerStatusResult } from '@/shared/machine-power-api';
import type { PhysicalMachineRecord } from '@/shared/project-space-api';

export function MachinePowerControl({ machine }: { machine: PhysicalMachineRecord }) {
  const [status, setStatus] = useState<MachinePowerStatusResult>();
  const [isChanging, setIsChanging] = useState(false);

  useEffect(() => {
    if (machine.kind !== 'physical') {
      setStatus(undefined);
      return;
    }
    let canceled = false;
    void projectSpaceClient.getMachinePowerStatus(machine.id).then((result) => {
      if (!canceled) setStatus(result);
    }).catch(() => {
      if (!canceled) setStatus(undefined);
    });
    return () => {
      canceled = true;
    };
  }, [machine.id, machine.kind]);

  if (
    machine.kind !== 'physical' ||
    !status?.provider.deviceId ||
    (status.state !== 'online' && status.state !== 'offline')
  ) {
    return null;
  }

  const isOn = status.state === 'online';

  async function togglePower() {
    setIsChanging(true);
    try {
      await projectSpaceClient.requestMachinePower({
        operationId: crypto.randomUUID(),
        physicalMachineId: machine.id,
        requestedState: 'on'
      });
      setStatus(await projectSpaceClient.getMachinePowerStatus(machine.id));
    } finally {
      setIsChanging(false);
    }
  }

  return (
    <span className="flex items-center gap-1.5">
      <Chip size="sm" variant={isOn ? 'primary' : 'secondary'}>
        Power {isOn ? 'on' : 'off'}
      </Chip>
      {!isOn ? (
        <Button
          aria-label={`Turn on ${machine.name}`}
          isDisabled={isChanging}
          size="sm"
          variant="outline"
          onPress={() => void togglePower()}
        >
          {isChanging ? <LoaderCircle className="size-3.5 animate-spin" /> : <Power className="size-3.5" />}
          Turn on
        </Button>
      ) : null}
    </span>
  );
}
