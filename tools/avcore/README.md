# avcore: the WebAssembly decoding core

`lib/avcore/avcore.wasm` decodes the formats Chrome can't play by itself. It is a minimal LGPL build
of FFmpeg 7.1.2 plus `avcore.c`, a small C API used by `js/codec/avcore.js`.

| Part | Contents |
| --- | --- |
| Video decoders | mpeg1video, mpeg2video |
| Audio decoders | ac3, eac3, dca (DTS), truehd, mlp, mp1, mp2, mp3, aac, pcm_dvd, pcm_bluray |
| Parsers | mpegvideo, ac3, dca, mlp, mpegaudio, aac |
| Filters | bwdif, yadif, format, scale, aresample |

Video comes out deinterlaced as I420; audio comes out as planar float in FLAC channel order
(at most 8 channels).

## Building

Requirements: git, make, Python 3 and the `ziglang` package. Zig's C compiler targets
`wasm32-wasi` directly, so Emscripten is not needed.

```sh
pip install ziglang==0.13.0
sh tools/avcore/build.sh
```

The script clones FFmpeg (tag `n7.1.2`) into `tools/avcore/.build`, configures it with only the
components above (`--disable-everything`, no GPL or non-free parts), builds the static libraries and
links `lib/avcore/avcore.wasm`. A build takes a few minutes.

## License

`avcore.c` and the resulting `avcore.wasm` are licensed under the GNU Lesser General Public License
v2.1 or later, like the FFmpeg libraries they link (`lib/avcore/LICENSE`). Anyone may rebuild the
module from these sources, change it, and drop the result into `lib/avcore/`.
