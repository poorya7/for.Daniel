/**
 * Application bootstrap.
 *
 * Single responsibility: mount the right root component. The default
 * is <App />; a `?test=<name>` URL bypass mounts a dev test page
 * instead, used for locking down isolated UI patterns before porting
 * them into the main app.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppCanvas } from "@/App.canvas";
import { startQueueRunner } from "@/lib/queue/triggers";
import { DevSimPanel } from "@/test-pages/DevSimPanel";
import { ExtractingPanelLightTestPage } from "@/test-pages/ExtractingPanelLightTestPage";
import { ExtractingShellTestPage } from "@/test-pages/ExtractingShellTestPage";
import { HomeLabPage } from "@/test-pages/HomeLabPage";
import { LastCaptureTestPage } from "@/test-pages/LastCaptureTestPage";
import { LiveCaptionsTestPage } from "@/test-pages/LiveCaptionsTestPage";
import { NoPanelMocksTestPage } from "@/test-pages/NoPanelMocksTestPage";
import { PeakSliderTestPage } from "@/test-pages/PeakSliderTestPage";
import { PickerMorphTestPage } from "@/test-pages/PickerMorphTestPage";
import { PinchPanCropTestPage } from "@/test-pages/PinchPanCropTestPage";
import { ReviewPagerTestPage } from "@/test-pages/ReviewPagerTestPage";
import { SharkLoaderLightTestPage } from "@/test-pages/SharkLoaderLightTestPage";
import { SharkTimingTestPage } from "@/test-pages/SharkTimingTestPage";
import { TapOutsideTestPage } from "@/test-pages/TapOutsideTestPage";
import { WaterMorphTestPage } from "@/test-pages/WaterMorphTestPage";
import { WordmarkLabTestPage } from "@/test-pages/WordmarkLabTestPage";
import "@/styles/global.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in index.html");
}

// Boot the offline-resilient capture queue (plan §6.1). Runs for the
// life of the page: sweeps any records stuck `syncing` from a
// previously-killed tab, drains the queue if non-empty on boot, then
// subscribes to online + visibility triggers for ongoing automatic
// drain passes. The drainer itself uses a Web Lock so concurrent tabs
// can't race the same record. We don't need to keep the returned
// runner around — its triggers fire passively, and explicit
// `drainNow()` calls from the submit path go through the exported
// function directly.
startQueueRunner();

const params = new URLSearchParams(window.location.search);
const testMode = params.get("test");
// Path-based fallback for routes mobile browsers reach via tap/typed URL
// (query params have flaked on iOS Safari for the sim panel — paths
// always survive the address bar). `?test=…` still works for the older
// pages so muscle-memory bookmarks don't break.
const pathName = window.location.pathname.replace(/\/+$/, "");

// Cream canvas is the only app. `/` → AppCanvas. Test pages and
// `?test=…` bypasses unchanged.
const root =
  testMode === "picker-morph" ? <PickerMorphTestPage />
    : testMode === "tap-outside" ? <TapOutsideTestPage />
    : testMode === "live-captions" ? <LiveCaptionsTestPage />
    : testMode === "peak-slider" || pathName.startsWith("/peak-slider") ? <PeakSliderTestPage />
    : testMode === "extracting-shell" || pathName.startsWith("/extracting-shell") ? <ExtractingShellTestPage />
    : testMode === "shark-loader-light" || pathName.startsWith("/shark-loader-light") ? <SharkLoaderLightTestPage />
    : testMode === "shark-timing" || pathName.startsWith("/shark-timing") ? <SharkTimingTestPage />
    : testMode === "extracting-panel-light" || pathName.startsWith("/extracting-panel-light") ? <ExtractingPanelLightTestPage />
    : testMode === "water-morph" || pathName.startsWith("/water-morph") ? <WaterMorphTestPage />
    : testMode === "no-panel-mocks" || pathName.startsWith("/no-panel-mocks") ? <NoPanelMocksTestPage />
    : testMode === "review-pager" || pathName.startsWith("/review-pager") ? <ReviewPagerTestPage />
    : testMode === "pinch-pan" || pathName.startsWith("/pinch-pan") ? <PinchPanCropTestPage />
    : testMode === "last-capture" || pathName.startsWith("/last-capture") ? <LastCaptureTestPage />
    : testMode === "home-lab" || pathName.startsWith("/home-lab") ? <HomeLabPage />
    : testMode === "wordmark-lab" || pathName.startsWith("/wordmark-lab") ? <WordmarkLabTestPage />
    : testMode === "sim" || pathName.startsWith("/sim") ? <DevSimPanel />
    : <AppCanvas />;

createRoot(rootElement).render(<StrictMode>{root}</StrictMode>);
