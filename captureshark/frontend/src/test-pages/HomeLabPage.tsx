/**
 * Home landing — fresh design lab.
 *
 * Reached at `/home-lab` or `?test=home-lab`. Buttons render but are
 * inert; the goal is the look, not the function. Theme: light, warm,
 * daylight-readable.
 *
 * Mascot is loaded as a CSS mask so the silhouette can be tinted to
 * any theme color via the `--lab-accent` variable.
 */

import "./HomeLabPage.css";

export function HomeLabPage(): React.ReactElement {
  return (
    <main className="lab-home">
      <div className="lab-home__cluster">
        <header className="lab-home__hero">
          <h1 className="lab-home__wordmark" aria-label="CaptureShark">
            <span className="lab-home__wordmark-capture">Capture</span>
            <span className="lab-home__wordmark-shark">Shark</span>
          </h1>
          <div
            className="lab-home__mascot"
            role="img"
            aria-label="CaptureShark mascot"
          />
          <div className="lab-home__tagline-group">
            <p className="lab-home__tagline">
              Field lead{" "}
              <span className="lab-home__arrow" aria-hidden="true">→</span>{" "}
              <span className="lab-home__accent">Google Sheet</span> in seconds
            </p>
            <p className="lab-home__subtagline">
              Photo, voice, or text. AI does the rest.
            </p>
          </div>
        </header>

        <nav className="lab-home__modes" aria-label="Capture mode">
          <LabModeButton label="Photo" icon={<CameraIcon />} />
          <LabModeButton label="Voice" icon={<MicIcon />} />
          <LabModeButton label="Text" icon={<FileTextIcon />} />
        </nav>

        <a
          className="lab-home__sheet-link"
          href="#"
          onClick={(e) => e.preventDefault()}
        >
          <span className="lab-home__sheet-name">CaptureShark Dev Leads</span>
          <span className="lab-home__sheet-arrow" aria-hidden="true">↗</span>
        </a>
      </div>
    </main>
  );
}

interface LabModeButtonProps {
  label: string;
  icon: React.ReactElement;
}

function LabModeButton({ label, icon }: LabModeButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      className="lab-home__mode"
      aria-label={label}
      onClick={(e) => e.preventDefault()}
    >
      <span className="lab-home__mode-icon" aria-hidden="true">{icon}</span>
      <span className="lab-home__mode-label">{label}</span>
    </button>
  );
}

function CameraIcon(): React.ReactElement {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

function MicIcon(): React.ReactElement {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function FileTextIcon(): React.ReactElement {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}
