# 发布与更新

面向你自己（维护者）的操作手册。用户那一侧的更新方式在文末。

---

## 一、第一次发布

### 1. 准备认证（三选一）

| 方式 | 命令 | 适用 |
|---|---|---|
| **PAT** | `.\scripts\publish.ps1 -Token ghp_xxx` | 最通用，一次粘贴 |
| **gh CLI** | `.\scripts\publish.ps1 -Gh` | 已装 gh 并登录 |
| **SSH** | `.\scripts\publish.ps1 -Ssh` | 长期使用，不用每次给 token |

**PAT 怎么拿**：https://github.com/settings/tokens → Generate new token (classic) → 勾 `repo` → 有效期建议 30 天。

> token 不要写进任何文件。脚本只把它用在这一次 push 的 URL 里，不落盘。

### 2. 跑一次

```powershell
cd E:\AIRP\_work\mini-phone
.\scripts\publish.ps1 -Token ghp_xxxxxxxx
```

脚本会做四件事：

1. 检查有没有未提交的改动（有就问你要不要先提交）
2. 确认分支是 `main`
3. 用 GitHub API 建仓库（已存在就跳过）
4. 推送

跑完会打印仓库地址。

### 3. 如果脚本挂了

手动走一遍：

```powershell
# 建仓库（网页上建也行，但不要勾 README/.gitignore）
# https://github.com/new  → 名字填 mini-phone → 什么都别勾

git remote add origin https://github.com/GGGFFF-Create/mini-phone.git
git push -u origin main
# 弹窗要求认证时，密码位置粘贴 PAT（不是账号密码）
```

---

## 二、日常更新（这是你以后最常用的）

### 改完代码 → 三件事

```powershell
cd E:\AIRP\_work\mini-phone

# 1. 先跑测试（别跳过，这是唯一的安全网）
node tests\core.test.mjs
node tests\integration.test.mjs
node tests\load-check.mjs

# 2. 提交
git add -A
git commit -m "feat: 加了语音播放"

# 3. 推
git push
```

`git push` 之后如果还要求认证，说明 PAT 过期了 —— 重新生成一个。

### 提交信息怎么写

用前缀区分类型，以后翻记录时一眼能看出改了什么：

| 前缀 | 用在 |
|---|---|
| `feat:` | 新功能 |
| `fix:` | 修 bug |
| `refactor:` | 重构（行为不变） |
| `docs:` | 只改文档 |
| `test:` | 只改测试 |
| `chore:` | 杂事（依赖、配置） |

例子：

```
feat: 语音播放 —— 点击台词用角色音色朗读
fix: 重抽后手机上残留旧消息
refactor: 把 stores 拆成 threads / moments / kv
```

---

## 三、发版本（想让用户看到"有更新"时）

### 版本号要改两处

```
manifest.json   → "version": "0.2.1"
index.js        → const VERSION = '0.2.1';
```

**两处必须一致**，`load-check` 会校验。不一致时会报：

```
✗ 版本号不一致：manifest 0.2.1 ≠ index.js 0.2.0
```

**为什么两处都要**：

- `manifest.json` 的版本是给酒馆看的（扩展列表里显示）
- `index.js` 的 `VERSION` 是给 iframe 用的（`ui/index.html?v=0.2.1`）

**第二处是关键。** 不带版本号，浏览器会缓存 `ui/*.js`，用户点了更新、刷新页面，看到的还是旧界面，然后来问你"为什么没变"。

### 发版本的完整流程

```powershell
# 1. 改两处版本号
# 2. 更新 README 的"当前版本"
# 3. 跑自检
node tests\load-check.mjs

# 4. 提交并打标签
git add -A
git commit -m "release: 0.2.1"
git tag v0.2.1
git push
git push --tags
```

打 tag 的作用：GitHub 上会自动生成一个 release 页面，用户能看到版本历史。

### 版本号怎么定

```
0.2.0 → 0.2.1   修 bug
0.2.0 → 0.3.0   加功能
0.2.0 → 1.0.0   第一个"敢让别人装"的版本
```

现在还是 0.x，意思是**接口随时可能变，数据格式也可能变**。等到聊天、语音、生图都稳定了再发 1.0。

---

## 四、用户那边怎么更新

### 装过一次的

在酒馆里：**扩展 → 扩展管理 → 找到「小手机」→ 点"更新"**。

酒馆会在扩展目录里执行 `git pull`，然后让用户刷新页面。

### 为什么用户不会自动收到更新

`manifest.json` 里 `"auto_update": false`。

这是故意的：自动更新意味着用户可能在写到一半时被换掉代码。让他们自己决定什么时候更新更稳。

想开自动更新就改成 `true`。

### 更新后用户看到旧界面怎么办

如果版本号改对了（`index.js` 的 `VERSION` 也改了），不会出现这个问题。

万一还是旧的：

1. 让用户 `Ctrl + F5` 强制刷新
2. 或者检查 `index.js` 里的 `VERSION` 有没有改

**这是最常见的"更新了但没变"的原因。**

---

## 五、把仓库地址给用户

装法有两种，都写进 README 里：

**方式一：酒馆里装**

```
扩展 → 安装扩展 → 粘贴 https://github.com/GGGFFF-Create/mini-phone
```

**方式二：手动**

```powershell
cd <SillyTavern>\public\scripts\extensions\third-party
git clone https://github.com/GGGFFF-Create/mini-phone.git
```

第二种的好处：以后能用 `git pull` 更新。第一种酒馆会自己处理。

---

## 六、常见问题

### push 被拒：`rejected (fetch first)`

远端有你本地没有的提交（比如在网页上改过文件）。

```powershell
git pull --rebase
git push
```

### 提交里混进了不该提交的东西

```powershell
# 还没 push 的话
git reset --soft HEAD~1
# 把文件加进 .gitignore，再重新提交
```

已经 push 了就得用 `git rm --cached 文件名` 再提交一次（历史里还在，但至少以后不会了）。

**如果误传了 token 或密钥**：立刻去 GitHub 撤销那个 token，光删文件没用 —— 历史里还在。

### 本地改乱了想回到上次提交

```powershell
git checkout -- .        # 丢弃所有未提交的改动
git status               # 确认
```

### 想知道哪些文件被 .gitignore 挡住了

```powershell
git status --ignored --short
```

现在被挡住的是四份设计笔记：

```
ARCHITECTURE.md
BUDGET.md
CONTEXT.md
PHONE-LINK.md
```

它们是给你的内部文档（含对第三方项目的分析），不适合随代码公开。想公开的话，把 `.gitignore` 里那四行删掉，然后 `git add` 它们。

---

## 七、发布前的检查清单

```
□ node tests\core.test.mjs        全绿
□ node tests\integration.test.mjs 全绿
□ node tests\load-check.mjs       通过
□ manifest.json 和 index.js 版本号一致
□ README 的版本号和功能描述是新的
□ .gitignore 挡住了该挡的（尤其密钥）
□ 提交信息说清了改了什么
```

这七条能在发布前挡掉九成"发出去才发现"的问题。

---

## 八、一个提醒

现在项目还是 **0.2.0**，只在 API 层面验证过（签名来自酒馆 1.19 源码），**没有在真实酒馆里跑过端到端**。

第一次让用户装之前，你自己先装一遍。最可能出问题的两处：

1. **iframe 桥接** —— `parent.__miniPhone` 的时机（iframe 加载完成 vs enable 完成）
2. **三阶段渲染钩子** —— 酒馆版本不同，`messageFormatter.stage` 的可用性不同

这两处代码里都留了 fallback 和日志，出问题时控制台会有 `[mini-phone]` 开头的记录。
