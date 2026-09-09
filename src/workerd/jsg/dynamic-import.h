#pragma once

namespace workerd::jsg {

enum class DynamicImportMode {
  DEFAULT,
  FALLBACK_ONLY,
  FALLBACK_ONLY_WITHOUT_REFERRER,
};

constexpr int FALLBACK_ONLY_IMPORTS_HOST_DEFINED_OPTION = -1;
constexpr int FALLBACK_ONLY_IMPORTS_WITHOUT_REFERRER_HOST_DEFINED_OPTION = -2;

constexpr bool isFallbackOnlyImportsHostDefinedOption(int option) {
  return option == FALLBACK_ONLY_IMPORTS_HOST_DEFINED_OPTION ||
      option == FALLBACK_ONLY_IMPORTS_WITHOUT_REFERRER_HOST_DEFINED_OPTION;
}

}  // namespace workerd::jsg
