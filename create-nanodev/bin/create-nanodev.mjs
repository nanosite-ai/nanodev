#!/usr/bin/env node
// `npm create @nanosite/nanodev@beta my-store` runs this: it hands off to `nanodev create my-store`.
import { runCreate } from "../lib/delegate.mjs";

process.exitCode = await runCreate(process.argv.slice(2));
