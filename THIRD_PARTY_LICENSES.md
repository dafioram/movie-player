# Third-party components

The player's own code (everything outside `lib/` except `tools/avcore/avcore.c`) is MIT licensed.
The components below are included in `lib/` unmodified or rebuilt from their published source,
and keep their own licenses. Each folder in `lib/` contains the component's license text.

## Mediabunny 1.65.2 — `lib/mediabunny/`

Reads MP4, MOV, WebM, MKV and MPEG-TS files.
License: Mozilla Public License 2.0 (`lib/mediabunny/LICENSE`).
Source: https://github.com/Vanilagy/mediabunny (npm package `mediabunny`, file `dist/bundles/mediabunny.min.mjs`, unmodified).

## FFmpeg 7.1.2 (subset) — `lib/avcore/avcore.wasm`

Decoders for MPEG-1/2 video, AC-3, E-AC-3, DTS, TrueHD/MLP, MPEG audio layers 1–3, AAC and LPCM,
the bwdif/yadif deinterlacers, libswscale and libswresample, compiled to WebAssembly together with
`tools/avcore/avcore.c`. Built as LGPL only (no `--enable-gpl`, no non-free components).
License: GNU Lesser General Public License v2.1 or later (`lib/avcore/LICENSE`).
Source: https://github.com/FFmpeg/FFmpeg, tag `n7.1.2`, unmodified. The exact build configuration
is in `tools/avcore/build.sh`, and the wrapper source is `tools/avcore/avcore.c`, so the module
can be rebuilt or replaced with a modified version (`sh tools/avcore/build.sh`).
The module also contains wasi-libc (MIT, Apache-2.0 with LLVM exception, and musl's MIT license),
supplied by the zig toolchain.

## JASSUB 2.5.36 — `lib/jassub/`

Renders ASS/SSA subtitles with libass.
License of the JavaScript wrapper: MIT (`lib/jassub/LICENSE`).
The WebAssembly modules (`lib/jassub/wasm/`) contain libass and the libraries it uses (such as
FreeType, HarfBuzz and FriBidi). The package declares their combined license as
`LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0`
(FreeType is used under the FreeType License).
`lib/jassub/default.woff2` is Liberation Sans (SIL Open Font License 1.1).
Source: https://github.com/ThaUnknown/jassub (npm package `jassub`). The wasm files are unmodified;
`jassub.js` and `worker/worker.js` were bundled with esbuild from the package's `dist` files
together with these small dependencies:

- abslink 1.3.1 — Apache License 2.0 — https://github.com/ThaUnknown/abslink
- throughput 1.0.2 — MIT — https://github.com/ThaUnknown/throughput
- lfa-ponyfill 1.1.1 — MIT — https://github.com/ThaUnknown/lfa-ponyfill

The `rvfc-polyfill` package that JASSUB normally imports was left out: Chrome supports
`requestVideoFrameCallback` natively.

To rebuild the bundle:

```sh
npm install jassub@2.5.36 esbuild
echo "" > empty.js
npx esbuild node_modules/jassub/dist/jassub.js --bundle --format=esm --minify --alias:rvfc-polyfill=./empty.js --outfile=lib/jassub/jassub.js
npx esbuild node_modules/jassub/dist/worker/worker.js --bundle --format=esm --minify --outfile=lib/jassub/worker/worker.js
cp node_modules/jassub/dist/wasm/*.js node_modules/jassub/dist/wasm/*.wasm lib/jassub/wasm/
cp node_modules/jassub/dist/default.woff2 lib/jassub/
```
