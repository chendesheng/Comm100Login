#!/usr/bin/env node
import { run } from '../src/cli/accounts.mjs';

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(`comm100-accounts: ${error.message}`);
  process.exitCode = 1;
}
