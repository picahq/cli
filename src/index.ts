// Package entry point.
//
// `bin/cli.js` imports `program` from here and calls `.parse()`. Building the
// program and parsing argv are deliberately separated so a downstream package
// (e.g. a private dev CLI) can `import { program } from '@withone/cli'`, add
// its own commands, and parse — without this module running on import.
export { program } from './cli.js';
