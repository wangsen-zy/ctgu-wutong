# 部署到 GitHub + Vercel（按本仓库当前实现）

## Vercel 部署（推荐做法：Root Directory 指向 `web/`）

本项目的在线页面与接口都在 `web/` 目录下：
- 静态页面：`web/index.html` + `web/app.js`
- Serverless API：`web/api/ai.js`（对应线上 `/api/ai`）
- 数据文件：`web/data/family.db`（浏览器端下载后用 sql.js 打开查询）

### 在 Vercel 的设置
- **Framework Preset**：Other
- **Root Directory**：`web`
- **Build Command**：留空
- **Output Directory**：留空
- **Environment Variables**：
  - `ZHIPU_API_KEY`：必填（用于 `/api/ai` 调用智谱）
  - `ZHIPU_MODEL`：可选（默认 `GLM-4-Flash-250414`）

> 注意：`web/data/family.db` 会作为静态资源被客户端下载。只要网站能在线查询真实数据，就无法阻止用户在浏览器里拿到这份 DB（最多只能“增加一点下载难度”）。

## 本地运行（与线上一致）

进入 `web/` 后用本地 dev server 启动（会同时提供静态资源与 `/api/ai`）：

```bash
cd web
export ZHIPU_API_KEY=你的Key
node local_dev_server.js --port 5173
```

打开 `http://localhost:5173` 即可。

## China-Mobile-Wutong（家庭圈用户识别模型）

本仓库包含两部分：

- **离线预计算（Python）**：从官方 xlsx 数据生成关系边概率、家庭圈、关键人、家庭画像等产物
- **H5 展示（纯静态）**：浏览器端加载 SQLite（sql.js），支持输入 `subs_id` 查询家庭圈图、证据链与画像；适配 Vercel 静态部署

---

### 1) 环境安装

```bash
python -m pip install -U -r requirements.txt
python -m pip install -e .
```

> 说明：`--device gpu` 需要你的 LightGBM 本地安装支持 GPU；不支持时用 `--device cpu`。

---

### 2) 生成离线预计算产物（parquet）

以“无标识的待验证数据”为例（默认会训练模型，但**不会把模型保存**的情况已修复：现在会把模型落盘到 `--out/model/`，后续可直接复用，不用每次重训）：

```bash
python scripts/run_offline_pipeline.py \
  --xlsx "dataset/AI+数据1：数据应用开发-家庭圈用户识别模型.xlsx" \
  --out "artifacts/valid_unlabeled_gpu3" \
  --score_sheet "无标识的待验证数据" \
  --device gpu
```

产物目录包含：

- `edges.parquet`：候选用户对 + `same_family_prob` + 证据字段
- `families.parquet`：`subs_id -> family_id_pred` + `key_person_flag`
- `family_profile.parquet`：家庭画像聚合
- `manifest.json`：阈值与统计信息

可选：生成 `cv_metrics.json`（写技术文档用，按家庭分组交叉验证）：

```bash
python scripts/run_offline_pipeline.py \
  --xlsx "dataset/AI+数据1：数据应用开发-家庭圈用户识别模型.xlsx" \
  --out "artifacts/cv_gpu" \
  --score_sheet "无标识的待验证数据" \
  --device gpu \
  --cv
```

#### 一次性导出 xlsx 的全部数据（训练/验证无标识/新增测试）用于前端查询（推荐）

```bash
python scripts/run_offline_pipeline.py \
  --xlsx "dataset/AI+数据1：数据应用开发-家庭圈用户识别模型.xlsx" \
  --out "artifacts/train_for_ui" \
  --export_sheets all \
  --train_mode auto \
  --device gpu
```

> 说明：当 `--export_sheets all` 时，会在 `artifacts/train_for_ui/` 下生成 `train/valid_unlabeled/test_unlabeled` 三个子目录（各自包含 `edges.parquet/families.parquet/family_profile.parquet/manifest.json`），并在 `artifacts/train_for_ui/model/` 保存可复用的 LightGBM 模型与元信息。

#### 新增/更新数据后不想重训怎么办？

- **复用旧模型直接打分**：把旧模型目录传给新的输出目录即可

```bash
python scripts/run_offline_pipeline.py \
  --xlsx "dataset/你的新数据.xlsx" \
  --out "artifacts/train_for_ui_new" \
  --export_sheets all \
  --train_mode never \
  --model_dir "artifacts/train_for_ui/model" \
  --device gpu
```

---

### 3) 构建 H5 使用的 SQLite（浏览器端可查询）

```bash
python scripts/build_ui_sqlite.py \
  --artifacts "artifacts/valid_unlabeled_gpu3" \
  --out_db "web/data/family.db" \
  --topk_edges_per_family 200

cp -f "artifacts/valid_unlabeled_gpu3/manifest.json" "web/data/manifest.json"
```

如果你使用了上面的 `--export_sheets all`（一个 root 目录包含多个子产物目录），可以这样构建 UI DB（会自动收集子目录）：

```bash
python scripts/build_ui_sqlite.py \
  --artifacts_root "artifacts/train_for_ui" \
  --out_db "web/data/family.db" \
  --out_manifests "web/data/manifests.json" \
  --topk_edges_per_family 200
```

> 注意：前端现在支持“同一 subs_id 在多个数据集命中时切换查看”，因此不再会按 subs_id 单列去重吞数据。

---

### 4) 本地启动 H5（纯静态）

```bash
cd web
python -m http.server 5173 --bind 0.0.0.0
```

浏览器打开 `http://<你的机器IP>:5173/`，输入 `subs_id` 查询即可。

---

### 5) Vercel 部署建议

这是纯静态站点：

- **Root Directory** 选择 `web`
- 不需要 build command（或留空）

将 `web/data/family.db` 与 `web/data/*.json` 一并部署即可。

---

### 6) AI 智能交互（可选，推荐加分）

H5 页面提供“智能解读/运营建议/问答”面板，通过 Vercel 的 Serverless Function `/api/ai` 调用智谱 `glm-4.5-flash`（完全免费模型，注意速率限制）：

- 官方模型说明：[`glm-4.5-flash` 使用指南](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.5-flash)

#### 配置方式（不要把 Key 写进前端/仓库）

在 Vercel 项目 Settings → Environment Variables 中设置：

- `ZHIPU_API_KEY` = 你的智谱 API Key

然后重新部署即可生效。

> 安全建议：请不要在聊天/仓库里粘贴真实 Key；如果已经泄露，建议尽快在平台侧轮换/作废旧 Key。

#### 本地测试为什么会报 501？

如果你用 `python -m http.server` 启动的是**纯静态服务器**，它不支持 POST，也不会执行 `web/api/ai.js`，所以前端调用 `/api/ai` 会返回 **501**。

#### 本地启用 `/api/ai` 的正确方式（推荐）

用 Vercel 本地开发模式启动（会同时跑静态资源 + Serverless Functions）。注意：Vercel CLI 需要较新的 Node（建议 Node ≥ 18）：

```bash
# 安装 vercel CLI
npm i -g vercel@latest

cd web
# 在 web/.env.local 配置 ZHIPU_API_KEY（不要提交）
vercel dev --listen 5173
```

然后浏览器打开 `http://localhost:5173/` 测试 AI 面板即可。

#### 如果你的机器 Node 版本较低（例如 Node 14）

可以用本项目提供的本地 dev server（兼容 Node 14），同样支持 `/api/ai`：

```bash
cd web
export ZHIPU_API_KEY=你的Key
node local_dev_server.js --port 5173
```


