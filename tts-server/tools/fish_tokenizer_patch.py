#!/usr/bin/env python3
"""Surgical patch: add a tiktoken-backed shim above FishTokenizer and swap
the one AutoTokenizer call for a fallback. Idempotent."""
import sys
from pathlib import Path

target = Path("/opt/fish-speech/fish_speech/tokenizer.py")
src = target.read_text()
MARKER = "# === FISH_PATCH_TIKTOKEN_FALLBACK ==="
if MARKER in src:
    print("already patched"); sys.exit(0)

SHIM = '''

# === FISH_PATCH_TIKTOKEN_FALLBACK ===
# Lets FishTokenizer load openaudio-s1-mini (and any other future fishaudio
# model that ships tokenizer.tiktoken + special_tokens.json but no HF
# tokenizer.json). AutoTokenizer can't read the dual_ar config, so we fall
# back to a tiktoken.Encoding wrapped in a class exposing just enough of
# AutoTokenizer's interface for fish-speech's encode/decode code to work.
class _FishTiktokenShim:
    def __init__(self, model_dir):
        import base64 as _b64
        import json as _json
        import tiktoken as _tt
        from pathlib import Path as _P
        p = _P(model_dir)
        tk_file = (p / "tokenizer.tiktoken") if p.is_dir() else p
        sp_file = (p / "special_tokens.json") if p.is_dir() else (p.parent / "special_tokens.json")
        mergeable_ranks = {}
        for line in tk_file.read_text().splitlines():
            if not line.strip(): continue
            tok_b64, rank = line.split()
            mergeable_ranks[_b64.b64decode(tok_b64)] = int(rank)
        self._special = _json.loads(sp_file.read_text()) if sp_file.exists() else {}
        pat_str = r"""(?i:\\'s|\\'t|\\'re|\\'ve|\\'m|\\'ll|\\'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+"""
        self._enc = _tt.Encoding(
            name="fish-openaudio",
            pat_str=pat_str,
            mergeable_ranks=mergeable_ranks,
            special_tokens=self._special,
        )
        self.vocab_size = self._enc.n_vocab
        self.pad_token_id = self._special.get("<|pad|>")
        self.eos_token_id = self._special.get("<|end_of_text|>") or self._special.get("<|endoftext|>")
    def get_vocab(self):
        # Only return the special tokens — fish-speech's semantic-id scan
        # only needs <|semantic:N|> entries from here.
        return dict(self._special)
    def convert_tokens_to_ids(self, token):
        return self._special.get(token)
    def encode(self, text, add_special_tokens=False, allowed_special=None, **kw):
        if allowed_special == "all":
            return self._enc.encode(text, allowed_special="all")
        if allowed_special is None:
            return self._enc.encode(text, disallowed_special=())
        return self._enc.encode(text, allowed_special=allowed_special)
    def decode(self, tokens, **kw):
        if isinstance(tokens, int): tokens = [tokens]
        return self._enc.decode(list(tokens))
    def save_pretrained(self, path):
        raise NotImplementedError("tiktoken-shim tokenizer has no save_pretrained")

def _fish_autotokenizer_or_tiktoken(model_path):
    try:
        return AutoTokenizer.from_pretrained(model_path)
    except Exception as _err:
        from pathlib import Path as _P
        p = _P(model_path)
        tk_file = (p / "tokenizer.tiktoken") if p.is_dir() else p
        if not tk_file.exists():
            raise
        logger.info(f"AutoTokenizer couldn't load {model_path} ({_err}); falling back to tiktoken.")
        return _FishTiktokenShim(model_path)

'''

# Insert the shim just before `class FishTokenizer:`
anchor = "class FishTokenizer:"
i = src.index(anchor)
src = src[:i] + SHIM + src[i:]

# Swap the AutoTokenizer call to use the new helper
src = src.replace(
    "self._tokenizer = AutoTokenizer.from_pretrained(model_path)",
    "self._tokenizer = _fish_autotokenizer_or_tiktoken(model_path)",
    1,
)

target.write_text(src)
print("ok — patched")
