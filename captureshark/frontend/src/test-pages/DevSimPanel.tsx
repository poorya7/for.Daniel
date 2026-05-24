/**
 * Dev simulator panel — `?test=sim`.
 *
 * Launchpad for testing the app under specific failure / first-run
 * conditions without having to actually be a new user, lose internet,
 * or stub the LLM. Each button navigates to the main app with the
 * right URL flag set; the existing simfail / first-run code paths
 * pick them up and pretend.
 *
 * All flags are dev-only — Vite's `import.meta.env.DEV` DCE strips
 * the handlers from prod builds, so a curious user landing on
 * `?simfail=…` in production sees the normal flow.
 */

import "./DevSimPanel.css";

interface Scenario {
  key: string;
  title: string;
  blurb: string;
  href: string;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    key: "fresh",
    title: "Test as a fresh user",
    blurb:
      "Pretends you haven't connected a sheet yet. Next save opens the Google Picker so you can pick one — your real connection stays put on the backend.",
    href: "/?fresh=1",
  },
  {
    key: "slow",
    title: "Slow LLM (5s before any text)",
    blurb:
      "Adds a 5-second delay before the extraction stream emits anything. Lets you feel the streaming-skeleton state on a real device without throttling your network.",
    href: "/?simfail=slow",
  },
  {
    key: "llm-error",
    title: "LLM hangs / errors mid-stream",
    blurb:
      "The extraction stream connects, sends a couple of fields, then errors out. Tests the fail-clean bounce-back path the way a real upstream-busy outage would.",
    href: "/?simfail=llm",
  },
  {
    key: "net",
    title: "No internet during extraction",
    blurb:
      "Pretends the extract fetch fails before any bytes arrive. You should bounce back to the input/voice phase with the offline pill, not get stuck on a half-loaded review card.",
    href: "/?simfail=net",
  },
  {
    key: "save",
    title: "No internet on review (save offline)",
    blurb:
      "Extracts normally, then shows the offline pill + disabled Save on the review card. Lets you preview the offline UI without putting the phone in airplane mode.",
    href: "/?simfail=save",
  },
  {
    key: "reset",
    title: "Reset — back to normal",
    blurb:
      "Clears all simulator flags and sends you back to the real app.",
    href: "/",
  },
];

export function DevSimPanel(): React.ReactElement {
  return (
    <div className="dev-sim-page">
      <header className="dev-sim-header">
        <h1>Dev Simulator</h1>
        <p>
          Pick a scenario. Each one navigates to the main app with the
          right flag set so the failure path fires without needing to
          actually be offline / a fresh user / stub the LLM.
        </p>
        <p className="dev-sim-note">
          Dev-only — stripped from production builds.
        </p>
      </header>

      <ul className="dev-sim-list">
        {SCENARIOS.map((scenario) => (
          <li key={scenario.key} className="dev-sim-card">
            <a className="dev-sim-link" href={scenario.href}>
              <span className="dev-sim-title">{scenario.title}</span>
              <span className="dev-sim-blurb">{scenario.blurb}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
