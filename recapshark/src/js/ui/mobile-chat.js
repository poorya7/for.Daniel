var _mobileChClosing = false;

function openMobileChat() {
  if (_mobileChClosing) return;
  const src = document.querySelector('.chat-panel');
  if (!src) return;
  const dest = document.getElementById('mobileChatBody');
  const overlay = document.getElementById('mobileChatOverlay');
  const backdrop = document.getElementById('mobileChatBackdrop');
  const fab = document.getElementById('mobileChatFab');
  const resultsView = document.getElementById('resultsView');
  const isFirstPage = resultsView && resultsView.classList.contains('hidden');
  dest.appendChild(src);
  src.style.display = 'flex';
  if (isFirstPage) {
    var messages = document.getElementById('chatMessages');
    var emptyState = document.getElementById('chatEmptyState');
    var inputArea = src.querySelector('.chat-input-area');
    if (messages) {
      messages.innerHTML = '<div class="chat-spacer"></div><div class="chat-bubble bubble-ai"><div class="bubble-label"><img src="' + window.RS_ASSETS.sharky + '" alt="" class="label-shark"> RecapShark.com</div>Copy a YouTube video URL, then press on the button above to recap.</div>';
    }
    if (emptyState) emptyState.style.display = 'none';
    if (inputArea) inputArea.style.display = 'none';
  } else {
    var emptyState = document.getElementById('chatEmptyState');
    var inputArea = src.querySelector('.chat-input-area');
    if (emptyState) emptyState.style.display = '';
    if (inputArea) inputArea.style.display = '';
  }
  overlay.classList.add('open');
  overlay.style.visibility = 'visible';
  backdrop.classList.add('open');
  // Engage the scroll lock: CSS freezes html/body via overflow:hidden +
  // overscroll-behavior:none while .chat-messages contains its own scroll
  // via overscroll-behavior:contain. Pure CSS approach — no position:fixed
  // (keeps input focus / iOS keyboard working) and no touchmove
  // preventDefault (which breaks synthetic click → textarea focus on iOS).
  document.documentElement.classList.add('mobile-chat-open');
  document.body.classList.add('mobile-chat-open');
  if (fab) fab.style.display = 'none';
  var messages = document.getElementById('chatMessages');
  if (messages) {
    requestAnimationFrame(function() { messages.scrollTop = messages.scrollHeight; });
  }
}

function closeMobileChat() {
  if (_mobileChClosing) return;
  const src = document.querySelector('.chat-panel');
  if (!src) return;
  _mobileChClosing = true;
  const input = src.querySelector('.chat-input');
  if (input) input.blur();
  const overlay = document.getElementById('mobileChatOverlay');
  const backdrop = document.getElementById('mobileChatBackdrop');
  const fab = document.getElementById('mobileChatFab');
  overlay.style.pointerEvents = 'none';
  backdrop.style.pointerEvents = 'none';
  overlay.classList.remove('open');
  overlay.classList.remove('maximized');
  const maxBtn = document.getElementById('chatMaximizeBtn');
  if (maxBtn) {
    maxBtn.setAttribute('aria-label', 'Maximize chat');
    maxBtn.setAttribute('title', 'Maximize');
  }
  backdrop.classList.remove('open');
  // Release the scroll lock by removing the classes (restores html/body
  // overflow). Page scroll position is untouched — nothing to restore
  // because we never moved it.
  document.documentElement.classList.remove('mobile-chat-open');
  document.body.classList.remove('mobile-chat-open');
  setTimeout(function() {
    overlay.style.visibility = 'hidden';
    overlay.style.pointerEvents = '';
    backdrop.style.pointerEvents = '';
    const dash = document.querySelector('.dashboard');
    if (dash) dash.appendChild(src);
    src.style.display = '';
    if (fab) fab.style.display = '';
    _mobileChClosing = false;
  }, 380);
}

export { openMobileChat, closeMobileChat };
// (window.openMobileChat / closeMobileChat bound from main.js — single bridge.)
