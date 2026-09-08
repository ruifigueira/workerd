#pragma once

#include <workerd/server/workerd.capnp.h>

#include <kj/common.h>
#include <kj/compat/http.h>
#include <kj/map.h>
#include <kj/mutex.h>
#include <kj/one-of.h>
#include <kj/string.h>
#include <kj/thread.h>

namespace workerd::fallback {

// The fallback service is a mechanism used only in workerd local development.
// It is used to use an external http service to resolve module specifiers
// dynamically if the module is not found in the static bundles. A worker
// must be configured to use the fallback service and workerd must be started
// with the --experimental CLI flag.
//
// There are two versions of the fallback service protocol:
//
// V1: The request is sent to the fallback service as a GET request using
// query strings to pass the details. The specifier and referrer are treated
// as strings. Import attributes are not included.
//
// V2: The request is sent to the fallback service as a POST request using
// JSON to pass the details. The specifier and referrer are treated as URLs.
// Import attributes are included.
//
// The fallback service may return a 301 redirect to a different module
// specifier, an error, or a 200 whose body is interpreted according to its
// Content-Type (see ResponseBodyKind).
enum class ImportType {
  // The import is a static or dynamic import
  IMPORT,
  // The import is a CommonJs-style require()
  REQUIRE,
  // The import originated from inside the runtime
  INTERNAL,
};

enum class Version {
  // With V1 of the fallback service, the request is sent to the fallback
  // service as a GET request using query strings to pass the details.
  // The specifier and referrer are treated as strings. Import attributes
  // are not included.
  V1,
  // With V2 of the fallback service, the request is sent to the fallback
  // service as a POST request using JSON to pass the details. The specifier
  // and referrer are treated as URLs. Import attributes are included.
  V2,
};

using ModuleOrRedirect =
    kj::Maybe<kj::OneOf<kj::String, kj::Own<server::config::Worker::Module::Reader>>>;

// How the body of a 200 response from a fallback service is interpreted.
enum class ResponseBodyKind {
  // A JSON-encoded `Worker.Module`. Used for any Content-Type other than the
  // ones below, or when there is no Content-Type.
  JSON,
  // Content-Type `application/wasm`: the body is the WebAssembly module bytes.
  WASM,
  // Content-Type `application/octet-stream`: the body is a data module.
  DATA,
};

ResponseBodyKind responseBodyKind(const kj::HttpHeaders& headers);

// Fills `module` from the body of a 200 response. A binary body, or a JSON body
// without a `name`, is named `specifier`. A JSON body that names a module is
// left as decoded; callers reject a name that differs from `specifier`.
// Throws if a JSON body cannot be decoded.
void decodeModuleResponse(ResponseBodyKind kind,
    kj::ArrayPtr<const kj::byte> body,
    kj::StringPtr specifier,
    server::config::Worker::Module::Builder module);

// A persistent client for the fallback service that uses a single background
// thread with a long-lived HTTP client for all module resolution requests.
// This avoids creating a new OS thread, DNS lookup, and TCP connection for
// each request, which can exhaust ephemeral ports when many modules are
// resolved concurrently (e.g. running many test files with vitest-pool-workers).
//
// IMPORTANT: This class supports only one caller at a time. tryResolve() will
// assert if called concurrently. Module resolution in workerd is single-threaded
// per isolate/registry so this is safe in practice.
class FallbackServiceClient {
 public:
  explicit FallbackServiceClient(kj::String address);
  ~FallbackServiceClient() noexcept(false);

  KJ_DISALLOW_COPY_AND_MOVE(FallbackServiceClient);

  ModuleOrRedirect tryResolve(Version version,
      ImportType type,
      kj::StringPtr specifier,
      kj::StringPtr rawSpecifier,
      kj::StringPtr referrer,
      const kj::HashMap<kj::StringPtr, kj::StringPtr>& attributes);

 private:
  // Shared state between the calling thread and the background thread.
  // Access is serialized through kj::MutexGuarded.
  struct SharedState {
    // Request fields - valid only when hasRequest is true.
    // These contain non-owning references into the caller's stack frame,
    // which is safe because the caller blocks until responseReady is set.
    Version version = Version::V1;
    ImportType type = ImportType::IMPORT;
    kj::StringPtr specifier;
    kj::StringPtr rawSpecifier;
    kj::StringPtr referrer;
    const kj::HashMap<kj::StringPtr, kj::StringPtr>* attributes = nullptr;
    bool hasRequest = false;

    // Response field - valid only when responseReady is true.
    ModuleOrRedirect response;
    bool responseReady = false;

    // Set to true to signal the background thread to exit.
    bool shutdown = false;
  };

  kj::String ownedAddress;
  kj::MutexGuarded<SharedState> state;
  kj::Thread thread;

  void threadMain();
};

}  // namespace workerd::fallback
