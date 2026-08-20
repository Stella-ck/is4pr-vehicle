# IS4PR 关联件工作台

这是根据 Excel《IS4PR车辆管理表.xlsx》中以下两个工作表制作的静态网站预览：

- 关联件影响问题（136 列，线上数据放在 Supabase；仓库仅保留脱敏演示数据）
- 关联件管理（21 列，线上数据放在 Supabase；仓库仅保留脱敏演示数据）

## 已实现

- 饱和紫 / 蓝 / 青配色的响应式工作台界面
- 两个工作表切换
- 全局关键词搜索、常用状态筛选、记录统计
- 普通用户无需登录即可查看
- 管理员登录后可双击编辑任意单元格
- 管理员可新增行、删除行、导出当前视图
- Supabase Auth 邮箱密码登录
- Supabase 数据库存储、RLS 权限控制
- GitHub Pages 可直接托管的静态前端

## 预览

直接双击 `index.html` 可能会被浏览器的本地文件安全策略拦截 JSON 加载。可以在此目录启动任意静态服务器，或直接把整个目录上传到 GitHub Pages。预览演示账号：

- 邮箱：`admin@demo.local`
- 密码：`admin123`

演示模式会把编辑结果保存在浏览器的 localStorage 中，不会写入线上数据库。

## 接入 Supabase

1. 在 Supabase 建立项目。
2. 打开 SQL Editor，执行 `supabase/schema.sql`。
3. 在 Authentication → Users 中创建管理员邮箱账号。
4. 首次登录后，在 SQL Editor 将账号设为管理员：

   ```sql
   update public.profiles
   set role = 'admin'
   where email = 'your-admin@example.com';
   ```

5. 安装依赖并导入 Excel 种子数据：

   ```bash
   npm install
   set SUPABASE_URL=https://your-project.supabase.co
   set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   npm run import-seed -- "C:\\path\\to\\full-seed-data.json"
   ```

   `SUPABASE_SERVICE_ROLE_KEY` 只用于本地导入，绝不能放到前端或 GitHub Pages。

6. 编辑 `index.html` 中的 `window.APP_CONFIG`：

   ```js
   window.APP_CONFIG = {
     supabaseUrl: 'https://your-project.supabase.co',
     supabaseAnonKey: 'your-anon-public-key'
   };
   ```

   前端只放 Supabase anon public key；RLS 会阻止未登录用户写入。

## 部署到 GitHub Pages

1. 新建 GitHub 仓库，例如 `is4pr-linked-parts-portal`。
2. 将本目录内的文件上传到仓库根目录。
3. 在仓库 Settings → Pages 中选择 `Deploy from a branch`、`main`、`/root`。
4. 等待 GitHub Pages 完成发布。
5. 在 Supabase Authentication → URL Configuration 中把 GitHub Pages 地址加入 Site URL / Redirect URLs。

如果后续要增加附件、图片、操作审计日志，可以继续使用 Supabase Storage 和 `audit_logs` 表扩展。


> 安全说明：GitHub 仓库只放脱敏演示数据。Excel 全量数据保留在本地预览包中，应通过 scripts/import-seed.mjs 导入 Supabase，不建议直接提交到公开仓库。



仓库前端不携带 Excel 数据文件；未配置 Supabase 时显示内置脱敏演示数据，配置 Supabase 后直接读取数据库。

