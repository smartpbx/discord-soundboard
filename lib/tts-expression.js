// Text → emotion segment preprocessor for TTS.
//
// Turns a single utterance into a list of segments, each tagged with an
// emotion preset (neutral / soft / excited / yell / angry / sad). Lives
// above the synthesis engines so Chatterbox, F5-TTS, GPT-SoVITS etc. all
// consume the same segmented output.
//
// Emotion cues, in precedence order (the first that matches a span wins):
//   1. Inline bracketed tags: [angry], [sad], [soft], [whisper], [yell],
//      [excited], [happy]. Tag applies to text until the next tag or end.
//   2. ALL-CAPS word runs of ≥2 words → yell for those words.
//   3. Triple-or-more `!` or `?!` → excited.
//   4. Trailing `...` within a sentence → soft for that sentence tail.
//   5. Default → neutral.
//
// Output shape:
//   [{ text, emotion, intensity, pause_ms_after }]
// where intensity is 0..1 (used to scale exaggeration within a preset).
//
// Presets themselves live in the TTS server; this module only labels
// segments so the server can route ref + cfg + temp + exag per segment.

'use strict';

const EMOTIONS = ['neutral', 'soft', 'excited', 'yell', 'angry', 'sad', 'happy'];

const TAG_TO_EMOTION = {
    angry: 'angry',
    mad: 'angry',
    sad: 'sad',
    cry: 'sad',
    crying: 'sad',
    soft: 'soft',
    softly: 'soft',
    quiet: 'soft',
    quietly: 'soft',
    whisper: 'soft',
    whispered: 'soft',
    whispering: 'soft',
    yell: 'yell',
    yelling: 'yell',
    shout: 'yell',
    shouting: 'yell',
    scream: 'yell',
    screaming: 'yell',
    excited: 'excited',
    enthusiastic: 'excited',
    happy: 'happy',
    laugh: 'happy',
    laughing: 'happy',
};

function normalizeEmotion(raw) {
    if (!raw) return 'neutral';
    const key = String(raw).toLowerCase().trim();
    return TAG_TO_EMOTION[key] || (EMOTIONS.includes(key) ? key : 'neutral');
}

// Split on sentence boundaries but preserve punctuation with each sentence
// so downstream prosody cues (! ? ...) aren't stripped.
function splitSentences(text) {
    if (!text) return [];
    const parts = [];
    let buf = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        buf += c;
        if ((c === '.' || c === '!' || c === '?') &&
            (text[i + 1] === undefined || /\s/.test(text[i + 1]))) {
            // consume run of trailing punctuation (e.g. "!!!", "?!")
            while (i + 1 < text.length && /[.!?]/.test(text[i + 1])) {
                buf += text[++i];
            }
            parts.push(buf.trim());
            buf = '';
        }
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
}

// Run-length detection for consecutive ALL-CAPS word spans (≥2 words).
// A "word" here is \w+ with optional trailing punctuation. Returns the
// input sentence split into [{text, is_caps}] chunks.
function splitCapsRuns(sentence) {
    const tokens = sentence.split(/(\s+)/);
    const out = [];
    let buf = [];
    let bufIsCaps = null;
    const isCapsWord = (tok) => {
        const w = tok.replace(/[^A-Za-z]/g, '');
        return w.length >= 2 && w === w.toUpperCase();
    };
    const flush = () => {
        if (!buf.length) return;
        const joined = buf.join('').replace(/^\s+|\s+$/g, '');
        if (joined) out.push({ text: joined, is_caps: !!bufIsCaps });
        buf = [];
        bufIsCaps = null;
    };
    let capsRunWords = 0;
    for (const tok of tokens) {
        if (/^\s+$/.test(tok)) {
            buf.push(tok);
            continue;
        }
        const capsish = isCapsWord(tok);
        if (capsish) capsRunWords++;
        else capsRunWords = 0;
        const capsRunActive = capsRunWords >= 1 && /[A-Z]/.test(tok) && isCapsWord(tok);
        // Flip chunks when caps-state changes (need ≥2 contiguous CAPS words
        // to trigger yell — buffer lookbehind handles that after-the-fact).
        if (bufIsCaps === null) bufIsCaps = capsRunActive;
        else if (bufIsCaps !== capsRunActive) { flush(); bufIsCaps = capsRunActive; }
        buf.push(tok);
    }
    flush();
    // Final pass: a standalone single-word CAPS chunk is NOT yell (probably
    // an acronym or emphasis). Merge it back with its neighbors as non-caps.
    const merged = [];
    for (const c of out) {
        const wordCount = c.text.split(/\s+/).filter(w => /\w/.test(w)).length;
        if (c.is_caps && wordCount < 2) merged.push({ text: c.text, is_caps: false });
        else merged.push(c);
    }
    // Coalesce adjacent same-state chunks
    const final = [];
    for (const c of merged) {
        const last = final[final.length - 1];
        if (last && last.is_caps === c.is_caps) last.text = (last.text + ' ' + c.text).replace(/\s+/g, ' ');
        else final.push({ ...c });
    }
    return final;
}

// Extract bracketed tags [tag] from a sentence; returns remaining text
// + the emotion tag if any. Ignores unknown tags (keeps them in text).
function extractTag(sentence) {
    const m = sentence.match(/^\s*\[([a-zA-Z][a-zA-Z_ ]{0,20})\]\s*(.*)$/);
    if (!m) return { tag: null, text: sentence };
    const mapped = normalizeEmotion(m[1]);
    if (mapped === 'neutral' && !(m[1].toLowerCase() in TAG_TO_EMOTION)) {
        // Unknown tag — leave it in the text rather than silently dropping.
        return { tag: null, text: sentence };
    }
    return { tag: mapped, text: m[2] };
}

// Collapse trailing "..." or " … " inside a sentence → mark soft for that
// sentence (mild intensity). Exclamation / question mark runs → excited.
function sentenceEmotion(sentence) {
    const trimmed = sentence.trim();
    if (!trimmed) return { emotion: 'neutral', intensity: 0.5 };
    // Triple ! or ?! → excited
    if (/[!?]{3,}/.test(trimmed) || /!!/.test(trimmed)) {
        return { emotion: 'excited', intensity: 0.85 };
    }
    // Trailing ellipsis → soft
    if (/(\.{3,}|…)\s*$/.test(trimmed)) {
        return { emotion: 'soft', intensity: 0.4 };
    }
    return { emotion: 'neutral', intensity: 0.5 };
}

// Main entrypoint.
function segmentText(rawInput, opts = {}) {
    const defaultEmotion = opts.defaultEmotion || 'neutral';
    const forcedEmotion = opts.forcedEmotion || null; // UI override: skip parsing
    const minSegmentChars = Number.isFinite(opts.minSegmentChars) ? opts.minSegmentChars : 3;

    const text = String(rawInput || '').trim();
    if (!text) return [];

    if (forcedEmotion) {
        return [{
            text,
            emotion: normalizeEmotion(forcedEmotion),
            intensity: 1.0,
            pause_ms_after: 0,
        }];
    }

    const segments = [];
    const sentences = splitSentences(text);
    // Tag carry: once [angry] appears, subsequent sentences inherit it
    // until a new tag flips the state.
    let carriedTag = null;

    for (let si = 0; si < sentences.length; si++) {
        let sentence = sentences[si];
        const { tag, text: stripped } = extractTag(sentence);
        if (tag) carriedTag = tag;
        sentence = stripped;
        if (!sentence.trim()) continue;

        const { emotion: defaultEmo, intensity: defaultInt } = sentenceEmotion(sentence);
        // Within the sentence, caps-runs override emotion for those spans.
        const capsChunks = splitCapsRuns(sentence);
        for (let ci = 0; ci < capsChunks.length; ci++) {
            const chunk = capsChunks[ci];
            if (chunk.text.length < minSegmentChars && segments.length) {
                // merge tiny tail into previous segment
                segments[segments.length - 1].text += ' ' + chunk.text;
                continue;
            }
            const chunkEmotion = chunk.is_caps
                ? 'yell'
                : (carriedTag || defaultEmo || defaultEmotion);
            const chunkIntensity = chunk.is_caps ? 1.0 : defaultInt;
            segments.push({
                text: chunk.text.trim(),
                emotion: chunkEmotion,
                intensity: chunkIntensity,
                pause_ms_after: 0,
            });
        }
        // Emotion boundary or sentence end → small pause
        if (si < sentences.length - 1) {
            segments[segments.length - 1].pause_ms_after = 180;
        }
    }

    // Coalesce adjacent segments that share emotion + intensity so we
    // don't fragment into one-word pieces for no reason.
    const coalesced = [];
    for (const s of segments) {
        const last = coalesced[coalesced.length - 1];
        if (last && last.emotion === s.emotion && Math.abs(last.intensity - s.intensity) < 0.05 && last.pause_ms_after === 0) {
            last.text = (last.text + ' ' + s.text).replace(/\s+/g, ' ');
            last.pause_ms_after = s.pause_ms_after;
        } else {
            coalesced.push({ ...s });
        }
    }
    return coalesced;
}

module.exports = {
    segmentText,
    normalizeEmotion,
    EMOTIONS,
    // exposed for tests
    _internal: { splitSentences, splitCapsRuns, extractTag, sentenceEmotion },
};
