#include <jni.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "../include/RelaySwarmFFI.h"

#define JNI_NAME(name) Java_uniffi_relayswarm_1ffi_Native_##name

typedef struct {
    jbyteArray array;
    jbyte *elements;
    const uint8_t *ptr;
    size_t len;
} Input;

static int borrow_input(JNIEnv *env, jbyteArray array, Input *input) {
    memset(input, 0, sizeof(*input));
    input->array = array;
    if (array == NULL) {
        jclass cls = (*env)->FindClass(env, "java/lang/IllegalArgumentException");
        if (cls != NULL) {
            (*env)->ThrowNew(env, cls, "byte array must not be null");
            (*env)->DeleteLocalRef(env, cls);
        }
        return 0;
    }
    jsize len = (*env)->GetArrayLength(env, array);
    input->len = (size_t)len;
    if (len == 0) return 1;
    input->elements = (*env)->GetByteArrayElements(env, array, NULL);
    if (input->elements == NULL) return 0;
    input->ptr = (const uint8_t *)input->elements;
    return 1;
}

static void release_input(JNIEnv *env, Input *input) {
    if (input->elements != NULL) {
        (*env)->ReleaseByteArrayElements(env, input->array, input->elements, JNI_ABORT);
    }
}

typedef struct {
    Input *inputs;
    RsBuffer *buffers;
    jsize len;
} BufferInputs;

static int borrow_buffers(JNIEnv *env, jobjectArray arrays, BufferInputs *inputs) {
    memset(inputs, 0, sizeof(*inputs));
    if (arrays == NULL) return 0;
    inputs->len = (*env)->GetArrayLength(env, arrays);
    if (inputs->len == 0) return 1;
    inputs->inputs = calloc((size_t)inputs->len, sizeof(*inputs->inputs));
    inputs->buffers = calloc((size_t)inputs->len, sizeof(*inputs->buffers));
    if (inputs->inputs == NULL || inputs->buffers == NULL) {
        free(inputs->inputs);
        free(inputs->buffers);
        memset(inputs, 0, sizeof(*inputs));
        jclass cls = (*env)->FindClass(env, "java/lang/OutOfMemoryError");
        if (cls != NULL) {
            (*env)->ThrowNew(env, cls, "cannot allocate native inputs");
            (*env)->DeleteLocalRef(env, cls);
        }
        return 0;
    }
    for (jsize i = 0; i < inputs->len; i++) {
        jbyteArray array = (jbyteArray)(*env)->GetObjectArrayElement(env, arrays, i);
        if (array == NULL || !borrow_input(env, array, &inputs->inputs[i])) {
            if (array != NULL) (*env)->DeleteLocalRef(env, array);
            for (jsize j = 0; j < i; j++) {
                release_input(env, &inputs->inputs[j]);
                (*env)->DeleteLocalRef(env, inputs->inputs[j].array);
            }
            free(inputs->inputs);
            free(inputs->buffers);
            memset(inputs, 0, sizeof(*inputs));
            return 0;
        }
        inputs->buffers[i].ptr = (uint8_t *)inputs->inputs[i].ptr;
        inputs->buffers[i].len = inputs->inputs[i].len;
    }
    return 1;
}

static void release_buffers(JNIEnv *env, BufferInputs *inputs) {
    for (jsize i = 0; i < inputs->len; i++) {
        release_input(env, &inputs->inputs[i]);
        (*env)->DeleteLocalRef(env, inputs->inputs[i].array);
    }
    free(inputs->inputs);
    free(inputs->buffers);
}

static void throw_failed(JNIEnv *env, RsBuffer error) {
    char message[64];
    size_t len = error.len < sizeof(message) - 1 ? error.len : sizeof(message) - 1;
    if (len != 0) memcpy(message, error.ptr, len);
    message[len] = '\0';
    relayswarm_buffer_free(error);
    if ((*env)->ExceptionCheck(env)) return;

    const char *class_name = strcmp(message, "invalid_transfer") == 0
        ? "uniffi/relayswarm_ffi/CoreException$InvalidTransfer"
        : "java/lang/IllegalStateException";
    jclass cls = (*env)->FindClass(env, class_name);
    if (cls == NULL) return;
    if (strcmp(message, "invalid_transfer") == 0) {
        jmethodID constructor = (*env)->GetMethodID(env, cls, "<init>", "()V");
        jobject exception = constructor == NULL ? NULL : (*env)->NewObject(env, cls, constructor);
        if (exception != NULL) {
            (*env)->Throw(env, (jthrowable)exception);
            (*env)->DeleteLocalRef(env, exception);
        }
    } else {
        (*env)->ThrowNew(env, cls, message);
    }
    (*env)->DeleteLocalRef(env, cls);
}

static jbyteArray buffer_result(JNIEnv *env, int32_t rc, RsBuffer out, RsBuffer error) {
    if (rc != 0) {
        throw_failed(env, error);
        return NULL;
    }
    if (out.len > INT32_MAX) {
        relayswarm_buffer_free(out);
        jclass cls = (*env)->FindClass(env, "java/lang/OutOfMemoryError");
        if (cls != NULL) {
            (*env)->ThrowNew(env, cls, "native buffer is too large for a Java array");
            (*env)->DeleteLocalRef(env, cls);
        }
        return NULL;
    }
    jbyteArray result = (*env)->NewByteArray(env, (jsize)out.len);
    if (result != NULL && out.len != 0) {
        (*env)->SetByteArrayRegion(env, result, 0, (jsize)out.len, (const jbyte *)out.ptr);
        if ((*env)->ExceptionCheck(env)) {
            (*env)->DeleteLocalRef(env, result);
            result = NULL;
        }
    }
    relayswarm_buffer_free(out);
    return result;
}

JNIEXPORT jint JNICALL JNI_NAME(abiVersion)(JNIEnv *env, jclass cls) {
    (void)env; (void)cls;
    return (jint)relayswarm_abi_version();
}

JNIEXPORT jbyteArray JNICALL JNI_NAME(call)(JNIEnv *env, jclass cls, jbyteArray name, jbyteArray args) {
    (void)cls;
    Input name_input, args_input;
    if (!borrow_input(env, name, &name_input)) return NULL;
    if (!borrow_input(env, args, &args_input)) {
        release_input(env, &name_input);
        return NULL;
    }
    RsBuffer out = {0}, error = {0};
    int32_t rc = relayswarm_call(name_input.ptr, name_input.len, args_input.ptr, args_input.len, &out, &error);
    release_input(env, &args_input);
    release_input(env, &name_input);
    return buffer_result(env, rc, out, error);
}

JNIEXPORT jlong JNICALL JNI_NAME(new)(JNIEnv *env, jclass cls, jbyteArray name, jbyteArray args) {
    (void)cls;
    Input name_input, args_input;
    if (!borrow_input(env, name, &name_input)) return 0;
    if (!borrow_input(env, args, &args_input)) {
        release_input(env, &name_input);
        return 0;
    }
    void *out = NULL;
    RsBuffer error = {0};
    int32_t rc = relayswarm_new(name_input.ptr, name_input.len, args_input.ptr, args_input.len, &out, &error);
    release_input(env, &args_input);
    release_input(env, &name_input);
    if (rc != 0) {
        throw_failed(env, error);
        return 0;
    }
    return (jlong)(intptr_t)out;
}

JNIEXPORT jbyteArray JNICALL JNI_NAME(method)(JNIEnv *env, jclass cls, jlong handle, jbyteArray name, jbyteArray args) {
    (void)cls;
    Input name_input, args_input;
    if (!borrow_input(env, name, &name_input)) return NULL;
    if (!borrow_input(env, args, &args_input)) {
        release_input(env, &name_input);
        return NULL;
    }
    RsBuffer out = {0}, error = {0};
    int32_t rc = relayswarm_method((void *)(intptr_t)handle, name_input.ptr, name_input.len, args_input.ptr, args_input.len, &out, &error);
    release_input(env, &args_input);
    release_input(env, &name_input);
    return buffer_result(env, rc, out, error);
}

JNIEXPORT jbyteArray JNICALL JNI_NAME(transferStart)(JNIEnv *env, jclass cls, jlong handle, jlong now,
        jlongArray peer_ids, jdoubleArray timings, jbooleanArray present, jdoubleArray origin,
        jdoubleArray shared, jbooleanArray origin_present, jbooleanArray shared_present) {
    (void)cls;
    jsize count = (*env)->GetArrayLength(env, peer_ids);
    if ((*env)->GetArrayLength(env, timings) != count * 2 || (*env)->GetArrayLength(env, present) != count * 2 ||
        (*env)->GetArrayLength(env, origin) != 2 || (*env)->GetArrayLength(env, shared) != 2 ||
        (*env)->GetArrayLength(env, origin_present) != 2 || (*env)->GetArrayLength(env, shared_present) != 2) {
        jclass illegal = (*env)->FindClass(env, "java/lang/IllegalArgumentException");
        if (illegal != NULL) {
            (*env)->ThrowNew(env, illegal, "invalid timing arrays");
            (*env)->DeleteLocalRef(env, illegal);
        }
        return NULL;
    }
    RsPeerTiming *peers = count == 0 ? NULL : calloc((size_t)count, sizeof(*peers));
    jlong *ids = NULL;
    jdouble *times = NULL, *origin_values = NULL, *shared_values = NULL;
    jboolean *flags = NULL, *origin_flags = NULL, *shared_flags = NULL;
    RsBuffer out = {0}, error = {0};
    int32_t rc = 1;
    if (count != 0 && peers == NULL) goto done;
    ids = (*env)->GetLongArrayElements(env, peer_ids, NULL);
    times = (*env)->GetDoubleArrayElements(env, timings, NULL);
    flags = (*env)->GetBooleanArrayElements(env, present, NULL);
    origin_values = (*env)->GetDoubleArrayElements(env, origin, NULL);
    shared_values = (*env)->GetDoubleArrayElements(env, shared, NULL);
    origin_flags = (*env)->GetBooleanArrayElements(env, origin_present, NULL);
    shared_flags = (*env)->GetBooleanArrayElements(env, shared_present, NULL);
    if (ids == NULL || times == NULL || flags == NULL || origin_values == NULL || shared_values == NULL ||
        origin_flags == NULL || shared_flags == NULL) goto done;
    for (jsize i = 0; i < count; i++) {
        peers[i].peer = (uint64_t)ids[i];
        peers[i].timing.first_byte_ms = times[i * 2];
        peers[i].timing.rate = times[i * 2 + 1];
        peers[i].timing.first_byte_present = flags[i * 2] != 0;
        peers[i].timing.rate_present = flags[i * 2 + 1] != 0;
    }
    RsTiming origin_timing = {origin_values[0], origin_values[1], origin_flags[0] != 0, origin_flags[1] != 0};
    RsTiming shared_timing = {shared_values[0], shared_values[1], shared_flags[0] != 0, shared_flags[1] != 0};
    rc = relayswarm_transfer_start((void *)(intptr_t)handle, (uint64_t)now, peers, (size_t)count,
        origin_timing, shared_timing, &out, &error);

done:
    if (ids != NULL) (*env)->ReleaseLongArrayElements(env, peer_ids, ids, JNI_ABORT);
    if (times != NULL) (*env)->ReleaseDoubleArrayElements(env, timings, times, JNI_ABORT);
    if (flags != NULL) (*env)->ReleaseBooleanArrayElements(env, present, flags, JNI_ABORT);
    if (origin_values != NULL) (*env)->ReleaseDoubleArrayElements(env, origin, origin_values, JNI_ABORT);
    if (shared_values != NULL) (*env)->ReleaseDoubleArrayElements(env, shared, shared_values, JNI_ABORT);
    if (origin_flags != NULL) (*env)->ReleaseBooleanArrayElements(env, origin_present, origin_flags, JNI_ABORT);
    if (shared_flags != NULL) (*env)->ReleaseBooleanArrayElements(env, shared_present, shared_flags, JNI_ABORT);
    free(peers);
    if ((*env)->ExceptionCheck(env)) return NULL;
    return buffer_result(env, rc, out, error);
}

JNIEXPORT jbyteArray JNICALL JNI_NAME(peerLinkHandleText)(JNIEnv *env, jclass cls, jlong handle, jlong now, jbyteArray text) {
    (void)cls;
    Input input;
    if (!borrow_input(env, text, &input)) return NULL;
    RsBuffer out = {0}, error = {0};
    int32_t rc = relayswarm_peer_link_handle_text((void *)(intptr_t)handle, (uint64_t)now, input.ptr, input.len, &out, &error);
    release_input(env, &input);
    return buffer_result(env, rc, out, error);
}

JNIEXPORT jbyteArray JNICALL JNI_NAME(peerLinkServeResponse)(JNIEnv *env, jclass cls, jlong handle, jlong now, jbyteArray bytes) {
    (void)cls;
    Input input;
    memset(&input, 0, sizeof(input));
    if (bytes != NULL && !borrow_input(env, bytes, &input)) return NULL;
    RsBuffer out = {0}, error = {0};
    int32_t rc = relayswarm_peer_link_serve_response((void *)(intptr_t)handle, (uint64_t)now,
        input.ptr, input.len, bytes != NULL, &out, &error);
    if (bytes != NULL) release_input(env, &input);
    return buffer_result(env, rc, out, error);
}

JNIEXPORT jbyteArray JNICALL JNI_NAME(peerLinkSendHave)(JNIEnv *env, jclass cls, jlong handle, jobjectArray keys) {
    (void)cls;
    BufferInputs inputs;
    if (!borrow_buffers(env, keys, &inputs)) return NULL;
    RsBuffer out = {0}, error = {0};
    RsBufferList list = {inputs.buffers, (size_t)inputs.len};
    int32_t rc = relayswarm_peer_link_send_have((void *)(intptr_t)handle, list, &out, &error);
    release_buffers(env, &inputs);
    return buffer_result(env, rc, out, error);
}

JNIEXPORT jlong JNICALL JNI_NAME(peerSelectionOrder)(JNIEnv *env, jclass cls, jlong handle) {
    (void)cls;
    uint64_t out = 0;
    RsBuffer error = {0};
    int32_t rc = relayswarm_peer_selection_order((void *)(intptr_t)handle, &out, &error);
    if (rc != 0) {
        throw_failed(env, error);
        return 0;
    }
    return (jlong)out;
}

JNIEXPORT void JNICALL JNI_NAME(free)(JNIEnv *env, jclass cls, jlong handle) {
    (void)env; (void)cls;
    relayswarm_object_free((void *)(intptr_t)handle);
}
