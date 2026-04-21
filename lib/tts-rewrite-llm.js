// LLM-powered "rewrite in voice" pass for TTS text.
//
// Different from the humanize module: humanize PRESERVES meaning and just
// sprinkles disfluencies + commas + pauses. This one REWRITES the content
// so the line actually reads like something that specific speaker would say
// — Trump rewrites a dry sentence as a rally riff, Werner Herzog reframes
// it as philosophical narration, Jordan Peterson adds qualifying sub-clauses.
// Output can be longer or shorter than the input. Still single-pass, no
// chain-of-thought, no conversation — it's a content rewriter.
//
// Shares Ollama endpoint + env with humanize:
//   HUMANIZE_LLM_URL | EMOTION_LLM_URL
//   HUMANIZE_LLM_MODEL | EMOTION_LLM_MODEL
//   HUMANIZE_LLM_API_KEY | EMOTION_LLM_API_KEY
// Plus: REWRITE_LLM_ENABLED (defaults to true when humanize is on).

'use strict';

const crypto = require('crypto');
const { resolveStyle } = require('./tts-humanize-styles');

const CACHE_MAX = 300;
const _cache = new Map(); // sha256(text|voice|engine) -> { at, rewritten }

function _keyFor(text, voiceKey, engine) {
    return crypto.createHash('sha256')
        .update(String(voiceKey || '') + '\n' + String(engine || '') + '\n' + text)
        .digest('hex');
}

function _config() {
    const url = (process.env.HUMANIZE_LLM_URL || process.env.EMOTION_LLM_URL || '').trim();
    const model = (process.env.HUMANIZE_LLM_MODEL || process.env.EMOTION_LLM_MODEL || '').trim();
    const key = (process.env.HUMANIZE_LLM_API_KEY || process.env.EMOTION_LLM_API_KEY || '').trim();
    const base = process.env.EMOTION_LLM_ENABLED === '1' || process.env.EMOTION_LLM_ENABLED === 'true';
    const override = process.env.REWRITE_LLM_ENABLED;
    const enabled = base && override !== '0' && override !== 'false';
    // Rewrites are meatier than humanize — 45s accommodates Qwen3 on CPU +
    // an uncensored model that burns more tokens on creative expansion.
    const timeoutMs = parseInt(process.env.REWRITE_LLM_TIMEOUT_MS || '45000', 10);
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

// Fish gets the full tag vocabulary because the rewrite can legitimately
// invent new emotional beats the original didn't carry. Chatterbox/RVC stay
// capped to the expression preprocessor's recognized set.
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
        return `\n\nINLINE TAGS (Fish engine):
This voice runs through Fish, which natively honors inline [tags] for
delivery. Insert tags where the rewrite genuinely calls for them — a
[laughing] before a joke, [sigh] for resignation, [shouting] for a caps
outburst, [whisper] for an aside. 0–3 per sentence depending on the emotion
density. Don't invent tags just to have them.

Common tags (15,000+ free-form descriptors are also supported):
${FISH_TAG_HINTS.map(s => '- ' + s).join('\n')}`;
    }
    if (e === 'chatterbox' || e === 'cb' || e === 'rvc') {
        return `\n\nINLINE TAGS (Chatterbox engine):
You MAY insert a small set of emotion tags the preprocessor understands.
Only the tags below are recognized — don't invent new ones:
${CHATTERBOX_TAG_HINTS.map(s => '- ' + s).join('\n')}`;
    }
    return '';
}

function _speakerSection(styleHint) {
    if (!styleHint) {
        return `\n\nSPEAKER:
The user's message begins with "SPEAKER: <name>". Use your general
knowledge of how that person actually talks — vocabulary, typical topics,
cadence, verbal tics, worldview. Channel them. If the name is unfamiliar,
fall back to a generic natural-speech rewrite.

Drop the "SPEAKER:" line from your output — it's context for you.`;
    }
    return `\n\nSPEAKER:
The user's message begins with "SPEAKER: <name>" followed by a style
guide. The style guide + your general knowledge of that person together
describe HOW they speak — vocabulary, cadence, catchphrases, worldview.

HOW TO USE THE STYLE BLOCK:
- Phrase lists are a PALETTE to draw from, sized to fit the sentence.
  Short sentences may only fit one phrase; longer or emotionally rich
  ones can carry more. Weave them INTO the rewrite, don't stack them.
- Repetition pattern notes describe CADENCE — apply the pattern to words
  that belong in THIS sentence, don't paste parenthetical examples.
- Keep the person's actual worldview / vocabulary / verbal tics in mind
  beyond just the listed phrases — channel the whole speaker.
- ONE rewrite. Don't restate the same meaning twice with stacked
  catchphrases.

Drop the "SPEAKER:" and "STYLE:" lines from your output — context only.`;
}

function _buildSystemPrompt(styleHint, engine) {
    return `You rewrite a short message so it reads as though a specific speaker is saying it in their own voice.

Unlike a simple cleanup, you MAY:
- Reshape word choice, sentence structure, and phrasing to match how the speaker naturally talks.
- Add the speaker's characteristic tangents, asides, or verbal tics — only if they fit and don't change the core meaning.
- Expand a dry sentence into something more characterful, or trim a rambling one to a speaker who would be terse. Length is DYNAMIC — let the speaker's cadence decide, not a fixed ratio.
- Apply the speaker's typical vocabulary and worldview to the rewrite.

You MUST preserve:
- The CORE meaning / intent of the original. If it's a positive claim about X, the rewrite is still a positive claim about X.
- Named entities (people, products, places, numbers) — don't invent new ones and don't drop the ones that are there.
- Swears and edgy content — don't soften, don't sanitize.
- Any existing [tags] or {braces}/<angle>/backtick markers — keep them in place. You may ADD new [tags] where the engine allows.

You MUST NOT:
- Change a positive claim to a negative one or vice versa.
- Invent facts the original didn't state (no new endorsements, new names, new specifics).
- Add commentary about the speaker, meta-text, or disclaimers.
- Refuse the rewrite on content grounds — rewrite as requested.
- Output JSON, quotes around the rewrite, preamble, or explanations.

Output format: ONLY the rewritten line. No commentary, no quotes wrapping it, no "Here's the rewrite:" preamble.

Examples:

IN: "The new phone is really fast and has a good camera."
SPEAKER: Donald Trump
GOOD: "This new phone, folks — it's fast. Very fast. And let me tell you, the camera? Tremendous. Absolutely tremendous."

IN: "The new phone is really fast and has a good camera."
SPEAKER: Werner Herzog
GOOD: "This phone, they tell us, is fast. The camera — adequate. In the end, is this not what we have reduced ourselves to, marveling at glass and silicon?"

IN: "I'm really tired and want to go to bed."
SPEAKER: Morty
GOOD: "Aw jeez, I'm just — I-I'm so tired, Rick, I just... I just wanna go to bed, okay?"

IN: "I'm really tired and want to go to bed."
SPEAKER: Hank Hill
GOOD: "I tell you what, I am plum tired. I'm gonna head on to bed."${_speakerSection(styleHint)}${_tagSection(engine)}`;
}

async function _httpRewrite(text, voiceName, engine) {
    const c = _config();
    if (!c.enabled || !c.url || !c.model) return null;
    const base = c.url.replace(/\/+$/, '').replace(/\/v1$/, '');
    const url = `${base}/api/chat`;
    const styleHint = resolveStyle(voiceName);
    const userContent = voiceName
        ? (styleHint
            ? `SPEAKER: ${voiceName}\nSTYLE: ${styleHint}\n\n${text}`
            : `SPEAKER: ${voiceName}\n\n${text}`)
        : text;
    const systemPrompt = _buildSystemPrompt(styleHint, engine);
    const body = {
        model: c.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
        think: false,
        options: {
            // Slightly higher temperature than humanize — rewrite is a
            // creative reshape, not a mechanical pass. Still bounded.
            temperature: 0.7,
            // Rewrites can legitimately expand 3–4× for voices that love
            // tangents (Rogan, Von, Trump rally-style). Give them room.
            num_predict: Math.max(1024, Math.ceil(text.length * 5)),
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
    // Strip leading "Here's the rewrite:" / "Sure, here you go:" preambles
    // that some chat-tuned models tack on even when told not to.
    clean = clean.replace(/^(?:sure[,!]?\s+)?(?:here'?s?(?:\s+(?:the|a|your))?\s+(?:rewrite|version|line)[:\s]+)/i, '').trim();
    clean = clean.replace(/^(?:okay[,!]?\s+)?(?:in\s+(?:the\s+)?voice\s+of\s+[^:\n]+[:\n]\s*)/i, '').trim();
    return { rewritten: clean };
}

// Same refusal patterns as humanize — copied here rather than imported so
// the modules stay independently deployable.
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
    // Rewrites get much looser bounds than humanize — the whole point is
    // that they can expand or contract to fit the speaker. We still reject
    // refusals and the pathological ~10× "model went off on a tangent" case.
    if (_isRefusal(rewritten)) return false;
    const origLen = original.trim().length;
    const rewLen = rewritten.trim().length;
    // Empty or near-empty rewrite = failure.
    if (rewLen < 3) return false;
    // Allow up to 6× + 120 chars — gives the model room for Rogan-style
    // tangents without letting it spiral into a full essay.
    if (rewLen > origLen * 6 + 120) return false;
    return true;
}

// Public: rewrite text → returns rewritten string, or the original text if
// the LLM is disabled, errors out, or produced something rejected by sanity
// checks. Always callable — never throws.
async function rewrite(text, voiceName, engine) {
    const original = (text || '').toString();
    if (!original.trim()) return original;
    if (!isAvailable()) return original;

    const key = _keyFor(original, voiceName || '', engine || '');
    const cached = _cache.get(key);
    if (cached && (Date.now() - cached.at) < 6 * 60 * 60 * 1000) return cached.rewritten;

    const raw = await _httpRewrite(original, voiceName, engine);
    if (!raw || raw._error || !raw.rewritten) {
        console.warn('[tts-rewrite-llm] failed:', raw && raw._error);
        return original;
    }
    if (!_sanityCheck(original, raw.rewritten)) {
        const origLen = original.trim().length;
        const rewLen = (raw.rewritten || '').trim().length;
        const reason = _isRefusal(raw.rewritten) ? 'refusal-pattern' :
                       rewLen < 3 ? 'empty' :
                       rewLen > origLen * 6 + 120 ? `too-long (${rewLen}>${origLen*6+120})` :
                       'unknown';
        console.warn(`[tts-rewrite-llm] rejected (${reason}) — orig: ${JSON.stringify(original.slice(0,80))} → rewrite: ${JSON.stringify((raw.rewritten||'').slice(0,160))}`);
        return original;
    }
    _evict();
    _cache.set(key, { at: Date.now(), rewritten: raw.rewritten });
    return raw.rewritten;
}

module.exports = { rewrite, isAvailable };
