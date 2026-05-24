(function() {
  const SELECTORS = '.summary-pane, .transcript-list, .chapters-list, .chat-messages, .bookmarks-pane, .overlay-body';
  const HIDE_DELAY = 1000;
  const timers = new WeakMap();

  function attachScrollBar(el) {
    el.addEventListener('scroll', () => {
      el.classList.add('is-scrolling');
      clearTimeout(timers.get(el));
      timers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), HIDE_DELAY));
    }, { passive: true });
  }

  function init() {
    document.querySelectorAll(SELECTORS).forEach(attachScrollBar);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
