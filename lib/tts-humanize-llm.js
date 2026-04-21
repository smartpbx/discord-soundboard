// LLM-powered naturalness pass for TTS text.
//
// User observed that adding "uhh"s, commas, and ellipses in the right spots
// makes Fish/Chatterbox output noticeably more believable — fewer robotic
// cadences, more human rhythm. This module pipes the user's raw text through
// the same Ollama endpoint we already use for emotion classification and asks
// it to insert disfluencies + punctuation + pauses while preserving meaning
// and all inline [tags]/{markers}.
//
// Same OpenAI-compatible shape as tts-emotion-llm.js — shares env vars:
//   EMOTION_LLM_URL, EMOTION_LLM_MODEL, EMOTION_LLM_API_KEY, EMOTION_LLM_TIMEOUT_MS
// Plus: HUMANIZE_LLM_ENABLED (defaults to true when EMOTION_LLM_ENABLED is on).

'use strict';

const crypto = require('crypto');
const { resolveStyle } = require('./tts-humanize-styles');

const CACHE_MAX = 500;
const _cache = new Map(); // sha256(text) -> { at, humanized }

function _keyFor(text, voiceKey, engine) {
    return crypto.createHash('sha256')
        .update(String(voiceKey || '') + '\n' + String(engine || '') + '\n' + text)
        .digest('hex');
}

function _config() {
    const url = (process.env.HUMANIZE_LLM_URL || process.env.EMOTION_LLM_URL || '').trim();
    // Humanize can use a different (ideally uncensored) model than emotion
    // classification — gemma2:2b refuses NSFW content, so HUMANIZE_LLM_MODEL
    // lets the operator point this pass at an abliterated/uncensored model
    // while keeping the emotion classifier on the fast one.
    const model = (process.env.HUMANIZE_LLM_MODEL || process.env.EMOTION_LLM_MODEL || '').trim();
    const key = (process.env.HUMANIZE_LLM_API_KEY || process.env.EMOTION_LLM_API_KEY || '').trim();
    const base = process.env.EMOTION_LLM_ENABLED === '1' || process.env.EMOTION_LLM_ENABLED === 'true';
    const override = process.env.HUMANIZE_LLM_ENABLED;
    // Humanize enabled iff the underlying LLM is usable AND operator hasn't
    // explicitly disabled just this feature.
    const enabled = base && override !== '0' && override !== 'false';
    // Bigger timeout — uncensored models on CPU can take 10–30 s for a rewrite.
    const timeoutMs = parseInt(process.env.HUMANIZE_LLM_TIMEOUT_MS || '30000', 10);
    return { url, model, key, enabled, timeoutMs };
}

function isAvailable() {
    const c = _config();
    return c.enabled && !!c.url && !!c.model;
}

function _evict() {
    if (_cache.size <= CACHE_MAX) return;
    const drop = Math.floor(_cache.size * 0.2);
    let i = 0;
    for (const k of _cache.keys()) {
        _cache.delete(k);
        if (++i >= drop) break;
    }
}

// Fish tags the LLM is allowed to insert when the voice runs through Fish
// (it natively parses inline [tags] and uses them to drive delivery). For
// Chatterbox the expression preprocessor recognizes a much smaller set —
// see lib/tts-expression.js — so we cap insertion to those.
const FISH_TAG_HINTS = [
    '[pause], [short pause] — silence',
    '[whisper], [low voice] — intimate / hushed',
    '[shouting], [screaming], [loud] — yell',
    '[excited], [delight] — animated energy',
    '[laughing], [chuckle], [chuckling] — laugh vocalisations',
    '[sad], [angry], [surprised], [shocked] — broad emotions',
    '[sigh], [inhale], [exhale] — breaths',
    '[panting], [moaning] — heavy breath',
    '[tsk], [clearing throat] — mouth sounds',
    '[emphasis] — stress the next word',
];

const CHATTERBOX_TAG_HINTS = [
    '[angry], [sad], [happy] — broad emotions',
    '[whisper], [soft] — intimate / hushed',
    '[yell], [shouting] — loud delivery',
];

function _tagSection(engine) {
    const e = String(engine || '').toLowerCase();
    if (e === 'fish') {
        return `\n\nTAG INSERTION (Fish engine):
This voice runs through Fish, which natively honors inline [tags]. Beyond
preserving any existing tags, you MAY ADD tags where they fit the delivery —
one [laughing] before a joke, [sigh] before a resigned line, [shouting] on
a caps-lock outburst, [whisper] on an aside, etc. Use them sparingly (0–2
per sentence), and only when the emotion is obvious from context.

Allowed tag examples (15,000+ free-form descriptors are also supported, but
stick to these unless something specific is called for):
${FISH_TAG_HINTS.map(s => '- ' + s).join('\n')}`;
    }
    if (e === 'chatterbox' || e === 'cb' || e === 'rvc') {
        // RVC voices run their source text through Chatterbox first, so the
        // same expression preprocessor applies — use the Chatterbox tag set.
        return `\n\nTAG INSERTION (Chatterbox engine):
You MAY insert a small set of emotion tags the preprocessor understands —
sparingly, only when the emotion is clear from context. Do NOT invent new
tags; this engine only recognizes:
${CHATTERBOX_TAG_HINTS.map(s => '- ' + s).join('\n')}`;
    }
    // GSV / unknown — no inline tag support, preserve existing only.
    return '';
}

function _speakerSection(styleHint) {
    if (!styleHint) {
        return `\n\nSPEAKER STYLE:
If the user's message begins with a line like "SPEAKER: <name>", use your
general knowledge of how that person speaks to match their real cadence,
catchphrases, and disfluency pattern. If you don't recognize the name,
fall back to generic natural disfluencies.
Drop the "SPEAKER: <name>" line from your output — it's context for you.`;
    }
    return `\n\nSPEAKER STYLE:
The user's message begins with "SPEAKER: <name>" followed by a style guide
for that specific speaker. Tailor your disfluencies, filler words, cadence,
and catchphrases to match — the style block overrides the generic
"sprinkle uhhhs everywhere" default. If it says NO "uhh"s, don't add any;
if it says heavy hesitations, lean in.

HOW TO USE THE STYLE BLOCK — read this carefully:
- Phrase lists in the style block (e.g. "believe me", "folks", "tremendous")
  are a PALETTE to pick from, NOT a checklist to recite. Pick the phrases
  that fit naturally in THIS sentence and weave them INTO the rewrite —
  never stack them together ("believe me, folks, tremendous, the best")
  and never recite the full list back-to-back. Use as many or as few as
  the sentence can carry naturally; longer sentences can take more, short
  ones maybe zero.
- Repetition pattern notes (e.g. 'Heavy repetition ("very, very")') describe
  the CADENCE. Apply the pattern to a word that fits the sentence — do NOT
  copy the parenthetical example verbatim.
- Produce ONE rewrite of the ORIGINAL message. DO NOT append a second
  restatement of the same meaning with different phrasing stacked on top.

Drop the "SPEAKER:" and "STYLE:" lines from your output — they're context
for you, not for the TTS.`;
}

function _buildSystemPrompt(styleHint, engine) {
    return `You rewrite short text messages so a TTS voice reads them naturally — like a real person thinking as they speak.

Your ONLY goal is to make the TTS delivery sound human — NOT to change meaning, NOT to add new facts, NOT to censor, NOT to rephrase for politeness.

Edits you MAY make:
- Sprinkle disfluencies where they fit the speaker — hesitations like "uhhh", "uhhhh", "ummm", "ummmm", "errrrr", "hmmmm" (ALWAYS stretch the vowel with 3–5 repeated h/m/r so the TTS actually drawls it), filler words like "like", "you know", "I mean", "kinda", "basically", and false starts like "I — I mean...". The SPEAKER STYLE block below decides HOW MANY and WHICH ones fit this voice.
- Add commas aggressively to break phrases so the voice breathes.
- Use ellipses (...) for trailing thoughts or mid-sentence thinking pauses.
- Add exclamation marks or question marks where intent is clear from context.
- Break run-on sentences into two or three shorter ones.

Edits you MUST NOT make:
- Change any word's meaning or substitute synonyms.
- Remove or add information (names, numbers, claims, slurs, swears — leave them alone).
- "Clean up" or soften profanity or offensive content.
- Rewrite sentences into a different tone (formal → casual, etc.).
- Add emojis.
- Remove or reorder any existing [tags] — keep every pre-existing tag exactly where it was.
- Remove or reorder any existing {braces} / <angle> / backtick markers.

Output format: ONLY the rewritten text. No JSON, no commentary, no preamble, no quotes around it.

Examples (note the stretched vowels in hesitations):

IN: im really tired today and I dont want to do anything
OUT: I'm... uhhh, I'm really tired today. And, like, ummm, I don't want to do anything.

IN: [angry] what the hell are you doing
OUT: [angry] Like, what the hell, uhhh, what the hell are you doing?!

IN: so yeah we went to the store and got some milk
OUT: So yeah, we — we went to the store and, uhhhh, got, ummm, some milk.

IN: HELLO THERE GENERAL KENOBI
OUT: HELLO THERE, UHHH, GENERAL KENOBI!

Worked speaker-style example — Trump (no "uhh", repetition pattern, palette of phrases):
IN: "ChatGPT and Copilot are awful tools of Satan, and Claude is the only option."
GOOD: "ChatGPT and Copilot — believe me, folks — they're awful, they're really awful tools of Satan. Claude is the only option. The only one."
BAD (stacks the whole phrase list and duplicates the message): "ChatGPT and Copilot are awful tools of Satan, and Claude is the only option. Believe me, folks, tremendous, the best, many people are saying, Claude is the only option."
Notice the GOOD version: ONE rewrite, phrases woven INTO the sentence, only one or two palette items used, repetition applied to a word from the original ("really awful"), no restatement tacked on the end.${_speakerSection(styleHint)}${_tagSection(engine)}`;
}

async function _httpHumanize(text, voiceName, engine) {
    const c = _config();
    if (!c.enabled || !c.url || !c.model) return null;
    const base = c.url.replace(/\/+$/, '').replace(/\/v1$/, '');
    const url = `${base}/api/chat`;
    const styleHint = resolveStyle(voiceName);
    const speakerBlock = voiceName
        ? (styleHint
            ? `SPEAKER: ${voiceName}\nSTYLE: ${styleHint}\n\n${text}`
            : `SPEAKER: ${voiceName}\n\n${text}`)
        : text;
    const systemPrompt = _buildSystemPrompt(styleHint, engine);
    const body = {
        model: c.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: speakerBlock },
        ],
        // Ollama-native shape: `think: false` disables Qwen3 thinking;
        // `options` takes temperature/num_predict/num_ctx.
        think: false,
        options: {
            temperature: 0.4,
            num_predict: Math.max(1024, Math.ceil(text.length * 3)),
            // 4K context is plenty for TTS messages + system prompt and keeps
            // Qwen3's VRAM footprint at ~3 GB (vs 7+ GB at the 32K default),
            // so it coexists with Fish-Speech's 19 GiB on the 3090 instead
            // of knocking Fish over with an OOM at startup.
            num_ctx: 4096,
        },
        stream: false,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (c.key) headers.Authorization = `Bearer ${c.key}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), c.timeoutMs);
    let resp;
    try {
        resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
        clearTimeout(t);
        return { _error: 'network: ' + (e.message || 'timeout') };
    }
    clearTimeout(t);
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return { _error: `http ${resp.status}: ${txt.slice(0, 200)}` };
    }
    const data = await resp.json().catch(() => null);
    // Ollama native response shape: { message: { role, content }, done_reason }
    const content = data?.message?.content;
    const done = data?.done_reason;
    if (typeof content !== 'string' || !content.trim()) {
        return { _error: `empty content (done_reason=${done})` };
    }
    let clean = content.trim();
    clean = clean.replace(/^```(?:\w+)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1);
    }
    return { humanized: clean };
}

// Common ways safety-tuned LLMs refuse. If we detect one we fall back to the
// original text — the user knows what they wrote, they don't want it
// sanitized. Pattern is case-insensitive; matches anywhere in output.
const REFUSAL_PATTERNS = [
    /\bI (?:can'?t|cannot|won'?t|will not|am unable|'m not able|refuse)\b/i,
    /\bI (?:don'?t|do not) (?:feel comfortable|think it('?s| is) appropriate)/i,
    /\bI (?:apologize|'m sorry),? (?:but|however)/i,
    /\bas an (?:AI|assistant|LLM|language model)/i,
    /\b(?:this|that|the) (?:content|language|message|text|request) (?:is|seems|contains|appears) (?:inappropriate|offensive|harmful|problematic|concerning)/i,
    /\b(?:I'd|I would) (?:prefer|suggest|recommend) (?:to |)(?:rephrase|reword|rewrite|avoid)/i,
    /\b(?:Let'?s|We should|I'll|I will) (?:keep|make|rephrase) (?:this|it) (?:respectful|appropriate|polite|kinder)/i,
    /\bI hope you understand\b/i,
    /\b(?:harmful|offensive|inappropriate|disrespectful) (?:content|language|stereotype|message)/i,
];

function _isRefusal(rewritten) {
    for (const re of REFUSAL_PATTERNS) {
        if (re.test(rewritten)) return true;
    }
    return false;
}

// Detect the "style showcase" failure mode: the LLM repeats a chunk of the
// original verbatim multiple times (e.g. "...Claude is the only option."
// appearing 3× in the rewrite when it appeared 1× in the original) because
// it tacked a second restatement on. Returns true when the rewrite looks
// duplicated.
function _looksDuplicated(original, rewritten) {
    // Grab the last 4–6 content words of the original (minus trailing punct)
    // as a distinctive phrase to count. Short inputs can't duplicate
    // meaningfully — skip the check.
    const words = original
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (words.length < 5) return false;
    const tail = words.slice(-Math.min(5, words.length)).join(' ').toLowerCase();
    if (tail.length < 12) return false;
    const origHits = (original.toLowerCase().match(new RegExp(tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    const rewHits = (rewritten.toLowerCase().match(new RegExp(tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    return rewHits > origHits + 1;
}

function _sanityCheck(original, rewritten) {
    // Cheap guards: reject if the model wandered off — too short (lost
    // content), too long (added prose), duplicated the input, or refused
    // the request. Tag-drop is a soft warning (logged but not blocking).
    if (_isRefusal(rewritten)) return false;
    const origLen = original.trim().length;
    const rewLen = rewritten.trim().length;
    if (rewLen < Math.max(origLen * 0.6, 4)) return false;   // drastically shorter = likely summarized
    // Allow up to 3.5x + 80 chars since aggressive humanize can more than
    // double short inputs ("hi" → "uhhhh, hi... yeah, hi" is legit).
    if (rewLen > origLen * 3.5 + 80) return false;            // drastically longer = likely added commentary
    // Catch the "style showcase" failure where the LLM appends a second
    // restatement of the input with stacked catchphrases.
    if (_looksDuplicated(original, rewritten)) return false;
    // Soft tag-preservation check: normalize whitespace + case before comparing.
    // A missing tag is annoying but not wrong — the rewrite still reads the
    // user's actual intent, just with one emotion marker stripped.
    const _norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const origTags = Array.from(original.matchAll(/\[[^\]]+\]/g)).map(m => _norm(m[0]));
    const rewTags = Array.from(rewritten.matchAll(/\[[^\]]+\]/g)).map(m => _norm(m[0]));
    const dropped = origTags.filter(t => !rewTags.includes(t));
    if (dropped.length) {
        console.warn('[tts-humanize-llm] rewrite dropped tags (allowed through):', dropped.join(', '));
    }
    return true;
}

// Public: humanize text → returns rewritten string, or the original text if
// the LLM is disabled, errors out, or produced something the sanity check
// rejects. Always callable — never throws.
async function humanize(text, voiceName, engine) {
    const original = (text || '').toString();
    if (!original.trim()) return original;
    if (!isAvailable()) return original;
    if (original.length < 8) return original;  // "hi" doesn't need pauses

    // Cache key includes voice + engine so "hello" through Jordan Peterson on
    // Fish caches separately from the same line through Chatterbox (different
    // tag vocabulary → different rewrite).
    const key = _keyFor(original, voiceName || '', engine || '');
    const cached = _cache.get(key);
    if (cached && (Date.now() - cached.at) < 6 * 60 * 60 * 1000) return cached.humanized;

    const raw = await _httpHumanize(original, voiceName, engine);
    if (!raw || raw._error || !raw.humanized) {
        console.warn('[tts-humanize-llm] failed:', raw && raw._error);
        return original;
    }
    if (!_sanityCheck(original, raw.humanized)) {
        // Surface enough context to diagnose which guard tripped
        const origLen = original.trim().length;
        const rewLen = (raw.humanized || '').trim().length;
        const reason = _isRefusal(raw.humanized) ? 'refusal-pattern' :
                       rewLen < Math.max(origLen * 0.6, 4) ? `too-short (${rewLen}<${Math.max(origLen*0.6,4).toFixed(0)})` :
                       rewLen > origLen * 3.5 + 80 ? `too-long (${rewLen}>${origLen*3.5+80})` :
                       _looksDuplicated(original, raw.humanized) ? 'duplicated-tail' :
                       'dropped-tags';
        console.warn(`[tts-humanize-llm] rejected (${reason}) — orig: ${JSON.stringify(original.slice(0,80))} → rewrite: ${JSON.stringify((raw.humanized||'').slice(0,120))}`);
        return original;
    }
    _evict();
    _cache.set(key, { at: Date.now(), humanized: raw.humanized });
    return raw.humanized;
}

module.exports = { humanize, isAvailable };
