# RE:BORN analysis sidecar

`reborn-sidecar` is the optional Python process that RE:BORN's desktop app runs for deeper audio analysis, sound generation, and stem separation. RE:BORN renders a mix or stems to WAV, sends the sidecar a file path, and gets structured measurements, new sounds, or stems back. The sidecar never edits a RE:BORN project; the studio imports what it returns as new assets.

It ships with a builtin numpy backend that always works. When [Ismail](https://github.com/newsbubbles/ismail) is installed, the sidecar also runs Ismail's analysis, comparison, sound generation (`sound_make`), and Demucs stem separation.

## Requirements

- Python 3.10 or later (developed on 3.11).
- `numpy` for the builtin backend.
- Optional: Ismail, which RE:BORN installs on request from **Browser** > **Generate** (about 650 MB), and its `separate` extra for stem separation (PyTorch and Demucs, about 700 MB more).

## Install

The desktop app creates its own environment on demand (`ensureEnvironment` in `apps/desktop/src/sidecar.ts`). To set one up by hand:

```powershell
cd python/ismail-bridge
py -3 -m venv venv
venv\Scripts\python -m pip install numpy
```

On macOS or Linux, use `python3 -m venv venv` and `venv/bin/python`.

To add Ismail by hand, install the commit RE:BORN pins (`ISMAIL_COMMIT` in `apps/desktop/src/sidecar.ts`):

```powershell
venv\Scripts\python -m pip install "ismail[separate] @ https://github.com/newsbubbles/ismail/archive/<commit>.zip"
```

Drop `[separate]` to skip PyTorch and Demucs. You can also install this package itself with `pip install .`, which adds a `reborn-sidecar` command.

## Run

From `python/ismail-bridge`:

```powershell
python -m reborn_sidecar
```

Then type requests, one JSON object per line:

```json
{"id": "1", "method": "hello"}
{"id": "2", "method": "analyze", "params": {"path": "C:/renders/mix.wav", "sections": [{"id": "drop", "start": 32, "end": 48}]}}
{"id": "3", "method": "compare", "params": {"path": "C:/renders/mix.wav", "reference": "C:/refs/ref.wav"}}
{"id": "4", "method": "generate", "params": {"name": "Stab", "instrument": "acid_bass", "notes": "0 C2 0.5 110", "bpm": 128, "outDir": "C:/renders/out"}}
{"id": "5", "method": "shutdown"}
```

## Protocol

[`PROTOCOL.md`](PROTOCOL.md) defines the wire format, every method and result field, error codes, and the measurement conventions. In short:

- Methods: `hello`, `analyze`, `compare`, `presets`, `generate`, `separate`, `cancel`, `shutdown`.
- Jobs stream `progress` notifications and stop at the next chunk after `cancel`.
- Errors: `invalid_params`, `not_found`, `unsupported_format`, `cancelled`, `backend_error`, `unavailable`, `internal`. Bad input and backend exceptions never stop the process.

## Backends

`REBORN_SIDECAR_BACKEND` picks the backend:

- `auto` (default): Ismail when `import ismail` succeeds, otherwise builtin.
- `builtin`: always the numpy backend.
- `ismail`: the Ismail adapter. If the module cannot be imported, the sidecar uses builtin and explains why in `hello.fallbackReason`.

## Plug in an Ismail module

The adapter in `reborn_sidecar/backends/ismail_adapter.py` looks for these optional attributes on the `ismail` module:

```python
__version__: str
CAPABILITIES: list[str]

def analyze(path: str, *, sections=None, bands=True, progress=None, should_cancel=None) -> dict: ...
def compare(path: str, reference: str, *, progress=None, should_cancel=None) -> dict: ...
```

- Every attribute is optional. A missing function means the builtin result is returned on its own.
- The adapter passes only the keyword arguments a function declares, or all of them when it takes `**kwargs`.
- `progress(completed, total, message)` forwards to protocol progress notifications.
- `should_cancel()` returns `True` after the client cancels. Check it between chunks of work.
- The return value must be a JSON-serializable `dict`. It appears unchanged under the `ismail` key of the result, next to the builtin metrics, so RE:BORN can always rely on the documented schema.
- An exception raised by Ismail becomes a `backend_error` response. The sidecar keeps running.
- Anything Ismail prints to stdout is redirected to stderr.

To try a module under another name, set `REBORN_SIDECAR_ISMAIL_MODULE`, and add its folder to `PYTHONPATH` if it is not installed.

## Test

From the repository root:

```powershell
python -m unittest discover -s python/ismail-bridge/tests -v
```

The tests generate WAV files in a temporary directory and spawn `python -m reborn_sidecar` for the protocol round trip.

## Layout

| Path | Contents |
| --- | --- |
| `reborn_sidecar/__main__.py` | Entry point; stdio setup and backend selection. |
| `reborn_sidecar/server.py` | JSON-lines protocol, job threads, and cancellation. |
| `reborn_sidecar/wavio.py` | Chunked WAV reader (`wave` for PCM, a RIFF parser for float and extensible files). |
| `reborn_sidecar/dsp.py` | K-weighting and true-peak filters. |
| `reborn_sidecar/backends/builtin.py` | numpy metrics and comparison findings. |
| `reborn_sidecar/backends/ismail_adapter.py` | Optional Ismail adapter. |
