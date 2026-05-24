/**
 * Isolated gesture-feel test page for the ReviewPager component.
 *
 * The pager includes its own chrome overlay (disclosure + dots +
 * counter) inside the Embla viewport. This page renders the three
 * tan-card slides with realistic rows so the disclosure-open compress
 * behavior is visible: opening the original note expands the chrome,
 * the slides reserve more padding-bottom via the chrome-height CSS
 * var, the tan cards inside the slides shrink, and Save / Discard
 * (outside the pager) stay anchored.
 *
 * URL: https://dev.captureshark.com/review-pager
 */
import type { ReactElement } from "react";

import { ReviewPager } from "@/components/ReviewPager/ReviewPager";

import "./ReviewPagerTestPage.css";

interface SampleRow {
  label: string;
  value: string;
}

const SAMPLE_PAGES: SampleRow[][] = [
  [
    { label: "Name", value: "Maria Hernandez" },
    { label: "Phone", value: "(555) 412-8830" },
    { label: "Email", value: "maria.h@example.com" },
    { label: "Agent?", value: "No" },
  ],
  [
    { label: "Intent", value: "Buying" },
    { label: "Timeline", value: "3-6 months" },
    { label: "Financing", value: "Pre-approved" },
    { label: "Budget", value: "$700k–$850k" },
  ],
  [
    { label: "Area", value: "Tustin / Irvine" },
    { label: "Follow up", value: "Tuesday morning" },
    { label: "Notes", value: "First-time buyer, prefers 30-year fixed." },
  ],
];

const SAMPLE_ORIGINAL_NOTE =
  "Hi, Maria here. I'm looking at homes in Tustin or Irvine, " +
  "budget around $700k to $850k. First-time buyer, no agent yet, " +
  "prefer 30-year fixed. Best time to reach me is Tuesday morning. " +
  "Email maria.h@example.com, phone 555-412-8830.";

export function ReviewPagerTestPage(): ReactElement {
  const slides = SAMPLE_PAGES.map((rows, idx) => (
    <SampleCard key={idx} rows={rows} />
  ));

  return (
    <div className="review-pager-test">
      <header className="review-pager-test__heading">
        <span className="review-pager-test__eyebrow">Extracted</span>
        <span className="review-pager-test__name">Maria</span>
        <span className="review-pager-test__budget">$700k–$850k</span>
      </header>

      <ReviewPager pages={slides} originalNote={SAMPLE_ORIGINAL_NOTE} />

      <button type="button" className="review-pager-test__save">
        Save to sheet
      </button>
      <button type="button" className="review-pager-test__discard">
        Discard
      </button>
    </div>
  );
}

function SampleCard({ rows }: { rows: SampleRow[] }): ReactElement {
  return (
    <div className="review-pager-test__card">
      <dl className="review-pager-test__rows">
        {rows.map((row) => (
          <div key={row.label} className="review-pager-test__row">
            <dt className="review-pager-test__row-label">{row.label}</dt>
            <dd className="review-pager-test__row-value">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
