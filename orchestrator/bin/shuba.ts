#!/usr/bin/env bun
import { cli } from '../src/cli.ts';
cli(process.argv.slice(2)).then((code) => process.exit(code));
