#include <fcntl.h>
#include <stdint.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);

extern int napi_get_undefined(napi_env, napi_value *);
extern int napi_throw_error(napi_env, const char *, const char *);
extern int napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern int napi_set_named_property(napi_env, napi_value, const char *, napi_value);

static const int private_descriptor = 198;

static napi_value set_close_on_exec(napi_env env, napi_callback_info info) {
  (void)info;
  const int flags = fcntl(private_descriptor, F_GETFD);
  if (flags == -1 || fcntl(private_descriptor, F_SETFD, flags | FD_CLOEXEC) == -1) {
    napi_throw_error(env, "DSH_FD198_CLOEXEC", "could not protect the private gateway descriptor");
    return 0;
  }
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != 0) return 0;
  return undefined;
}

/** N-API v1 entrypoint resolved by Node without a development header dependency. */
__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "setCloseOnExec", 14, set_close_on_exec, 0, &function) != 0) return 0;
  if (napi_set_named_property(env, exports, "setCloseOnExec", function) != 0) return 0;
  return exports;
}
