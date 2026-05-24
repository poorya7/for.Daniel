// Bare IDs referenced inside the DCL block below (toggleOverlay / showToast /
// closeAllOverlays / etc.) are HTML-onclick-bridged — those are public window
// surfaces by design.

document.addEventListener('DOMContentLoaded', () => {

  function on(selector, handler) {
    document.querySelectorAll(selector).forEach(el => el.addEventListener('click', handler));
  }

  function onId(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  }

  /* ── Overlay backdrop + close buttons ── */
  onId('backdrop', () => closeAllOverlays());
  on('.overlay-close', () => closeAllOverlays());

  /* ── History items (placeholder) ── */
  on('.history-item', () => { closeAllOverlays(); showToast('📋 History coming soon!'); });

  /* ── Export options ── */
  on('.export-option', function() { selectExport(this); });

  /* ── Export confirm button ── */
  on('.btn-export-go', () => {
    Analytics.exportConfirmed(document.querySelector('.export-option.selected .export-label')?.textContent || '');
    closeAllOverlays();
    showToast('⬇ Export coming soon!');
  });

  /* ── Overlay toggles (history, lang, export) ── */
  on('.nav-icon-btn[title="Video history"], .nw-history-btn, .nw-history-btn-m', () => toggleOverlay('historyPanel'));
  onId('langToggleBtn', () => toggleOverlay('langPanel'));
  on('.mobile-lang-globe', () => toggleOverlay('langPanel'));
  on('.export-tab-btn, .export-circle-btn', () => toggleOverlay('exportPanel'));
  on('.mobile-export-fab', () => toggleOverlay('exportPanel'));
  on('.tab-btn-bookmarks-circle', () => showToast('📑 Bookmarks coming soon!'));
  on('.tab-btn-language', () => toggleOverlay('langPanel'));

  /* ── Font size ── */
  on('.font-btn, .nw-font-btn', function() {
    const delta = this.textContent.includes('+') ? 1 : -1;
    changeFontSize(delta);
  });

  /* ── Mobile chat (nav button) ── */
  onId('navChatBtnM', () => openMobileChat());

  /* ── Paste buttons ── */
  on('.nav-paste-btn, .btn-paste, .nw-paste-btn', () => triggerPaste());

  /* ── User menu ── */
  on('.user-avatar-btn', (e) => toggleUserMenu(e));

  /* ── Theme switchers ── */
  onId('brutalistCycleBtn', () => cycleBrutalistTheme());
  onId('lightCycleBtn', () => cycleLightTheme());
  onId('darkCycleBtn', () => cycleDarkTheme());

  /* ── Bookmark (placeholder) ── */
  on('.btn-add-bm', () => showToast('📑 Bookmarks coming soon!'));

  /* ── Mobile chat ── */
  onId('mobileChatFab', () => openMobileChat());
  onId('mobileChatBackdrop', () => closeMobileChat());
  on('.mobile-chat-close', () => closeMobileChat());
  /* Maximize / restore the mobile chat overlay. We toggle a .maximized
     class on the overlay (height switches from 66dvh → 100dvh in CSS),
     swap the icon between expand-corners and contract-corners, and
     update the aria-label/title for accessibility. */
  onId('chatMaximizeBtn', () => {
    const overlay = document.getElementById('mobileChatOverlay');
    const btn = document.getElementById('chatMaximizeBtn');
    if (!overlay || !btn) return;
    const isMax = overlay.classList.toggle('maximized');
    btn.setAttribute('aria-label', isMax ? 'Restore chat' : 'Maximize chat');
    btn.setAttribute('title', isMax ? 'Restore' : 'Maximize');
  });

  /* ── Mobile Tools tab — opens #toolsPanel; blocks default tab activation */
  const toolsBtn = document.getElementById('tabBtnToolsMobile');
  if (toolsBtn) {
    toolsBtn.addEventListener('click', function(e) {
      e.stopImmediatePropagation();
      e.preventDefault();
      toggleOverlay('toolsPanel');
    }, true);
  }

  /* ── Tools panel sub-tabs (Bookmarks / Export) ── */
  on('.tools-subtab', function() {
    const tab = this.dataset.toolsTab;
    document.querySelectorAll('.tools-subtab').forEach(b => b.classList.toggle('active', b === this));
    document.querySelectorAll('.tools-subpane').forEach(p => {
      p.classList.toggle('active', p.id === 'toolsSub' + tab.charAt(0).toUpperCase() + tab.slice(1));
    });
  });

  /* ── "Add bookmark" → show the in-panel "coming soon" dialog ── */
  onId('bmAddBtn', () => {
    const dlg = document.getElementById('bmDialog');
    if (dlg) dlg.classList.add('show');
  });
  onId('bmDialogClose', () => {
    const dlg = document.getElementById('bmDialog');
    if (dlg) dlg.classList.remove('show');
  });

  /* ── User dropdown items (placeholder) ── */
  on('.user-dropdown-item:not(.signout)', () => { showToast('👤 Switch account coming soon!'); toggleUserMenu(); });
  on('.user-dropdown-item.signout', () => { showToast('👋 Sign out coming soon!'); toggleUserMenu(); });

});
