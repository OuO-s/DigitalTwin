```python
"""协议适配器统一接口。

新增一个客户协议 = 新增一个本类的实现；核心（Hub / WS / 前端）零改动。
所有适配器只做一件事：把客户原始报文翻译为统一孪生消息（见
shared/twin_message_schema.json），再交给 Hub.ingest。
"""

from abc import ABC, abstractmethod


class ProtocolAdapter(ABC):
    """协议适配器基类。"""

    @abstractmethod
    def connect(self, config=None):
        """建立到协议端点（Broker / API / Kafka 集群）的连接。"""

    @abstractmethod
    def subscribe(self, device_list=None):
        """订阅指定设备的上行数据。"""

    @abstractmethod
    def normalize(self, raw):
        """把原始报文翻译为统一孪生消息（dict，符合 Schema）。"""

    @abstractmethod
    def send_command(self, device_id, cmd):
        """向设备下发指令。"""

```

