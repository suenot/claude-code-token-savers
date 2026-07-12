#!/usr/bin/env bun
import { createSkillInject } from '../src/skillinject/server.ts';

const port = Number(process.env.PORT || 47856);
const upstream = process.env.SKILLINJECT_UPSTREAM || 'https://api.anthropic.com';
const maxSkills = process.env.SKILLINJECT_MAX_SKILLS ? Number(process.env.SKILLINJECT_MAX_SKILLS) : undefined;
const classifierModel = process.env.SKILLINJECT_MODEL || 'a8e/auto';
const storeDir = process.env.SKILLINJECT_STORE_DIR || undefined;
const enabled = process.env.SKILLINJECT_ENABLED !== 'false';

createSkillInject({ port, upstream, maxSkills, classifierModel, storeDir, enabled }).listen(port);
process.stderr.write(
  `[skill-inject] listening on 127.0.0.1:${port} → ${upstream} (skill re-injector)\n`,
);
