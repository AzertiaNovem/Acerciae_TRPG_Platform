#pragma once
#include <trantor/utils/Logger.h>
// Thin alias so modules do not depend on the web framework's logger directly.
#define ALOG_INFO LOG_INFO
#define ALOG_WARN LOG_WARN
#define ALOG_ERROR LOG_ERROR
#define ALOG_DEBUG LOG_DEBUG
