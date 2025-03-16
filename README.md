# MCP 客户端项目

基于TypeScript开发的Model Context Protocol（MCP）客户端实现，提供多AI平台集成和MCP服务器管理功能。


## 功能特性
- 📡 MCP协议标准实现（v1.5.0）
- 🤖 多AI平台支持（Anthropic Claude/OpenAI）
- 🔌 可扩展的MCP服务器连接管理
- 🔒 环境变量加密配置
- 🚀 开发/生产双模式支持
- 🛠️ 工具调用可视化追踪

## 技术栈
- **运行时**: Node.js 16+
- **语言**: TypeScript 5.7
- **核心依赖**: 
  - `@modelcontextprotocol/sdk` 
  - `@anthropic-ai/sdk`
  - `openai`
- **工具链**: 
  - TypeScript 5.7
  - npm 9+

## 快速开始

### 1. 环境准备
```bash
# 安装依赖
npm install

# 复制环境模板
cp .env.example .env
```

### 2. 配置设置
编辑`.env`文件:
```ini
# Anthropic配置
ANTHROPIC_API_KEY=your_claude_key

# OpenAI配置 
OPENAI_API_KEY=your_openai_key
OPENAI_BASE_URL=https://api.openai.com/v1

# MCP服务器配置见mcp_settings.json
```

### 3. 运行模式
**开发模式**（实时重载）:
```bash
npm run dev
```

**生产构建**:
```bash
npm run build
# 输出文件在/build目录
```

## 项目结构
```tree
├── index.ts            # 主入口（MCP客户端实现）
├── mcp_settings.json   # MCP服务器配置
├── package.json        # 依赖管理
├── tsconfig.json       # TypeScript配置
├── .env.example        # 环境变量模板
└── README.md           # 项目文档
```

## MCP服务器配置示例
编辑`mcp_settings.json`:
```json
{
  "mcpServers": {
    "api-server": {
      "command": "node",
      "args": [
        "D:/mcp/mcp-api-server/build/index.js"
      ],
      "env": {
        "BASE_URL": "https://127.0.0.0:8080",
        "CLIENT_ID": "xxx",
        "CLIENT_SECRET": "xxx",
        "USERNAME": "xxx",
        "PASSWORD": "xxx",
        "TENANT_ID": "1",
        "REJECT_UNAUTHORIZED": "false"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## 核心功能调用
```typescript
// 初始化客户端
const client = new MCPClient();

// 连接MCP服务器
await client.connectToServer({
  command: "node",
  args: ["path/to/server.js"],
  env: { API_KEY: "secret" }
});

// 执行AI查询
const response = await client.processQuery("显示当前用户列表");
```

## 许可协议
本项目基于 [MIT License](LICENSE) 授权。
