# 小手机 · Mini Phone

给 SillyTavern 装一部小手机。角色在正文里发消息，手机上真的收到；手机里有自己的聊天和朋友圈。

**当前版本 0.2.0** — 聊天 + 朋友圈已可用，语音和生图是下一阶段。

## 它现在能做什么

| 能力 | 说明 |
|---|---|
| **台词识别** | 从正文里认出"谁说了什么、什么情绪、原文是什么"，渲染成可点的声波按钮 |
| **手机联动** | 正文里写 `<phone>`，消息、图片、转账、红包、语音、位置、礼物、歌曲、朋友圈真的出现在手机上 |
| **手机聊天** | 独立 API 聊天，上下文取自酒馆正文（可切"剧情内 / 半局外 / 局外"） |
| **朋友圈** | 角色自己发动态、给动态点赞评论；正文里写 `[朋友圈]` 也会进这里 |
| **主动发消息** | 回合制：每 N 条正文给一次机会，每天有上限 |
| **带进正文** | 把手机聊天一次性注入下一段正文，角色就"知道"了 |
| **预算可见** | 每次请求前能看到每一块占多少字 |

## 安装

```powershell
Copy-Item -Recurse . "<你的SillyTavern>\public\scripts\extensions\third-party\mini-phone"
```

刷新酒馆 → 扩展菜单（魔棒）→「小手机」→ 设置里填模型接口。

**目录名必须是 `mini-phone`**（和 manifest 的 `name` 一致）。

## 第一次用，按这个顺序

1. **配置模型** — 设置 → 模型接口。填 `https://api.xxx.com/v1` + key + 模型名，点"测试连接"
2. **让模型学会台词格式** — 酒馆里正常聊一轮，`enable()` 已经注入了格式规则
3. **看正文有没有声波按钮** — 有就说明协议通了
4. **打开手机发一条消息** — 消息 App → 选联系人 → 说话
5. **验证联动** — 回正文聊一轮，看手机有没有收到 `<phone>`

## 目录

```
manifest.json        扩展清单
index.js             宿主层（唯一 import SillyTavern 的文件）
style.css            宿主侧：手机窗口怎么摆

core/                不碰 DOM、不碰酒馆，可以直接跑测试
  markup.js          标记扫描器（替代正则链）
  protocol.js        台词协议：解析 / 渲染 / 剥离 / 诊断
  phone.js           <phone> 块解析 + 类型字典
  routes.js          角色名归一（别名 → 正式名）
  store.js           三档存储 + 角色卡隔离
  llm.js             模型客户端 + 上下文组装 + 漏斗取文
  chat.js            聊天业务（发消息 / 投递 / 撤回 / 主动）
  moments.js         朋友圈业务（生成 / 反应 / 导入）

ui/                  iframe 内的界面
  index.html
  phone.js           外壳：锁屏 / 桌面 / 路由
  apps.js            ★ App 注册表（唯一真源）
  theme.css          CSS 变量，换主题只改 :root
  apps/chat/         消息 App
  apps/moments/      朋友圈 App
  apps/settings/     设置 App

tests/
  core.test.mjs        64 项：扫描器、协议、解析、归一、漏斗
  integration.test.mjs 29 项：内存存储 + 假模型，跑完整链路
  load-check.mjs       装载自检
```

## 测试

```powershell
node tests\core.test.mjs         # 64 passed
node tests\integration.test.mjs  # 29 passed
node tests\load-check.mjs        # ✓ 全部通过
```

## 加一个 App

改两处：

```js
// ui/apps.js —— 加一行
{
  id: 'album', name: '相册', icon: '🖼️', accent: '#4a9af0',
  load: () => import('./apps/album/index.js'),
}

// 建 apps/album/index.js
export async function mount(root, ctx) {
  // root 是干净容器，ctx 里有 { api, state, toast, setTitle, navigate }
  return { title: '相册', back: () => false };
}
```

**没有第三步。** 桌面图标、路由、返回按钮都是壳提供的。

## 三个设计决定（为什么这么写）

**① iframe 隔离**
酒馆的 DOM 是战场（角色卡 CSS、正则美化、状态栏插件都在改）。手机放进去必然互相踩。iframe 给的是硬边界：你的样式永远不炸正文。

**② 同源直调，不走 postMessage**
单人项目里，消息名 + 请求 id + Promise 表那套样板代码不值当。
`parent.__miniPhone.bind(window)` 直接调函数，能传 Blob、能返回 Promise。
代价是 iframe 能摸到 parent —— 所以加了 `bind()` 的来源校验。

**③ 文本协议，不碰 MVU**
MVU 卡需要卡作者写变量定义。文本协议只需要模型按格式输出，普通卡和 MVU 卡都能用。这是"适配所有角色卡"的唯一低成本路径。

## 已知边界

- 只在 API 层面验证过（`setExtensionPrompt` / `messageFormatter` / `generateRaw` 来自酒馆 1.19 源码），**没有在真实酒馆里跑过端到端**
- 语音、生图未实现
- 不做插件系统（第三方 App）—— 对单人项目是负债
