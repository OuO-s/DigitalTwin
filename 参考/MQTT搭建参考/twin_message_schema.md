```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "twin_message_schema.json",
  "title": "统一孪生消息 Schema（窄腰契约）",
  "description": "所有协议适配器都必须把客户原始报文 normalize 成本 Schema 定义的消息；所有下游（渲染/面板/回放/告警）只消费本 Schema。",
  "definitions": {
    "ts": {
      "type": "integer",
      "description": "设备侧时间戳（毫秒）"
    },
    "pose": {
      "type": "object",
      "required": ["x", "y", "z", "yaw", "roll", "pitch"],
      "properties": {
        "x": { "type": "number" },
        "y": { "type": "number" },
        "z": { "type": "number" },
        "yaw": { "type": "number" },
        "roll": { "type": "number" },
        "pitch": { "type": "number" }
      }
    },
    "joint": {
      "type": "object",
      "required": ["joints"],
      "properties": {
        "joints": {
          "type": "array",
          "items": { "type": "number" },
          "description": "关节角度（弧度），顺序与模型关节绑定一致"
        }
      }
    },
    "status": {
      "type": "object",
      "required": ["state"],
      "properties": {
        "state": { "type": "string" },
        "battery": { "type": "number" },
        "speed": { "type": "number" },
        "task": { "type": "string" }
      },
      "additionalProperties": true
    },
    "command": {
      "type": "object",
      "required": ["cmd"],
      "properties": {
        "cmd": { "type": "string" }
      },
      "additionalProperties": true
    }
  },
  "oneOf": [
    {
      "description": "① 位姿流（高频，驱动物体移动）",
      "type": "object",
      "required": ["twinId", "ts", "type", "data"],
      "properties": {
        "twinId": { "type": "string" },
        "ts": { "$ref": "#/definitions/ts" },
        "type": { "const": "pose" },
        "data": { "$ref": "#/definitions/pose" }
      }
    },
    {
      "description": "② 关节状态（驱动关节动画）",
      "type": "object",
      "required": ["twinId", "ts", "type", "data"],
      "properties": {
        "twinId": { "type": "string" },
        "ts": { "$ref": "#/definitions/ts" },
        "type": { "const": "joint" },
        "data": { "$ref": "#/definitions/joint" }
      }
    },
    {
      "description": "③ 状态事件（驱动变色/面板/告警）",
      "type": "object",
      "required": ["twinId", "ts", "type", "data"],
      "properties": {
        "twinId": { "type": "string" },
        "ts": { "$ref": "#/definitions/ts" },
        "type": { "const": "status" },
        "data": { "$ref": "#/definitions/status" }
      }
    },
    {
      "description": "④ 指令下发（浏览器 → 设备）",
      "type": "object",
      "required": ["twinId", "type", "data"],
      "properties": {
        "twinId": { "type": "string" },
        "type": { "const": "command" },
        "data": { "$ref": "#/definitions/command" }
      }
    },
    {
      "description": "⑤ 快照（重连/订阅时全量下发，解决状态续播）",
      "type": "object",
      "required": ["type", "ts", "data"],
      "properties": {
        "type": { "const": "snapshot" },
        "ts": { "$ref": "#/definitions/ts" },
        "data": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["twinId", "ts", "type", "data"],
            "properties": {
              "twinId": { "type": "string" },
              "ts": { "$ref": "#/definitions/ts" },
              "type": { "type": "string" },
              "data": { "type": "object" }
            }
          }
        }
      }
    },
    {
      "description": "⑥ 指令回执（设备执行结果回传，闭环可见）",
      "type": "object",
      "required": ["twinId", "type", "data"],
      "properties": {
        "twinId": { "type": "string" },
        "type": { "const": "ack" },
        "data": {
          "type": "object",
          "required": ["ref", "ok"],
          "properties": {
            "ref": { "type": "string" },
            "ok": { "type": "boolean" },
            "err": { "type": ["string", "null"] }
          }
        }
      }
    }
  ]
}

```

