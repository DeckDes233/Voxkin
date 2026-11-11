# 独立诊断工具

从仓库根目录运行，使用 `.venv` 中的 Python。

| 工具 | 用途 |
| --- | --- |
| `dev_llm_server.py` | 不访问外网的本地测试 LLM，用于可重复的流式链路测试；不能代表真实模型的理解能力和网络延迟 |
| `verify_voice.py` | 语音链路验证辅助，参数和所需引擎见脚本 |

启动本地测试 LLM：

```powershell
.\.venv\Scripts\python.exe tools\dev_llm_server.py --port 8799
```

使用它时需显式把测试配置指向该服务，报告中注明“本地测试 LLM”。真实延迟结论统一记录到 [BENCHMARK_RESULTS](../docs/BENCHMARK_RESULTS.md)。运行与评测脚本见 [scripts](../scripts/README.md)。
