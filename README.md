# IS4PR 车辆关联件管理

这个静态网站将 Excel《IS4PR车辆管理表.xlsx》的 `关联件管理` 工作表转换为“车辆 → 关联件 → 版本字段”的结构：

- 车辆以卡片方式展示；点击后查看该车全部关联件版本。
- 游客无需登录即可查看与导出关联件信息。
- 非管理员账号登录后仍只有查看与导出权限。
- `admin` 角色可新增、编辑、删除车辆和每条关联件版本记录。
- 生产数据保存在 Supabase；前端不保存服务角色密钥。
- 旧的“关联件影响问题”界面已从网站移除。

仓库中的 `data/vehicle-components.demo.json` 仅包含脱敏演示数据。由 Excel 提取的完整数据输出到 `data/vehicle-components.local.json`，已被 `.gitignore` 忽略，不会提交到 GitHub。

## Supabase 初始化

1. 在 Supabase 的 SQL Editor 中执行 [`supabase/schema.sql`](supabase/schema.sql)。它会创建 `vehicles`、`vehicle_component_versions`、用户角色和 RLS 策略。
2. 如需彻底删除旧站的“关联件影响问题”远端记录，再执行 [`supabase/remove-legacy-issue-data.sql`](supabase/remove-legacy-issue-data.sql)。该脚本删除旧的 `sheet-1` 配置及其级联行数据。
3. 如需只读账号或管理员账号，可使用网站右上角的登录入口注册，或在 Supabase Authentication 中创建账号。游客不登录也可以直接查看关联件信息。
4. 将需要编辑权限的账号设置为管理员：

   ```sql
   update public.profiles
   set role = 'admin'
   where email = 'your-admin@example.com';
   ```

5. 在 Supabase Authentication 的 URL Configuration 中加入 GitHub Pages 地址，例如 `https://stella-ck.github.io/is4pr-vehicle/`，以便邮箱验证后返回网站。

如果线上环境已经执行过旧版权限策略，请再执行一次 [`supabase/enable-public-read.sql`](supabase/enable-public-read.sql)，把车辆和关联件版本表的读取权限开放给游客。

RLS 现在允许匿名游客和已登录用户读取车辆数据；插入、修改、删除仍仅允许 `admin` 角色。前端的 `window.APP_CONFIG` 只使用 anon public key，`SUPABASE_SERVICE_ROLE_KEY` 只能在本地导入时使用。

## 从 Excel 导入

在项目根目录运行：

```powershell
npm run build-vehicle-data -- -SourceWorkbook "C:\Users\xiaojia.liu.ext\Desktop\work\4PR\【M】IS4PR车辆管理表.xlsx"
```

脚本会识别第 2 行的 IS4PR 车辆表头，并将每辆车列中的版本值展开成 `data/vehicle-components.local.json`。当前工作簿会生成 13 辆车的关联件版本记录。

然后导入到 Supabase：

```powershell
$env:SUPABASE_URL = "https://your-project.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "your-service-role-key"
npm run import-vehicle-data -- .\data\vehicle-components.local.json --replace
```

默认导入会更新同一“车辆 + 关联件 + 版本字段”的记录，并保留未出现在本次文件中的旧记录。加上 `--replace` 会先清空本次导入车辆的所有关联件版本，再写入最新 Excel 内容，适合完整同步。

## 本地预览与部署

安装依赖后，可用任意静态服务器预览：

```powershell
npm install
npx serve .
```

在未完成 Supabase 初始化前，可追加 `?demo=1` 强制查看脱敏卡片预览。也可以直接部署整个目录到 GitHub Pages。`index.html` 已包含前端 Supabase 配置；若切换 Supabase 项目，只需替换其中的 `supabaseUrl` 和 `supabaseAnonKey`。不要把本地 Excel、`data/vehicle-components.local.json` 或服务角色密钥提交到 GitHub。

## 维护入口

- 网站右上角：游客查看、登录/退出、刷新数据。
- 车辆卡片：按车辆编号、VIN 或关联件关键词搜索。
- 管理员：新增车辆，编辑或删除车辆；在车辆详情中新增、编辑、删除任意版本字段。
- 游客和所有已登录用户：导出当前车辆的 CSV 版本清单。
