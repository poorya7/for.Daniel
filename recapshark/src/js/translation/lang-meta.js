/**
 * Translation language metadata & configuration.
 * Pure data — no DOM, no state, no side-effects.
 */
export const TranslationLangMeta = (() => {

  const CONTEXT_LABEL_EN = '\uD83E\uDD88 Context from RecapShark.com';
  const CONTEXT_LABELS = {
    fa: '\uD83E\uDD88 زمینه از RecapShark.com',
    ar: '\uD83E\uDD88 سياق من RecapShark.com',
    he: '\uD83E\uDD88 הקשר מ-RecapShark.com',
    ur: '\uD83E\uDD88 سیاق از RecapShark.com',
    es: '\uD83E\uDD88 Contexto de RecapShark.com',
    pt: '\uD83E\uDD88 Contexto do RecapShark.com',
    fr: '\uD83E\uDD88 Contexte de RecapShark.com',
    de: '\uD83E\uDD88 Kontext von RecapShark.com',
    it: '\uD83E\uDD88 Contesto da RecapShark.com',
    ja: '\uD83E\uDD88 RecapShark.com からのコンテキスト',
    ko: '\uD83E\uDD88 RecapShark.com 맥락',
    zh: '\uD83E\uDD88 来自 RecapShark.com 的背景',
    ru: '\uD83E\uDD88 Контекст от RecapShark.com',
    hi: '\uD83E\uDD88 RecapShark.com से संदर्भ',
  };

  const SECTIONS = {
    summary:    { contentId: 'summaryDisplayHost',   parentId: 'summaryPanel' },
    chapters:   { contentId: 'topicsList',          parentId: null },
    transcript: { contentId: 'fullTranscriptPanel', parentId: null },
  };

  // Order grouped by language family for a natural enterprise-style scan:
  //   English first → European Romance (es, fr, pt, fa, it) → Germanic
  //   (de) → Slavic (ru) → CJK (zh, ja, ko) → South Asian (hi) →
  //   Middle Eastern / RTL (ku, ar).
  // Persian trails the European Romance group (after pt, before it).
  // Kurdish is kept in the popular list for personal relevance even
  // though its global speaker count is below the usual "popular"
  // threshold; sits just above Arabic in the Middle Eastern cluster.
  const POPULAR_LANGS = ['en','es','fr','pt','fa','it','de','ru','zh','ja','ko','hi','ku','ar'];

  const ADVANCED_MODEL_LANGS = new Set([
    'si','my','km','gu','yo','ig','zu','xh','mi','sm','haw','lo','am'
  ]);

  // Map language code → flagcdn.com country code (only where they differ from the emoji's country).
  // Without an entry here _flagImg() falls back to using the lang code as the cc, which
  // either produces a WRONG flag (e.g. sv → SV = El Salvador instead of Sweden, tg → TG = Togo
  // instead of Tajikistan, ne → NE = Niger instead of Nepal, ms → MS = Montserrat instead of
  // Malaysia, be → BE = Belgium instead of Belarus, sr → SR = Suriname instead of Serbia,
  // ky → KY = Cayman Islands instead of Kyrgyzstan, bs → BS = Bahamas instead of Bosnia) or
  // an INVALID emoji that iOS renders as a letter-pair fallback (ur, kk, sq, et) — both
  // visible bugs in the language picker.
  const _LANG_TO_COUNTRY = {
    en:'us', zh:'cn', ja:'jp', ko:'kr', hi:'in', ar:'sa', el:'gr', he:'il', vi:'vn', uk:'ua', cs:'cz', bn:'bd',
    ta:'in', te:'in', mr:'in', gu:'in', kn:'in', ml:'in', pa:'in', si:'lk', my:'mm', km:'kh', lo:'la',
    'zh-TW':'tw', ku:'iq', ka:'ge', hy:'am', ps:'af', am:'et', ha:'ng', yo:'ng', ig:'ng', zu:'za', xh:'za',
    sw:'ke', ca:'es', af:'za', sl:'si', mi:'nz', sm:'ws', haw:'us', fil:'ph', eu:'es', gl:'es', cy:'gb', ga:'ie',
    // Mismatches between ISO 639 lang code and ISO 3166 country code (added 2026-04-29):
    da:'dk', sv:'se', et:'ee', ne:'np',
    sq:'al', sr:'rs', ms:'my', be:'by', bs:'ba',
    kk:'kz', ky:'kg', tg:'tj', ur:'pk',
  };
  // Country code (ISO 3166-1 alpha-2) → regional-indicator flag emoji.
  // Returns '' for non-2-char codes (callers fall back to PNG-only).
  function _ccToEmoji(cc) {
    if (!cc || cc.length !== 2) return '';
    const upper = cc.toUpperCase();
    return String.fromCodePoint(
      0x1F1E6 + upper.charCodeAt(0) - 65,
      0x1F1E6 + upper.charCodeAt(1) - 65
    );
  }
  /**
   * Wavy-flag <img> for the mobile dual-mode pins layout.
   *
   * Why a separate path from _flagImg: in dual mode both flags need to
   * occupy the EXACT same fixed bounding box so the bilingual ↔
   * bilingual-swapped switch is a true mirror. The default rendering
   * mixes a native emoji glyph (US, sized via font-size, glyph extends
   * past the em-box on iOS due to the wavy curves) with our hand-drawn
   * wavy PNG (Iran, sized via explicit em width/height) — visibly
   * asymmetric, the user notices on swap. Forcing both flags through
   * <img> elements with the same .dual-flag width/height dissolves the
   * asymmetry.
   *
   * Persian → our local hand-drawn wavy PNG (no Pahlavi Lion-and-Sun in Unicode).
   * Everything else → Twemoji v13.1.1 wavy SVG (v14+ flattened the design).
   */
  function _wavyFlagImg(langCode) {
    if (langCode === 'fa') {
      const src = (typeof window !== 'undefined' && window.RS_ASSETS && window.RS_ASSETS.iranFlag)
        || 'img/iran-flag-wavy.png';
      return '<img src="' + src + '" class="dual-flag" alt="Iran">';
    }
    const cc = _LANG_TO_COUNTRY[langCode] || langCode;
    if (cc && cc.length === 2) {
      const upper = cc.toUpperCase();
      const cp1 = (0x1F1E6 + upper.charCodeAt(0) - 65).toString(16);
      const cp2 = (0x1F1E6 + upper.charCodeAt(1) - 65).toString(16);
      return '<img src="https://cdn.jsdelivr.net/gh/twitter/twemoji@13.1.1/assets/svg/'
        + cp1 + '-' + cp2 + '.svg" class="dual-flag" alt="' + cc.toUpperCase() + '">';
    }
    return '';
  }
  function _flagImg(langCode) {
    const cc = _LANG_TO_COUNTRY[langCode] || langCode;
    const emoji = _ccToEmoji(cc);
    // Emit BOTH the wavy emoji (mobile) and the flat flagcdn PNG (desktop).
    // CSS in dashboard.css (.lang-flag-emoji / .lang-flag-img + @media
    // max-width:900px) toggles visibility — emoji on mobile (iOS/Android/Mac
    // render as wavy Apple/Noto/Twemoji glyphs), PNG on desktop (Windows
    // falls back to letter pairs for emoji flags, which would look terrible).
    return '<span class="lang-flag-emoji">' + emoji + '</span>' +
           '<img src="https://flagcdn.com/w40/' + cc + '.png" class="lang-flag-img" alt="' + cc.toUpperCase() + '">';
  }

  const LANG_META = {
    en: { name: 'English',      native: 'English',       flag: _flagImg('en'), code: 'EN' },
    fa: { name: 'Persian',      native: '\u0641\u0627\u0631\u0633\u06CC',  flag: '<span class="lang-flag-emoji"><img src="' + (window.RS_ASSETS && window.RS_ASSETS.iranFlag || 'img/iran-flag.png') + '" class="lang-flag-iran-emoji" alt="Iran"></span><img src="' + (window.RS_ASSETS && window.RS_ASSETS.iranFlag || 'img/iran-flag.png') + '" class="lang-flag-img" alt="Iran">', code: 'FA' },
    es: { name: 'Spanish',      native: 'Espa\u00f1ol',  flag: _flagImg('es'), code: 'ES' },
    pt: { name: 'Portuguese',   native: 'Portugu\u00eas', flag: _flagImg('pt'), code: 'PT' },
    fr: { name: 'French',       native: 'Fran\u00e7ais', flag: _flagImg('fr'), code: 'FR' },
    zh: { name: 'Chinese',      native: '\u4E2D\u6587',  flag: _flagImg('zh'), code: 'ZH' },
    de: { name: 'German',       native: 'Deutsch',       flag: _flagImg('de'), code: 'DE' },
    ja: { name: 'Japanese',     native: '\u65E5\u672C\u8A9E', flag: _flagImg('ja'), code: 'JA' },
    ko: { name: 'Korean',       native: '\uD55C\uAD6D\uC5B4', flag: _flagImg('ko'), code: 'KO' },
    hi: { name: 'Hindi',        native: '\u0939\u093F\u0928\u094D\u0926\u0940', flag: _flagImg('hi'), code: 'HI' },
    ar: { name: 'Arabic',       native: '\u0627\u0644\u0639\u0631\u0628\u064A\u0629', flag: _flagImg('ar'), code: 'AR' },
    ru: { name: 'Russian',      native: '\u0420\u0443\u0441\u0441\u043A\u0438\u0439', flag: _flagImg('ru'), code: 'RU' },
    it: { name: 'Italian',      native: 'Italiano',      flag: _flagImg('it'), code: 'IT' },
    tr: { name: 'Turkish',      native: 'T\u00fcrk\u00e7e', flag: _flagImg('tr'), code: 'TR' },
    nl: { name: 'Dutch',        native: 'Nederlands',    flag: _flagImg('nl'), code: 'NL' },
    pl: { name: 'Polish',       native: 'Polski',        flag: _flagImg('pl'), code: 'PL' },
    sv: { name: 'Swedish',      native: 'Svenska',       flag: _flagImg('sv'), code: 'SV' },
    da: { name: 'Danish',       native: 'Dansk',         flag: _flagImg('da'), code: 'DA' },
    fi: { name: 'Finnish',      native: 'Suomi',         flag: _flagImg('fi'), code: 'FI' },
    no: { name: 'Norwegian',    native: 'Norsk',         flag: _flagImg('no'), code: 'NO' },
    el: { name: 'Greek',        native: '\u0395\u03BB\u03BB\u03B7\u03BD\u03B9\u03BA\u03AC', flag: _flagImg('el'), code: 'EL' },
    he: { name: 'Hebrew',       native: '\u05E2\u05D1\u05E8\u05D9\u05EA', flag: _flagImg('he'), code: 'HE' },
    th: { name: 'Thai',         native: '\u0E44\u0E17\u0E22', flag: _flagImg('th'), code: 'TH' },
    vi: { name: 'Vietnamese',   native: 'Ti\u1EBFng Vi\u1EC7t', flag: _flagImg('vi'), code: 'VI' },
    id: { name: 'Indonesian',   native: 'Bahasa Indonesia', flag: _flagImg('id'), code: 'ID' },
    ms: { name: 'Malay',        native: 'Bahasa Melayu', flag: _flagImg('ms'), code: 'MS' },
    uk: { name: 'Ukrainian',    native: '\u0423\u043A\u0440\u0430\u0457\u043D\u0441\u044C\u043A\u0430', flag: _flagImg('uk'), code: 'UK' },
    cs: { name: 'Czech',        native: '\u010Ce\u0161tina', flag: _flagImg('cs'), code: 'CS' },
    ro: { name: 'Romanian',     native: 'Rom\u00e2n\u0103', flag: _flagImg('ro'), code: 'RO' },
    hu: { name: 'Hungarian',    native: 'Magyar',        flag: _flagImg('hu'), code: 'HU' },
    bg: { name: 'Bulgarian',    native: '\u0411\u044A\u043B\u0433\u0430\u0440\u0441\u043A\u0438', flag: _flagImg('bg'), code: 'BG' },
    hr: { name: 'Croatian',     native: 'Hrvatski',      flag: _flagImg('hr'), code: 'HR' },
    sk: { name: 'Slovak',       native: 'Sloven\u010Dina', flag: _flagImg('sk'), code: 'SK' },
    sr: { name: 'Serbian',      native: '\u0421\u0440\u043F\u0441\u043A\u0438', flag: _flagImg('sr'), code: 'SR' },
    bn: { name: 'Bengali',      native: '\u09AC\u09BE\u0982\u09B2\u09BE', flag: _flagImg('bn'), code: 'BN' },
    ta: { name: 'Tamil',        native: '\u0BA4\u0BAE\u0BBF\u0BB4\u0BCD', flag: _flagImg('ta'), code: 'TA' },
    ur: { name: 'Urdu',         native: '\u0627\u0631\u062F\u0648', flag: _flagImg('ur'), code: 'UR' },
    fil: { name: 'Filipino',    native: 'Filipino',      flag: _flagImg('fil'), code: 'FIL' },
    sw: { name: 'Swahili',      native: 'Kiswahili',     flag: _flagImg('sw'), code: 'SW' },
    ca: { name: 'Catalan',      native: 'Catal\u00e0',   flag: _flagImg('ca'), code: 'CA' },
    af: { name: 'Afrikaans',    native: 'Afrikaans',     flag: _flagImg('af'), code: 'AF' },
    et: { name: 'Estonian',     native: 'Eesti',         flag: _flagImg('et'), code: 'ET' },
    lv: { name: 'Latvian',      native: 'Latvie\u0161u', flag: _flagImg('lv'), code: 'LV' },
    lt: { name: 'Lithuanian',   native: 'Lietuvi\u0173', flag: _flagImg('lt'), code: 'LT' },
    sl: { name: 'Slovenian',    native: 'Sloven\u0161\u010Dina', flag: _flagImg('sl'), code: 'SL' },
    // South & Southeast Asian
    te: { name: 'Telugu',       native: '\u0C24\u0C46\u0C32\u0C41\u0C17\u0C41', flag: _flagImg('te'), code: 'TE' },
    mr: { name: 'Marathi',      native: '\u092E\u0930\u093E\u0920\u0940', flag: _flagImg('mr'), code: 'MR' },
    gu: { name: 'Gujarati',     native: '\u0A97\u0AC1\u0A9C\u0AB0\u0ABE\u0AA4\u0AC0', flag: _flagImg('gu'), code: 'GU' },
    kn: { name: 'Kannada',      native: '\u0C95\u0CA8\u0CCD\u0CA8\u0CA1', flag: _flagImg('kn'), code: 'KN' },
    ml: { name: 'Malayalam',    native: '\u0D2E\u0D32\u0D2F\u0D3E\u0D33\u0D02', flag: _flagImg('ml'), code: 'ML' },
    pa: { name: 'Punjabi',      native: '\u0A2A\u0A70\u0A1C\u0A3E\u0A2C\u0A40', flag: _flagImg('pa'), code: 'PA' },
    si: { name: 'Sinhala',      native: '\u0DC3\u0DD2\u0D82\u0DC4\u0DBD', flag: _flagImg('si'), code: 'SI' },
    ne: { name: 'Nepali',       native: '\u0928\u0947\u092A\u093E\u0932\u0940', flag: _flagImg('ne'), code: 'NE' },
    my: { name: 'Burmese',      native: '\u1019\u103C\u1014\u103A\u1019\u102C', flag: _flagImg('my'), code: 'MY' },
    km: { name: 'Khmer',        native: '\u1781\u17D2\u1798\u17C2\u179A', flag: _flagImg('km'), code: 'KM' },
    lo: { name: 'Lao',          native: '\u0EA5\u0EB2\u0EA7', flag: _flagImg('lo'), code: 'LO' },
    // East Asian
    'zh-TW': { name: 'Chinese (Traditional)', native: '\u7E41\u9AD4\u4E2D\u6587', flag: _flagImg('zh-TW'), code: 'ZH-TW' },
    mn: { name: 'Mongolian',    native: '\u041C\u043E\u043D\u0433\u043E\u043B', flag: _flagImg('mn'), code: 'MN' },
    // Middle Eastern & Central Asian
    ku: { name: 'Kurdish',      native: 'Kurd\u00ee',    flag: _flagImg('ku'), code: 'KU' },
    az: { name: 'Azerbaijani',  native: 'Az\u0259rbaycan', flag: _flagImg('az'), code: 'AZ' },
    uz: { name: 'Uzbek',        native: 'O\u02BBzbek',   flag: _flagImg('uz'), code: 'UZ' },
    kk: { name: 'Kazakh',       native: '\u049A\u0430\u0437\u0430\u049B', flag: _flagImg('kk'), code: 'KK' },
    ky: { name: 'Kyrgyz',       native: '\u041A\u044B\u0440\u0433\u044B\u0437\u0447\u0430', flag: _flagImg('ky'), code: 'KY' },
    tg: { name: 'Tajik',        native: '\u0422\u043E\u04B7\u0438\u043A\u04E3', flag: _flagImg('tg'), code: 'TG' },
    ka: { name: 'Georgian',     native: '\u10E5\u10D0\u10E0\u10D7\u10E3\u10DA\u10D8', flag: _flagImg('ka'), code: 'KA' },
    hy: { name: 'Armenian',     native: '\u0540\u0561\u0575\u0565\u0580\u0565\u0576', flag: _flagImg('hy'), code: 'HY' },
    ps: { name: 'Pashto',       native: '\u067E\u069A\u062A\u0648', flag: _flagImg('ps'), code: 'PS' },
    // African
    am: { name: 'Amharic',      native: '\u12A0\u121B\u122D\u129B', flag: _flagImg('am'), code: 'AM' },
    ha: { name: 'Hausa',        native: 'Hausa',         flag: _flagImg('ha'), code: 'HA' },
    yo: { name: 'Yoruba',       native: 'Yor\u00f9b\u00e1', flag: _flagImg('yo'), code: 'YO' },
    ig: { name: 'Igbo',         native: 'Igbo',          flag: _flagImg('ig'), code: 'IG' },
    zu: { name: 'Zulu',         native: 'isiZulu',       flag: _flagImg('zu'), code: 'ZU' },
    xh: { name: 'Xhosa',       native: 'isiXhosa',      flag: _flagImg('xh'), code: 'XH' },
    so: { name: 'Somali',       native: 'Soomaali',      flag: _flagImg('so'), code: 'SO' },
    rw: { name: 'Kinyarwanda',  native: 'Ikinyarwanda',  flag: _flagImg('rw'), code: 'RW' },
    mg: { name: 'Malagasy',     native: 'Malagasy',      flag: _flagImg('mg'), code: 'MG' },
    // European (additional)
    sq: { name: 'Albanian',     native: 'Shqip',         flag: _flagImg('sq'), code: 'SQ' },
    mk: { name: 'Macedonian',   native: '\u041C\u0430\u043A\u0435\u0434\u043E\u043D\u0441\u043A\u0438', flag: _flagImg('mk'), code: 'MK' },
    bs: { name: 'Bosnian',      native: 'Bosanski',      flag: _flagImg('bs'), code: 'BS' },
    is: { name: 'Icelandic',    native: '\u00CDslenska',  flag: _flagImg('is'), code: 'IS' },
    mt: { name: 'Maltese',      native: 'Malti',         flag: _flagImg('mt'), code: 'MT' },
    ga: { name: 'Irish',        native: 'Gaeilge',       flag: _flagImg('ga'), code: 'GA' },
    cy: { name: 'Welsh',        native: 'Cymraeg',       flag: _flagImg('cy'), code: 'CY' },
    gl: { name: 'Galician',     native: 'Galego',        flag: _flagImg('gl'), code: 'GL' },
    eu: { name: 'Basque',       native: 'Euskara',       flag: _flagImg('eu'), code: 'EU' },
    be: { name: 'Belarusian',   native: '\u0411\u0435\u043B\u0430\u0440\u0443\u0441\u043A\u0430\u044F', flag: _flagImg('be'), code: 'BE' },
    // Latin American
    ht: { name: 'Haitian Creole', native: 'Krey\u00f2l',  flag: _flagImg('ht'), code: 'HT' },
    // Pacific
    mi: { name: 'Maori',        native: 'Te Reo M\u0101ori', flag: _flagImg('mi'), code: 'MI' },
    sm: { name: 'Samoan',       native: 'Gagana Samoa',  flag: _flagImg('sm'), code: 'SM' },
    haw: { name: 'Hawaiian',    native: '\u02BB\u014Clelo Hawai\u02BBi', flag: _flagImg('haw'), code: 'HAW' },
  };

  return {
    CONTEXT_LABEL_EN,
    CONTEXT_LABELS,
    SECTIONS,
    POPULAR_LANGS,
    ADVANCED_MODEL_LANGS,
    LANG_META,
    wavyFlagImg: _wavyFlagImg,
  };

})();
