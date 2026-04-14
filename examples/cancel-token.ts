/**
 * Cooperative cancellation example — cancel a long-running module mid-flight.
 */
import { Type } from '@sinclair/typebox';
import { APCore, CancelToken, Context, ExecutionCancelledError } from 'apcore-js';
import { v4 as uuidv4 } from 'uuid';

const client = new APCore();

// Register a slow module that checks for cancellation
client.module({
  id: 'demo.slow_task',
  description: 'Simulates a long-running task that checks for cancellation',
  inputSchema: Type.Object({ steps: Type.Number() }),
  outputSchema: Type.Object({ completed: Type.Number() }),
  execute: async (inputs, context) => {
    const steps = inputs.steps as number;
    let completed = 0;
    for (let i = 0; i < steps; i++) {
      // Check for cancellation before each step
      context.cancelToken?.check();
      await new Promise((resolve) => setTimeout(resolve, 50));
      completed++;
    }
    return { completed };
  },
});

// Run 1: Normal completion
console.log('--- Run 1: Normal completion ---');
const result = await client.call('demo.slow_task', { steps: 3 });
console.log('Completed:', result);

// Run 2: Cancel mid-flight
console.log('\n--- Run 2: Cancel after 80ms ---');
const token = new CancelToken();
// Build a Context that carries the cancel token using the full constructor
const ctx = new Context(
  uuidv4().replace(/-/g, ''), // traceId
  null,                        // callerId
  [],                          // callChain
  null,                        // executor
  null,                        // identity
  null,                        // redactedInputs
  {},                          // data
  token,                       // cancelToken
);

// Cancel after 80ms
setTimeout(() => {
  console.log('Cancelling...');
  token.cancel();
}, 80);

try {
  await client.call('demo.slow_task', { steps: 10 }, ctx);
  console.log('Should not reach here');
} catch (err) {
  if (err instanceof ExecutionCancelledError) {
    console.log('Caught cancellation:', err.message);
  } else {
    throw err;
  }
}

// Token state
console.log('\nToken cancelled:', token.isCancelled); // true
token.reset();
console.log('After reset:', token.isCancelled); // false
