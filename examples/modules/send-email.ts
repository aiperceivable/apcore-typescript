/**
 * Full-featured example module: send an email.
 *
 * Demonstrates:
 * - ModuleAnnotations (destructive, not idempotent)
 * - ModuleExample instances
 * - Tags, version, metadata
 * - ContextLogger usage inside execute()
 */

import { Type } from '@sinclair/typebox';
import { FunctionModule, ContextLogger } from 'apcore-js';
import type { Context } from 'apcore-js';

export const sendEmailModule = new FunctionModule({
  moduleId: 'email.send',
  description: 'Send an email message',
  inputSchema: Type.Object({
    to: Type.String(),
    subject: Type.String(),
    body: Type.String(),
    apiKey: Type.String(),
  }),
  outputSchema: Type.Object({
    status: Type.String(),
    messageId: Type.String(),
  }),
  tags: ['email', 'communication', 'external'],
  version: '1.2.0',
  metadata: { provider: 'example-smtp', maxRetries: 3 },
  annotations: {
    readonly: false,
    destructive: true,
    idempotent: false,
    requiresApproval: false,
    openWorld: true,
    streaming: false,
  },
  examples: [
    {
      title: 'Send a welcome email',
      inputs: {
        to: 'user@example.com',
        subject: 'Welcome!',
        body: 'Welcome to the platform.',
        apiKey: 'sk-xxx',
      },
      output: {
        status: 'sent',
        messageId: 'msg-12345',
      },
      description: 'Sends a welcome email to a new user.',
    },
  ],
  execute: (inputs, context: Context) => {
    const logger = ContextLogger.fromContext(context, 'send_email');
    logger.info('Sending email', {
      to: inputs.to as string,
      subject: inputs.subject as string,
    });

    const hash = Math.abs(
      (inputs.to as string)
        .split('')
        .reduce((a, c) => a + c.charCodeAt(0), 0) % 100000,
    );
    const messageId = `msg-${String(hash).padStart(5, '0')}`;

    logger.info('Email sent successfully', { messageId });
    return { status: 'sent', messageId };
  },
});
