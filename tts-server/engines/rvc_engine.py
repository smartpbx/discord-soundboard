"""RVC v2 voice conversion engine — fairseq-free implementation.

Converts base TTS audio to a target voice using:
- HuBERT/ContentVec features via transformers (replaces fairseq)
- F0 pitch extraction via torchcrepe
- RVC synthesis via direct torch model loading
- FAISS index retrieval for timbre control
- Consonant/breath protection
- Per-voice pitch transpose and base voice selection
"""

import io
import os
import json
import logging
from typing import Optional

import numpy as np
import torch
import soundfile as sf
from scipy.signal import medfilt
from torch.nn import functional as F

log = logging.getLogger("tts-server")

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "rvc")
MANIFEST_PATH = os.path.join(MODELS_DIR, "manifest.json")

# Singletons (lazy-loaded)
_hubert_model = None
_device = None
_is_half = False
_synthesizers = {}  # cache: model_id -> (net_g, if_f0, target_sr)
_faiss_indexes = {}  # cache: index_path -> (index, big_npy)


def free_caches():
    """Drop all cached RVC models + FAISS indexes + HuBERT from GPU memory.

    Called on training-mode enter — these are the largest 3090 tenants on
    the TTS side (each RVC voice loads ~2–3 GB, indices another ~2 GB per
    voice, HuBERT another ~1 GB). Next synth request lazy-reloads.
    """
    import torch as _torch
    global _hubert_model
    n_synth = len(_synthesizers)
    n_idx = len(_faiss_indexes)
    _synthesizers.clear()
    _faiss_indexes.clear()
    _hubert_model = None
    log.info("RVC: freed %d synthesizers, %d indexes, hubert", n_synth, n_idx)
    try:
        if _torch.cuda.is_available():
            _torch.cuda.empty_cache()
    except Exception as e:
        log.warning("RVC: empty_cache failed: %s", e)


# ---------------------------------------------------------------------------
# Manifest / voice listing (unchanged public API)
# ---------------------------------------------------------------------------

def _load_manifest():
    """Load the voice manifest."""
    if not os.path.exists(MANIFEST_PATH):
        return []
    try:
        with open(MANIFEST_PATH) as f:
            return json.load(f)
    except Exception as e:
        log.error("Failed to load RVC manifest: %s", e)
        return []


def get_voices():
    """Return list of available RVC voice dicts for the /voices endpoint."""
    manifest = _load_manifest()
    voices = []
    for entry in manifest:
        pth_path = os.path.join(MODELS_DIR, entry["pth"])
        if not os.path.exists(pth_path):
            continue
        voices.append({
            "id": f"rvc_{entry['id']}",
            "name": entry.get("name", entry["id"]),
            "engine": "rvc",
            "gender": entry.get("gender", "unknown"),
            "language": "en-us",
            "group": entry.get("group", "Celebrity"),
        })
    return voices


def get_rvc_model_ids():
    """Return set of valid RVC model IDs (with rvc_ prefix)."""
    return {v["id"] for v in get_voices()}


def get_base_voice(rvc_model_id: str) -> Optional[str]:
    """Return the preferred Kokoro base voice for an RVC model.

    Male RVC targets should use a male Kokoro voice, female targets a female one.
    The manifest can override this with a 'base_voice' field.
    """
    model_id = rvc_model_id.replace("rvc_", "", 1)
    manifest = _load_manifest()
    entry = next((e for e in manifest if e["id"] == model_id), None)
    if not entry:
        return None

    # Explicit override in manifest
    if entry.get("base_voice"):
        return entry["base_voice"]

    # Auto-select based on gender
    gender = entry.get("gender", "unknown")
    if gender == "female":
        return "af_heart"
    else:
        return "am_adam"  # male default — deeper, neutral voice


# ---------------------------------------------------------------------------
# Device helpers
# ---------------------------------------------------------------------------

def _get_device():
    global _device
    if _device is None:
        _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        log.info("RVC device: %s", _device)
    return _device


# ---------------------------------------------------------------------------
# HuBERT / ContentVec feature extraction
# ---------------------------------------------------------------------------

def _get_hubert():
    """Load ContentVec HuBERT model via transformers (cached singleton)."""
    global _hubert_model
    if _hubert_model is not None:
        return _hubert_model

    from transformers import HubertModel
    import torch.nn as nn

    class HubertModelWithFinalProj(HubertModel):
        def __init__(self, config):
            super().__init__(config)
            self.final_proj = nn.Linear(config.hidden_size, config.classifier_proj_size)

    log.info("Loading ContentVec HuBERT model (first request may download ~1.2GB)...")
    model = HubertModelWithFinalProj.from_pretrained("lengyue233/content-vec-best")
    model = model.to(_get_device())
    model.eval()
    _hubert_model = model
    log.info("ContentVec HuBERT model loaded")
    return _hubert_model


def _extract_hubert_features(audio_16k: np.ndarray) -> torch.Tensor:
    """Extract HuBERT content features from 16kHz mono audio.

    Returns: tensor of shape (1, time_frames, 768)
    """
    device = _get_device()
    hubert = _get_hubert()

    audio_tensor = torch.from_numpy(audio_16k).float().unsqueeze(0).to(device)
    # Normalize
    if audio_tensor.abs().max() > 1.0:
        audio_tensor = audio_tensor / audio_tensor.abs().max()

    with torch.no_grad():
        feats = hubert(audio_tensor)["last_hidden_state"]  # (1, T, 768)

    return feats


# ---------------------------------------------------------------------------
# F0 pitch extraction
# ---------------------------------------------------------------------------

def _extract_f0(audio_16k: np.ndarray, hop_length: int = 160,
                f0_min: float = 50.0, f0_max: float = 1100.0,
                transpose: int = 0, filter_radius: int = 3) -> np.ndarray:
    """Extract F0 using torchcrepe with median filtering and pitch transpose.

    Args:
        transpose: Semitones to shift pitch. -12 = one octave down, +12 = one octave up.
        filter_radius: Median filter size for F0 smoothing. 0 to disable.

    Returns: f0 array of shape (time_frames,)
    """
    import torchcrepe

    device = _get_device()
    audio_tensor = torch.from_numpy(audio_16k).float().unsqueeze(0).to(device)

    with torch.no_grad():
        f0 = torchcrepe.predict(
            audio_tensor,
            sample_rate=16000,
            hop_length=hop_length,
            fmin=f0_min,
            fmax=f0_max,
            model="full",
            batch_size=512,
            device=device,
            pad=True,
        )
    f0 = f0.squeeze(0).cpu().numpy()

    # Replace NaN with 0
    f0 = np.nan_to_num(f0)

    # Median filter to smooth pitch jitter
    if filter_radius >= 3:
        f0 = medfilt(f0, kernel_size=filter_radius)

    # Apply pitch transpose (semitones)
    if transpose != 0:
        f0[f0 > 0] *= pow(2, transpose / 12)

    return f0


def _f0_to_coarse(f0: np.ndarray) -> np.ndarray:
    """Convert continuous F0 to quantized coarse pitch (1-255 range for embedding)."""
    f0_mel_min = 1127 * np.log(1 + 50.0 / 700)
    f0_mel_max = 1127 * np.log(1 + 1100.0 / 700)

    f0_mel = np.zeros_like(f0)
    voiced = f0 > 1.0
    f0_mel[voiced] = 1127 * np.log(1 + f0[voiced] / 700)

    f0_coarse = np.zeros_like(f0, dtype=np.int64)
    f0_coarse[voiced] = np.clip(
        np.round((f0_mel[voiced] - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1),
        1, 255
    ).astype(np.int64)

    return f0_coarse


# ---------------------------------------------------------------------------
# FAISS index retrieval
# ---------------------------------------------------------------------------

def _load_faiss_index(index_path: str):
    """Load FAISS index and bulk-reconstruct all training vectors (cached)."""
    if index_path in _faiss_indexes:
        return _faiss_indexes[index_path]

    import faiss

    index = faiss.read_index(index_path)

    # Try to add DirectMap so we can reconstruct vectors
    try:
        ivf = faiss.extract_index_ivf(index)
        ivf.make_direct_map()
    except Exception:
        pass  # Not an IVF index, try reconstruct anyway

    # Bulk-reconstruct all training vectors
    big_npy = None
    try:
        big_npy = index.reconstruct_n(0, index.ntotal)
        log.info("FAISS index loaded: %s (%d vectors)", index_path, index.ntotal)
    except Exception as e:
        log.warning("FAISS reconstruct_n failed (%s), index retrieval will be limited", e)

    _faiss_indexes[index_path] = (index, big_npy)
    return index, big_npy


def _apply_index(feats: torch.Tensor, index_path: str,
                 index_rate: float = 0.5) -> torch.Tensor:
    """Blend HuBERT features with nearest neighbors from FAISS index.

    Uses the reference RVC pipeline approach: bulk reconstruct all training
    vectors, search for k-nearest neighbors, inverse-distance-squared weighted
    blending.
    """
    if not index_path or not os.path.exists(index_path) or index_rate <= 0:
        return feats

    try:
        index, big_npy = _load_faiss_index(index_path)
        feats_np = feats.squeeze(0).cpu().numpy().astype(np.float32)

        if big_npy is not None:
            # Reference pipeline: search + inverse-distance-squared weighted retrieval
            k = 8
            distances, indices = index.search(feats_np, k=k)

            # Inverse-distance-squared weighting
            weights = np.square(1.0 / (distances + 1e-6))
            weights /= weights.sum(axis=1, keepdims=True)

            # Weighted sum of neighbor vectors from bulk-reconstructed array
            retrieved = np.sum(big_npy[indices] * np.expand_dims(weights, axis=2), axis=1)

            # Blend with original features
            blended = (1 - index_rate) * feats_np + index_rate * retrieved
            log.info("FAISS index applied (rate=%.2f, %d vectors)", index_rate, index.ntotal)
        else:
            # Fallback: no reconstruction available, skip index
            log.warning("FAISS index has no reconstructable vectors, skipping")
            blended = feats_np

        feats = torch.from_numpy(blended).unsqueeze(0).to(feats.device, dtype=feats.dtype)

    except ImportError:
        log.warning("faiss-cpu not installed, skipping index retrieval")
    except Exception as e:
        log.warning("FAISS index retrieval failed (non-fatal): %s", e)

    return feats


# ---------------------------------------------------------------------------
# RVC model loading
# ---------------------------------------------------------------------------

def _load_synthesizer(model_id: str, pth_path: str):
    """Load RVC .pth model, return (net_g, if_f0, target_sr)."""
    if model_id in _synthesizers:
        return _synthesizers[model_id]

    from engines.rvc_models import (
        SynthesizerTrnMs256NSFsid,
        SynthesizerTrnMs768NSFsid,
        SynthesizerTrnMs256NSFsid_nono,
        SynthesizerTrnMs768NSFsid_nono,
        sr2sr,
    )

    device = _get_device()
    log.info("Loading RVC model: %s from %s", model_id, pth_path)

    cpt = torch.load(pth_path, map_location="cpu", weights_only=False)
    config = cpt.get("config")
    if config is None:
        raise ValueError(f"RVC checkpoint missing 'config' key: {pth_path}")

    version = cpt.get("version", "v1")
    if_f0 = cpt.get("f0", 1)

    sr = config[-1] if isinstance(config[-1], (int, str)) else 40000
    if isinstance(sr, str):
        sr = sr2sr.get(sr, 40000)

    if version == "v2" or version == "v2_nof0":
        if if_f0:
            model_cls = SynthesizerTrnMs768NSFsid
        else:
            model_cls = SynthesizerTrnMs768NSFsid_nono
    else:
        if if_f0:
            model_cls = SynthesizerTrnMs256NSFsid
        else:
            model_cls = SynthesizerTrnMs256NSFsid_nono

    net_g = model_cls(*config, is_half=_is_half)
    net_g.load_state_dict(cpt["weight"], strict=False)
    net_g = net_g.to(device)
    net_g.eval()
    net_g.remove_weight_norm()

    result = (net_g, bool(if_f0), sr)
    _synthesizers[model_id] = result
    log.info("RVC model loaded: %s (version=%s, f0=%s, sr=%d)", model_id, version, if_f0, sr)
    return result


# ---------------------------------------------------------------------------
# Main conversion pipeline
# ---------------------------------------------------------------------------

def convert(audio_bytes: bytes, rvc_model_id: str) -> bytes:
    """Convert audio to target voice using RVC. Returns WAV bytes.

    Pipeline:
    1. Read input WAV, resample to 16kHz mono
    2. Extract HuBERT content features
    3. Extract F0 pitch with transpose and median filtering
    4. Upsample features, apply FAISS index retrieval
    5. Apply consonant/breath protection
    6. Run RVC synthesizer
    7. Normalize and return output WAV
    """
    model_id = rvc_model_id.replace("rvc_", "", 1)
    manifest = _load_manifest()
    entry = next((e for e in manifest if e["id"] == model_id), None)
    if not entry:
        raise ValueError(f"RVC model not found: {model_id}")

    pth_path = os.path.join(MODELS_DIR, entry["pth"])
    index_path = os.path.join(MODELS_DIR, entry["index"]) if entry.get("index") else ""

    if not os.path.exists(pth_path):
        raise FileNotFoundError(f"Model file not found: {pth_path}")
    if index_path and not os.path.exists(index_path):
        index_path = ""

    # Per-voice settings from manifest (with defaults)
    transpose = entry.get("transpose", 0)
    index_rate = entry.get("index_rate", 0.5)
    protect = entry.get("protect", 0.33)

    device = _get_device()

    # --- 1. Load and resample audio to 16kHz mono ---
    import torchaudio

    audio_buf = io.BytesIO(audio_bytes)
    audio, orig_sr = sf.read(audio_buf, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)  # mono

    if orig_sr != 16000:
        audio_t = torch.from_numpy(audio).float().unsqueeze(0)
        audio_t = torchaudio.functional.resample(audio_t, orig_sr, 16000)
        audio_16k = audio_t.squeeze(0).numpy()
    else:
        audio_16k = audio

    log.info("Input audio: %.2fs at %dHz -> resampled to 16kHz (%d samples)",
             len(audio) / orig_sr, orig_sr, len(audio_16k))

    # --- 2. Extract HuBERT features ---
    feats = _extract_hubert_features(audio_16k)  # (1, T, 768)

    # --- 3. Load RVC model ---
    net_g, if_f0, target_sr = _load_synthesizer(model_id, pth_path)

    # --- 4. Extract F0 with transpose and filtering ---
    hop_length = 160  # 10ms at 16kHz
    if if_f0:
        f0 = _extract_f0(audio_16k, hop_length=hop_length, transpose=transpose,
                         filter_radius=3)

    # --- 5. Align feature and F0 lengths ---
    if if_f0:
        # Upsample HuBERT features 2x to match F0 resolution
        feats = F.interpolate(feats.transpose(1, 2), scale_factor=2, mode="nearest")
        feats = feats.transpose(1, 2)

        # Align lengths
        p_len = min(feats.shape[1], len(f0))
        feats = feats[:, :p_len, :]
        f0 = f0[:p_len]

        # Save pre-index features for consonant protection
        feats0 = feats.clone()

        # FAISS index blending
        if index_path:
            feats = _apply_index(feats, index_path, index_rate=index_rate)

        # --- Consonant/breath protection ---
        if protect < 0.5:
            pitchf_for_protect = torch.from_numpy(f0).float().unsqueeze(0).to(device)
            # Build per-frame blend mask: voiced frames use converted features,
            # unvoiced frames blend back toward original (protecting consonants)
            protect_mask = torch.ones_like(pitchf_for_protect)
            protect_mask[pitchf_for_protect < 1] = protect
            protect_mask = protect_mask.unsqueeze(-1)  # (1, T, 1) for broadcasting
            feats = feats * protect_mask + feats0 * (1 - protect_mask)

        # Prepare pitch tensors
        f0_coarse = _f0_to_coarse(f0)
        pitch = torch.from_numpy(f0_coarse).long().unsqueeze(0).to(device)
        pitchf = torch.from_numpy(f0).float().unsqueeze(0).to(device)
    else:
        feats = F.interpolate(feats.transpose(1, 2), scale_factor=2, mode="nearest")
        feats = feats.transpose(1, 2)
        p_len = feats.shape[1]

        if index_path:
            feats = _apply_index(feats, index_path, index_rate=index_rate)

    # --- 6. Run RVC synthesis ---
    phone = feats.to(device)
    phone_lengths = torch.tensor([p_len], dtype=torch.long, device=device)
    sid = torch.tensor([0], dtype=torch.long, device=device)

    with torch.no_grad():
        if if_f0:
            audio_out, _, _ = net_g.infer(phone, phone_lengths, pitch, pitchf, sid)
        else:
            audio_out, _, _ = net_g.infer(phone, phone_lengths, sid)

    audio_out = audio_out.squeeze(0).squeeze(0).cpu().numpy()

    # --- 7. Normalize and write output WAV ---
    audio_out = np.clip(audio_out, -1.0, 1.0)
    peak = np.abs(audio_out).max()
    if peak > 0:
        input_peak = np.abs(audio_16k).max()
        if input_peak > 0:
            audio_out = audio_out * (input_peak / peak)
        audio_out = np.clip(audio_out, -1.0, 1.0)

    output_buf = io.BytesIO()
    sf.write(output_buf, audio_out, target_sr, format="WAV")
    output_buf.seek(0)
    return output_buf.read()
