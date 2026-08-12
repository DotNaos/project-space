import { describe, expect, test } from "bun:test";

import {
  isAuthenticationError,
  MachineConnectionResponseError,
  parseMachineConnectionApproval,
  parseMachineConnectionDecision,
  readMachineConnectionResponse,
  shouldRefreshAfterDecisionError,
} from "../src/features/machine-connection/components/machine-connection-approval-client";

const approval = {
  architecture: "arm64",
  clientVersion: "0.4.0",
  expiresAt: "2026-07-11T10:10:00.000Z",
  hostname: "office-mac",
  name: "Office Mac",
  operatingSystem: "darwin",
  status: "pending",
};

describe("machine connection approval response parsing", () => {
  test("accepts the complete approval contract", () => {
    expect(parseMachineConnectionApproval(approval)).toEqual(approval);
  });

  test("rejects missing, unknown, and malformed approval fields with a controlled error", () => {
    for (const payload of [
      { ...approval, status: "unknown" },
      { ...approval, expiresAt: "tomorrow" },
      { ...approval, operatingSystem: "ios" },
      { ...approval, name: "<script>" },
      { status: "pending" },
      null,
    ]) {
      expect(() => parseMachineConnectionApproval(payload)).toThrow(
        "Project Space returned an invalid machine approval response.",
      );
    }
  });

  test("requires the decision response to match the requested action", () => {
    expect(
      parseMachineConnectionDecision({ status: "approved" }, "approve"),
    ).toEqual({
      status: "approved",
    });
    expect(
      parseMachineConnectionDecision({ status: "denied" }, "deny"),
    ).toEqual({
      status: "denied",
    });
    expect(() =>
      parseMachineConnectionDecision({ status: "denied" }, "approve"),
    ).toThrow("Project Space returned an invalid machine decision response.");
  });

  test("turns malformed successful JSON into a controlled response error", async () => {
    await expect(
      readMachineConnectionResponse(
        new Response('{"status":"surprise"}', { status: 200 }),
        parseMachineConnectionApproval,
        "Could not load this machine connection request.",
      ),
    ).rejects.toMatchObject({
      message: "Project Space returned an invalid machine approval response.",
      name: "MachineConnectionResponseError",
    });
  });

  test("preserves safe status and code details for auth and decision recovery", async () => {
    const unauthorized = await readMachineConnectionResponse(
      new Response('{"code":"invalid_credential","error":"Login required."}', {
        status: 401,
      }),
      parseMachineConnectionApproval,
      "Could not load this machine connection request.",
    ).catch((error: unknown) => error);
    const conflict = new MachineConnectionResponseError(
      "Connection request expired.",
      409,
      "expired",
    );

    expect(unauthorized).toMatchObject({
      code: "invalid_credential",
      message: "Login required.",
      statusCode: 401,
    });
    expect(isAuthenticationError(unauthorized)).toBe(true);
    expect(shouldRefreshAfterDecisionError(conflict)).toBe(true);
  });

  test("does not reflect oversized or malformed backend error fields", async () => {
    const error = await readMachineConnectionResponse(
      new Response(
        JSON.stringify({ code: "INVALID CODE", error: "x".repeat(501) }),
        { status: 500 },
      ),
      parseMachineConnectionApproval,
      "Could not load this machine connection request.",
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: undefined,
      message: "Could not load this machine connection request.",
      statusCode: 500,
    });
  });
});
