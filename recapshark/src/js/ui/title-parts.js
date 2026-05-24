/**
 * title-parts.js — HTML building for title displays.
 *
 * Owns: parsing colorized title HTML into hero / before / after / channel
 * parts, word-counting (whitespace-based), styling the channel pipe
 * separator, and building the inner HTML for single-language and
 * bilingual displays.
 *
 * Imports: title-lang for langClassesFor (used by buildBilingualHTML).
 * Reads: AppState.videoData.channel + Helpers.escapeHtml via window bridge.
 */

import { langClassesFor } from './title-lang.js';

/**
 * Parse colorized title HTML into hero/top/bottom parts.
 */
export function parseParts(html) {
  if (!html) return { before: '', hero: '', after: '', channel: '' };

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Channel resolution order:
  //   1) AppState.videoData.channel (yt-dlp metadata, slow)
  //   2) #videoChannel DOM (also yt-dlp-sourced, same timing)
  //   3) Pipe-extracted from the title text itself — YouTube titles often
  //      end in " | Channel", and the colorize HTML carries that suffix
  //      from the start. Without this, .ts1-channel sits empty during
  //      rewind and pops in once yt-dlp returns, adding ~11px of vertical
  //      space and pushing the video frame + everything below it down.
  let channel = (typeof AppState !== 'undefined' && AppState.videoData?.channel)
    ? AppState.videoData.channel
    : (document.getElementById('videoChannel')?.textContent || '');
  if (!channel) {
    const fullText = tmp.textContent || '';
    const lastPipe = fullText.lastIndexOf('|');
    if (lastPipe !== -1) {
      const after = fullText.slice(lastPipe + 1).trim();
      // Reject pathological tails ("a", or one with another |) — those are
      // unlikely to be a channel name.
      if (after.length >= 2 && after.length <= 60 && !after.includes('|')) {
        channel = after;
      }
    }
  }

  // 1) API-colorized yellow span
  const heroSpan = tmp.querySelector('span[style*="FF2D78"]');
  if (heroSpan) {
    let before = '', after = '', found = false;
    for (const node of tmp.childNodes) {
      if (node === heroSpan) { found = true; continue; }
      const c = node.nodeType === Node.TEXT_NODE ? node.textContent : node.outerHTML;
      if (!found) before += c; else after += c;
    }
    return { before: before.trim(), hero: heroSpan.textContent.trim(), after: after.trim(), channel };
  }

  // 2) Fallback: longest ALL-CAPS word
  const fullText = tmp.textContent;
  const capsWords = fullText.match(/\b[A-Z]{4,}\b/g);
  if (capsWords) {
    const heroWord = capsWords.sort((a, b) => b.length - a.length)[0];
    const splitParts = html.split(heroWord);
    return { before: splitParts[0].trim(), hero: heroWord, after: splitParts.slice(1).join(heroWord).trim(), channel };
  }

  return { before: html, hero: '', after: '', channel };
}

/**
 * Count words in text (strips HTML tags first).
 *
 * TODO(cjk-layout): This splits on whitespace, which always returns 1 for
 * unspaced scripts (Chinese, Japanese, Thai, Lao, Khmer, Burmese). As a
 * result, buildDisplayHTML always thinks the title is "short" for those
 * languages and renders the hero inline instead of on its own line.
 * Fix: detect unspaced scripts (e.g. via the panel's lang-* class) and
 * use a character-count threshold (~6+ chars = "long enough") for those.
 * Until then, CJK titles render as a single wrapping line with the hero
 * inline — functional but loses the dramatic own-line treatment.
 */
export function wordCount(text) {
  if (!text) return 0;
  const plain = text.replace(/<[^>]*>/g, '').trim();
  return plain ? plain.split(/\s+/).length : 0;
}

/**
 * Style pipe separator + channel name (e.g. "| The Daily Show") with muted color.
 */
export function stylePipe(html) {
  // Match | and everything after it (including HTML spans) until </div>
  return html.replace(
    /(\s*\|\s*)([\s\S]*?)(\s*<\/div>)/,
    '<span class="ts1-pipe"> | </span><span class="ts1-channel-tag">$2</span>$3'
  );
}

/**
 * Build the inner HTML for a .ts-display panel.
 * If before or after has < 3 words, merge it inline with the hero.
 */
export function buildDisplayHTML(p) {
  const heroSpan = p.hero ? `<span class="ts1-hero">${p.hero}</span>` : '';
  const bw = wordCount(p.before);
  const aw = wordCount(p.after);

  let top, bottom;

  if (!p.hero) {
    top = p.before;
    bottom = p.after;
  } else if (bw < 3 && aw < 3) {
    // Both short — everything on one line
    top = [p.before, heroSpan, p.after].filter(Boolean).join(' ');
    bottom = '';
  } else if (bw < 3) {
    // Before short — merge with hero (avoids orphan 1-2 word top line)
    top = [p.before, heroSpan].filter(Boolean).join(' ');
    bottom = p.after;
  } else if (aw < 3) {
    // After short — merge with hero (avoids orphan 1-2 word bottom line)
    top = p.before;
    bottom = [heroSpan, p.after].filter(Boolean).join(' ');
  } else {
    // Both long enough — hero gets its own line
    return `<div class="ts1-wrap">
      <div class="ts1-channel">${p.channel}</div>
      <div class="ts1-rule"></div>
      <div class="ts1-top">${p.before}</div>
      ${heroSpan}
      <div class="ts1-bottom">${p.after}</div>
    </div>`;
  }

  return `<div class="ts1-wrap">
      <div class="ts1-channel">${p.channel}</div>
      <div class="ts1-rule"></div>
      <div class="ts1-top">${top}</div>
      ${bottom ? `<div class="ts1-bottom">${bottom}</div>` : ''}
    </div>`;
}

/**
 * Build bilingual side-by-side HTML: two .ts1-wrap columns in a grid.
 * primaryLang is the "main" language (translated), secondaryLang is the
 * "other" (original).
 */
export function buildBilingualHTML(primaryHTML, secondaryHTML, primaryLang, secondaryLang, swapped) {
  const pParts = parseParts(primaryHTML);
  const sParts = parseParts(secondaryHTML);

  const pInner = buildDisplayHTML(pParts);
  const sInner = buildDisplayHTML(sParts);

  // Apply lang classes directly on each .ts1-wrap column
  const pLangCls = langClassesFor(primaryLang);
  const sLangCls = langClassesFor(secondaryLang);

  const swapCls = swapped ? ' bilingual-cols-swapped' : '';

  return '<div class="ts-display-bilingual' + swapCls + '">' +
    pInner.replace('class="ts1-wrap"', 'class="ts1-wrap ' + pLangCls + '"') +
    sInner.replace('class="ts1-wrap"', 'class="ts1-wrap ' + sLangCls + '"') +
    '</div>';
}
