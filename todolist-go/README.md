# Go TodoList

使用 Go 标准库构建的轻量级 TodoList Web 应用，支持新增、完成/取消完成、删除和状态筛选。任务以 JSON 文件保存，重启后仍然保留。

## 启动

需要 Go 1.22 或更高版本。在本目录运行：

```bash
go run .
```

浏览器打开 <http://localhost:8080>。

## 配置

- `TODO_ADDR`：监听地址，默认 `:8080`。例如 `127.0.0.1:8080`。
- `TODO_DATA`：任务文件路径，默认 `data/tasks.json`。

## API

- `GET /api/tasks`：获取任务列表
- `POST /api/tasks`：创建任务，JSON 格式 `{"title":"任务内容"}`
- `PATCH /api/tasks/{id}`：更新任务，JSON 字段可选 `title`、`done`
- `DELETE /api/tasks/{id}`：删除任务
