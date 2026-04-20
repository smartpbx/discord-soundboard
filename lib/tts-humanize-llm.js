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

function _keyFor(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function _config() {
    const url = (process.env.EMOTION_LLM_URL || '').trim();
    const model = (process.env.EMOTION_LLM_MODEL || '').trim();
    const key = (process.env.EMOTION_LLM_API_KEY || '').trim();
    const base = process.env.EMOTION_LLM_ENABLED === '1' || process.env.EMOTION_LLM_ENABLED === 'true';
    const override = process.env.HUMANIZE_LLM_ENABLED;
    // Humanize enabled iff the underlying LLM is usable AND operator hasn't
    // explicitly disabled just this feature.
    const enabled = base && override !== '0' && override !== 'false';
    const timeoutMs = parseInt(process.env.EMOTION_LLM_TIMEOUT_MS || '8000', 10);
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

const SYSTEM_PROMPT = `You rewrite short text messages so a TTS voice reads them naturally.

Your ONLY goal is to make the TTS delivery sound human — NOT to change meaning, NOT to add new facts, NOT to censor, NOT to rephrase for politeness.

Edits you MAY make:
- Insert natural disfluencies: "uh", "um", "like", "you know", "I mean", "hmm", "er" — sparingly, where a human would actually pause to think. Maximum 1 per ~15 words.
- Add commas to break long noun phrases or clauses so the reader breathes.
- Use ellipses (...) for trailing thoughts or hesitation.
- Add exclamation marks or question marks where intent is clear from context.
- Break a run-on sentence into two.

Edits you MUST NOT make:
- Change any word's meaning or substitute synonyms.
- Remove or add information (names, numbers, claims, slurs, swears — leave them alone).
- "Clean up" or soften profanity or offensive content.
- Rewrite sentences into a different tone (formal → casual, etc.).
- Add emojis.
- Remove or reorder any existing [tags] like [shouting], [whisper], [laughing], [angry] — keep them exactly where they were.
- Remove or reorder any existing {braces} / <angle> / backtick markers.

Output format: ONLY the rewritten text. No JSON, no commentary, no preamble, no quotes around it. Preserve the original roughly — this is polishing, not rewriting.

Examples:
IN: im really tired today and I dont want to do anything
OUT: I'm... really tired today. And, uh, I don't want to do anything.

IN: [angry] what the hell are you doing
OUT: [angry] What the hell are you doing?!

IN: so yeah we went to the store and got some milk
OUT: So yeah, we went to the store and, uh, got some milk.

IN: HELLO THERE GENERAL KENOBI
OUT: HELLO THERE, GENERAL KENOBI!`;

async function _httpHumanize(text) {
    const c = _config();
    if (!c.enabled || !c.url || !c.model) return null;
    const url = c.url.endsWith('/chat/completions') ? c.url : `${c.url.replace(/\/+$/, '')}/chat/completions`;
    const body = {
        model: c.model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
        ],
        temperature: 0.4,
        max_tokens: Math.max(256, Math.ceil(text.length * 1.5)),
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
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { _error: 'no choices[0].message.content in response' };
    // Strip code fences / surrounding quotes some models like to add
    let clean = content.trim();
    clean = clean.replace(/^```(?:\w+)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1);
    }
    return { humanized: clean };
}

function _sanityCheck(original, rewritten) {
    // Cheap guards: reject if the model wandered off — too short (lost
    // content), too long (added prose), or dropped a [tag] that was in the
    // original. Fall back to original on rejection.
    const origLen = original.trim().length;
    const rewLen = rewritten.trim().length;
    if (rewLen < Math.max(origLen * 0.6, 4)) return false;   // drastically shorter = likely summarized
    if (rewLen > origLen * 2.5 + 50) return false;            // drastically longer = likely added commentary
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
async function humanize(text) {
    const original = (text || '').toString();
    if (!original.trim()) return original;
    if (!isAvailable()) return original;
    if (original.length < 8) return original;  // "hi" doesn't need pauses

    const key = _keyFor(original);
    const cached = _cache.get(key);
    if (cached && (Date.now() - cached.at) < 6 * 60 * 60 * 1000) return cached.humanized;

    const raw = await _httpHumanize(original);
    if (!raw || raw._error || !raw.humanized) {
        console.warn('[tts-humanize-llm] failed:', raw && raw._error);
        return original;
    }
    if (!_sanityCheck(original, raw.humanized)) {
        console.warn('[tts-humanize-llm] sanity check rejected rewrite, keeping original');
        return original;
    }
    _evict();
    _cache.set(key, { at: Date.now(), humanized: raw.humanized });
    return raw.humanized;
}

module.exports = { humanize, isAvailable };
