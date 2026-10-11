# 来源与适用边界

查阅日期：2026-10-11。以下是教程作者、RPG Maker 官方手册/源码和 OpenAI 官方文档的一手来源。只提炼短小原则，不打包教程原文、示例图片或商业图块。部分官方博客同时显示旧日期和统一更新日期，因此不以页面日期判断教程首次发表时间。

## 制图教程

| 编号 | 来源 | 直接支持的内容 | 本 Skill 如何使用 |
| --- | --- | --- | --- |
| T1 | Avery：[Tutorial - Mapping: Interior](https://www.rpgmakerweb.com/blog/tutorial-mapping-interior) | 室内形状应有用途，注意墙高、楼梯、家具落地与过大面积 | 功能和空间一致性检查；不把示例墙高定成全项目标准 |
| T2 | Avery：[Mapping: Towns](https://www.rpgmakerweb.com/blog/mapping-towns) | 城镇生活/生产、目的地与道路、材料协调、玩家实际画面 | 地点形成原因、功能相邻关系与视口检查 |
| T3 | Avery：[Mapping Forests](https://www.rpgmakerweb.com/blog/mapping-forests) | 大形到细节，林间空隙、使用痕迹、季节与探索地点 | 组织自然环境与疏密；不把作者偏爱的树木数量变成限制 |
| T4 | Avery：[Tips and Tricks: Mapping Cliffs](https://www.rpgmakerweb.com/blog/tips-and-tricks-mapping-cliffs) | 平台高差一致、预留通路、道路/洞穴用途、崖脚碎石关系 | 先处理地形成立，再处理自然变化；保留人工直线地形 |
| T5 | Avery：[How to Map a Desert](https://www.rpgmakerweb.com/blog/how-to-map-a-desert) | 地图用途、辽阔与行走、方向辨认、水与植被、避免重复杂物 | 有意义的空地与地标；不统一缩小或填满所有地图 |
| T6 | Avery：[Tile Edits So Simple, ANYONE Can Do Them!](https://www.rpgmakerweb.com/blog/tile-sets-so-simple-anyone-can-do-them) | 图块表内摆放影响家具落地；局部编辑/组合可复用 | 核实素材锚点和整件组合；素材改动范围仍由用户任务决定 |
| T7 | Avery：[Parallax Mapping in MZ: Basics and Tips](https://www.rpgmakerweb.com/blog/parallax-mapping-in-mz-basics-and-tips) | 视差制图的自由度、制作成本、通行/动画问题及与编辑器制图的取舍 | 不把新增视差方案当成所有布局问题的默认解法 |
| T8 | hiddenone：[Upgrading a Generated Dungeon](https://www.rpgmakerweb.com/blog/upgrading-a-generated-dungeon) | 自动迷宫可改成有用途的空间，先布局/出入口，再细节；注意事件空间和阻路 | 原始布局需经过设计加工；粗图先验证，不无限精修 |

## 关卡设计方法

| 编号 | 来源 | 直接支持的内容 | 适用边界 |
| --- | --- | --- | --- |
| L1 | The Level Design Book：[Flow](https://book.leveldesignbook.com/process/layout/flow) | 动线与速度、方向、寻路、尺度有关；标记主要路线；粗搭建和试玩检验体验 | 主要使用 3D 示例；本 Skill 将方法适配为 2D 格子地图，不照搬尺寸或战斗规则 |
| L2 | The Level Design Book：[Typology](https://book.leveldesignbook.com/process/layout/typology) | 布局类别帮助交流，也可能限制设计；不同结构有不同用途 | 用于解释候选和批次关系，不规定每图必须使用不同类型 |

## 引擎规格与技术核对

| 编号 | 官方资料 | 用途 |
| --- | --- | --- |
| E1 | [MV — Editing Map Designs](https://rpgmakerofficial.com/product/MV_Help/page/01_07_01.html) | 自动图块、Shift 操作、上下层的编辑规则 |
| E2 | [MZ — Editing Map Designs](https://rpgmakerofficial.com/product/MZ_help-en/01_07_01.html) | 手动四层选择、自动图块和阴影编辑 |
| E3 | [MZ — Tileset Settings](https://rpgmakerofficial.com/product/MZ_help-en/01_08_10.html) | 通行、四方向、星标、柜台、草丛和地形标签 |
| E4 | [MZ — Asset Standards](https://rpgmakerofficial.com/product/MZ_help-en/01_11_01.html) | 素材的布局和命名约定；以实际项目版本为准 |
| E5 | [MZ API — Tilemap.js](https://rpgmakerofficial.com/product/mz/rmmz_api/Tilemap.js.html) | 图块数据读取、四个图块平面、阴影、自动图块与绘制 |
| E6 | [MV 官方 corescript 仓库](https://github.com/rpgtkoolmv/corescript) | 参照 Tilemap、Game_Map、Game_CharacterBase、Game_Interpreter；最终核对用户项目中的版本 |
| E7 | [MV — Movement](https://rpgmakerofficial.com/product/MV_Help/page/01_10_06.html) / [MZ — Movement](https://rpgmakerofficial.com/product/MZ_help-en/01_10_06.html) | 传送的直接指定与变量指定、位置/移动指令 |

不要把网页上的默认尺寸、未安装插件的行为或示例版本覆盖到用户项目。Region ID、坐标引用和插件扩展还应在项目自己的 objects/core 脚本中核对。

## Skill 结构与调用

OpenAI：[Build skills](https://learn.chatgpt.com/docs/build-skills)。用于核对 `SKILL.md`、可选 references/scripts、显式调用及本地发现位置。Skill 的具体存放和同步服从当前环境；不假定所有设备自动共享同一个个人 Skill。

## 本 Skill 自行综合的部分

“Sample 素材语法表”“单张设计卡”“整批布局对照”“先做有区别的代表图”“数据/静态视觉/整批设计/实机行为分别记录”、现代九类场所示例，以及只读清点脚本，都是本次把参考原则转成可执行流程的设计。它们不是教程原话，也不是经过用户项目 A/B 试验确认的效果保证。

教程的个人审美偏好只作参考。固定装饰百分比、必须环路、禁用 U 形、禁止对称、按算法给审美总分等规则没有在本 Skill 中作为通用标准。
