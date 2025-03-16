import { Anthropic } from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";

import dotenv from "dotenv";

dotenv.config(); // load environment variables from .env

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY) {
  throw new Error("至少需要设置ANTHROPIC_API_KEY或OPENAI_API_KEY环境变量");
}

class MCPClient {
  private mcp: Client;
  private anthropic?: Anthropic;
  private openai?: OpenAI;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];

  constructor() {
    // Initialize Anthropic client and MCP client
    this.anthropic = ANTHROPIC_API_KEY ? new Anthropic({
      apiKey: ANTHROPIC_API_KEY,
    }) : undefined;

    this.openai = OPENAI_API_KEY ? new OpenAI({
      baseURL: OPENAI_BASE_URL,
      apiKey: OPENAI_API_KEY,
    }) : undefined;
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }

  async connectToServer(config: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }) {
    /**
     * Connect to an MCP server
     *
     * @param serverScriptPath - Path to the server script (.py or .js)
     */
    try {
      // Initialize transport with configured parameters
      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env
      });
      this.mcp.connect(this.transport);

      // List available tools
      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => {
        return {
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        };
      });
      console.log(
        "Connected to server with tools:",
        this.tools.map(({ name }) => name),
      );
    } catch (e) {
      console.log("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  private async handleOpenAIQuery(query: string) {
    if (!this.openai) throw new Error("OPENAI_API_KEY未配置");
    const completion = await this.openai!.chat.completions.create({
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: query
      }],
      tools: this.tools.map(tool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema
        }
      })),
      tool_choice: "auto"
    });

    const response = completion.choices[0].message;
    const finalText = [];
    const toolResults = [];

    if (response.tool_calls) {
      for (const toolCall of response.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        const result = await this.mcp.callTool({
          name: toolName,
          arguments: toolArgs,
        });
        toolResults.push(result);
        finalText.push(
          `[调用工具 ${toolName} 参数 ${JSON.stringify(toolArgs)}]`
        );

        // 将工具结果发送给OpenAI
        const followUpResponse = await this.openai!.chat.completions.create({
          model: "gpt-4o",
          messages: [{
            role: "user",
            content: query
          }, {
            role: "assistant",
            content: null,
            tool_calls: response.tool_calls
          }, {
            role: "tool",
            content: JSON.stringify(result.content),
            tool_call_id: toolCall.id
          }]
        });

        finalText.push(followUpResponse.choices[0].message.content || "");
      }
    } else {
      finalText.push(response.content || "");
    }

    return finalText.join("\n");
  }

  private async handleAnhropicAIQuery(query: string) {
    if (!this.anthropic) throw new Error("ANTHROPIC_API_KEY未配置");
    const messages: MessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];
    const response = await this.anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1000,
      messages,
      tools: this.tools,
    });

    const finalText = [];
    const toolResults = [];

    for (const content of response.content) {
      if (content.type === "text") {
        finalText.push(content.text);
      } else if (content.type === "tool_use") {
        const toolName = content.name;
        const toolArgs = content.input as { [x: string]: unknown } | undefined;

        const result = await this.mcp.callTool({
          name: toolName,
          arguments: toolArgs,
        });
        toolResults.push(result);
        finalText.push(
          `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`,
        );

        messages.push({
          role: "user",
          content: result.content as string,
        });

        const followUpResponse = await this.anthropic.messages.create({
          model: "claude-3-5-sonnet-20240620",
          max_tokens: 1000,
          messages,
        });

        finalText.push(
          followUpResponse.content[0].type === "text" ? followUpResponse.content[0].text : "",
        );
      }
    }

    return finalText.join("\n");
  }

  async processQuery(query: string) {
    // 根据可用模型选择API
    if (query.startsWith("/anhropic")) {
      return this.handleAnhropicAIQuery(query.slice(7).trim());
    }
    return this.handleOpenAIQuery(query);
  }

  async chatLoop() {
    /**
     * Run an interactive chat loop
     */
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log("\nMCP Client Started!");
      console.log("Type your queries or 'quit' to exit.");

      while (true) {
        const message = await rl.question("\nQuery: ");
        if (message.toLowerCase() === "quit") {
          break;
        }
        const response = await this.processQuery(message);
        console.log("\n" + response);
      }
    } finally {
      rl.close();
    }
  }

  async cleanup() {
    /**
     * Clean up resources
     */
    await this.mcp.close();
  }
}

import fs from 'fs';

interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
}

async function loadMCPServers() {
  const configPath = './mcp_settings.json';
  
  if (!fs.existsSync(configPath)) {
    throw new Error('MCP配置文件未找到: ' + configPath);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const servers = [];

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers) as [string, ServerConfig][]) {
    if (!serverConfig.disabled) {
      servers.push({
        name: serverName,
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env
      });
    }
  }

  return servers;
}

async function main() {
  const mcpClient = new MCPClient();
  try {
    const servers = await loadMCPServers();
    
    // 并行连接所有服务
    await Promise.all(servers.map(server => 
      mcpClient.connectToServer({
        command: server.command,
        args: server.args,
        env: server.env
      })
    ));

    await mcpClient.chatLoop();
  } catch (e) {
    console.error('初始化失败:', e);
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();
