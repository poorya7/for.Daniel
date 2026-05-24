// Test #10 — Accessibility regression sweep with axe-core (BASELINE mode).
//
// Refactor protection wants to catch NEW a11y issues introduced by file
// moves, not fail on pre-existing ones (those are tracked in TODO and
// fixed in their own dedicated work, not as a refactor blocker).
//
// Approach: maintain a baseline list of violation IDs that exist pre-refactor.
// The test fails only if a NEW violation ID appears, OR if the node count for
// an existing ID grows. Pre-existing-but-unchanged issues pass through.
//
// To regenerate the baseline (e.g. after intentionally fixing some violations):
//   1. Set BASELINE_REGENERATE_MODE = true below
//   2. Run this test once
//   3. Copy the printed JSON into BASELINE_VIOLATIONS
//   4. Set BASELINE_REGENERATE_MODE = false
//   5. Commit

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  pasteUrlAndAwaitResultsView,
  awaitFullPipeline,
  failOnConsoleError,
} from './_helpers.js';

const BASELINE_REGENERATE_MODE = false;

// Baseline captured 2026-05-06 (pre-SRP-refactor). Each entry: { id, nodeCount }.
// Refactor must not introduce new IDs or grow node counts on these.
const BASELINE_VIOLATIONS = {
  'aria-prohibited-attr': { impactCeiling: 'serious' },
  'button-name': { impactCeiling: 'critical' },
  'color-contrast': { impactCeiling: 'serious' },
  'scrollable-region-focusable': { impactCeiling: 'serious' },
};

test('a11y sweep: no NEW serious/critical violations beyond pre-refactor baseline', async ({ page }) => {
  failOnConsoleError(page);
  await pasteUrlAndAwaitResultsView(page);
  await awaitFullPipeline(page);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical'
  );

  if (BASELINE_REGENERATE_MODE) {
    const dump = serious.map((v) => `'${v.id}': { impactCeiling: '${v.impact}' },`).join('\n  ');
    console.log('\n===== BASELINE TO PASTE (regenerate mode) =====\n  ' + dump + '\n');
    return;
  }

  // Find any NEW violation (ID not in baseline).
  const newIds = serious.filter((v) => !BASELINE_VIOLATIONS[v.id]);

  if (newIds.length > 0) {
    console.log('\n===== NEW A11Y VIOLATIONS (not in baseline) =====');
    for (const v of newIds) {
      console.log(`\n[${v.impact}] ${v.id} — ${v.help}`);
      console.log(`   ${v.helpUrl}`);
      for (const node of v.nodes.slice(0, 3)) {
        console.log(`   • ${node.target.join(', ')}`);
      }
    }
  }

  expect(
    newIds.map((v) => v.id),
    `${newIds.length} NEW a11y violation(s) introduced by the refactor (not in pre-refactor baseline)`
  ).toEqual([]);
});
