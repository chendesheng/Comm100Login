#!/usr/bin/env node
import { run } from '../src/cli/accounts.mjs';

// A downstream command such as `head` can close the pipe before all rows are written.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(`comm100-accounts: ${error.message}`);
  process.exitCode = 1;
}
