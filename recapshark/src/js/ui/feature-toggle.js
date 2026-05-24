export const FeatureToggle = (() => {
  function _getTranscriptTab() {
    const tabs = document.querySelectorAll('.tab-btn');
    return tabs[1] || null;
  }

  function setChat(enabled) {
    const ci = document.getElementById('chatInput');
    const cb = document.getElementById('chatSendBtn');
    const cm = document.getElementById('chatMessages');
    if (ci) { ci.disabled = !enabled; ci.placeholder = enabled ? 'Ask about this video...' : 'Chat unavailable — no transcript'; }
    if (cb) cb.disabled = !enabled;
    if (cm) { cm.style.opacity = enabled ? '' : '0.4'; cm.style.pointerEvents = enabled ? '' : 'none'; }
  }

  function setTranscriptTab(enabled) {
    const tab = _getTranscriptTab();
    if (!tab) return;
    tab.disabled = !enabled;
    tab.style.opacity = enabled ? '' : '0.4';
    tab.style.pointerEvents = enabled ? '' : 'none';
  }

  function setLangButton(enabled) {
    const group = document.getElementById('langGroup');
    if (group) { group.style.opacity = enabled ? '' : '0.4'; group.style.pointerEvents = enabled ? '' : 'none'; }
  }

  function setAll(enabled) {
    setChat(enabled);
    setTranscriptTab(enabled);
    setLangButton(enabled);
  }

  return { setChat, setTranscriptTab, setLangButton, setAll };
})();
