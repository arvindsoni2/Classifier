#!/usr/bin/env node
/**
 * Honest placeholder for project scripts whose capability arrives in a later
 * plan task (docs/06-Implementation-Plan.md). Exits non-zero with an explicit
 * message so nothing can silently pass or silently touch real Downloads.
 */
const [capability, task] = process.argv.slice(2);

if (!capability || !task) {
  console.error('not-until-task: expected <capability> <taskNumber>');
  process.exit(2);
}

console.error(
  `${capability}: not implemented until Task ${task} (docs/06-Implementation-Plan.md); ` +
    'exiting without side effects.',
);
process.exit(1);
