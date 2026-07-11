import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
} from "node:crypto";

import type { MachineConnectRequestRecord } from "./machine-connection-contract";

export function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

export function secretHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function equalSecretHash(expectedHash: string, value: string) {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(secretHash(value), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function approvalProofMessage(requestId: string, challenge: string) {
  return Buffer.from(
    `project-space-machine-connect:v1:${requestId}:${challenge}`,
    "utf8",
  );
}

export function verifyApprovalProof(
  request: MachineConnectRequestRecord,
  signature: string,
) {
  if (!request.approvalChallenge) {
    return false;
  }

  try {
    const publicKey = createPublicKey({
      format: "jwk",
      key: {
        crv: "Ed25519",
        kty: "OKP",
        x: request.publicKey,
      },
    });
    const signatureBytes = Buffer.from(signature, "base64url");
    return (
      signatureBytes.length === 64 &&
      verify(
        null,
        approvalProofMessage(request.id, request.approvalChallenge),
        publicKey,
        signatureBytes,
      )
    );
  } catch {
    return false;
  }
}
