import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../src/db/reeve-db.js";
import type { TaskRecord } from "../src/types.js";

const { sendMock, ResendMock } = vi.hoisted(() => {
  const sendMock = vi.fn().mockResolvedValue({ data: { id: "email_123" }, error: null });
  const ResendMock = vi.fn().mockImplementation(function MockResend(this: { emails: unknown }) {
    this.emails = { send: sendMock };
  });
  return { sendMock, ResendMock };
});
vi.mock("resend", () => ({ Resend: ResendMock }));

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: newId(),
    description: "Remove the unused foo variable",
    targetRepo: "org/repo",
    status: "passed",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("email template builders (pure, no Resend involved)", () => {
  it("buildFinalPassEmail links the ready PR and names the target repo", async () => {
    const { buildFinalPassEmail } = await import("../src/notify.js");
    const task = makeTask();

    const message = buildFinalPassEmail({
      task,
      to: "me@example.test",
      prUrl: "https://github.com/org/repo/pull/1",
    });

    expect(message.to).toBe("me@example.test");
    expect(message.subject).toMatch(/passed/);
    expect(message.subject).toContain("org/repo");
    expect(message.text).toContain("https://github.com/org/repo/pull/1");
    expect(message.text).toContain(task.description);
  });

  it("buildEscalationEmail includes a draft PR link when one is provided (step-escalation)", async () => {
    const { buildEscalationEmail } = await import("../src/notify.js");
    const task = makeTask({ status: "escalated" });

    const message = buildEscalationEmail({
      task,
      to: "me@example.test",
      prUrl: "https://github.com/org/repo/pull/2",
      reason: "Structural check failed: unexpected token",
    });

    expect(message.subject).toMatch(/escalated/);
    expect(message.text).toContain("https://github.com/org/repo/pull/2");
    expect(message.text).toContain("Structural check failed: unexpected token");
  });

  it("buildEscalationEmail omits any PR link when none is provided (pre-flight escalation)", async () => {
    const { buildEscalationEmail } = await import("../src/notify.js");
    const task = makeTask({ status: "escalated-preflight" });

    const message = buildEscalationEmail({
      task,
      to: "me@example.test",
      reason: "The task doesn't say which file to edit.",
    });

    expect(message.text).not.toMatch(/pull\//);
    expect(message.text).toContain("The task doesn't say which file to edit.");
  });
});

describe("sendEmail", () => {
  const originalApiKey = process.env.RESEND_API_KEY;

  beforeEach(() => {
    sendMock.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
  });

  it("sends via the Resend client when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const { sendEmail } = await import("../src/notify.js");

    await sendEmail({ to: "me@example.test", subject: "Reeve: task passed", text: "body text" });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "me@example.test",
        subject: "Reeve: task passed",
        text: "body text",
      }),
    );
  });

  it("no-ops without throwing when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    const { sendEmail } = await import("../src/notify.js");

    await expect(
      sendEmail({ to: "me@example.test", subject: "Reeve: task passed", text: "body text" }),
    ).resolves.toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("swallows a Resend send failure rather than throwing", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    sendMock.mockRejectedValueOnce(new Error("Resend is down"));
    const { sendEmail } = await import("../src/notify.js");

    await expect(
      sendEmail({ to: "me@example.test", subject: "Reeve: task passed", text: "body text" }),
    ).resolves.toBeUndefined();
  });
});
