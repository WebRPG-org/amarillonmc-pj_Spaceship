# 项目协作指南

本文件适用于整个仓库。与用户沟通、编写项目说明时默认使用中文；代码标识符沿用所在模块的约定。

## 项目定位与入口

- 当前开发主体是 `engine/`：独立浏览器客户端、服务端权威世界模拟和 MySQL 存储，直接复用根目录的 RPG Maker 数据与素材。
- 根目录的 `Game.rpgproject`、`index.html`、`js/` 及 `server/` 是保留的旧 MV/MMO 工程。旧服务使用 RethinkDB；旧账号和存档不会自动迁入新引擎。处理新功能前先确认目标运行时，避免误改旧实现。
- 启动命令和兼容边界先看 `engine/README.md`；设计决策和阶段记录从 `doc/README.md` 查找。历史文档中的测试数量、限制和待办属于当时记录，须结合当前代码核实。

| 路径 | 用途 |
| --- | --- |
| `engine/server/index.mjs` | HTTP、WebSocket、会话、素材服务和运行时生命周期 |
| `engine/server/world.mjs` | 权威世界、移动、战斗、实体和快照 |
| `engine/server/content.mjs`、`engine/server/events.mjs` | RM 内容导入、事件适配和兼容诊断 |
| `engine/server/instances.mjs`、`engine/server/rounds.mjs`、`engine/server/round-store.mjs` | 副本路由、规则和局内存储 |
| `engine/server/persistence.mjs`、`engine/server/schema.sql` | MySQL 持久化和表结构 |
| `engine/server/workbench.mjs`、`engine/client/editor*` | 本机内容工作台 |
| `engine/client/app.mjs`、`engine/client/renderer.mjs`、`engine/client/protocol.mjs` | 浏览器交互、渲染和服务端快照展示 |
| `engine/content/gameplay.json` | 副本、实时 NPC、商店、奖励等玩法配置 |
| `data/`、`img/`、`audio/`、`effects/`、`fonts/` | 共享的原始游戏内容与资源 |
| `engine/test/`、`engine/client/*.test.mjs` | 服务端与客户端回归测试 |
| `engine/tools/` | 内容检查、数据库管理、生成器和浏览器验证脚本 |

## 本地开发

新引擎使用 **Node.js >= 22**、原生 ES modules（`.mjs`）和浏览器模块，没有前端打包步骤。根目录的 `Start.bat` 启动的是旧工程的 browser-sync，不是新引擎。

从仓库根目录执行以下首次安装与启动命令（第一行进入 `engine/`）：

```powershell
cd engine
npm install --cache .local/npm-cache
npm run mysql:start
npm run dev
```

- 新客户端默认为 `http://127.0.0.1:8098`；项目独立 MySQL 默认为 `127.0.0.1:3317`。已有服务运行时先确认状态，避免重复启动。
- 首次使用项目 MySQL 脚本时，**不要预先复制 `.env.example` 为 `.env`**。脚本会生成凭据和 `.env`；已有配置必须保留。手动连接自管数据库时才参考 `.env.example`。
- `engine/.env` 保存本机配置与凭据，不提交、不在输出中泄露密码。`engine/.local/` 包含数据库、凭据和日志，不能作为普通缓存删除；不要操作其他 MySQL 服务或数据目录。
- 停止时先结束应用进程，再在 `engine/` 执行 `npm run mysql:stop`。数据库脚本会复用已有项目数据。
- 内容修改后需重建运行时并刷新浏览器。工作台的“重置（重启服务）”可应用内容修改，但会断开玩家、结束副本；服务端 `.mjs` 或环境变量修改仍需重启 Node 进程。具体行为见 `engine/README.md`。

## 实现约束

- 服务端决定位置、碰撞、战斗、物资、奖励和副本状态；客户端发送操作意图并展示快照。保留 `contextInstanceId` 校验以及由 `instance.id`、`mapId` 组成的场景身份，防止旧操作和表现串入其他副本。
- 游戏计时依据服务端时间；打开背包或其他 UI 不暂停世界模拟。重连后重新验证会话，并以服务端快照恢复状态，不在客户端积攒旧战斗命令重放。
- 保持主世界、局内物资与永久资料的边界。改动持久化、结算或奖励时检查事务、请求去重、失败恢复及旧存档兼容，不能只改内存表现。
- 新引擎通过显式适配器解释受支持的事件和插件标记，不执行地图中的任意 JavaScript。未知内容应保留并提供诊断；“可导入”“可渲染”和“完整实现旧玩法”需分别验证。
- 默认 2D 客户端不运行旧 RPG Maker 插件。MV3D/MZ3D 使用隔离的展示宿主；不要将旧游戏主循环引入新客户端。
- 工作台仅供本机开发使用。保持 `DEV_TOOLS=1`、loopback、同源、拒绝代理转发、写请求标记和路径/字段白名单等边界。
- 工作台保存需保留版本冲突检查、备份、串行写入和未知字段；不能通过直接覆盖整份文档绕过这些行为。
- 沿用相邻源码的格式和模块组织，避免无关重排或全仓格式化。`js/libs/`、旧第三方插件及 `engine/client/vendor/` 的修改需与任务直接相关，保留许可证和来源信息。

## 地图、数据库与素材

- `data/` 是旧编辑器与新引擎共享的源文件。编辑时保留原生字段、插件备注、事件页、指令参数和未知扩展，不进行整批格式转换。
- 保持地图、事件、数据库条目的 ID 稳定；删除事件保留 `null` 槽位，不重排数组。新建地图同步 `data/MapInfos.json`，核对传送、物品、技能、图块组及素材引用。
- RM 地图保留六个平面，数据长度为 `width * height * 6`：0–3 为图块、4 为阴影、5 为区域。调整尺寸时处理越界事件并核对入口与出口。
- 新引擎玩法配置在 `engine/content/gameplay.json`，地图的 `engine_npc`、`engine_shop` 等标签引用对应定义；实时工具仍从 Tool Map 的原生 108/408 注释导入。不要增加运行时未消费的重复配置。
- `engine/tools/build-*.mjs` 和 `import-*.mjs` 会写入地图、数据库或素材。运行前检查具体写入目标及已有手工编辑；它们不是只读检查，不应为了验证改动而随手重跑。
- 进行地图制作、重绘或美化时，先阅读 `.agents/skills/rpgmaker-map-design/SKILL.md`，按项目图块与 Sample 核实组合。不要为单张地图随意修改共享图块 PNG 或通行 flags。
- 地图验收同时检查实际渲染、出生点、真实碰撞、交互站位和去回程传送。使用 `World` 的实际移动规则；不要通过移除 NPC、忽略碰撞或开发传送来证明道路可通行。

## 验证

以下命令均在**仓库根目录**执行；只运行与改动相关的检查，必要时再扩展范围。

| 场景 | 命令或方式 |
| --- | --- |
| 默认自动测试 | `npm --prefix engine test`（也可 `npm run engine:test`） |
| 内容导入与兼容报告 | `npm --prefix engine run content:check`（也可 `npm run engine:content`） |
| 定向回归示例 | `node --test engine/test/tutorial-maps.test.mjs`，按实际改动选择测试文件 |
| 客户端纯逻辑回归 | `node --test engine/client/*.test.mjs` |
| 真实 MySQL 集成测试 | 启动项目数据库后执行 `npm --prefix engine run test:integration` |
| 3D 浏览器验证 | `npm --prefix engine run test:3d`；先核实浏览器依赖与脚本配置 |
| UI 与地图视觉改动 | 参考 `engine/client/VERIFICATION.md` 及对应 `engine/tools/verify-*-ui.mjs`，实际操作并查看截图 |

- 默认测试会跳过需要真实 MySQL 的测试组，不能据此声称数据库集成已通过。`test:integration` 会写入测试账号或临时 schema，并清理本轮数据，运行前核对目标连接。
- 内容检查输出兼容诊断；命令成功不表示所有旧插件和事件语义已支持，应检查与本次改动有关的诊断。
- 浏览器验证脚本可能需要配置 `PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE`，部分还需真实数据库。先读所选脚本的依赖及副作用，不把某台机器上的默认绝对路径当作通用配置。
- 逻辑修复增加能复现问题的针对性回归；纯文档修改核对路径、命令和差异即可。视觉正确性不能只靠单元测试判断。
- 截图、测试报告和编辑器备份放在已忽略的 `engine/.artifacts/`；不要将本机生成物、依赖目录或数据库文件加入提交。

## 文档与交付

- 开始修改前检查工作区，保留用户已有改动，控制改动范围。完成后检查差异，说明修改内容、实际运行的验证及未验证项。
- 启动方式、接口或兼容边界改变时同步 `engine/README.md`；设计决策和阶段记录放在 `doc/`，并按需更新 `doc/README.md` 索引。记录日期使用 UTC。
- 历史验收保留当时的事实；后续修复新增带日期的记录，不将旧记录改写为当时尚未实现的能力。
