/**
 * Two Resend email templates (escalation, final-pass) — reusing the
 * existing house Resend pattern (see `volunteer-ops/src/lib/email.ts`):
 * `RESEND_API_KEY` env var, a null-guarded client that no-ops with a
 * warning rather than throwing when the key is unset, and a send that logs
 * and swallows rather than propagating (notification delivery isn't
 * transactional — a failed email should never fail the task itself).
 *
 * Template builders are pure functions with no env dependency, so they're
 * testable without mocking Resend at all; only `sendEmail` touches the SDK.
 */

import { Resend } from "resend";
import type { TaskRecord } from "./types.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resendClient = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const FROM_ADDRESS = process.env.REEVE_EMAIL_FROM || "Reeve <onboarding@resend.dev>";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!resendClient) {
    console.warn(
      `sendEmail skipped — RESEND_API_KEY not set (to: ${message.to}, subject: "${message.subject}")`,
    );
    return;
  }
  try {
    await resendClient.emails.send({
      from: FROM_ADDRESS,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  } catch (error) {
    console.error(`sendEmail failed (to: ${message.to}, subject: "${message.subject}"):`, error);
  }
}

export interface FinalPassEmailInput {
  task: TaskRecord;
  to: string;
  prUrl: string;
}

/** Handoff: here's the PR — links the ready-for-review PR. */
export function buildFinalPassEmail(input: FinalPassEmailInput): EmailMessage {
  return {
    to: input.to,
    subject: `Reeve: task passed — ${input.task.targetRepo}`,
    text: [
      `Task: ${input.task.description}`,
      `Target repo: ${input.task.targetRepo}`,
      `Pull request ready for review: ${input.prUrl}`,
    ].join("\n\n"),
  };
}

export interface EscalationEmailInput {
  task: TaskRecord;
  to: string;
  /** Present for a step-escalation (links the draft PR); absent for a pre-flight escalation, where no PR was ever opened. */
  prUrl?: string;
  /** Step-escalation: the last attempt's reasoning + test/structural output, verbatim. Pre-flight: the task-author's stated reason. */
  reason: string;
}

/** Diagnostic: what passed/safe, what broke, why — covers both step-escalation and pre-flight escalation. */
export function buildEscalationEmail(input: EscalationEmailInput): EmailMessage {
  const lines = [`Task: ${input.task.description}`, `Target repo: ${input.task.targetRepo}`];
  if (input.prUrl) {
    lines.push(`Draft PR (safe steps only): ${input.prUrl}`);
  }
  lines.push(`Reason: ${input.reason}`);
  return {
    to: input.to,
    subject: `Reeve: task escalated — ${input.task.targetRepo}`,
    text: lines.join("\n\n"),
  };
}
