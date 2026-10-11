# Browser client verification

## Verified locally on 2026-10-06

- Actual in-app browser: login, persisted account after server restart, map transfer to Rural and School Hall, tile/character rendering, direction-key taps, existing equipment-repair dialogue and its No branch, imported Curry Bread recipe, and development loadout.
- Inventory remained open while the authoritative tick advanced from 910 to 1376 and forbidden-zone damage changed HP from 544 to 404. Browser warning/error log was empty on the checked map views.
- The automated suite passed 38 non-database checks. The separately enabled MySQL suite passed 12 reported tests (including parent groups), covering two WebSocket clients, attacks/death/drop pickup, idempotency, reconnect, all 30 map HTTP loads and 27 playable transfers. This is not a claim of visually testing all maps or running a capacity test.
- Not completed: exhaustive plugin/skill semantics, two simultaneously operated browser UIs, responsive-layout sweep and long-duration network fault testing.

This client is an independent Canvas 2D renderer and ES-module application. It does not load `rpg_core.js`, `rpg_objects.js`, `rpg_scenes.js`, PIXI, or RPG Maker plugins. Autotile quarter-coordinate tables describe the existing MV/MZ file format and come from this project's legacy runtime.

Run the decoder and protocol regression tests with `node --test engine/client/*.test.mjs` from the repository root. The tests compare every tile actually present in the project's maps across twelve animation phases against isolated legacy decoder functions, check character-sheet slicing and map wrapping, and verify forbidden-zone activation/expiry boundaries using the server clock.

Browser integration checklist, to run against the new engine HTTP server:

1. Open `/`, inspect the login screen, and enter content preview without a database account.
2. Inspect Map001 (overworld water), Map026 and Map029 (ARPG tests), an interior table/ceiling map, and the large map. Check autotile edges, water animation, table edges, object characters, shadows, and star-layer occlusion.
3. Switch through all maps. Missing resources must appear in the compatibility panel instead of crashing the client.
4. Register/login, move and attack. Use two browser sessions to confirm remote movement and damage updates while one session's inventory panel remains open.
5. Exercise development loadout, spawn enemies, skill selection, inventory use/equip, recipes, death/respawn, and forbidden-zone warnings.
6. Test dialogue continuation/choices, map transfer, music toggle and resource errors.
7. Disconnect and reconnect the server connection; inspect authoritative snapshots after reconnect. No gameplay operation is queued locally for later replay.
8. Capture desktop login, map preview, connected ARPG and inventory screenshots. Inspect at a narrow viewport for overflow.

Known explicit compatibility boundaries at the original October 6 baseline: standard 48-pixel tiles and MV image-sheet animations. The subsequent Effekseer integration is documented below; plugin-specific character-layout decoding, plugin runtime execution and parallax plugin layers remain separate work. Preview selects the first unconditional event page and does not execute commands. Looped maps can be read by the decoder, but the camera currently clamps at the authored map boundary.

## Protocol and session behavior

- The login/register form matches the API's 3–32-character username and 8–128-character password limits. Successful registration also logs in. Controls remain disabled until the content manifest is loaded.
- Each connection validates the session with `GET /api/session` and `Authorization: Bearer …`. A 401 returns to the login form; network failures and a temporarily unavailable database retry with increasing delays up to 15 seconds. Sessions are held by this server process, so a server restart requires logging in again; persisted player state remains in MySQL.
- Gameplay actions are sent only after the first authoritative snapshot. Map fetches are scoped to the current session generation so a late preview response cannot overwrite an online snapshot. Opening inventory/crafting/report stops local movement input but leaves the socket and rendering active.
- The zone warning and tint use `snapshot.serverTime`, `zone.startsAt` and `zone.endsAt`, never the browser clock. The current developer zone covers the entire map; future rectangular zones are also drawable.
- Account state is not simulated in preview. Switching out of an account clears stale dialogue, forbidden-zone status and transient picture/fade effects. Browser visibility changes clear held input; snapshots still restore authoritative state on return.
- Event presentations support MV sheet animations/balloons, basic image show/move/rotate/erase, audio, fades, flash and shake. Color tone is an approximation rather than MV's exact pixel shader. Unknown presentation codes are logged once and included in the compatibility panel. Audio panning, transition timing for audio fades, weather, number input and specialized plugin UI are not implemented. See the later Effekseer implementation notes for MZ effects.

## 副本、背包与角色外观验收（新增）

本轮客户端新增原 SRD CharacterCreatorEX 素材的分层组合；这不要求执行原插件。角色创建器使用服务端 `/api/appearance` 白名单，按全局顺序组合 Part1/Part2，提供原色板选择、脸图、四方向行走与侧视动作预览，以及已有 Actor 外观。客户端仅提交部件和色板编号，不上传合成图片。颜色矩阵以仓库中原 PIXI 的实际输出为回归基准，包括它的运算顺序。

主任务已用独立无头 Edge 验证外观换色保存、NPC 入局与开始，以及实际行走完成普通撤离，页面无 JavaScript 异常；完整 Boss 路线另由服务端真实地图移动与正常攻击回归通过。以下保留进一步手动验收流程：

1. 登录后出生于 Map040 中央街区 (20,23)。向东走到 Map041 榆风广场，找 (23,12)「远征接引员」；从街区 (8,12) 门进入 Map043 美容工作室，找 (10,8)「外观调整师」。方向键面向 NPC，按 E；服务 NPC 优先于附近掉落物响应交互。
2. 在外观调整师处切换部件与色板，确认脸图、行走、侧视预览同时变化；保存后检查地图角色与左上角脸图。第二个账号应看到同一套外观。换回「已有角色外观」后，确认新外观不改变战斗属性。
3. 在远征接引员处创建 PvE 或 PvPvE。第二个账号通过该 NPC 刷新列表、加入房间。房主点击「开始副本」。等待阶段不接受普通战斗命令。
4. 进入副本后，侧栏显示本局阶段、剩余时间与目标；「查看副本状态」显示玩家、钥匙、普通出口、禁区解除、Boss和终局出口状态。PvE禁用玩家互伤，PvPvE允许玩家互相攻击。
5. 打开背包测试「整理背包」与指定数量的「丢弃」。死亡掉落绘制为一个遗落背包，面板显示其中条目，点击「整包拾取」一次领取全部内容。普通物品依然单条拾取。
6. 保持一个客户端背包或外观面板打开，让另一客户端移动、战斗，确认快照持续刷新。第一轮仅实现「停留」；随后新增的离线策略见下方验收清单。
7. 普通撤离、终局通关、主动退出或死亡后返回世界均应显示对应结算。副本死亡按钮显示「结束行动并返回世界」，不调用普通世界重生。副本内关闭测试传送与开发按钮。

### 手动通关路线

坐标以地图左下角 HUD 的 X / Y 为准。移动使用 WASD / 方向键，J 或空格攻击，E 交互，Tab 背包。正式副本沿地图门口移动，不使用开发传送。

| 目标 | 实际地图与坐标 |
| --- | --- |
| 副本起点 | Map011，(22,22) |
| 初始补给 | Map011，箱子 (24,22)；靠近并面向箱子按 E |
| 通行证 | Map011 入口 (15,14) → Map012；保管箱 (8,13) |
| 普通出口 | Map011，(23,22)；持通行证解锁后所有人可用，再次 E 为个人撤离 |
| 封锁解除组件 | Map011 南出口 (22,48) → Map020；工具箱 (27,3) |
| 解除控制台 | 返回 Map011，入口 (26,38) → Map013；控制台 (8,8) |
| 进入最终区域 | Map020 (9,14) → Map021；Map021 (11,41) → Map022 |
| 终局 | 在 Map022 击败封锁守卫，拾取终局钥匙，前往终局出口 (12,7) 按 E |

解除普通禁区后，Map022 保持持续禁区。实际伤害、掉落、钥匙是否满足条件和结算始终由服务端判断。也可在拿到通行证后选择普通撤离，不进入最终战斗。

渲染场景身份包含 `instance.id` 和 `mapId`；相同地图编号进入不同副本时清理旧实体插值、特效、图片和对话。除账户外观保存外，操作包含其产生时的 `contextInstanceId`，让服务器拒绝串局的旧操作。加入命令的 `instanceId` 仍表示目标房间，与来源上下文分别保存。

## 2026-10-11 鼠标、触屏和装备面板扩展

客户端将地图点击提交为 `navigate` 意图，由服务端计算路径、碰撞、交互距离和攻击资源消耗，不在浏览器修改角色位置。地面点击是移动；点击 NPC 是靠近并交互；点击掉落物是靠近并领取；点击敌人或 PvP 场景中的其他玩家是靠近并攻击。按住指针会跟随新指向的格子更新目的地。右键或 Escape 打开 / 关闭背包，触屏双指取消；键盘移动、打开面板、失去焦点和换图会取消旧路径。内容预览的地面点击仅移动观察中心。

离线策略下拉提供停留、躲避、探物和追杀，在普通世界与副本侧栏都可操作。显示值来自服务端快照，修改提交为永久资料更新。装备面板以 `instanceId` 区分同种武器的不同个体，分别显示当前耐久和最大耐久；装备与丢弃指定个体。武器攻击方式、射程、弹药、MP 和耐久消耗读取服务端 `weaponProfiles`，弹药数量按真实物品库存统计。

本次已通过的独立回归：`node --test engine/test/navigation.test.mjs engine/client/pointer.test.mjs`，共 7 项；并通过 `node --check engine/client/app.mjs`。覆盖障碍绕行、动态碰撞、交互距离、非目标传送口避让、仅末步允许触碰阻挡传送口、搜索节点上限、循环地图、不可推断传送口、点选优先级、PvE 阻止误选玩家、双指取消不产生残留点击、武器个体耐久和弹药数量显示。浏览器实际验收由主任务另行记录，不能以这些单元测试代替。

本机无头 Edge 已实际完成：鼠标点击接引员入局／开始、点击补给箱自动搜刮、保存离线探物策略、背包显示耐久与成本、四种新武器装备后点击敌人并产生实际命中和原生 MZ 粒子。最终页面无 JavaScript 异常、无失败请求。粒子加载与画面已检查；四种武器截图位于 `engine/.artifacts/phase03-weapon-61.png` 至 `phase03-weapon-64.png`。这不是完整触屏设备兼容或多客户端压力测试。

后续手动验收清单：

1. 分别在 50%、100% 和 200% 缩放下点击空地，确认目的地标记、寻路绕障碍和停止位置一致。按住鼠标拖动改变终点，再用方向键接管。
2. 从服务 NPC 两格以上距离单击 NPC，确认靠近后打开界面；重复测试远处掉落物和正在移动的敌人。PvE 中点击其他玩家不发起攻击。
3. 单击地图触碰传送口，确认确实经入口换图，换图后无旧路径残留。打开背包时角色停止寻路，而敌人与禁区继续运行。
4. 右键、Escape 与触屏双指打开 / 关闭菜单，双指抬起后角色不继续走向两次触摸的位置。对话选择的取消由事件原有取消分支决定。
5. 修改离线策略，换图、进出副本并重新登录，确认选项持久保存；断开连接后由第二个客户端观察真实行为。
6. 持有两件同种不同耐久武器，分别装备和丢弃，确认面板始终对应正确个体；枪械弹药、法杖 MP 和投掷武器耐久随攻击由快照更新。
