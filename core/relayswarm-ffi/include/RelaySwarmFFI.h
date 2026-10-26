#ifndef RELAYSWARM_FFI_H
#define RELAYSWARM_FFI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint8_t *ptr;
    size_t len;
} RsBuffer;

typedef struct {
    const RsBuffer *ptr;
    size_t len;
} RsBufferList;

typedef struct {
    double first_byte_ms;
    double rate;
    bool first_byte_present;
    bool rate_present;
} RsTiming;

typedef struct {
    uint64_t peer;
    RsTiming timing;
} RsPeerTiming;

#define RELAYSWARM_ABI_VERSION 2

/* Generic inputs and outputs contain UTF-8 JSON; fast-path outputs contain
 * little-endian records. The caller owns every returned/error buffer and
 * frees it exactly once. Input buffers and lists are borrowed for the call. */
uint32_t relayswarm_abi_version(void);
void relayswarm_buffer_free(RsBuffer buffer);
void relayswarm_object_free(void *handle);

int32_t relayswarm_call(const uint8_t *name, size_t name_len, const uint8_t *args, size_t args_len, RsBuffer *out, RsBuffer *error);
int32_t relayswarm_new(const uint8_t *name, size_t name_len, const uint8_t *args, size_t args_len, void **out, RsBuffer *error);
int32_t relayswarm_method(const void *handle, const uint8_t *name, size_t name_len, const uint8_t *args, size_t args_len, RsBuffer *out, RsBuffer *error);
int32_t relayswarm_transfer_start(const void *handle, uint64_t now, const RsPeerTiming *peers, size_t peers_len, RsTiming origin, RsTiming shared, RsBuffer *out, RsBuffer *error);
int32_t relayswarm_peer_link_handle_text(const void *handle, uint64_t now, const uint8_t *text, size_t text_len, RsBuffer *out, RsBuffer *error);
int32_t relayswarm_peer_link_serve_response(const void *handle, uint64_t now, const uint8_t *bytes, size_t bytes_len, bool present, RsBuffer *out, RsBuffer *error);
int32_t relayswarm_peer_link_send_have(const void *handle, RsBufferList keys, RsBuffer *out, RsBuffer *error);
int32_t relayswarm_peer_selection_order(const void *handle, uint64_t *out, RsBuffer *error);

#ifdef __cplusplus
}
#endif
#endif
