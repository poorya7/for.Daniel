import { Analytics } from '../analytics/analytics.js';
import { syncPanelLayout } from './controls.js';

/*
 * Theme registry. Each entry is a complete set of CSS variable values that
 * applyTheme() pushes onto :root. Light + dark themes only override COLOUR
 * tokens — structural tokens (fonts, radii, borders, shadows, heading styling)
 * are inherited from the :root defaults in dashboard.css. Brutalist is the
 * one theme that replaces the structural tokens too, giving it its signature
 * sharp/chunky aesthetic without needing per-rule body.theme-brutalist
 * overrides throughout the rest of the CSS.
 */
const themes = {
  light: [
    { name:'Cyber Ocean',   nwBg:'#0A2F4A', nwLbg:'rgba(8,145,178,0.18)',   nwLbc:'rgba(8,145,178,0.40)',   vars:{'--bg':'#EFF9FB','--surface':'#F8FCFF','--surface2':'#0D2535','--border':'#A5E5F0','--text-primary':'#0C1E2A','--text-secondary':'#2A5A70','--text-muted':'#7AAFC0','--accent':'#0891B2','--accent-light':'#C8EEF5','--accent-hover':'#0E7490','--accent2':'#5B6E8A','--accent2-light':'#EDF1F5','--separator':'#0D2E4A','--nav-bg':'#061526','--nav-muted':'#5ABCD4','--chip-bg':'#C8EEF5','--chip-text':'#0891B2','--vc-bg':'#061526','--vc-border':'#0D2E4A','--vc-text':'#5ABCD4','--vc-text-bright':'#C8EEF5','--vc-cc-bg':'#0A2F4A','--vc-cc-border':'#0E7490','--bubble-ai-bg':'#154058','--bubble-ai-text':'#D8F0F8','--bubble-ai-border':'#1E5570','--bubble-label-color':'#5ABCD4','--highlight-kw':'#D946EF','--highlight-name':'#E07C00','--highlight-date':'#7C8B6F','--highlight-tr':'#7C3AED','--highlight-karaoke':'#E6007A','--highlight-warm':'#F59E0B','--highlight-pop':'#FF6B6B'}},
    { name:'Violet Dreams', nwBg:'#280B50', nwLbg:'rgba(124,58,237,0.15)',   nwLbc:'rgba(124,58,237,0.35)', vars:{'--bg':'#FAF5FF','--surface':'#FFFFFF','--surface2':'#1A0A38','--border':'#DDD6FE','--text-primary':'#1E0B45','--text-secondary':'#5B3A8F','--text-muted':'#9B79D4','--accent':'#7C3AED','--accent-light':'#F3EEFF','--accent-hover':'#6D28D9','--accent2':'#7070B8','--accent2-light':'#F0F0FA','--separator':'#220550','--nav-bg':'#12002E','--nav-muted':'#A78BFA','--chip-bg':'#F3EEFF','--chip-text':'#7C3AED','--vc-bg':'#12002E','--vc-border':'#220550','--vc-text':'#A78BFA','--vc-text-bright':'#DDD6FE','--vc-cc-bg':'#1A0A38','--vc-cc-border':'#6D28D9','--bubble-ai-bg':'#3A2070','--bubble-ai-text':'#E0D4F8','--bubble-ai-border':'#4A2E88','--bubble-label-color':'#A78BFA','--highlight-kw':'#D946EF','--highlight-name':'#0891B2','--highlight-date':'#8B7355','--highlight-tr':'#B45309','--highlight-karaoke':'#F59E0B','--highlight-warm':'#FBBF24','--highlight-pop':'#EC4899'}},
    { name:'Cherry Blossom',nwBg:'#320050', nwLbg:'rgba(219,39,119,0.15)',   nwLbc:'rgba(219,39,119,0.35)', vars:{'--bg':'#FFF0F6','--surface':'#FFFFFF','--surface2':'#1F002E','--border':'#FBCFE8','--text-primary':'#3B0060','--text-secondary':'#7E2B80','--text-muted':'#C084FC','--accent':'#DB2777','--accent-light':'#FDF2FA','--accent-hover':'#BE185D','--accent2':'#7C3AED','--accent2-light':'#F3EEFF','--separator':'#2E0050','--nav-bg':'#1A0026','--nav-muted':'#C084FC','--chip-bg':'#FDF2FA','--chip-text':'#DB2777','--vc-bg':'#1A0026','--vc-border':'#2E0050','--vc-text':'#C084FC','--vc-text-bright':'#FBCFE8','--vc-cc-bg':'#1F002E','--vc-cc-border':'#BE185D','--bubble-ai-bg':'#481A58','--bubble-ai-text':'#F4D0E8','--bubble-ai-border':'#5C2470','--bubble-label-color':'#F472B6','--highlight-kw':'#1D4ED8','--highlight-name':'#047857','--highlight-date':'#8B6914','--highlight-tr':'#B45309','--highlight-karaoke':'#059669','--highlight-warm':'#F59E0B','--highlight-pop':'#EF4444'}},
    { name:'Terracotta',    nwBg:'#2E1200', nwLbg:'rgba(194,65,12,0.15)',    nwLbc:'rgba(194,65,12,0.35)',  vars:{'--bg':'#FFF5EE','--surface':'#FFFCF8','--surface2':'#1E0800','--border':'#FDDCBD','--text-primary':'#230800','--text-secondary':'#7A3000','--text-muted':'#B06030','--accent':'#C2410C','--accent-light':'#FFF2EC','--accent-hover':'#9A3412','--accent2':'#5A8A80','--accent2-light':'#EEF5F3','--separator':'#2E1200','--nav-bg':'#1A0800','--nav-muted':'#C05621','--chip-bg':'#FFF2EC','--chip-text':'#C2410C','--vc-bg':'#1A0800','--vc-border':'#2E1200','--vc-text':'#C05621','--vc-text-bright':'#FDDCBD','--vc-cc-bg':'#1E0800','--vc-cc-border':'#9A3412','--bubble-ai-bg':'#4A2810','--bubble-ai-text':'#F4DCC4','--bubble-ai-border':'#5C3418','--bubble-label-color':'#F97316','--highlight-kw':'#7C3AED','--highlight-name':'#0891B2','--highlight-date':'#6B7C5A','--highlight-tr':'#D946EF','--highlight-karaoke':'#2563EB','--highlight-warm':'#FCD34D','--highlight-pop':'#EF4444'}},
    { name:'Classic Blue',  nwBg:'#0D1520', nwLbg:'rgba(37,99,235,0.15)',    nwLbc:'rgba(37,99,235,0.35)',  vars:{'--bg':'#F4F6F8','--surface':'#FFFFFF','--surface2':'#FFFFFF','--border':'#E2E6EA','--text-primary':'#0F1923','--text-secondary':'#5A6472','--text-muted':'#9AA3AD','--accent':'#2563EB','--accent-light':'#EEF3FF','--accent-hover':'#1D4ED8','--accent2':'#E07C5A','--accent2-light':'#FFF7ED','--separator':'#1E293B','--nav-bg':'#111827','--nav-muted':'#6B7280','--chip-bg':'#EEF3FF','--chip-text':'#2563EB','--vc-bg':'#111827','--vc-border':'#1F2937','--vc-text':'#6B7280','--vc-text-bright':'#E2E6EA','--vc-cc-bg':'#1F2937','--vc-cc-border':'#374151','--bubble-ai-bg':'#2A3A50','--bubble-ai-text':'#D8E4F0','--bubble-ai-border':'#384C64','--bubble-label-color':'#60A5FA','--highlight-kw':'#E07C00','--highlight-name':'#7C3AED','--highlight-date':'#7A8A6A','--highlight-tr':'#B45309','--highlight-karaoke':'#DB2777','--highlight-warm':'#F59E0B','--highlight-pop':'#EC4899'}},
    { name:'Emerald Scholar',nwBg:'#023520',nwLbg:'rgba(5,150,105,0.15)',    nwLbc:'rgba(5,150,105,0.35)',  vars:{'--bg':'#F0FDF4','--surface':'#F8FFF9','--surface2':'#021A10','--border':'#A7F3D0','--text-primary':'#012010','--text-secondary':'#1A5C30','--text-muted':'#40A060','--accent':'#059669','--accent-light':'#ECFDF5','--accent-hover':'#047857','--accent2':'#4A6878','--accent2-light':'#ECF1F3','--separator':'#063020','--nav-bg':'#011A0A','--nav-muted':'#34D399','--chip-bg':'#ECFDF5','--chip-text':'#059669','--vc-bg':'#011A0A','--vc-border':'#063020','--vc-text':'#34D399','--vc-text-bright':'#A7F3D0','--vc-cc-bg':'#021A10','--vc-cc-border':'#047857','--bubble-ai-bg':'#143D28','--bubble-ai-text':'#C8F0DC','--bubble-ai-border':'#1E5238','--bubble-label-color':'#34D399','--highlight-kw':'#D946EF','--highlight-name':'#E07C00','--highlight-date':'#8B7355','--highlight-tr':'#1D4ED8','--highlight-karaoke':'#DB2777','--highlight-warm':'#FBBF24','--highlight-pop':'#EC4899'}},
  ],
  dark: [
    { name:'Gold & Obsidian',nwBg:'#2A2208', nwLbg:'rgba(217,119,6,0.20)',   nwLbc:'rgba(217,119,6,0.45)',  vars:{'--bg':'#0C0A02','--surface':'#1A1708','--surface2':'#12100A','--border':'#584A28','--panel-gap':'#615532','--text-primary':'#F5F0D0','--text-secondary':'#D4C888','--text-muted':'#8A7840','--accent':'#D97706','--accent-light':'#261C06','--accent-hover':'#B45309','--accent2':'#10B981','--accent2-light':'#082A1A','--separator':'#584A28','--nav-bg':'#08080A','--nav-muted':'#B38A00','--chip-bg':'#261C06','--chip-text':'#D97706','--vc-bg':'#08080A','--vc-border':'#1A1800','--vc-text':'#B38A00','--vc-text-bright':'#F5F0D0','--vc-cc-bg':'#1A1600','--vc-cc-border':'#B45309','--bubble-ai-bg':'#2A2510','--bubble-ai-text':'#F5F0D0','--bubble-ai-border':'#4A4020','--bubble-label-color':'#D4A84B','--highlight-kw':'#D97706','--highlight-name':'#10B981','--highlight-date':'#C8A070','--highlight-tr':'#A78BFA','--highlight-karaoke':'#06B6D4','--highlight-warm':'#FBBF24','--highlight-pop':'#EC4899'}},
    { name:'Deep Space',    nwBg:'#141838', nwLbg:'rgba(99,102,241,0.15)',    nwLbc:'rgba(99,102,241,0.35)', vars:{'--bg':'#060814','--surface':'#101838','--surface2':'#0A1028','--border':'#2E3C70','--panel-gap':'#35394D','--text-primary':'#E0E8F8','--text-secondary':'#98A8D8','--text-muted':'#4A5A8A','--accent':'#6366F1','--accent-light':'#141A48','--accent-hover':'#4F46E5','--accent2':'#EC4899','--accent2-light':'#1A0820','--separator':'#2E3C70','--nav-bg':'#030510','--nav-muted':'#5A6AB0','--chip-bg':'#141A48','--chip-text':'#6366F1','--vc-bg':'#030510','--vc-border':'#0C1228','--vc-text':'#5A6AB0','--vc-text-bright':'#D4DEF8','--vc-cc-bg':'#070A18','--vc-cc-border':'#4F46E5','--bubble-ai-bg':'#1A2248','--bubble-ai-text':'#E0E8F8','--bubble-ai-border':'#2A3868','--bubble-label-color':'#818CF8','--highlight-kw':'#6366F1','--highlight-name':'#EC4899','--highlight-date':'#D4A870','--highlight-tr':'#F59E0B','--highlight-karaoke':'#EC4899','--highlight-warm':'#FBBF24','--highlight-pop':'#F472B6'}},
    { name:'Midnight Crimson',nwBg:'#241018',nwLbg:'rgba(225,29,72,0.15)',   nwLbc:'rgba(225,29,72,0.35)',  vars:{'--bg':'#0A050A','--surface':'#1E0C18','--surface2':'#140810','--border':'#4E2040','--panel-gap':'#4A2D3E','--text-primary':'#F5D8E0','--text-secondary':'#D098A8','--text-muted':'#704050','--accent':'#E11D48','--accent-light':'#220A14','--accent-hover':'#BE123C','--accent2':'#06B6D4','--accent2-light':'#041418','--separator':'#4E2040','--nav-bg':'#060306','--nav-muted':'#903860','--chip-bg':'#220A14','--chip-text':'#E11D48','--vc-bg':'#060306','--vc-border':'#1A0810','--vc-text':'#903860','--vc-text-bright':'#F0D0D8','--vc-cc-bg':'#100610','--vc-cc-border':'#BE123C','--bubble-ai-bg':'#2A1020','--bubble-ai-text':'#F5D8E0','--bubble-ai-border':'#4A2038','--bubble-label-color':'#F472B6','--highlight-kw':'#E11D48','--highlight-name':'#06B6D4','--highlight-date':'#D4A870','--highlight-tr':'#F59E0B','--highlight-karaoke':'#4ADE80','--highlight-warm':'#FBBF24','--highlight-pop':'#06B6D4'}},
    { name:'Shadow Emerald', nwBg:'#181818', nwLbg:'rgba(34,197,94,0.14)',    nwLbc:'rgba(34,197,94,0.35)',  vars:{'--bg':'#0C0C0C','--surface':'#1A1A1A','--surface2':'#141414','--border':'#404040','--panel-gap':'#3F3F3F','--text-primary':'#ECECEC','--text-secondary':'#B8B8B8','--text-muted':'#686868','--accent':'#22C55E','--accent-light':'#122218','--accent-hover':'#16A34A','--accent2':'#5AAACC','--accent2-light':'#0C1418','--separator':'#404040','--nav-bg':'#080808','--nav-muted':'#3BB860','--chip-bg':'#122218','--chip-text':'#22C55E','--vc-bg':'#080808','--vc-border':'#1A1A1A','--vc-text':'#3BB860','--vc-text-bright':'#E8E8E8','--vc-cc-bg':'#0E0E0E','--vc-cc-border':'#16A34A','--bubble-ai-bg':'#242424','--bubble-ai-text':'#ECECEC','--bubble-ai-border':'#3A3A3A','--bubble-label-color':'#4ADE80','--highlight-kw':'#22C55E','--highlight-name':'#5AAACC','--highlight-date':'#C8A870','--highlight-tr':'#F472B6','--highlight-karaoke':'#FACC15','--highlight-warm':'#FBBF24','--highlight-pop':'#F472B6'}},
    { name:'Carbon',        nwBg:'#142030', nwLbg:'rgba(59,130,246,0.15)',    nwLbc:'rgba(59,130,246,0.35)', vars:{'--bg':'#0A0E18','--surface':'#152030','--surface2':'#101828','--border':'#304058','--panel-gap':'#343B49','--text-primary':'#D8E2F0','--text-secondary':'#90A0C0','--text-muted':'#485878','--accent':'#3B82F6','--accent-light':'#121E38','--accent-hover':'#2563EB','--accent2':'#A855F7','--accent2-light':'#1A0828','--separator':'#304058','--nav-bg':'#050810','--nav-muted':'#5868A8','--chip-bg':'#121E38','--chip-text':'#3B82F6','--vc-bg':'#050810','--vc-border':'#101828','--vc-text':'#5868A8','--vc-text-bright':'#C8D4E8','--vc-cc-bg':'#080E1C','--vc-cc-border':'#2563EB','--bubble-ai-bg':'#1E2A40','--bubble-ai-text':'#D8E2F0','--bubble-ai-border':'#304058','--bubble-label-color':'#60A5FA','--highlight-kw':'#3B82F6','--highlight-name':'#A855F7','--highlight-date':'#D4A870','--highlight-tr':'#F59E0B','--highlight-karaoke':'#F472B6','--highlight-warm':'#FBBF24','--highlight-pop':'#F472B6'}},
  ],
  brutalist: [
    { name:'RecapShark OG', bodyClass:'theme-brutalist', nwBg:'#1B323A', nwLbg:'rgba(220,38,38,0.15)', nwLbc:'rgba(220,38,38,0.70)', vars:{'--bg':'#F5F0E8','--surface':'#FFFFFF','--surface2':'#FFFBE6','--border':'#0C1E2A','--text-primary':'#0C1E2A','--text-secondary':'#2A5A70','--text-muted':'#7AAFC0','--accent':'#0891B2','--accent-light':'#D5F5FA','--accent-hover':'#0E7490','--accent2':'#DC2626','--accent2-light':'#FEF2F2','--separator':'#0C1E2A','--nav-bg':'#0C1E2A','--nav-muted':'#5ABCD4','--chip-bg':'#DC2626','--chip-text':'#FFFFFF','--vc-bg':'#FFFFFF','--vc-border':'#0C1E2A','--vc-text':'#2A5A70','--vc-text-bright':'#0C1E2A','--vc-cc-bg':'#F5F0E8','--vc-cc-border':'#0C1E2A','--bubble-ai-bg':'#FFFBE6','--bubble-ai-text':'#0C1E2A','--bubble-ai-border':'#0C1E2A','--bubble-label-color':'#0891B2','--highlight-kw':'#D946EF','--highlight-name':'#E07C00','--highlight-date':'#7C8B6F','--highlight-tr':'#7C3AED','--highlight-karaoke':'#C026D3','--highlight-warm':'#FFD100','--highlight-pop':'#EE5E48','--font-heading':'"Syne", sans-serif','--font-body':'"Space Grotesk", sans-serif','--font-mono':'"JetBrains Mono", monospace','--font-display':'"Unbounded", sans-serif','--radius-sm':'2px','--radius':'4px','--radius-lg':'6px','--border-width':'2px','--border-width-thick':'3px','--shadow-sm':'2px 2px 0 rgba(12,30,42,0.2)','--shadow-md':'4px 4px 0 rgba(12,30,42,0.2)','--shadow-lg':'6px 6px 0 rgba(12,30,42,0.25)','--heading-weight':'700','--heading-case':'uppercase','--heading-letter-spacing':'0.05em'}},
  ]
};

let currentMode = 'brutalist', lightIdx = 0, darkIdx = 0, brutalistIdx = 0;

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function lightenHex(hex, amount) {
  let r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  r = Math.min(255, Math.round(r + (255 - r) * amount));
  g = Math.min(255, Math.round(g + (255 - g) * amount));
  b = Math.min(255, Math.round(b + (255 - b) * amount));
  return '#' + [r,g,b].map(c => c.toString(16).padStart(2,'0')).join('');
}
function darkenHex(hex, amount) {
  let r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  r = Math.round(r * (1 - amount)); g = Math.round(g * (1 - amount)); b = Math.round(b * (1 - amount));
  return '#' + [r,g,b].map(c => c.toString(16).padStart(2,'0')).join('');
}

/*
 * Structural tokens (fonts/radii/borders/shadows/heading styling) live only
 * on the brutalist theme. When the user cycles AWAY from brutalist we must
 * actively remove these inline properties from :root so the theme stops
 * over-riding the :root modern-defaults. Colour tokens get overwritten every
 * time by the theme.vars loop; structural tokens don't, because light/dark
 * themes don't include them — without this removal their values would stick.
 */
const STRUCTURAL_TOKEN_KEYS = [
  '--font-heading', '--font-body', '--font-mono', '--font-display',
  '--radius-sm', '--radius', '--radius-lg',
  '--border-width', '--border-width-thick',
  '--shadow-sm', '--shadow-md', '--shadow-lg',
  '--heading-weight', '--heading-case', '--heading-letter-spacing',
];

function applyTheme(theme, mode) {
  const root = document.documentElement;
  // Clear any brutalist structural tokens left over from a previous apply —
  // the theme.vars loop below will re-add them only if this theme defines
  // them (brutalist does; light/dark don't).
  STRUCTURAL_TOKEN_KEYS.forEach(k => root.style.removeProperty(k));

  // Transcript / subtitle entity-highlight palette (date / num / name from
  // entity-highlighter.js). Set BEFORE theme.vars so a theme can opt-in to
  // a custom palette by including --tx-*-color in its vars (vars loop wins
  // by virtue of running second). Defaults split by mode because the same
  // strong colors that pop on cream/white surfaces (light + brutalist) sink
  // into the background on dark surfaces — dark themes need brighter mid-tones.
  const isLightSurface = mode === 'light' || mode === 'brutalist';
  if (isLightSurface) {
    root.style.setProperty('--tx-date-color',      '#C2410C'); // terracotta
    root.style.setProperty('--tx-num-color',       '#15803D'); // forest green
    root.style.setProperty('--tx-name-color',      '#7C3AED'); // purple
    root.style.setProperty('--tx-stretch-color',   '#DB2777'); // hot pink
    root.style.setProperty('--tx-discourse-color', '#0E7490'); // dark cyan
    root.style.setProperty('--tx-punct-color',     '#A16207'); // mustard
  } else {
    root.style.setProperty('--tx-date-color',      '#FB923C'); // bright orange
    root.style.setProperty('--tx-num-color',       '#34D399'); // emerald
    root.style.setProperty('--tx-name-color',      '#C084FC'); // orchid
    root.style.setProperty('--tx-stretch-color',   '#F472B6'); // rose
    root.style.setProperty('--tx-discourse-color', '#67E8F9'); // light cyan
    root.style.setProperty('--tx-punct-color',     '#FCD34D'); // amber
  }

  Object.entries(theme.vars).forEach(([k,v]) => root.style.setProperty(k, v));
  document.querySelector('.now-watching-bar').style.background = theme.nwBg;
  const lbl = document.querySelector('.nw-label');
  if (lbl) { lbl.style.background = theme.nwLbg; lbl.style.borderColor = theme.nwLbc; }
  currentMode = mode;
  document.getElementById('lightCycleBtn').classList.toggle('is-active', mode === 'light');
  document.getElementById('darkCycleBtn').classList.toggle('is-active', mode === 'dark');
  const brutBtn = document.getElementById('brutalistCycleBtn');
  if (brutBtn) brutBtn.classList.toggle('is-active', mode === 'brutalist');
  document.body.classList.remove('dark');

  const accent = theme.vars['--accent'];
  root.style.setProperty('--mech-accent', accent);
  root.style.setProperty('--mech-bright', lightenHex(accent, 0.35));
  root.style.setProperty('--mech-glow', hexToRgba(accent, 0.4));
  root.style.setProperty('--mech-dim', theme.vars['--vc-border']);
  root.style.setProperty('--mech-icon', theme.vars['--vc-text']);
  root.style.setProperty('--mech-text', theme.vars['--vc-text']);
  root.style.setProperty('--mech-sep', darkenHex(theme.vars['--vc-text'], 0.5));

  if (mode === 'light' || mode === 'brutalist') root.style.removeProperty('--panel-gap');

  // Remove all theme body classes, then apply current one if set
  document.body.classList.forEach(c => { if (c.startsWith('theme-')) document.body.classList.remove(c); });
  if (theme.bodyClass) document.body.classList.add(theme.bodyClass);
  document.body.classList.add('theme-mode-' + mode);

  // Re-sync the resizable panel layout — brutalist and non-brutalist use
  // fundamentally different grids + inline-style sets. Without this call,
  // inline styles stamped during a resize in one theme leak into the other
  // (e.g. stale dashboard margin-right after switching away from brutalist).
  syncPanelLayout();

  // Karaoke caches per-cluster horizontal mid-fractions for the wave loop's
  // timing math, AND caches --karaoke-radius-sec which a theme can change.
  // Both need to invalidate after a theme apply. One-way coupling via window
  // event so themes.js doesn't need to know karaoke exists.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('rs:layout-change', { detail: { source: 'theme' } }));
  }
}

export function cycleLightTheme() {
  lightIdx = (lightIdx + 1) % themes.light.length;
  applyTheme(themes.light[lightIdx], 'light');
  Analytics.themeChanged('light', themes.light[lightIdx].name);
}

export function cycleDarkTheme() {
  darkIdx = (darkIdx + 1) % themes.dark.length;
  applyTheme(themes.dark[darkIdx], 'dark');
  Analytics.themeChanged('dark', themes.dark[darkIdx].name);
}

export function cycleBrutalistTheme() {
  brutalistIdx = (brutalistIdx + 1) % themes.brutalist.length;
  applyTheme(themes.brutalist[brutalistIdx], 'brutalist');
  Analytics.themeChanged('brutalist', themes.brutalist[brutalistIdx].name);
}

document.addEventListener('DOMContentLoaded', function() {
  applyTheme(themes.brutalist[0], 'brutalist');
});
