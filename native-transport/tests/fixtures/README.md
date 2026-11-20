# 测试素材来源

2026-11-10 使用环境已有 FFmpeg 本地生成，无用户媒体、无外部下载。

```
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=10 -t 0.3 -c:v libvpx -deadline realtime -g 1 -an test.vp8.ivf
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000 -t 0.1 -c:a libopus -frame_duration 20 -ac 2 test.opus.ogg
```

`test.opus.packet` 是按 Ogg lacing 取出的第三个完整 packet（跳过 OpusHead 和 OpusTags），真实 Opus 编码音频包。仅用于可重复协议测试。解码命令：`ffmpeg -i test.vp8.ivf -f framemd5 -`，`ffmpeg -i test.opus.ogg -f s16le -`。
