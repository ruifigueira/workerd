#include "script.h"

#include <workerd/jsg/jsvalue.h>

namespace workerd::jsg {

jsg::JsValue NonModuleScript::runAndReturn(jsg::Lock& js) const {
  auto boundScript = unboundScript.Get(js.v8Isolate)->BindToCurrentContext();
  return jsg::JsValue(check(boundScript->Run(js.v8Context())));
}

void NonModuleScript::run(jsg::Lock& js) const {
  auto boundScript = unboundScript.Get(js.v8Isolate)->BindToCurrentContext();
  check(boundScript->Run(js.v8Context()));
}

NonModuleScript NonModuleScript::compile(
    jsg::Lock& js, kj::StringPtr code, kj::StringPtr name, DynamicImportMode dynamicImportMode) {
  // Create a dummy script origin for it to appear in Sources panel.
  auto isolate = js.v8Isolate;
  v8::Local<v8::PrimitiveArray> hostDefinedOptions;
  if (dynamicImportMode != DynamicImportMode::DEFAULT) {
    auto option = dynamicImportMode == DynamicImportMode::FALLBACK_ONLY
        ? FALLBACK_ONLY_IMPORTS_HOST_DEFINED_OPTION
        : FALLBACK_ONLY_IMPORTS_WITHOUT_REFERRER_HOST_DEFINED_OPTION;
    hostDefinedOptions = v8::PrimitiveArray::New(isolate, 1);
    hostDefinedOptions->Set(isolate, 0, v8::Int32::New(isolate, option));
  }
  v8::ScriptOrigin origin(
      js.str(name), 0, 0, false, -1, {}, false, false, false, hostDefinedOptions);
  v8::ScriptCompiler::Source source(js.str(code), origin);
  return NonModuleScript(js, check(v8::ScriptCompiler::CompileUnboundScript(isolate, &source)));
}

}  // namespace workerd::jsg
