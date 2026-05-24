/**
 * Translation UI — barrel re-export
 * Sub-modules: lang-panel, transcript, bilingual
 */
export { _buildLangPanel, _repositionLangBar } from './translation-lang-panel.js';

export {
  _getTranscriptLines,
} from './translation-transcript.js';

export {
  _removeAllSubs,
  _createBilingualControls,
  _showBilingualControls,
  _hideBilingualControls,
  _setBilingualEnabled,
  _updateCollapseBtnAvailability,
  _evalPendingForCurrentTab,
  _markSectionReady,
  _showTranslateProgress,
  _hideTranslateProgress,
  _updateSwitchBtn,
  _updateToggleLabel,
  _showQualityWarning,
  _hideQualityWarning,
  _showCapHitNotice,
  _hideCapHitNotice,
  _precacheGreeting,
  _translateChatGreeting,
} from './translation-bilingual.js';
