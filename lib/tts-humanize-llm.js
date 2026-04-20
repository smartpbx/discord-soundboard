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

const CACHE_MAX = 500;
const _cache = new Map(); // sha256(text) -> { at, humanized }

function _keyFor(text, voiceKey) {
    return crypto.createHash('sha256').update(String(voiceKey || '') + '\n' + text).digest('hex');
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

const SYSTEM_PROMPT = `You rewrite short text messages so a TTS voice reads them naturally — like a real person thinking as they speak.

Your ONLY goal is to make the TTS delivery sound human — NOT to change meaning, NOT to add new facts, NOT to censor, NOT to rephrase for politeness.

Edits you MAY make:
- Sprinkle disfluencies liberally throughout — aim for ONE every 5–8 words, plus at most clause breaks. This is the main thing that makes it sound real. Options:
  * Hesitations: "uhhh", "uhhhh", "ummm", "ummmm", "errrrr", "hmmmm" — ALWAYS stretch the vowel with 3–5 repeated h/m/r so the TTS actually drawls it instead of clipping "uh" in a tenth of a second.
  * Filler words: "like", "you know", "I mean", "kinda", "sorta", "basically", "so yeah".
  * False starts: "I — I mean...", "we — we went...".
- Add commas aggressively to break phrases so the voice breathes. It's fine to over-comma, it reads more natural.
- Use ellipses (...) for trailing thoughts, hesitation, or mid-sentence thinking pauses.
- Add exclamation marks or question marks where intent is clear from context.
- Break run-on sentences into two or three shorter ones.

Edits you MUST NOT make:
- Change any word's meaning or substitute synonyms.
- Remove or add information (names, numbers, claims, slurs, swears — leave them alone).
- "Clean up" or soften profanity or offensive content.
- Rewrite sentences into a different tone (formal → casual, etc.).
- Add emojis.
- Remove or reorder any existing [tags] like [shouting], [whisper], [laughing], [angry] — keep them exactly where they were.
- Remove or reorder any existing {braces} / <angle> / backtick markers.

Output format: ONLY the rewritten text. No JSON, no commentary, no preamble, no quotes around it.

Examples (note the multiple h's/m's in hesitations and the frequency):

IN: im really tired today and I dont want to do anything
OUT: I'm... uhhh, I'm really tired today. And, like, ummm, I don't want to do anything.

IN: [angry] what the hell are you doing
OUT: [angry] Like, what the hell, uhhh, what the hell are you doing?!

IN: so yeah we went to the store and got some milk
OUT: So yeah, we — we went to the store and, uhhhh, got, ummm, some milk.

IN: HELLO THERE GENERAL KENOBI
OUT: HELLO THERE, UHHH, GENERAL KENOBI!

IN: I was thinking we should go to the party
OUT: I was, ummmm, kinda thinking... you know, we should, uhhhh, we should go to the party.

SPEAKER-SPECIFIC STYLE:
If the user's message begins with a line like "SPEAKER: <name>", tailor your
disfluencies, filler phrases, cadence, and catchphrases to that person's real
known speech pattern. Keep the meaning and structure of the core message —
you're just choosing WHICH fillers fit their voice, not rewriting content.
- Jordan Peterson: "well", slow methodical "...", "precisely", no "like" or "you know" — he's formal/lecturer.
- Hank Hill: "I tell you what", "dang ol'", "son", slower drawl, short clipped pauses.
- Rick Sanchez: burps (use "*burp*"), "wubba", abrupt cuts, "listen Morty"-style tangents, cynical sighs.
- Donald Trump: "believe me", "folks", "tremendous", short sentences, repetition, "uh" for emphasis.
- Snoop Dogg: "yeah", "you know what I'm sayin", laid-back drawl, "nephew", "cuz".
- Arnold Schwarzenegger: "come on", "do it now", commanding short sentences, no disfluencies — he's decisive.
- Stewie Griffin: "what the deuce", "victory shall be mine", British-tinged formal + sarcastic.
- Theo Von: "brother", "I'll tell ya", self-deprecating tangents, southern drawl.
- Gilbert Gottfried: extreme pauses, sharp nasal shouts, "and then...", over-enunciation.
- Morty: "aw jeez", "c'mon Rick", anxious stutters, "uhhh" a lot with breaking voice.

If the name isn't on that list, use your general knowledge of how they speak — match their real cadence. If you don't recognize the name at all, fall back to generic natural disfluencies.

Drop the "SPEAKER: <name>" line from your output — it's context for you, not for the TTS.`;

async function _httpHumanize(text, voiceName) {
    const c = _config();
    if (!c.enabled || !c.url || !c.model) return null;
    // Ollama's native /api/chat endpoint honors {think: false} reliably.
    // The OpenAI-compatible /v1/chat/completions path ignores both
    // chat_template_kwargs and /no_think tags on Qwen3, so thinking leaks and
    // eats max_tokens. Swap /v1/... → /api/chat when talking to Ollama.
    const base = c.url.replace(/\/+$/, '').replace(/\/v1$/, '');
    const url = `${base}/api/chat`;
    // Prepend the speaker hint if we have a name — the system prompt tells
    // the LLM to use it for stylistic choices only, not echo it back.
    const userContent = voiceName ? `SPEAKER: ${voiceName}\n\n${text}` : text;
    const body = {
        model: c.model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
        ],
        // Ollama-native shape: `think: false` disables Qwen3 thinking;
        // `options` takes temperature/num_predict (their max_tokens).
        think: false,
        options: {
            temperature: 0.4,
            num_predict: Math.max(1024, Math.ceil(text.length * 3)),
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

function _sanityCheck(original, rewritten) {
    // Cheap guards: reject if the model wandered off — too short (lost
    // content), too long (added prose), refused the request, or dropped a
    // [tag] that was in the original. Fall back to original on rejection.
    if (_isRefusal(rewritten)) return false;
    const origLen = original.trim().length;
    const rewLen = rewritten.trim().length;
    if (rewLen < Math.max(origLen * 0.6, 4)) return false;   // drastically shorter = likely summarized
    // Allow up to 3.5x + 80 chars since aggressive humanize can more than
    // double short inputs ("hi" → "uhhhh, hi... yeah, hi" is legit).
    if (rewLen > origLen * 3.5 + 80) return false;            // drastically longer = likely added commentary
    const origTags = Array.from(original.matchAll(/\[[^\]]+\]/g)).map(m => m[0].toLowerCase());
    const rewTags = Array.from(rewritten.matchAll(/\[[^\]]+\]/g)).map(m => m[0].toLowerCase());
    // Every original tag must appear in the rewritten text
    for (const tag of origTags) {
        if (!rewTags.includes(tag)) return false;
    }
    return true;
}

// Public: humanize text → returns rewritten string, or the original text if
// the LLM is disabled, errors out, or produced something the sanity check
// rejects. Always callable — never throws.
async function humanize(text, voiceName) {
    const original = (text || '').toString();
    if (!original.trim()) return original;
    if (!isAvailable()) return original;
    if (original.length < 8) return original;  // "hi" doesn't need pauses

    // Cache key includes voice name so "hello" through Jordan Peterson caches
    // separately from "hello" through Hank Hill.
    const key = _keyFor(original, voiceName || '');
    const cached = _cache.get(key);
    if (cached && (Date.now() - cached.at) < 6 * 60 * 60 * 1000) return cached.humanized;

    const raw = await _httpHumanize(original, voiceName);
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
                       'dropped-tags';
        console.warn(`[tts-humanize-llm] rejected (${reason}) — orig: ${JSON.stringify(original.slice(0,80))} → rewrite: ${JSON.stringify((raw.humanized||'').slice(0,120))}`);
        return original;
    }
    _evict();
    _cache.set(key, { at: Date.now(), humanized: raw.humanized });
    return raw.humanized;
}

module.exports = { humanize, isAvailable };
