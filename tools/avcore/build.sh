#!/bin/sh
# Builds lib/avcore/avcore.wasm: a small LGPL FFmpeg subset plus avcore.c.
#
# Requirements: git, make, Python 3 with the "ziglang" package (pip install ziglang==0.13.0).
# No Emscripten needed: zig compiles C to plain wasm32-wasi.
#
# Usage: sh tools/avcore/build.sh
set -eu

FFMPEG_TAG=n7.1.2
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=${WORK:-"$HERE/.build"}
ZIG=$(python3 -c "import ziglang,os;print(os.path.join(os.path.dirname(ziglang.__file__),'zig'))")

mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexec "%s" cc -target wasm32-wasi "$@"\n' "$ZIG" > "$WORK/bin/zcc"
printf '#!/bin/sh\nexec "%s" ar "$@"\n' "$ZIG" > "$WORK/bin/zar"
printf '#!/bin/sh\nexec "%s" ranlib "$@"\n' "$ZIG" > "$WORK/bin/zranlib"
chmod +x "$WORK/bin/"*

if [ ! -d "$WORK/ffmpeg" ]; then
  git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git "$WORK/ffmpeg"
fi

mkdir -p "$WORK/ffbuild"
cd "$WORK/ffbuild"
"$WORK/ffmpeg/configure" \
  --prefix="$WORK/ffinstall" --enable-cross-compile --target-os=none --arch=x86_32 \
  --cc="$WORK/bin/zcc" --ar="$WORK/bin/zar" --ranlib="$WORK/bin/zranlib" \
  --disable-everything --disable-programs --disable-doc --disable-network \
  --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-asm --disable-inline-asm --disable-x86asm --disable-debug \
  --disable-runtime-cpudetect --disable-autodetect \
  --disable-avdevice --disable-avformat --disable-postproc \
  --enable-avcodec --enable-avfilter --enable-swresample --enable-swscale --enable-avutil \
  --enable-decoder=mpeg1video,mpeg2video,ac3,eac3,dca,truehd,mlp,mp1,mp2,mp3,aac,pcm_dvd,pcm_bluray \
  --enable-parser=mpegvideo,ac3,dca,mlp,mpegaudio,aac \
  --enable-filter=bwdif,yadif,buffer,buffersink,format,scale,aresample,abuffer,abuffersink \
  --extra-cflags="-O3 -msimd128 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN" \
  --extra-ldflags="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman"
make -j"$(nproc 2>/dev/null || echo 2)"
make install

mkdir -p "$ROOT/lib/avcore"
"$ZIG" cc -target wasm32-wasi -O3 -msimd128 -mexec-model=reactor \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN \
  -I"$WORK/ffinstall/include" "$HERE/avcore.c" \
  "$WORK/ffinstall/lib/libavfilter.a" "$WORK/ffinstall/lib/libswscale.a" \
  "$WORK/ffinstall/lib/libswresample.a" "$WORK/ffinstall/lib/libavcodec.a" \
  "$WORK/ffinstall/lib/libavutil.a" \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman \
  -Wl,--strip-all \
  -o "$ROOT/lib/avcore/avcore.wasm"

ls -la "$ROOT/lib/avcore/avcore.wasm"
