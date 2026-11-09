# Movie Player

A private movie player that runs entirely in Chrome. Drop in a movie with its subtitle and audio
files (or a zip of them) and it plays, with switchable audio tracks, subtitles, chapters and a
details panel that explains exactly how the file is being played.

Nothing is uploaded. Files are read from your disk by the browser and never leave your computer.
There is no server, no account and no analytics, and the app works offline once it has loaded.

It is a static site: plain HTML, CSS and JavaScript modules with no build step, made to be hosted
on GitHub Pages.

## Features

- **Opens almost anything you drop on it**: MP4, M4V, MOV, WebM, MKV, VOB, MPG, TS and M2TS, plus
  companion subtitle, audio and font files. Folders and uncompressed zips work too.
- **Plays what Chrome can't**: AC3, E-AC3, DTS, TrueHD, MP2 and DVD LPCM audio are decoded in the
  browser (WebAssembly) and handed to Chrome as lossless FLAC. MPEG-1 and MPEG-2 video (DVD rips,
  TV recordings) is decoded, deinterlaced and re-encoded to H.264 on the fly.
- **Switch audio tracks** inside MKV, MP4 and MPEG files, or add audio from separate files. A track
  that can't be played is greyed out with the reason, and the player falls back to another track.
- **Subtitles**: SRT and WebVTT (with size, colour, background and outline settings), ASS/SSA with
  full styling via libass, PGS (Blu-ray) and VobSub (DVD) bitmaps, embedded or in separate files.
  A second subtitle track can be shown at the top of the picture. Each track has its own delay
  setting. Forced subtitles turn on automatically for the audio language.
- **Text encodings are detected**, so old SRT files in Windows-1252, Windows-1251 or UTF-16 show
  the right characters.
- **Chapters** from MKV and MP4 appear on the seek bar and in a chapter menu.
- **Thumbnail preview** while hovering the seek bar.
- **Details panel** (the *i* button): container, codecs, resolution, HDR, bitrates, every track and
  its status, the playback path (direct play or remux, and why), hardware or software decoding
  (and why), dropped frames and buffer.
- **Picture modes**: fit, fill, stretch, zoom 1.33× and forced 4:3, 16:9 or 2.35:1.
- **Remembers** where you stopped in each movie, and can reopen the last movie with one click
  (if the file is still in the same place), with the same audio and subtitle tracks.
- **Installable**: works offline, and once installed it can be chosen in "Open with" for video files
  and zips.
- Space plays and pauses. Everything else is in the control bar.

## Supported formats

| | Supported | Not supported |
| --- | --- | --- |
| Containers | MP4, M4V, MOV, WebM, MKV, MPEG-PS (.mpg, .vob), MPEG-TS (.ts, .m2ts, .mts), uncompressed zip | AVI, WMV, FLV, ISO images, VIDEO_TS folders and DVD menus |
| Video | H.264, VP8, VP9, AV1, HEVC (where the GPU decodes it), MPEG-1 and MPEG-2 (converted) | VC-1, MPEG-4 Part 2 (DivX/Xvid), HEVC without a hardware decoder |
| Audio | AAC, Opus, MP3, FLAC, Vorbis, PCM; AC3, E-AC3, DTS, TrueHD, MP2, DVD/Blu-ray LPCM (converted) | DTS-HD MA's lossless layer (the DTS core plays), AAC-LATM |
| Subtitles | SRT, WebVTT, ASS/SSA, PGS (.sup), VobSub (.idx + .sub), embedded in MKV and VOB | DVB subtitles, Teletext, MicroDVD .sub, subtitles inside MPEG-TS |

### Naming companion files

Companion files are matched to the movie by name. Words after the movie's name become the track
label:

| File | Shown as |
| --- | --- |
| `Movie.2019.en.srt` | English |
| `Movie.2019.es.forced.srt` | Spanish, forced |
| `Movie.2019.English.SDH.srt` | English, SDH |
| `Movie.2019.fre.commentary.m4a` | French, commentary |
| `Movie.2019.pt-BR.ass` | Portuguese (Brazil) |

When there is only one movie in what you open, every companion file is used whatever its name.
Font files next to an ASS subtitle (or attached inside an MKV) are used to render it.

### Zips

A zip is treated like a folder. Video and audio inside it must be stored **without compression**;
they then play straight from the zip with no unpacking. Subtitles and fonts may be compressed.
Zip64 (files over 4 GB) is supported. Encrypted zips, multi-part zips, RAR and 7z are not.

```sh
zip -0 -r "Movie.zip" "Movie folder"
```

## Requirements

Desktop Chrome 110 or newer, or another Chromium browser (Edge, Brave, Opera, Vivaldi). Other
browsers and mobile devices are not supported.

## Put it on GitHub Pages

1. Create a repository and push these files to it (the repository root is the site root).
2. On GitHub, open **Settings → Pages**, set **Source** to *Deploy from a branch*, choose the
   `main` branch and the `/ (root)` folder, and save.
3. After a minute the player is live at `https://<user>.github.io/<repository>/`.

All paths are relative, so the app works under any sub-path. The `.nojekyll` file tells GitHub
Pages to serve the files as they are.

To run it locally, serve the folder with any static web server, for example
`python3 -m http.server`, and open `http://localhost:8000`. Opening `index.html` straight from
disk does not work, because browsers don't allow modules and workers from `file://` pages.

### Publishing an update

The service worker caches the app so it works offline. When you change any file, also change
`VERSION` at the top of `sw.js`. Visitors then see *Update available — Reload*; the app never
reloads by itself, so a movie is never interrupted.

## My file won't play

The error message says which part failed, and the details panel shows the status of every track.
[HandBrake](https://handbrake.fr/) or [ffmpeg](https://ffmpeg.org/) fix almost everything.

Repackage into MKV without re-encoding (container not supported, codecs fine):

```sh
ffmpeg -i "input.avi" -map 0 -c copy "output.mkv"
```

Convert the video to H.264, keeping all other tracks (VC-1, DivX/Xvid, or HEVC without hardware
support):

```sh
ffmpeg -i "input.mkv" -map 0 -c copy -c:v libx264 -crf 18 -preset medium "output.mkv"
```

Convert the audio to AAC (an audio format that isn't supported):

```sh
ffmpeg -i "input.mkv" -map 0 -c copy -c:a aac -b:a 384k "output.mkv"
```

In HandBrake, pick a preset such as *Fast 1080p30* and add all audio and subtitle tracks on their
tabs.

**Choppy MPEG-2**: MPEG-2 is converted in the browser. Standard-definition DVD video is easy for
any computer; 1080i TV recordings can be too heavy for slower ones. The details panel shows the
conversion speed; below 1.0× the computer can't keep up.

**Software decoding**: the details panel reports what Chrome says about the exact video stream.
Chrome doesn't tell web pages which decoder it actually picked; to see it, paste
`chrome://media-internals` into the address bar while the movie plays. If hardware acceleration is
off, turn on *Settings → System → Use graphics acceleration when available*.

## How it works

1. **Intake** (`js/intake.js`, `js/zip.js`) collects files from the pickers, drag and drop, folders
   and "Open with", and lists zip entries. Stored zip entries are slices of the zip file, so a
   movie inside a zip plays without being copied.
2. **Probe** (`js/movie.js`) reads the container header and index without decoding anything:
   [Mediabunny](https://mediabunny.dev/) for MP4, MOV, WebM, MKV and MPEG-TS, our own reader for
   MKV subtitles, chapters and attachments (`js/demux/mkv.js`) and for MPEG program streams
   (`js/demux/mpeg.js`). It decides how each track will be played.
3. **Direct play** is used when the file is MP4, MOV or WebM with at most one audio track that
   Chrome plays: the file goes straight to Chrome's player.
4. **Remux** (`js/engine/remux.js`) handles everything else. The video and the selected audio track
   are read separately, wrapped into fragmented MP4 (`js/engine/fmp4.js`) and fed to Chrome's
   player through Media Source Extensions, about 30 seconds ahead of the playhead. Chrome still
   decodes the video itself, so hardware decoding and audio/video sync work as usual.
5. **Conversion** runs in workers (`js/codec/`). `lib/avcore/avcore.wasm` is a small LGPL build
   of FFmpeg's decoders compiled to WebAssembly. Decoded audio is re-encoded as FLAC (lossless) by
   `js/codec/flac.js`; decoded MPEG-2 video is deinterlaced (bwdif) and re-encoded as H.264 with
   Chrome's own encoder (WebCodecs), using the GPU when available.
6. **Subtitles** (`js/subs/`) are drawn over the picture: SRT/VTT as text, ASS through libass
   (JASSUB), and PGS/VobSub as bitmaps. Embedded subtitle tracks are read in the background,
   starting near the playhead.

## Project structure

```
index.html              the player
help.html               help and troubleshooting
manifest.webmanifest    installable app, "Open with" file types
sw.js                   service worker: offline cache and update prompt
css/player.css
js/main.js              start-up, service worker, "Open with" launches
js/app.js               app controller: loading, tracks, controls, menus
js/intake.js            pickers, drag and drop, folders, name matching
js/zip.js               zip reader (stored entries as byte ranges, Zip64)
js/names.js             languages, file name tags, formatting
js/movie.js             probing and the track model
js/storage.js           positions, preferences, last movie
js/thumbs.js            seek-bar thumbnails
js/decoder-info.js      hardware/software decode report
js/demux/               MKV metadata and subtitles, MPEG-PS/TS demuxer
js/engine/              remux engine, fragmented MP4 writer, Annex B helpers
js/codec/               codec worker, wasm loader, FLAC encoder
js/subs/                subtitle manager, SRT/VTT/ASS text, PGS, VobSub, encodings, fonts
js/ui/                  menus, details panel, notices, DOM helpers
lib/                    third-party code, copied in (no CDN)
tools/avcore/           source and build script for lib/avcore/avcore.wasm
```

## Rebuilding the codec core

`lib/avcore/avcore.wasm` is prebuilt. To rebuild it from source you need git, make and Python 3
with the `ziglang` package (zig compiles C straight to WebAssembly; Emscripten is not needed):

```sh
pip install ziglang==0.13.0
sh tools/avcore/build.sh
```

The script downloads FFmpeg 7.1.2, configures an LGPL-only build with just the needed decoders,
parsers and filters, and links it with `tools/avcore/avcore.c`. See `tools/avcore/README.md`.

## Privacy

The app stores, in this browser only: playback positions, preferences (volume, preferred
languages, subtitle style), and the location of the last movie (a file handle, not the file).
**More → Clear history** removes positions and the last movie.

## License

The player's own code is released under the [MIT License](LICENSE).
Third-party components in `lib/` keep their own licenses (MPL-2.0, LGPL-2.1-or-later and
permissive licenses); see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
