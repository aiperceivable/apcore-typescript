/**
 * Readonly example module: look up a user by ID.
 *
 * Demonstrates readonly and idempotent annotations.
 * This module only reads data — no side effects.
 */

import { Type } from '@sinclair/typebox';
import { FunctionModule } from 'apcore-js';

const users: Record<string, { id: string; name: string; email: string }> = {
  'user-1': { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
  'user-2': { id: 'user-2', name: 'Bob', email: 'bob@example.com' },
};

export const getUserModule = new FunctionModule({
  moduleId: 'user.get',
  description: 'Get user details by ID',
  inputSchema: Type.Object({ userId: Type.String() }),
  outputSchema: Type.Object({
    id: Type.String(),
    name: Type.String(),
    email: Type.String(),
  }),
  annotations: {
    readonly: true,
    destructive: false,
    idempotent: true,
    requiresApproval: false,
    openWorld: true,
    streaming: false,
  },
  execute: (inputs) => {
    const user = users[inputs.userId as string];
    if (!user) {
      return {
        id: inputs.userId as string,
        name: 'Unknown',
        email: 'unknown@example.com',
      };
    }
    return { ...user };
  },
});
