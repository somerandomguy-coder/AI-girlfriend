"""Mai's Python sidecar: needle tool-call repair + Vietnamese/English phonemizer.

POST /complete  {"tools": [json-schema tools], "text": "..."} -> needle's response dict
POST /phonemize {"text": "..."}                               -> {"phonemes": "..."}
GET  /health                                                  -> {"ok": true, "needle": bool, "g2p": bool}

Needle is a tiny grammar-constrained tool-calling model: its output always parses and matches the
schema. Mai's main LLM is smarter but sometimes writes broken tool-call JSON; this turns intent
text into a valid call. Agents are cached per toolset.

VieNeu-TTS (served by audio.cpp) reads SEA-G2P phonemes, not raw text. The prebuilt sea-g2p wheel
does the normalisation (numbers, dates, units) and English code-switching here, so audio.cpp needs
no extra native library.
"""
import hashlib
import json
import os
import re
import sys

os.environ.setdefault("NEEDLE_TELEMETRY", "0")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

try:
    import needle
except ImportError:  # phonemizer-only install
    needle = None

try:
    from sea_g2p import SEAPipeline
except ImportError:  # needle-only install
    SEAPipeline = None

_agents: dict = {}
_lock = Lock()
_g2p = None
_g2p_lock = Lock()


def agent_for(tools: list):
    key = hashlib.sha1(json.dumps(tools, sort_keys=True).encode()).hexdigest()
    with _lock:
        if key not in _agents:
            _agents.clear()  # one toolset at a time keeps memory flat
            _agents[key] = needle.Needle(tools=tools)
        return _agents[key]


# VieNeu's non-verbal cues. The Rust front end in audio.cpp doesn't know them, so they are turned into
# the model's <|emotion_k|> tokens here, between phonemized segments (same mapping as vieneu's
# phonemize_text_with_emotions).
_CUES = {
    "cười": 1, "laugh": 1, "chuckle": 1, "haha": 1,
    "thở dài": 2, "sigh": 2,
    "hắng giọng": 3, "ahem": 3, "clear throat": 3,
}
_CUE_RE = re.compile(r"\[(" + "|".join(sorted(map(re.escape, _CUES), key=len, reverse=True)) + r")\]", re.IGNORECASE)


def phonemize(text: str) -> str:
    global _g2p
    with _g2p_lock:
        if _g2p is None:
            _g2p = SEAPipeline("vi")
        out = []
        pos = 0
        for m in _CUE_RE.finditer(text):
            seg = text[pos:m.start()].strip()
            if seg:
                out.append(_g2p.run(seg, punc_norm=True))
            out.append(f"<|emotion_{_CUES[m.group(1).lower()]}|>")
            pos = m.end()
        tail = text[pos:].strip()
        if tail:
            out.append(_g2p.run(tail, punc_norm=True))
        return " ".join(out)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "needle": needle is not None, "g2p": SEAPipeline is not None})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))).decode("utf-8"))
            if self.path == "/complete":
                if needle is None:
                    return self._send(503, {"error": "cactus-needle not installed"})
                ag = agent_for(req["tools"])
                with _lock:
                    ag.reset()
                    out = ag.complete(req["text"])
                return self._send(200, out)
            if self.path == "/phonemize":
                if SEAPipeline is None:
                    return self._send(503, {"error": "sea-g2p not installed"})
                return self._send(200, {"phonemes": phonemize(req["text"])})
            self._send(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001 - report everything to the caller
            self._send(500, {"error": str(e)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"mai sidecar on 127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
