#!/usr/bin/env node
import { runCli } from "./program.js";

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
});
process.exitCode = code;
