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
Json::Value openAiResponse(const std::string& body) {
    if(isJson(body))return json::parse(body);
    Json::Value out,msg,usage;std::map<int,Json::Value> tools;std::string finish;bool done=false;
    msg["content"]="";
    for(const auto& data:events(body)) {
        if(done)throw std::runtime_error("AI stream continued after completion");
        if(data=="[DONE]"){done=true;continue;}
        auto e=json::parse(data);if(e.isMember("error"))throw std::runtime_error("AI provider returned a stream error");
        if(e["usage"].isObject())usage=e["usage"];
        for(const auto& c:e["choices"]) {
            if(c.get("index",0).asInt()!=0)continue;
            append(msg["content"],c["delta"]["content"]);
            if(c["delta"]["refusal"].isString()&&!c["delta"]["refusal"].asString().empty())throw std::runtime_error("the model declined this request");
            for(const auto& t:c["delta"]["tool_calls"]) { auto& tool=tools[index(t["index"])];append(tool["id"],t["id"]);tool["type"]="function";append(tool["function"]["name"],t["function"]["name"]);append(tool["function"]["arguments"],t["function"]["arguments"]); }
            if(c["finish_reason"].isString())finish=c["finish_reason"].asString();
        }
    }
    if(!done||finish.empty())throw std::runtime_error("AI stream ended before completion");
    for(auto& [i,t]:tools){if(!t["id"].isString()||!t["function"]["name"].isString())throw std::runtime_error("incomplete streamed tool call");msg["tool_calls"].append(t);}
    out["choices"][0]["message"]=msg;out["choices"][0]["finish_reason"]=finish;out["usage"]=usage;return out;
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
