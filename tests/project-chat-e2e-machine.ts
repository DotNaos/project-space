import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';

import type { MachineConnectionStore } from '../server/machine-connection-contract';
import {
  MachineConnectionService,
  machineApprovalProofMessage
} from '../server/machine-connection-service';

export interface ProjectChatE2EMachineCredential {
  backendUrl: string;
  credential: string;
  issuedAt: string;
  machineId: string;
  machineName: string;
  version: 'project-space.project-chat-e2e-credential/v1';
}

interface EnrollProjectChatE2EMachineOptions {
  backendUrl: string;
  hostId: string;
  store: MachineConnectionStore;
  userId: string;
}

function machineKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x) {
    throw new Error('E2E machine public key could not be exported.');
  }
  return { privateKey, publicKey: jwk.x };
}

export async function enrollProjectChatE2EMachine(
  options: EnrollProjectChatE2EMachineOptions
): Promise<ProjectChatE2EMachineCredential> {
  const keys = machineKeyPair();
  const service = new MachineConnectionService({
    publicOrigin: options.backendUrl,
    store: options.store
  });
  const created = await service.createRequest({
    architecture: 'arm64',
    clientVersion: 'project-chat-e2e',
    hostname: options.hostId,
    name: 'Project Chat E2E Machine',
    operatingSystem: 'darwin',
    publicKey: keys.publicKey
  });

  await service.approveRequest(created.requestId, options.userId);
  const approved = await service.pollRequest(created.requestId, created.pollToken);
  if (approved.status !== 'approved') {
    throw new Error('E2E machine enrollment was not approved.');
  }

  const signature = sign(
    null,
    machineApprovalProofMessage(created.requestId, approved.approvalChallenge),
    keys.privateKey
  ).toString('base64url');
  const exchanged = await service.exchangeApproval(
    created.requestId,
    created.pollToken,
    signature
  );

  return {
    backendUrl: new URL(options.backendUrl).origin,
    credential: exchanged.credential,
    issuedAt: exchanged.issuedAt,
    machineId: exchanged.machineId,
    machineName: exchanged.machineName,
    version: 'project-space.project-chat-e2e-credential/v1'
  };
}

export async function writePrivateProjectChatE2ECredential(
  path: string,
  credential: ProjectChatE2EMachineCredential
) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory()) {
    throw new Error('PROJECT_CHAT_E2E_CREDENTIAL_FILE parent must be a directory.');
  }

  let file: FileHandle | undefined;
  let created = false;
  try {
    file = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    );
    created = true;
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(credential)}\n`, 'utf8');
    await file.sync();
  } catch (error) {
    if (created) {
      await file?.close().catch(() => undefined);
      file = undefined;
      await rm(path, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await file?.close();
  }
}
