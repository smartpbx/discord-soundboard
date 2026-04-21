// Per-voice humanize style profiles.
//
// Each profile tells the humanize LLM HOW a specific speaker talks — which
// fillers to use (or avoid), cadence, catchphrases. The humanize module
// injects the matched profile into the user message so the LLM produces
// disfluencies tailored to the character instead of a generic "uhhh" pass.
//
// Keys are the voice directory id (e.g. "trump", "jordan_peterson"). Lookup
// normalizes both the key and the inbound voice name — so a voice whose
// display name is "Donald Trump" still matches the "trump" entry. When a
// voice isn't listed here, the humanize module falls back to a generic
// natural-disfluencies style.
//
// When adding a new voice, drop an entry here keyed by the directory id the
// TTS server uses. Aliases help when the display name diverges from the id.

'use strict';

// Each style string is injected verbatim under a "SPEAKER STYLE:" header in
// the user message. Keep them concrete and short — the LLM works best with
// 2–5 specific rules, not paragraphs of context.
const STYLES = {
    // --- Political / public figures -----------------------------------------

    trump: {
        aliases: ['donald trump', 'donaldtrump', 'donald'],
        style: [
            'Short, punchy sentences. Apply a repeat-an-emphasis-word pattern to an adjective or adverb from the ORIGINAL sentence (e.g. "really, really awful", "so, so bad") — do NOT paste "very, very" verbatim.',
            'Palette of signature phrases — pick the ones that fit THIS sentence, weave them inside the message rather than stacking at the start or end: "believe me", "folks", "tremendous", "the best", "many people are saying", "believe it or not", "I\'ll tell ya". Short sentences may only fit one; longer ones can carry two or three.',
            'NO "uhhh"/"ummm" — he speaks in confident declarations, not hesitations.',
            'Do NOT restate the message a second time with stacked catchphrases.',
        ].join(' '),
    },

    biden: {
        aliases: ['joe biden', 'joebiden', 'joe'],
        style: [
            'Slow, deliberate pace with lots of ellipses... and mid-sentence resets.',
            'Fillers: "look", "folks", "c\'mon man", "here\'s the deal", "not a joke".',
            'Light "uhh" — a hesitation here and there but not constant.',
            'Whispered asides work ("...not a joke"). Commas are your friend.',
        ].join(' '),
    },

    obama: {
        aliases: ['barack obama', 'barackobama', 'barack'],
        style: [
            'Measured, oratorical cadence. Pauses between clauses with commas and em-dashes.',
            'Fillers: "look", "let me be clear", "the fact is", "ultimately".',
            'Minimal "uhh" — calm and composed. Emphasis via repetition and cadence, not hesitation.',
            'Often drops the final "g" ("workin\'", "talkin\'") when relaxed.',
        ].join(' '),
    },

    bush: {
        aliases: ['george bush', 'georgebush', 'george w bush', 'gwbush'],
        style: [
            'Folksy Texan cadence. Short sentences with occasional bushisms.',
            'Fillers: "folks", "you know", "make no mistake", "look". Occasional "uhh".',
            'Drops g\'s ("workin\'"). Chuckles mid-sentence ("heh") are on-brand.',
            'Simple vocabulary. Avoid anything too professorial.',
        ].join(' '),
    },

    elon: {
        aliases: ['elon musk', 'elonmusk', 'musk'],
        style: [
            'Awkward nerdy cadence with long hesitations — "uhhh" and "ummmm" ARE appropriate.',
            'Fillers: "um", "essentially", "I mean", "which is", "sort of", "basically".',
            'False starts and mid-sentence restarts ("so the — the thing is...").',
            'Nervous chuckles ("heh") where he would normally deflect. Trails off with ellipses.',
        ].join(' '),
    },

    rfk_jr: {
        aliases: ['rfk', 'robert kennedy', 'kennedy jr', 'rfkjr'],
        style: [
            'Hoarse, raspy voice with shorter breaths and raspy pauses.',
            'Measured and a bit hesitant. Light "uhh" is fine but not heavy.',
            'Fillers: "look", "the fact is", "you know". Formal-ish word choice.',
            'Break long sentences with commas — he runs out of breath otherwise.',
        ].join(' '),
    },

    // --- Celebrities / personalities ---------------------------------------

    arnold: {
        aliases: ['arnold schwarzenegger', 'arnoldschwarzenegger', 'schwarzenegger', 'arnold_schwarenegger'],
        style: [
            'Commanding, confident, short imperative sentences. NO "uhh"/"ummm" ever.',
            'Catchphrases sparingly: "do it now", "come on", "get to the chopper" only if context fits.',
            'Heavy accent is handled by the voice model — don\'t respell words phonetically.',
            'Exclamation marks welcome. No hesitations — he is decisive.',
        ].join(' '),
    },

    freeman: {
        aliases: ['morgan freeman', 'morganfreeman', 'morgan'],
        style: [
            'Slow, measured, narratorial. Long pauses with commas and ellipses.',
            'NO "uhh"/"ummm" — he is the calm voice of authority.',
            'Light fillers: occasional "you see", "now". Mostly just breath and rhythm.',
            'Over-comma to force pauses between clauses. That\'s where the gravitas is.',
        ].join(' '),
    },

    jack_black: {
        aliases: ['jack black', 'jackblack'],
        style: [
            'High energy, theatrical, rock-and-roll vibe. Exclamations liberally.',
            'Fillers: "dude", "bro", "oh my god", "check this out", "yeah!!!".',
            'Light "uhhh" when mock-thinking. Stretches vowels for emphasis ("sooooo good").',
            'Random shouted interjections are fine. Laughs mid-sentence ("ha-HA!").',
        ].join(' '),
    },

    snoop: {
        aliases: ['snoop dogg', 'snoopdogg', 'snoop dog'],
        style: [
            'Laid-back drawl. Stretched vowels ("yeaaaah").',
            'Fillers: "you know what I\'m sayin\'", "nephew", "cuz", "homie", "yeah".',
            'Minimal "uhh" — he glides with "yeah" and "you know" instead.',
            'Drop g\'s ("sayin\'", "chillin\'"). Soft-spoken, rarely shouts.',
        ].join(' '),
    },

    joe_rogan_test: {
        aliases: ['joe rogan', 'joerogan', 'rogan'],
        style: [
            'Excited, leaning-forward curiosity. Lots of "it\'s crazy", "that\'s wild".',
            'Fillers: "like", "you know", "I mean", "have you ever". Moderate "uhh".',
            'Interrupts himself with side thoughts — em-dashes and false starts.',
            'Occasional "bro" and "dude". Questions rhetorical, often stacked.',
        ].join(' '),
    },

    jordan_peterson: {
        aliases: ['jordan peterson', 'jordanpeterson'],
        style: [
            'Slow, methodical, lecturer cadence. Frequent "well..." openings.',
            'HEAVY hesitations fit: stretched "uhhhh" and "ummmm" mid-clause as he searches for precision.',
            'Fillers: "well", "precisely", "so to speak", "roughly speaking", "so then". NEVER "like" or "you know".',
            'Em-dashes and long commas for qualifying sub-clauses. Formal vocabulary.',
        ].join(' '),
    },

    theo_von: {
        aliases: ['theo von', 'theovon'],
        style: [
            'Southern Louisiana drawl. Self-deprecating tangents that spiral.',
            'HEAVY fillers and hesitations — "uhhh", "ummm", "bro", "brother", "I\'ll tell ya", "dog".',
            'Absurd folksy similes ("like a squirrel on Adderall"). Breaks sentences weird.',
            'Drop g\'s. Trail off with "...ya know?" often.',
        ].join(' '),
    },

    gilbert_godfrey: {
        aliases: ['gilbert gottfried', 'gottfried', 'gilbert', 'gilbertgodfrey'],
        style: [
            'Extreme dramatic pauses. Over-enunciate specific words with caps-lock emphasis.',
            'Fillers: "AND THEN...", "SO NOW...", "WHAT DO YOU KNOW...".',
            'Sharp nasal shouts, then abrupt drops. Exclamation marks on key beats.',
            'Light "uhh" but mostly dead-air pauses (use ... liberally) before the punchline.',
        ].join(' '),
    },

    gilbert_yell: {
        aliases: ['gilbert gottfried yell', 'gilbertyell'],
        style: [
            'Everything is SHOUTED. Caps-lock words for maximum intensity.',
            'Minimal fillers — he\'s yelling, not thinking. Short loud fragments.',
            'Exclamation marks on every sentence. Rhetorical questions screamed.',
        ].join(' '),
    },

    shane_gillis: {
        aliases: ['shane gillis', 'shanegillis'],
        style: [
            'Casual bro cadence, slightly slurred. Laughs mid-sentence.',
            'Fillers: "dude", "bro", "like", "fuckin\'", "I mean". Moderate "uhh".',
            'Irreverent asides. Drops g\'s. Sentences sometimes peter out with "or whatever".',
        ].join(' '),
    },

    tim_robinson: {
        aliases: ['tim robinson', 'timrobinson'],
        style: [
            'Escalating energy — starts normal, gets increasingly unhinged and shouty.',
            'Fillers: "I don\'t KNOW!", "listen to me!", "you can\'t just...". Exclamation marks.',
            'Abrupt all-caps shouts mid-sentence. Repeats phrases for emphasis ("I\'m TELLING you, I\'m TELLING you").',
            'Desperate tone on key words. Use em-dashes for interruptions.',
        ].join(' '),
    },

    christopher_walken: {
        aliases: ['christopher walken', 'christopherwalken', 'walken'],
        style: [
            'Weird arrhythmic pauses mid-phrase. Break sentences at unexpected spots.',
            'Over-comma so the voice hitches at odd beats. Ellipses mid-clause.',
            'Minimal "uhh" — the pauses themselves do the work. Understated emphasis.',
            'Example: "I had, this thing. On my desk. And I thought... why not."',
        ].join(' '),
    },

    sean_connory: {
        aliases: ['sean connery', 'connery', 'seanconnory'],
        style: [
            'Confident Scottish delivery. Voice model handles the accent — don\'t respell words.',
            'Minimal "uhh". Measured, roguish pauses with ellipses.',
            'Fillers: "well", "you see", "my dear". Short declarative sentences.',
        ].join(' '),
    },

    austin_powers: {
        aliases: ['austin powers', 'austinpowers', 'mike myers'],
        style: [
            'Swinging-sixties British cheek. Playful and over-the-top.',
            'Catchphrases sparingly: "yeah baby", "groovy", "oh behave", "shagadelic".',
            'Minimal "uhh" — mostly confident mock-suave delivery.',
            'Use exclamations and em-dashes for comedic pauses.',
        ].join(' '),
    },

    werner_herzog: {
        aliases: ['werner herzog', 'wernerherzog', 'herzog'],
        style: [
            'Bleakly philosophical narration. Slow, measured, Germanic cadence.',
            'NO "uhh"/"ummm" — he speaks in deliberate, complete thoughts.',
            'Long sentences with nested clauses. Em-dashes and commas for philosophical weight.',
            'Word choice skews melancholic and grand ("the abyss", "indifferent nature").',
        ].join(' '),
    },

    gordon_ramsay: {
        aliases: ['gordon ramsay', 'gordonramsay', 'ramsay'],
        style: [
            'Explosive intensity when angry — caps-lock shouts and profanity stay as-is.',
            'Fillers: "bloody hell", "for fuck\'s sake", "what are you DOING". Heavy on exclamations.',
            'NO "uhh" — he\'s decisive even when furious. Short clipped sentences.',
            'British-ism: "bloody", "brilliant", "donkey" (as insult). Em-dashes for interruption.',
        ].join(' '),
    },

    stephen_hawking: {
        aliases: ['stephen hawking', 'stephenhawking', 'hawking'],
        style: [
            'Robotic synthesizer cadence — the voice model handles the sound.',
            'NO fillers, NO "uhh"/"ummm", NO contractions ("do not" over "don\'t").',
            'Short, precise, declarative sentences. Commas for structural pauses only.',
            'Formal scientific word choice. No emotional inflection.',
        ].join(' '),
    },

    dr_disrespect: {
        aliases: ['dr disrespect', 'drdisrespect', 'doc'],
        style: [
            'Bombastic self-aggrandizing trash talk. Over-the-top bravado.',
            'Catchphrases sparingly: "the two-time", "violence, speed, momentum", "champions club".',
            'NO "uhh" — pure confidence. Exclamations welcome.',
            'Short declarative hype-sentences. Third-person references to himself work.',
        ].join(' '),
    },

    // --- Cartoon / animated characters -------------------------------------

    homer: {
        aliases: ['homer simpson', 'homersimpson'],
        style: [
            'Dim-witted cadence. Signature "d\'oh!" works. Stretched "mmmm" for cravings ("mmmm, donuts").',
            'Fillers: "uhhhh", "woo-hoo", "why you little", "boy I tell ya". Heavy hesitation is fine.',
            'Short dumb-guy sentences. Trails off mid-thought. Grunts and sighs between words.',
            'Exclamations for outbursts. Low-effort vocabulary.',
        ].join(' '),
    },

    peter_griffin: {
        aliases: ['peter griffin', 'petergriffin'],
        style: [
            'Dumb-guy cadence with weird chuckles ("heheheh").',
            'Fillers: "heh", "aw geez", "you know what really grinds my gears", "holy crap".',
            'Light "uhh". Non-sequitur asides ("this is like that time...") work.',
            'Shout random words mid-sentence for emphasis. Exclamations welcome.',
        ].join(' '),
    },

    stewie: {
        aliases: ['stewie griffin', 'stewiegriffin', 'stewie_griffin'],
        style: [
            'British-tinged, precocious, sardonic. Formal vocabulary with disdain.',
            'Fillers: "what the deuce", "oh blast", "victory shall be mine", "by God".',
            'NO "uhh" — he is articulate. Sneering pauses with em-dashes instead.',
            'Deliberately over-formal phrasing. Light sarcasm via italicized-feeling words.',
        ].join(' '),
    },

    rick: {
        aliases: ['rick sanchez', 'ricksanchez', 'rick c-137'],
        style: [
            'Cynical drunk-genius cadence. Burps belong IN the text as "*burp*".',
            'Fillers: "listen Morty", "look", "*burp*", "wubba lubba dub dub", "whatever".',
            'Abrupt mid-sentence cuts with em-dashes. Sighs and dismissive exhales.',
            'Light "uhh" but more often he trails off with "...whatever" or cuts himself off.',
        ].join(' '),
    },

    morty: {
        aliases: ['morty smith', 'mortysmith'],
        style: [
            'Anxious, breaking, teenage. HEAVY stutters and hesitations.',
            'Fillers: "aw jeez", "c\'mon Rick", "I-I dunno", "uhhhh", "w-what".',
            'Stretch "uhhh"/"ummm" 3–5 letters. Stammer with repeated syllables ("I-I-I").',
            'Voice cracks mid-sentence — use ... and em-dashes for faltering.',
        ].join(' '),
    },

    cartman: {
        aliases: ['eric cartman', 'ericcartman', 'cartman eric'],
        style: [
            'Whiny, demanding, bratty. Drawn-out complaints.',
            'Fillers: "screw you guys", "respect my authoritah", "mom!", "you guys".',
            'Stretch vowels for whining ("nooooo", "mooom"). Minimal "uhh" — he\'s too confident.',
            'Exclamations and ALL-CAPS for outbursts. Bossy tone.',
        ].join(' '),
    },

    hank_hill: {
        aliases: ['hank hill', 'hankhill'],
        style: [
            'Slow Texan drawl. Short clipped pauses, not drawn-out ones.',
            'Fillers: "I tell you what", "dang ol\'", "son", "that boy ain\'t right".',
            'Minimal "uhh" — he just pauses silently. Use commas for breathing beats.',
            'Drop g\'s ("tellin\'"). Mild exclamations ("dangit"). Avoid profanity.',
        ].join(' '),
    },

    macho_man: {
        aliases: ['macho man', 'machoman', 'randy savage'],
        style: [
            'OVER-THE-TOP wrestler bravado. Growls, stretched syllables, "OHHH YEAAAH".',
            'Catchphrases: "ohhh yeah", "dig it", "the cream rises to the top".',
            'NO "uhh" — pure hype. Everything shouted or growled.',
            'Stretch vowels aggressively ("MAAAN", "YEAAAH"). Exclamations on every line.',
        ].join(' '),
    },

    macho_man_yell: {
        aliases: ['macho man yell', 'machomanyell'],
        style: [
            'Everything SHOUTED — pure wrestler hype. Caps-lock liberally.',
            'Stretched vowels ("OHHHH YEAAAHHH", "DIG IT MAAAAN"). Exclamations every line.',
            'NO fillers, NO "uhh" — just raw volume.',
        ].join(' '),
    },

    // --- Misc / meme / other ----------------------------------------------

    emma_watson: {
        aliases: ['emma watson', 'emmawatson'],
        style: [
            'British RP. Soft, articulate, polite cadence.',
            'Minimal "uhh". Light fillers: "I mean", "sort of", "actually", "quite".',
            'Commas for gentle pauses. Rarely shouts. Questions rise softly.',
        ].join(' '),
    },

    helldivers: {
        aliases: ['helldiver', 'helldivers narrator'],
        style: [
            'Propagandist military narrator. Bombastic patriotic cadence.',
            'Catchphrases: "for Super Earth", "managed democracy", "liberty".',
            'NO "uhh" — pure confident declaration. Exclamations welcome.',
            'Short clipped sentences, like a recruitment ad.',
        ].join(' '),
    },

    drain_cleaner: {
        aliases: ['drain cleaner'],
        style: [
            'Informercial-style hype — confident, fast, pitchman cadence.',
            'NO "uhh" — pure sales pitch energy. Exclamations liberally.',
            'Fillers: "and that\'s not all", "but wait", "for only", "guaranteed".',
            'Short punchy sentences with repetition for emphasis.',
        ].join(' '),
    },

    infrabren: {
        aliases: ['infrabren'],
        style: [
            'Casual conversational cadence. Light, natural disfluencies.',
            'Moderate "uhh"/"ummm" — sprinkle naturally every 10–15 words.',
            'Fillers: "like", "you know", "I mean", "kinda". Relaxed tone.',
        ].join(' '),
    },
};

function _norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Build a lookup index once: every key + every alias maps to the same style
// string, stored under its normalized form.
const _index = new Map();
for (const [key, entry] of Object.entries(STYLES)) {
    const norm = _norm(key);
    if (norm) _index.set(norm, entry.style);
    if (Array.isArray(entry.aliases)) {
        for (const a of entry.aliases) {
            const na = _norm(a);
            if (na) _index.set(na, entry.style);
        }
    }
}

// Resolve a voice display name or directory id to its style string. Returns
// null when no profile matches — the caller falls back to generic humanize.
function resolveStyle(voiceName) {
    if (!voiceName) return null;
    const k = _norm(voiceName);
    if (!k) return null;
    if (_index.has(k)) return _index.get(k);
    // Looser fallback: the voice name often contains the directory-id
    // stem (e.g., "Donald Trump (RVC)" → "donaldtrumprvc", which still
    // contains "trump"). Match the longest key whose normalized form is
    // a substring of the input so that "trump" beats "tr" etc.
    let best = null;
    let bestLen = 0;
    for (const [nk, style] of _index.entries()) {
        if (nk.length < 4) continue; // avoid spurious short-stem matches
        if (k.includes(nk) && nk.length > bestLen) {
            best = style;
            bestLen = nk.length;
        }
    }
    return best;
}

module.exports = { resolveStyle };
