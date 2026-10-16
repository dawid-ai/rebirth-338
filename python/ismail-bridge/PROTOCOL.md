# Sidecar protocol (version 1)

The sidecar speaks JSON lines over stdio. You start it with `python -m reborn_sidecar`, write requests to its stdin, and read messages from its stdout. Every message is one UTF-8 JSON object followed by `\n`. Logs go to stderr only; nothing else is ever written to stdout.

The sidecar only reads the files you name. It never writes to or edits RE:BORN projects.

## Messages

### Request

```json
{"id": "r1", "method": "analyze", "params": {"path": "C:/renders/mix.wav"}}
```

- `id`: non-empty string chosen by the client. It must be unique among requests that are still running.
- `method`: one of the methods in [Methods](#methods).
- `params`: object. You can omit it or send `null` for methods without parameters.

### Response

Exactly one response per request, either a result or an error:

```json
{"id": "r1", "result": {}}
{"id": "r1", "error": {"code": "not_found", "message": "File not found: C:/renders/mix.wav"}}
```

### Progress notification

Long methods (`analyze`, `compare`) send zero or more notifications before their response:

```json
{"id": "r1", "progress": {"completed": 12, "total": 60, "message": "Analyzing mix.wav"}}
```

`completed` and `total` count work units (1-second chunks for the builtin backend). Notifications are rate limited to about one every 50 ms, and the last chunk is always reported. When the Ismail backend runs, a second phase starts again at `0` with messages prefixed `Ismail:`.

### Malformed input

If a line is not valid UTF-8 JSON, is not an object, or has no string `id`, the sidecar answers with `"id": null`:

```json
{"id": null, "error": {"code": "invalid_params", "message": "Malformed request line: ..."}}
```

The sidecar keeps running after any bad input.

## Error codes

| Code | Meaning |
| --- | --- |
| `invalid_params` | Malformed line, unknown method, missing or wrong-typed parameter, or duplicate running `id`. |
| `not_found` | A `path` or `reference` file does not exist. |
| `unsupported_format` | The file is not a supported WAV encoding. |
| `cancelled` | The job stopped after a `cancel` request. |
| `backend_error` | The analysis backend raised an exception or returned a non-JSON result. The process stays up. |
| `internal` | A bug in the protocol layer. The process stays up. |

## Methods

### `hello`

Handshake and health check. It is answered on the main thread, so it stays responsive while jobs run. Use it as a ping.

Result:

```json
{
  "protocol": 1,
  "backend": "builtin",
  "version": "0.1.0",
  "backendVersion": "0.1.0",
  "capabilities": ["analyze", "compare", "cancel", "progress", "sections", "bands", "lufs", "truePeak", "stereo"],
  "pid": 1234,
  "python": "3.11.9",
  "numpy": "1.26.4"
}
```

- `backend` is `builtin` or `ismail`.
- The Ismail backend adds `ismail` and `ismail:<name>` capabilities.
- `fallbackReason` is present when `REBORN_SIDECAR_BACKEND=ismail` was requested but the module could not be imported.

### `analyze`

Params:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `path` | string | required | WAV file to measure. |
| `sections` | `[{id, start, end}]` | `[]` | Ranges in seconds, `0 <= start < end`. |
| `bands` | boolean | `true` | `false` omits `bands` from every metrics object. |

Result:

```json
{
  "path": "C:/renders/mix.wav",
  "backend": "builtin",
  "format": {"sampleRate": 48000, "channels": 2, "frames": 2880000, "durationSeconds": 60.0, "sampleFormat": "pcm24"},
  "metrics": { "...": "Metrics, see below" },
  "sections": [
    {"id": "drop", "start": 32.0, "end": 48.0, "analyzedStart": 32.0, "analyzedEnd": 48.0, "metrics": {}}
  ]
}
```

With the Ismail backend, `backend` is `ismail` and the Ismail output is attached unchanged as `ismail`.

#### Metrics

| Field | Unit | Definition |
| --- | --- | --- |
| `peakDbfs` | dBFS | Largest absolute sample over all channels. |
| `rmsDbfs` | dBFS | `20 * log10(rms)` over all samples of all channels. A full-scale sine reads -3.01 dBFS (no +3 dB AES17 offset). |
| `crestDb` | dB | `peakDbfs - rmsDbfs`. |
| `integratedLufs` | LUFS | BS.1770-4 integrated loudness: K-weighting, 400 ms blocks with 75% overlap, -70 LUFS absolute gate, -10 LU relative gate. |
| `truePeakDbtp` | dBTP | Largest of the sample peak and a 4x oversampled estimate (48-tap polyphase interpolator). |
| `spectralCentroidHz` | Hz | Power-weighted mean frequency from 20 Hz to 20 kHz. |
| `bands` | object | `{sub, bass, lowMid, mid, harsh, air}`, each `{db, share}`. |
| `stereoCorrelation` | -1..1 | Pearson correlation of channels 1 and 2. `null` for mono. |
| `dcOffset` | linear | Mean sample value of the channel with the largest offset. |
| `channels` | array | Per channel: `peakDbfs`, `rmsDbfs`, `truePeakDbtp`, `dcOffset`. |

Values that are undefined, such as the level of digital silence or the loudness of a file shorter than 400 ms, are `null`.

Band ranges: `sub` 20-60 Hz, `bass` 60-250 Hz, `lowMid` 250-500 Hz, `mid` 500 Hz-2 kHz, `harsh` 2-6 kHz, `air` 6-20 kHz. Lower bounds are inclusive and upper bounds exclusive. `db` is the band's mean-square level in the same convention as `rmsDbfs`, averaged over channels, so a pure tone's band `db` matches its `rmsDbfs`. `share` is the band's fraction of the energy in all six bands. Bands come from 100 ms Hann-windowed FFT frames (10 Hz resolution).

Loudness channel convention: mono files count as one channel with no dual-mono compensation, so a -20 dBFS (peak) 1 kHz mono sine reads -23 LUFS, and the same sine on both channels of a stereo file reads -20 LUFS. Five- and six-channel files use the BS.1770 weights for `L R C Ls Rs` and `L R C LFE Ls Rs` (surrounds 1.41, LFE excluded).

Sections snap to a 100 ms grid. `analyzedStart` and `analyzedEnd` report the measured range. A section past the end of the file returns all-`null` metrics.

### `compare`

Params: `{path: string, reference: string}`. Both files are measured with the builtin metrics.

Result:

```json
{
  "path": "mix.wav",
  "reference": "ref.wav",
  "backend": "builtin",
  "mix": {"format": {}, "metrics": {}},
  "referenceAnalysis": {"format": {}, "metrics": {}},
  "differences": {
    "integratedLufs": {"mix": -9.1, "reference": -8.0, "difference": -1.1},
    "rmsDbfs": {}, "peakDbfs": {}, "truePeakDbtp": {}, "crestDb": {}, "spectralCentroidHz": {}, "stereoCorrelation": {},
    "bands": {
      "lowMid": {"rangeHz": [250, 500], "mixDb": -18.2, "referenceDb": -21.0, "difference": 2.8, "balanceDifference": 3.1}
    }
  },
  "findings": [
    {"kind": "band", "metric": "lowMid", "difference": 3.1, "message": "Your mix has 3.1 dB more low-mid energy than the reference."}
  ]
}
```

- `difference` is always `mix - reference`.
- Band `difference` compares absolute levels. `balanceDifference` is loudness matched: it compares each band's share of its own file's energy, so a louder mix does not show "more" in every band. Band findings use `balanceDifference`.
- `findings` are sorted by absolute `difference`, largest first.

| `kind` | Reported when |
| --- | --- |
| `loudness` | Integrated loudness differs by 1 LU or more. |
| `band` | A band's balance differs by 1.5 dB or more and the band holds at least 1% of the energy in either file. |
| `crest` | Crest factor differs by 2 dB or more. |
| `stereo` | Stereo correlation differs by 0.2 or more. |
| `truePeak` | The mix's true peak is above -1 dBTP. |
| `dcOffset` | The mix's DC offset is 0.1% of full scale or more. |

### `cancel`

Params: `{target: string}`, the `id` of a running `analyze` or `compare`.

Result: `{"target": "r1", "cancelled": true}`. `cancelled` is `false` when no job with that id is running, for example because it already finished.

Cancellation is cooperative. The job checks between chunks and then answers its own request with a `cancelled` error. A job that already produced its result still sends that result.

### `shutdown`

Result: `{"ok": true}`. The sidecar then cancels running jobs, waits up to 5 seconds for them to stop, and exits with code 0. Closing stdin has the same effect without a response.

## Supported audio

RIFF/WAVE files with integer PCM at 8, 16, 24, or 32 bits, or IEEE float at 32 or 64 bits, including `WAVE_FORMAT_EXTENSIBLE` headers. Any other encoding, RF64, or non-WAV file returns `unsupported_format`. A `data` chunk that claims more bytes than the file holds is clamped to the bytes present.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `REBORN_SIDECAR_BACKEND` | `auto` | `builtin`, `ismail`, or `auto`. |
| `REBORN_SIDECAR_ISMAIL_MODULE` | `ismail` | Module name the Ismail adapter imports. |
| `REBORN_SIDECAR_LOG_LEVEL` | `INFO` | Python logging level for stderr. |
| `REBORN_SIDECAR_THROTTLE_MS` | `0` | Delay per chunk. For tests only. |

## Concurrency

The main thread reads stdin and answers `hello`, `cancel`, and `shutdown` directly. Each `analyze` or `compare` runs on its own worker thread; at most two run at once, and the rest wait for a slot (and can be cancelled while waiting). Responses can arrive in any order, so match them by `id`.
