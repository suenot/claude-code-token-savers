#!/usr/bin/env node
import { cli } from '../src/cli.js';
cli(process.argv.slice(2)).then((code) => process.exit(code));
