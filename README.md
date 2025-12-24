# 家庭圈洞察看板（评委使用说明）

本仓库提供一个可在线访问的 H5 看板，用于展示家庭圈查询与可解释洞察：
- 输入 `subs_id`：查看成员列表、关系图、证据边、画像信息
- 可选 AI 面板：对当前家庭圈做结构化解读（需配置 API Key）

## 在线访问
- 评委可直接访问 Vercel 部署地址（由提交方提供）。

## 部署到 Vercel（项目导入后一次性配置）

在 Vercel 创建项目并导入该 GitHub 仓库后：
- **Framework Preset**：Other
- **Root Directory**：`web`
- **Build Command / Output Directory**：留空

环境变量（Project Settings → Environment Variables）：
- **必须**：`ZHIPU_API_KEY`（用于 `/api/ai`）
- **可选**：`ZHIPU_MODEL`（默认 `GLM-4-Flash-250414`）

部署完成后：
- 主页：`/`
- AI 接口：`/api/ai`

## 本地运行（用于复现演示效果）

```bash
cd web
export ZHIPU_API_KEY=你的Key
node local_dev_server.js --port 5173
```

打开 `http://localhost:5173` 即可。



