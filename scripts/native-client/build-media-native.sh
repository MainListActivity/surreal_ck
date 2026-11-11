#!/usr/bin/env bash
# 由 build-media-runtime.py 调用。仅运行已核验官方源码，不安装工具链。
set -euo pipefail
set -x
: "${MEDIA_SOURCE_ROOT:?}" "${MEDIA_PREFIX:?}" "${MEDIA_TARGET:?}" "${MEDIA_JOBS:=2}"
export PKG_CONFIG_LIBDIR="$MEDIA_PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
export CFLAGS='-O2'
export CXXFLAGS='-O2'
unset LDFLAGS LD_LIBRARY_PATH DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH
if [[ "$MEDIA_TARGET" == macos ]]; then
  export CC=clang CXX=clang++
  export MACOSX_DEPLOYMENT_TARGET=11.0
  platform_args=(--enable-avfoundation --enable-indev=avfoundation)
else
  export CC=gcc CXX=g++ LC_ALL=C
  # 不依赖 MinGW runner 私有 DLL；最终 imports 审计仍必须通过。
  export LDFLAGS='-static -static-libgcc -static-libstdc++'
  platform_args=(--target-os=mingw32 --enable-indev=dshow,gdigrab)
fi
for tool in "$CC" "$CXX" make pkg-config; do command -v "$tool"; "$tool" --version; done
(
  cd "$MEDIA_SOURCE_ROOT/libvpx-1.17.0"
  ./configure --prefix="$MEDIA_PREFIX" --target=generic-gnu --disable-shared --enable-static \
    --disable-examples --disable-tools --disable-docs --disable-unit-tests --disable-vp9 --enable-pic
  make -j "$MEDIA_JOBS"
  make install
)
(
  cd "$MEDIA_SOURCE_ROOT/opus-1.6.1"
  ./configure --prefix="$MEDIA_PREFIX" --disable-shared --enable-static --with-pic \
    --disable-doc --disable-extra-programs --disable-deep-plc --disable-dred --disable-osce
  make -j "$MEDIA_JOBS"
  make install
)
(
  cd "$MEDIA_SOURCE_ROOT/SDL2-2.32.10"
  ./configure --prefix="$MEDIA_PREFIX" --disable-shared --enable-static \
    --disable-video-x11 --disable-video-wayland --disable-alsa --disable-pulseaudio \
    --disable-pipewire --disable-jack --disable-esd --disable-sndio --disable-oss \
    --disable-libsamplerate --disable-hidapi --disable-joystick --disable-haptic --disable-sensor
  make -j "$MEDIA_JOBS"
  make install
)
(
  cd "$MEDIA_SOURCE_ROOT/FFmpeg-n9.0.2"
  ./configure --prefix="$MEDIA_PREFIX" --cc="$CC" --cxx="$CXX" \
    --disable-autodetect --disable-gpl --disable-nonfree --disable-version3 \
    --disable-shared --enable-static --pkg-config-flags=--static \
    --disable-network --disable-doc --disable-debug --disable-x86asm --disable-everything \
    --disable-ffprobe --enable-ffmpeg --enable-ffplay --enable-sdl2 --enable-libvpx --enable-libopus \
    --enable-encoder=libvpx_vp8,libopus,rawvideo,pcm_s16le \
    --enable-decoder=wrapped_avframe,vp8,opus,rawvideo,mjpeg,bmp,dvvideo,pcm_u8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be \
    --enable-parser=vp8,opus,mjpeg --enable-demuxer=ivf,ogg \
    --enable-muxer=ivf,ogg,rawvideo,pcm_s16le,null --enable-protocol=file,pipe \
    --enable-filter=scale,format,aresample,aformat,testsrc2,sine --enable-indev=lavfi \
    "${platform_args[@]}"
  if [[ "$MEDIA_TARGET" == windows ]]; then
    # FFmpeg's per-tool LDFLAGS append to its normal security/link flags.
    # Separate maps bind extracted archive members to each final link, before strip.
    make -j "$MEDIA_JOBS" V=1 \
      'LDFLAGS-ffmpeg=-Wl,-Map,ffmpeg-link.map' \
      'LDFLAGS-ffplay=-Wl,-Map,ffplay-link.map'
  else
    make -j "$MEDIA_JOBS"
  fi
  make install
)
