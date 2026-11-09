/*
 * avcore.c - small decoding core for Movie Player, compiled to WebAssembly.
 *
 * Wraps a minimal LGPL build of FFmpeg (libavcodec, libavfilter, libswresample,
 * libswscale, libavutil). It decodes the formats Chrome cannot play by itself:
 *   video: MPEG-1, MPEG-2 (deinterlaced with bwdif, output as yuv420p)
 *   audio: AC-3, E-AC-3, DTS, TrueHD/MLP, MPEG audio layer 1/2/3, AAC, DVD/Blu-ray LPCM
 *          (output as planar float, in FLAC channel order, at most 8 channels)
 *
 * Licensed under the GNU Lesser General Public License v2.1 or later, like the
 * FFmpeg libraries it links. See tools/avcore/README.md for build steps.
 */
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersrc.h>
#include <libavfilter/buffersink.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libavutil/imgutils.h>
#include <libavutil/log.h>
#include <libswresample/swresample.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define QMAX 64
#define TB_US ((AVRational){1, 1000000})

typedef struct Dec {
    AVCodecContext *ctx;
    AVCodecParserContext *parser;
    AVPacket *pkt;
    AVFrame *frame;
    int is_video;
    int use_parser;
    int deint;
    /* queue of finished frames (already filtered / converted) */
    AVFrame *q[QMAX];
    int qhead, qlen;
    /* current output frame */
    AVFrame *cur;
    /* video filter graph */
    AVFilterGraph *graph;
    AVFilterContext *src, *sink;
    int gw, gh, gfmt, gsar_num, gsar_den;
    /* audio */
    SwrContext *swr;
    int swr_in_rate, swr_in_fmt;
    AVChannelLayout swr_in_layout;
    AVChannelLayout out_layout;
    float *abuf;
    int abuf_cap, a_samples, a_channels, a_rate;
    double a_pts;
    char err[256];
} Dec;

static void set_err(Dec *d, const char *what, int code) {
    char buf[128];
    av_strerror(code, buf, sizeof buf);
    snprintf(d->err, sizeof d->err, "%s: %s", what, buf);
}

EXPORT(ac_malloc) void *ac_malloc(int size) { return av_malloc(size > 0 ? size : 1); }
EXPORT(ac_free) void ac_free(void *p) { av_free(p); }

EXPORT(ac_log_quiet) void ac_log_quiet(int quiet) { av_log_set_level(quiet ? AV_LOG_QUIET : AV_LOG_WARNING); }

static void q_push(Dec *d, AVFrame *f) {
    if (d->qlen >= QMAX) { av_frame_free(&f); return; }
    d->q[(d->qhead + d->qlen) % QMAX] = f;
    d->qlen++;
}

static AVFrame *q_pop(Dec *d) {
    if (!d->qlen) return NULL;
    AVFrame *f = d->q[d->qhead];
    d->qhead = (d->qhead + 1) % QMAX;
    d->qlen--;
    return f;
}

EXPORT(ac_open)
Dec *ac_open(const char *codec_name, const uint8_t *extra, int extralen,
             int sample_rate, int channels, int use_parser, int deint) {
    const AVCodec *codec = avcodec_find_decoder_by_name(codec_name);
    if (!codec) return NULL;
    Dec *d = av_mallocz(sizeof(Dec));
    d->ctx = avcodec_alloc_context3(codec);
    d->is_video = codec->type == AVMEDIA_TYPE_VIDEO;
    d->deint = deint;
    d->ctx->pkt_timebase = TB_US;
    if (extra && extralen > 0) {
        d->ctx->extradata = av_mallocz(extralen + AV_INPUT_BUFFER_PADDING_SIZE);
        memcpy(d->ctx->extradata, extra, extralen);
        d->ctx->extradata_size = extralen;
    }
    if (!d->is_video) {
        if (sample_rate > 0) d->ctx->sample_rate = sample_rate;
        if (channels > 0) av_channel_layout_default(&d->ctx->ch_layout, channels);
    } else {
        /* never hand out frames that reference missing pictures (after a seek) */
        d->ctx->flags &= ~AV_CODEC_FLAG_OUTPUT_CORRUPT;
    }
    int r = avcodec_open2(d->ctx, codec, NULL);
    if (r < 0) {
        avcodec_free_context(&d->ctx);
        av_free(d);
        return NULL;
    }
    if (use_parser) {
        d->parser = av_parser_init(codec->id);
        if (d->parser) d->use_parser = 1;
    }
    d->pkt = av_packet_alloc();
    d->frame = av_frame_alloc();
    return d;
}

EXPORT(ac_error) const char *ac_error(Dec *d) { return d->err; }

/* ---------- video ---------- */

static int build_graph(Dec *d, AVFrame *f) {
    avfilter_graph_free(&d->graph);
    d->graph = avfilter_graph_alloc();
    char args[256];
    AVRational sar = f->sample_aspect_ratio;
    if (sar.num <= 0 || sar.den <= 0) sar = (AVRational){1, 1};
    snprintf(args, sizeof args,
             "video_size=%dx%d:pix_fmt=%d:time_base=1/1000000:pixel_aspect=%d/%d:colorspace=%d:range=%d",
             f->width, f->height, f->format, sar.num, sar.den, f->colorspace, f->color_range);
    int r = avfilter_graph_create_filter(&d->src, avfilter_get_by_name("buffer"), "in", args, NULL, d->graph);
    if (r < 0) { set_err(d, "buffer", r); return r; }
    r = avfilter_graph_create_filter(&d->sink, avfilter_get_by_name("buffersink"), "out", NULL, NULL, d->graph);
    if (r < 0) { set_err(d, "buffersink", r); return r; }
    AVFilterInOut *outputs = avfilter_inout_alloc();
    AVFilterInOut *inputs = avfilter_inout_alloc();
    outputs->name = av_strdup("in");
    outputs->filter_ctx = d->src;
    outputs->pad_idx = 0;
    outputs->next = NULL;
    inputs->name = av_strdup("out");
    inputs->filter_ctx = d->sink;
    inputs->pad_idx = 0;
    inputs->next = NULL;
    const char *desc = d->deint ? "bwdif=mode=send_frame:parity=auto:deint=interlaced,format=yuv420p"
                                : "format=yuv420p";
    r = avfilter_graph_parse_ptr(d->graph, desc, &inputs, &outputs, NULL);
    avfilter_inout_free(&inputs);
    avfilter_inout_free(&outputs);
    if (r < 0) { set_err(d, "graph parse", r); return r; }
    r = avfilter_graph_config(d->graph, NULL);
    if (r < 0) { set_err(d, "graph config", r); return r; }
    d->gw = f->width;
    d->gh = f->height;
    d->gfmt = f->format;
    d->gsar_num = sar.num;
    d->gsar_den = sar.den;
    return 0;
}

static void drain_graph(Dec *d) {
    /* deinterlacers halve the time base (to allow field rate output): convert back to microseconds */
    AVRational tb = av_buffersink_get_time_base(d->sink);
    for (;;) {
        AVFrame *o = av_frame_alloc();
        int r = av_buffersink_get_frame(d->sink, o);
        if (r < 0) { av_frame_free(&o); break; }
        if (o->pts != AV_NOPTS_VALUE) o->pts = av_rescale_q(o->pts, tb, TB_US);
        if (o->duration > 0) o->duration = av_rescale_q(o->duration, tb, TB_US);
        q_push(d, o);
    }
}

static int push_video(Dec *d, AVFrame *f) {
    if (f) {
        if (f->pts == AV_NOPTS_VALUE) f->pts = f->best_effort_timestamp;
        AVRational sar = f->sample_aspect_ratio;
        if (sar.num <= 0 || sar.den <= 0) sar = (AVRational){1, 1};
        if (!d->graph || f->width != d->gw || f->height != d->gh || f->format != d->gfmt ||
            sar.num != d->gsar_num || sar.den != d->gsar_den) {
            if (d->graph) {
                (void)av_buffersrc_add_frame_flags(d->src, NULL, 0);
                drain_graph(d);
            }
            int r = build_graph(d, f);
            if (r < 0) return r;
        }
    }
    int r = av_buffersrc_add_frame_flags(d->src, f, AV_BUFFERSRC_FLAG_KEEP_REF);
    if (r < 0 && f) { set_err(d, "filter", r); return r; }
    drain_graph(d);
    return 0;
}

/* ---------- audio ---------- */

static const char *flac_layouts[9] = {NULL, "mono", "stereo", "3.0", "quad", "5.0", "5.1", "6.1", "7.1"};

static int push_audio(Dec *d, AVFrame *f) {
    AVFrame *o = av_frame_clone(f);
    if (o->pts == AV_NOPTS_VALUE) o->pts = f->best_effort_timestamp;
    q_push(d, o);
    return 0;
}

static int convert_audio(Dec *d, AVFrame *f) {
    char desc[64];
    AVChannelLayout in = {0};
    av_channel_layout_copy(&in, &f->ch_layout);
    if (in.order == AV_CHANNEL_ORDER_UNSPEC) av_channel_layout_default(&in, in.nb_channels);
    av_channel_layout_describe(&in, desc, sizeof desc);
    /* treat side surrounds as back surrounds: FLAC's 4/5/6-channel orders name them "back" */
    AVChannelLayout fake = {0};
    if (!strcmp(desc, "5.1(side)")) av_channel_layout_from_string(&fake, "5.1");
    else if (!strcmp(desc, "5.0(side)")) av_channel_layout_from_string(&fake, "5.0");
    else if (!strcmp(desc, "quad(side)")) av_channel_layout_from_string(&fake, "quad");
    else av_channel_layout_copy(&fake, &in);
    av_channel_layout_describe(&fake, desc, sizeof desc);
    int n = fake.nb_channels;
    AVChannelLayout target = {0};
    if (n >= 1 && n <= 8 && !strcmp(desc, flac_layouts[n])) av_channel_layout_copy(&target, &fake);
    else if (n >= 6) av_channel_layout_from_string(&target, "5.1");
    else if (n == 1) av_channel_layout_from_string(&target, "mono");
    else av_channel_layout_from_string(&target, "stereo");

    if (!d->swr || d->swr_in_rate != f->sample_rate || d->swr_in_fmt != f->format ||
        av_channel_layout_compare(&d->swr_in_layout, &fake) ||
        av_channel_layout_compare(&d->out_layout, &target)) {
        swr_free(&d->swr);
        int r = swr_alloc_set_opts2(&d->swr, &target, AV_SAMPLE_FMT_FLTP, f->sample_rate,
                                    &fake, f->format, f->sample_rate, 0, NULL);
        if (r < 0 || swr_init(d->swr) < 0) {
            set_err(d, "resampler", r);
            av_channel_layout_uninit(&in);
            av_channel_layout_uninit(&fake);
            av_channel_layout_uninit(&target);
            return -1;
        }
        d->swr_in_rate = f->sample_rate;
        d->swr_in_fmt = f->format;
        av_channel_layout_uninit(&d->swr_in_layout);
        av_channel_layout_copy(&d->swr_in_layout, &fake);
        av_channel_layout_uninit(&d->out_layout);
        av_channel_layout_copy(&d->out_layout, &target);
    }
    int ch = target.nb_channels;
    int max = swr_get_out_samples(d->swr, f->nb_samples) + 32;
    if (d->abuf_cap < max * ch) {
        av_free(d->abuf);
        d->abuf_cap = max * ch;
        d->abuf = av_malloc(sizeof(float) * d->abuf_cap);
    }
    uint8_t *planes[8];
    for (int c = 0; c < ch; c++) planes[c] = (uint8_t *)(d->abuf + c * max);
    int got = swr_convert(d->swr, planes, max, (const uint8_t **)f->extended_data, f->nb_samples);
    if (got < 0) { set_err(d, "convert", got); got = 0; }
    /* compact the planes so channel c starts at c * got */
    for (int c = 1; c < ch; c++) memmove(d->abuf + c * got, d->abuf + c * max, sizeof(float) * got);
    d->a_samples = got;
    d->a_channels = ch;
    d->a_rate = f->sample_rate;
    d->a_pts = f->pts == AV_NOPTS_VALUE ? NAN : f->pts / 1e6;
    av_channel_layout_uninit(&in);
    av_channel_layout_uninit(&fake);
    av_channel_layout_uninit(&target);
    return 0;
}

/* ---------- decode ---------- */

static int decode_packet(Dec *d, AVPacket *pkt) {
    int r = avcodec_send_packet(d->ctx, pkt);
    if (r < 0 && r != AVERROR(EAGAIN) && r != AVERROR_EOF) {
        set_err(d, "decode", r);
        /* bad packet: keep going, the next one may be fine */
    }
    for (;;) {
        r = avcodec_receive_frame(d->ctx, d->frame);
        if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) break;
        if (r < 0) { set_err(d, "decode", r); break; }
        if (d->is_video) push_video(d, d->frame);
        else push_audio(d, d->frame);
        av_frame_unref(d->frame);
    }
    return 0;
}

/* pts_us < 0 means "no timestamp" (use -1). flags bit0: key frame (no-parser mode). */
EXPORT(ac_send)
int ac_send(Dec *d, const uint8_t *data, int len, double pts_us, int flags) {
    int64_t pts = pts_us < 0 || isnan(pts_us) ? AV_NOPTS_VALUE : (int64_t)pts_us;
    if (d->use_parser) {
        while (len > 0) {
            uint8_t *out = NULL;
            int outlen = 0;
            int used = av_parser_parse2(d->parser, d->ctx, &out, &outlen, data, len, pts, pts, 0);
            if (used < 0) { set_err(d, "parse", used); return used; }
            data += used;
            len -= used;
            pts = AV_NOPTS_VALUE;
            if (outlen) {
                d->pkt->data = out;
                d->pkt->size = outlen;
                d->pkt->pts = d->parser->pts;
                d->pkt->dts = d->parser->dts;
                d->pkt->flags = d->parser->key_frame == 1 ? AV_PKT_FLAG_KEY : 0;
                decode_packet(d, d->pkt);
                d->pkt->data = NULL;
                d->pkt->size = 0;
            }
        }
        return 0;
    }
    AVPacket *p = av_packet_alloc();
    if (av_new_packet(p, len) < 0) { av_packet_free(&p); return -1; }
    memcpy(p->data, data, len);
    p->pts = pts;
    p->dts = AV_NOPTS_VALUE;
    p->flags = (flags & 1) ? AV_PKT_FLAG_KEY : 0;
    decode_packet(d, p);
    av_packet_free(&p);
    return 0;
}

/* End of stream: drain the parser, decoder and filter graph. */
EXPORT(ac_flush_end)
void ac_flush_end(Dec *d) {
    if (d->use_parser) {
        uint8_t *out = NULL;
        int outlen = 0;
        av_parser_parse2(d->parser, d->ctx, &out, &outlen, NULL, 0, AV_NOPTS_VALUE, AV_NOPTS_VALUE, 0);
        if (outlen) {
            d->pkt->data = out;
            d->pkt->size = outlen;
            d->pkt->pts = d->parser->pts;
            decode_packet(d, d->pkt);
            d->pkt->data = NULL;
            d->pkt->size = 0;
        }
    }
    decode_packet(d, NULL);
    if (d->is_video && d->graph) push_video(d, NULL);
}

/* Seek: forget everything buffered. */
EXPORT(ac_reset)
void ac_reset(Dec *d) {
    avcodec_flush_buffers(d->ctx);
    if (d->parser) {
        av_parser_close(d->parser);
        d->parser = av_parser_init(d->ctx->codec_id);
    }
    avfilter_graph_free(&d->graph);
    d->gw = d->gh = 0;
    AVFrame *f;
    while ((f = q_pop(d))) av_frame_free(&f);
    av_frame_free(&d->cur);
}

/* Pops the next finished frame. Returns 1 if a frame is ready, 0 if none. */
EXPORT(ac_receive)
int ac_receive(Dec *d) {
    av_frame_free(&d->cur);
    d->cur = q_pop(d);
    if (!d->cur) return 0;
    if (!d->is_video) {
        if (convert_audio(d, d->cur) < 0) return ac_receive(d);
    }
    return 1;
}

/* video getters */
EXPORT(ac_v_width) int ac_v_width(Dec *d) { return d->cur->width; }
EXPORT(ac_v_height) int ac_v_height(Dec *d) { return d->cur->height; }
EXPORT(ac_v_data) uint8_t *ac_v_data(Dec *d, int plane) { return d->cur->data[plane]; }
EXPORT(ac_v_stride) int ac_v_stride(Dec *d, int plane) { return d->cur->linesize[plane]; }
EXPORT(ac_v_pts) double ac_v_pts(Dec *d) { return d->cur->pts == AV_NOPTS_VALUE ? -1 : (double)d->cur->pts; }
EXPORT(ac_v_duration) double ac_v_duration(Dec *d) { return (double)d->cur->duration; }
EXPORT(ac_v_sar_num) int ac_v_sar_num(Dec *d) { return d->cur->sample_aspect_ratio.num; }
EXPORT(ac_v_sar_den) int ac_v_sar_den(Dec *d) { return d->cur->sample_aspect_ratio.den; }
EXPORT(ac_v_repeat) int ac_v_repeat(Dec *d) { return d->cur->repeat_pict; }
EXPORT(ac_v_key) int ac_v_key(Dec *d) { return (d->cur->flags & AV_FRAME_FLAG_KEY) ? 1 : 0; }

/* decoder-level info */
EXPORT(ac_c_width) int ac_c_width(Dec *d) { return d->ctx->width; }
EXPORT(ac_c_height) int ac_c_height(Dec *d) { return d->ctx->height; }
EXPORT(ac_c_fps_num) int ac_c_fps_num(Dec *d) { return d->ctx->framerate.num; }
EXPORT(ac_c_fps_den) int ac_c_fps_den(Dec *d) { return d->ctx->framerate.den; }
EXPORT(ac_c_profile) int ac_c_profile(Dec *d) { return d->ctx->profile; }
EXPORT(ac_c_interlaced) int ac_c_interlaced(Dec *d) { return d->ctx->field_order > AV_FIELD_PROGRESSIVE; }

/* audio getters */
EXPORT(ac_a_data) float *ac_a_data(Dec *d) { return d->abuf; }
EXPORT(ac_a_samples) int ac_a_samples(Dec *d) { return d->a_samples; }
EXPORT(ac_a_channels) int ac_a_channels(Dec *d) { return d->a_channels; }
EXPORT(ac_a_rate) int ac_a_rate(Dec *d) { return d->a_rate; }
EXPORT(ac_a_pts) double ac_a_pts(Dec *d) { return isnan(d->a_pts) ? -1 : d->a_pts * 1e6; }

EXPORT(ac_close)
void ac_close(Dec *d) {
    if (!d) return;
    ac_reset(d);
    avfilter_graph_free(&d->graph);
    if (d->parser) av_parser_close(d->parser);
    avcodec_free_context(&d->ctx);
    av_packet_free(&d->pkt);
    av_frame_free(&d->frame);
    swr_free(&d->swr);
    av_channel_layout_uninit(&d->swr_in_layout);
    av_channel_layout_uninit(&d->out_layout);
    av_free(d->abuf);
    av_free(d);
}
