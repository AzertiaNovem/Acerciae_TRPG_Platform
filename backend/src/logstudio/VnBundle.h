#pragma once
#include <json/json.h>
#include <string>

namespace acerciae::logstudio {
// Renders the self-contained HTML player shipped inside a visual-novel bundle (index.html).
// `data` is the bundle script: {title, template, scenes[{id,title,background}], events[{id,scene_id,kind,text,speaker,stage[{name,position,active,image}],dice,audio}]}.
// Asset paths are relative to the bundle root; the page needs no network access.
std::string renderStandaloneVn(const Json::Value& data);
}
