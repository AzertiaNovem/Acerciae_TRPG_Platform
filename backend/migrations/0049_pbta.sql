ALTER TABLE channels DROP CONSTRAINT channels_rule_system_check;
ALTER TABLE channels ADD CONSTRAINT channels_rule_system_check CHECK (rule_system IN ('coc7e','dnd2024','pbta'));

-- Kept outside channels: channel listings use SELECT * and are player-visible.
CREATE TABLE pbta_packs (
    channel_id uuid PRIMARY KEY REFERENCES channels ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 1,
    pack jsonb NOT NULL DEFAULT $pack${
  "schemaVersion": 1,
  "name": "边境调查",
  "stats": [
    {
      "id": "sense",
      "name": "洞察"
    },
    {
      "id": "nerve",
      "name": "胆识"
    },
    {
      "id": "rapport",
      "name": "交涉"
    }
  ],
  "books": [
    {
      "id": "scout",
      "name": "巡界员"
    },
    {
      "id": "scribe",
      "name": "抄录师"
    }
  ],
  "resources": [
    {
      "id": "supply",
      "name": "补给"
    },
    {
      "id": "xp",
      "name": "经验"
    }
  ],
  "conditions": [
    {
      "id": "exposed",
      "name": "暴露行踪"
    },
    {
      "id": "tired",
      "name": "疲惫"
    }
  ],
  "bands": [
    {
      "id": "miss",
      "name": "局势转折",
      "min": null,
      "max": 6
    },
    {
      "id": "mixed",
      "name": "有所取舍",
      "min": 7,
      "max": 9
    },
    {
      "id": "strong",
      "name": "占据主动",
      "min": 10,
      "max": null
    }
  ],
  "moves": [
    {
      "id": "search",
      "name": "冒险搜查",
      "trigger": "当你进入仍有人监视的现场，指出你想验证的痕迹。",
      "stat": "sense",
      "book": "",
      "outcomes": {
        "miss": "GM 揭示现场如何回应你的到来。",
        "mixed": "找到痕迹。选择一项：留下证据，或花掉宝贵时间。",
        "strong": "找到痕迹，并指出一条安全退路。"
      }
    },
    {
      "id": "cross",
      "name": "越过封锁",
      "trigger": "当你冒着被发现的风险穿过封锁，描述你利用的空隙。",
      "stat": "nerve",
      "book": "",
      "outcomes": {
        "miss": "封锁线发生变化，由 GM 描述新的局面。",
        "mixed": "你可以过去，但须留下装备或引来注意。",
        "strong": "你过去了，还能带上一位同伴。"
      }
    },
    {
      "id": "parley",
      "name": "交换情报",
      "trigger": "当你拿出对方在意的筹码，说明你想问什么。",
      "stat": "rapport",
      "book": "",
      "outcomes": {
        "miss": "对方提出一个让局面改变的要求。",
        "mixed": "对方愿意回答，但要你先兑现承诺。",
        "strong": "获得答复，并得知谁也在打听这件事。"
      }
    },
    {
      "id": "compare",
      "name": "核对记录",
      "trigger": "当调查者在安全处比对笔记，每人说出一处吻合或矛盾，并约定下一步验证什么。",
      "stat": "",
      "book": "",
      "outcomes": {}
    },
    {
      "id": "trail",
      "name": "留路标",
      "trigger": "当你走在队伍最前方，说出你留下的标记，同伴随后能循迹找到你。",
      "stat": "",
      "book": "scout",
      "outcomes": {}
    },
    {
      "id": "copy",
      "name": "留副本",
      "trigger": "当你有时间抄录证据，说出副本藏在哪里，并把位置记入笔记。",
      "stat": "",
      "book": "scribe",
      "outcomes": {}
    }
  ],
  "gmMoves": [
    {
      "id": "pressure",
      "name": "逼近的代价",
      "text": "让一项已出现的威胁更接近，问调查者如何应对。"
    }
  ]
}$pack$::jsonb
);
CREATE FUNCTION ensure_pbta_pack() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO pbta_packs(channel_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$;
CREATE TRIGGER init_pbta AFTER INSERT OR UPDATE OF rule_system ON channels
    FOR EACH ROW WHEN (NEW.rule_system='pbta') EXECUTE FUNCTION ensure_pbta_pack();
