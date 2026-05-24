LANG_NAMES = {
    "en": "English", "fa": "Persian", "es": "Spanish", "pt": "Portuguese",
    "fr": "French", "zh": "Chinese", "zh-TW": "Traditional Chinese",
    "de": "German", "ja": "Japanese", "ko": "Korean", "hi": "Hindi",
    "ar": "Arabic", "ru": "Russian", "it": "Italian", "tr": "Turkish",
    "nl": "Dutch", "pl": "Polish", "sv": "Swedish", "da": "Danish",
    "fi": "Finnish", "no": "Norwegian", "el": "Greek", "he": "Hebrew",
    "th": "Thai", "vi": "Vietnamese", "id": "Indonesian", "ms": "Malay",
    "uk": "Ukrainian", "cs": "Czech", "ro": "Romanian", "hu": "Hungarian",
    "bg": "Bulgarian", "hr": "Croatian", "sk": "Slovak", "sr": "Serbian",
    "bn": "Bengali", "ta": "Tamil", "ur": "Urdu", "fil": "Filipino",
    "sw": "Swahili", "ca": "Catalan", "af": "Afrikaans", "et": "Estonian",
    "lv": "Latvian", "lt": "Lithuanian", "sl": "Slovenian",
    "te": "Telugu", "mr": "Marathi", "gu": "Gujarati", "kn": "Kannada",
    "ml": "Malayalam", "pa": "Punjabi", "si": "Sinhala", "ne": "Nepali",
    "my": "Burmese", "km": "Khmer", "lo": "Lao", "mn": "Mongolian",
    "ku": "Kurdish", "az": "Azerbaijani", "uz": "Uzbek", "kk": "Kazakh",
    "ky": "Kyrgyz", "tg": "Tajik", "ka": "Georgian", "hy": "Armenian",
    "ps": "Pashto", "am": "Amharic", "ha": "Hausa", "yo": "Yoruba",
    "ig": "Igbo", "zu": "Zulu", "xh": "Xhosa", "so": "Somali",
    "rw": "Kinyarwanda", "mg": "Malagasy", "sq": "Albanian",
    "mk": "Macedonian", "bs": "Bosnian", "is": "Icelandic", "mt": "Maltese",
    "ga": "Irish", "cy": "Welsh", "gl": "Galician", "eu": "Basque",
    "be": "Belarusian", "ht": "Haitian Creole", "mi": "Maori",
    "sm": "Samoan", "haw": "Hawaiian",
    "bo": "Tibetan", "eo": "Esperanto", "lb": "Luxembourgish",
    "co": "Corsican", "su": "Sundanese", "jv": "Javanese",
    "ceb": "Cebuano", "gd": "Scots Gaelic", "tt": "Tatar",
    "tk": "Turkmen", "wo": "Wolof", "ti": "Tigrinya",
    "om": "Oromo", "sd": "Sindhi", "fj": "Fijian", "to": "Tongan",
}


def lang_code_to_name(code: str) -> str:
    return LANG_NAMES.get(code, code)


# 16 languages where gpt-4o-mini reliably degenerates (repetition loops,
# leaked Chinese characters, hallucinated tokens). They route to gpt-4o
# in `translate.py` + `summarize.py`, and are skipped by the Google
# Translate fast path in `google_translate.py` (Google's coverage on these
# is also weakest, so the gpt-4o quality bump is doubly justified).
ADVANCED_MODEL_LANGS = frozenset({
    "si",   # Sinhala
    "my",   # Burmese
    "km",   # Khmer
    "gu",   # Gujarati   — mini leaks Chinese characters
    "yo",   # Yoruba
    "ig",   # Igbo
    "zu",   # Zulu
    "xh",   # Xhosa
    "mi",   # Maori
    "sm",   # Samoan     — mini hallucinates "fa'atekinolosi"
    "haw",  # Hawaiian
    "lo",   # Lao        — mini produces garbled output
    "am",   # Amharic    — mini produces garbled output
    "bo",   # Tibetan    — complex script, mini struggles
    "ti",   # Tigrinya   — Ge'ez script like Amharic
    "wo",   # Wolof      — low-resource, mini hallucinates
})
