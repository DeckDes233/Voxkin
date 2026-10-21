# 许可证分析

本文件用于在 MIT 与 GPL-3.0 之间做选择，只记录事实与影响，不构成法律意见。

## 1. 依赖清单

| 组件 | 使用方式 | 许可证 |
| --- | --- | --- |
| GPT-SoVITS | 外部进程，通过 HTTP 调用 | MIT |
| Genie TTS | Python 包，进程内调用 | MIT |
| faster-whisper | Python 包 | MIT |
| aiohttp | Python 包 | Apache-2.0 |
| numpy | Python 包 | BSD-3-Clause |
| PyYAML | Python 包 | MIT |
| soundfile | Python 包 | BSD-3-Clause |
| sounddevice | Python 包 | MIT |
| opencc-python-reimplemented | Python 包 | Apache-2.0 |
| mineflayer | npm 包 | MIT |
| mineflayer-pathfinder | npm 包 | MIT |
| ws | npm 包 | MIT |
| Fabric Loader | Mod 运行时依赖 | Apache-2.0 |
| Fabric API | Mod 运行时依赖 | Apache-2.0 |
| Minecraft 1.21.1 | 客户端游戏，不随仓库分发 | Mojang 最终用户许可协议 |

测试阶段另外使用了 Paper 1.21.1 服务端。Paper 使用 GPL-3.0，但它只在本地作为测试服务器运行，没有链接进本项目，也没有随仓库分发。

## 2. 分发边界

仓库中不包含：

- 模型权重与参考录音
- GPT-SoVITS 运行包（Python 3.9 与 torch）
- Minecraft 客户端或服务端文件
- Paper 服务端
- 任何真实 API 密钥

因此本项目的许可证只需要和上表中的 MIT、Apache-2.0、BSD 依赖兼容。这三类都属于宽松许可证，MIT 与 GPL-3.0 都能兼容。

## 3. MIT 的影响

- 允许商业使用、修改、再发布与闭源衍生。
- 需要保留版权声明与许可证文本。
- 不要求公开修改后的源码。
- 与 Fabric 生态的常见做法一致，便于其他 Mod 与本项目互相引用。

## 4. GPL-3.0 的影响

- 分发修改版时必须提供完整源码，并以 GPL-3.0 授权。
- 如果将来把本项目与 GPL 代码（例如直接链接 Paper 的插件代码）合并，GPL 会更省事。
- 对于只通过网络提供服务的使用方式，GPL-3.0 不要求公开源码；若在意这一点，应考虑 AGPL-3.0。
- 部分公司在采用 GPL 依赖时会走额外审批，可能减少企业用户。

## 5. 结论

当前依赖全部宽松许可，两种协议都成立。

推荐 MIT，理由：

1. 项目的价值在整合与体验，不在代码保护。
2. MIT 与现有依赖、Fabric 生态、未来可能的商业合作都兼容。
3. 如果以后需要强制衍生开源，可以在重要版本切换，但已发布的 MIT 版本无法收回。

如果目标是「任何基于本项目的公开衍生都必须开源」，选 GPL-3.0；如果还要求网络服务也开源，选 AGPL-3.0。

协议确定后需要做三件事：

1. 在仓库根目录加入 `LICENSE` 全文。
2. 在 `pyproject.toml`、`bridge/package.json`、`mod/src/main/resources/fabric.mod.json` 中写入协议标识。
3. 在 README 顶部替换「协议待定」的说明。

## 6. 第三方声明

Apache-2.0 依赖（aiohttp、opencc-python-reimplemented、Fabric Loader、Fabric API）要求在被再分发时保留其许可证与 NOTICE。本仓库通过 pip 与 npm 安装这些依赖，不复制它们的源码；如果将来打包成整合包或离线安装包，需要附带第三方许可证清单。
