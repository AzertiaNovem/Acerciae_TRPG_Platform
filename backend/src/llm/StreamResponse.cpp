#include "StreamResponse.h"
#include "../core/Json.h"
#include <sstream>
#include <map>
#include <stdexcept>
#include <vector>

namespace acerciae::llm {
namespace {
bool isJson(const std::string& s) { auto p=s.find_first_not_of(" \t\r\n");return p!=std::string::npos && s[p]=='{'; }
std::vector<std::string> events(const std::string& body) {
    std::istringstream input(body);std::string line,data;std::vector<std::string> out;
    while(std::getline(input,line)) {
        if(!line.empty()&&line.back()=='\r')line.pop_back();
        if(line.empty()) { if(!data.empty()){data.pop_back();out.push_back(data);data.clear();} }
        else if(line.rfind("data:",0)==0) { auto text=line.substr(5);if(!text.empty()&&text[0]==' ')text.erase(0,1);data+=text+'\n'; }
        if(out.size()>100000)throw std::runtime_error("too many AI stream events");
    }
    if(!data.empty())throw std::runtime_error("AI stream ended inside an event");
    return out;
}
int index(const Json::Value& v) { if(!v.isInt()||v.asInt()<0||v.asInt()>128)throw std::runtime_error("invalid AI stream index");return v.asInt(); }
void append(Json::Value& dest,const Json::Value& value) { if(value.isString())dest=(dest.isString()?dest.asString():"")+value.asString(); }
}
Json::Value responsesResponse(const std::string& body) {
    if(isJson(body))return json::parse(body);
    // OpenAI Responses stream: typed events, ending with response.completed / .incomplete / .failed, which carry the
    // whole response. Finished output items also arrive one by one, in case a gateway trims the terminal object.
    Json::Value out,items(Json::arrayValue);bool done=false;
    for(const auto& data:events(body)) {
        auto e=json::parse(data);auto type=e["type"].asString();
        if(done)throw std::runtime_error("AI stream continued after completion");
        if(type=="error"||type=="response.failed")throw std::runtime_error("AI provider returned a stream error");
        if(type=="response.output_item.done"&&e["item"].isObject())items.append(e["item"]);
        else if(type=="response.completed"||type=="response.incomplete") {
            if(!e["response"].isObject())throw std::runtime_error("AI stream completion carried no response");
            out=e["response"];done=true;
        }
    }
    if(!done)throw std::runtime_error("AI stream ended before completion");
    if(!out["output"].isArray()||out["output"].empty())out["output"]=items;
    return out;
}
Json::Value anthropicResponse(const std::string& body) {
    if(isJson(body))return json::parse(body);
    Json::Value out;std::map<int,Json::Value> blocks;std::map<int,std::string> inputs;std::map<int,bool> stopped;
    bool started=false,done=false;
    for(const auto& data:events(body)) {
        auto e=json::parse(data);auto type=e["type"].asString();
        if(type=="error")throw std::runtime_error("AI provider returned a stream error");
        if(type=="ping")continue;
        if(done)throw std::runtime_error("AI stream continued after completion");
        if(type=="message_start") { if(started)throw std::runtime_error("duplicate AI message start");started=true;out=e["message"]; }
        else if(!started)throw std::runtime_error("missing AI message start");
        else if(type=="content_block_start") {int i=index(e["index"]);if(blocks.count(i))throw std::runtime_error("duplicate AI content block");blocks[i]=e["content_block"];stopped[i]=false;}
        else if(type=="content_block_delta") {
            int i=index(e["index"]);if(!blocks.count(i)||stopped[i])throw std::runtime_error("invalid AI content delta");auto& b=blocks[i];const auto& d=e["delta"];
            auto kind=d["type"].asString();
            if(kind=="text_delta")append(b["text"],d["text"]);
            else if(kind=="input_json_delta")inputs[i]+=d["partial_json"].asString();
            else if(kind=="thinking_delta")append(b["thinking"],d["thinking"]);
            else if(kind=="signature_delta")append(b["signature"],d["signature"]);
        } else if(type=="content_block_stop") {int i=index(e["index"]);if(!blocks.count(i))throw std::runtime_error("unknown AI content block");stopped[i]=true;}
        else if(type=="message_delta") {out["stop_reason"]=e["delta"]["stop_reason"];if(e["usage"].isObject())for(auto& k:e["usage"].getMemberNames())out["usage"][k]=e["usage"][k];}
        else if(type=="message_stop")done=true;
    }
    if(!started||!done||!out["stop_reason"].isString())throw std::runtime_error("AI stream ended before completion");
    out["content"]=Json::Value(Json::arrayValue);
    for(auto& [i,b]:blocks){if(!stopped[i])throw std::runtime_error("AI content block was interrupted");if(inputs.count(i))b["input"]=json::parse(inputs[i]);out["content"].append(b);}
    return out;
}
}
