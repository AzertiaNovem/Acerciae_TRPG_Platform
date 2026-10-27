#include "Zip.h"
#include <zlib.h>
#include <cstdint>
#include <ctime>

namespace acerciae::zip {
namespace {
void u16(std::string& s, uint32_t v) { s += char(v & 0xff); s += char((v >> 8) & 0xff); }
void u32(std::string& s, uint32_t v) { for (int i = 0; i < 4; ++i) s += char((v >> (8 * i)) & 0xff); }
// MS-DOS date/time of "now" (UTC), as ZIP requires.
void dosTime(uint32_t& t, uint32_t& d) {
    std::time_t now = std::time(nullptr); std::tm tm{}; gmtime_r(&now, &tm);
    t = ((tm.tm_hour & 31) << 11) | ((tm.tm_min & 63) << 5) | ((tm.tm_sec / 2) & 31);
    d = (((tm.tm_year - 80) & 127) << 9) | (((tm.tm_mon + 1) & 15) << 5) | (tm.tm_mday & 31);
}
} // namespace

std::string build(const std::vector<std::pair<std::string, std::string>>& files) {
    std::string out, central; uint32_t t, d; dosTime(t, d); uint32_t count = 0;
    for (const auto& [pathIn, data] : files) {
        std::string path = pathIn; while (!path.empty() && path[0] == '/') path.erase(0, 1); if (path.empty()) continue;
        uint32_t crc = crc32(0, reinterpret_cast<const Bytef*>(data.data()), (uInt)data.size());
        uint32_t offset = (uint32_t)out.size();
        // Local file header: version 20, flags bit 11 (UTF-8 names), method 0.
        u32(out, 0x04034b50); u16(out, 20); u16(out, 0x0800); u16(out, 0); u16(out, t); u16(out, d); u32(out, crc); u32(out, (uint32_t)data.size()); u32(out, (uint32_t)data.size()); u16(out, (uint32_t)path.size()); u16(out, 0);
        out += path; out += data;
        u32(central, 0x02014b50); u16(central, 0x031e); u16(central, 20); u16(central, 0x0800); u16(central, 0); u16(central, t); u16(central, d); u32(central, crc); u32(central, (uint32_t)data.size()); u32(central, (uint32_t)data.size());
        u16(central, (uint32_t)path.size()); u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0); u32(central, 0x81a40000u); u32(central, offset);
        central += path; ++count;
    }
    uint32_t cdOffset = (uint32_t)out.size(); out += central;
    u32(out, 0x06054b50); u16(out, 0); u16(out, 0); u16(out, count); u16(out, count); u32(out, (uint32_t)central.size()); u32(out, cdOffset); u16(out, 0);
    return out;
}
} // namespace acerciae::zip
