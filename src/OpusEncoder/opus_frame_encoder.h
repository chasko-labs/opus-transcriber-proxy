#ifndef OPUS_FRAME_ENCODER_H
#define OPUS_FRAME_ENCODER_H

#include <emscripten.h>

typedef struct opus_encoder_context opus_encoder_context;

EMSCRIPTEN_KEEPALIVE
opus_encoder_context* opus_frame_encoder_create(int sample_rate, int channels, int application);

EMSCRIPTEN_KEEPALIVE
int opus_frame_encoder_get_frame_size(opus_encoder_context *ctx);

EMSCRIPTEN_KEEPALIVE
int opus_frame_encode(
    opus_encoder_context *ctx,
    const unsigned char *pcm_data,
    int pcm_length,
    unsigned char *output_buffer,
    int output_buffer_size
);

EMSCRIPTEN_KEEPALIVE
void opus_frame_encoder_destroy(opus_encoder_context *ctx);

EMSCRIPTEN_KEEPALIVE
int opus_frame_encoder_set_bitrate(opus_encoder_context *ctx, int bitrate);

EMSCRIPTEN_KEEPALIVE
int opus_frame_encoder_set_complexity(opus_encoder_context *ctx, int complexity);

EMSCRIPTEN_KEEPALIVE
int opus_frame_encoder_set_dtx(opus_encoder_context *ctx, int enable);

// Whether the most recently encoded frame was a DTX frame (OPUS_GET_IN_DTX). Only meaningful when
// DTX has been enabled via opus_frame_encoder_set_dtx.
EMSCRIPTEN_KEEPALIVE
int opus_frame_encoder_get_last_in_dtx(opus_encoder_context *ctx);

#endif // OPUS_FRAME_ENCODER_H
