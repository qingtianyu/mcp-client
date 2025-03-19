import { Anthropic } from '@anthropic-ai/sdk';
import { OpenAI } from 'openai';
import { 
  ASSISTANT_IDENTITY,
  TOOL_USE_INTRO,
  WORKING_DIRECTORY,
  TOOLS,
  MCP_SERVERS,
  generateToolsSection,
  generateMcpServersSection
} from './prompt.js';

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import readline from "readline/promises";
import dotenv from "dotenv";

dotenv.config(); // load environment variables from .env

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY) {
  throw new Error("至少需要设置ANTHROPIC_API_KEY或OPENAI_API_KEY环境变量");
}

class MCPClient {
  private mcp: Client;
  private anthropic?: Anthropic;
  private openai?: OpenAI;
  private deepseek?: OpenAI;
  private transport: StdioClientTransport | null = null;
  private tools: any[] = [];
  private messages: any[] = [];
  private promptConfig: {
    assistantIdentity?: string;
    workingDirectory?: string;
    customTools?: Record<string, any>;
    customMcpServers?: Record<string, any>;
  } = {};

  constructor(config?: {
    assistantIdentity?: string;
    workingDirectory?: string;
    customTools?: Record<string, any>;
    customMcpServers?: Record<string, any>;
  }) {
    // 初始化提示词配置
    this.promptConfig = {
      assistantIdentity: config?.assistantIdentity,
      workingDirectory: config?.workingDirectory,
      customTools: config?.customTools,
      customMcpServers: config?.customMcpServers
    };
    
    // 初始化系统提示词
    this.initializeSystemPrompt();
    
    // Initialize Anthropic client and MCP client
    this.anthropic = ANTHROPIC_API_KEY ? new Anthropic({
      apiKey: ANTHROPIC_API_KEY,
    }) : undefined;

    this.openai = OPENAI_API_KEY ? new OpenAI({
      baseURL: OPENAI_BASE_URL,
      apiKey: OPENAI_API_KEY,
    }) : undefined;

    this.deepseek = DEEPSEEK_API_KEY ? new OpenAI({
      baseURL: DEEPSEEK_BASE_URL,
      apiKey: DEEPSEEK_API_KEY,
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

  public getMcp(): Client {
    return this.mcp;
  }

  private async handleOpenAIQuery(query: string) {
    if (!this.openai) throw new Error("OPENAI_API_KEY未配置");
    
    this.messages.push({ role: "user", content: query });
    
    const completion = await this.openai!.chat.completions.create({
      model: OPENAI_MODEL,
      messages: this.messages,
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

    if (response.tool_calls && response.tool_calls.length > 0) {
      // 添加助手消息（带工具调用）
      this.messages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: response.tool_calls
      });

      // 处理每个工具调用
      for (const toolCall of response.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        console.log(`调用工具 ${toolName} 参数 ${JSON.stringify(toolArgs)}`);
        finalText.push(`[调用工具 ${toolName} 参数 ${JSON.stringify(toolArgs)}]`);

        // 执行工具调用
        const result = await this.mcp.callTool({
          name: toolName,
          arguments: toolArgs,
        });

        // 添加工具响应消息
        this.messages.push({
          role: "tool",
          content: JSON.stringify(result.content),
          tool_call_id: toolCall.id
        });
      }

      // 发送后续请求处理工具结果
      const followUpResponse = await this.openai!.chat.completions.create({
        model: OPENAI_MODEL,
        messages: this.messages
      });

      finalText.push(followUpResponse.choices[0].message.content || "");
    } else {
      // 没有工具调用，直接返回响应内容
      finalText.push(response.content || "");
    }

    return finalText.join("\n");
  }

  private async handleAnhropicAIQuery(query: string) {
    if (!this.anthropic) throw new Error("ANTHROPIC_API_KEY未配置");
    this.messages.push({
      role: "user",
      content: query,
    });
    const response = await this.anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1000,
      messages: this.messages,
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

        this.messages.push({
          role: "user",
          content: result.content as string,
        });

        const followUpResponse = await this.anthropic.messages.create({
          model: "claude-3-5-sonnet-20240620",
          max_tokens: 1000,
          messages: this.messages,
        });

        finalText.push(
          followUpResponse.content[0].type === "text" ? followUpResponse.content[0].text : "",
        );
      }
    }

    return finalText.join("\n");
  }

  private async handleDeepSeekQuery(query: string) {
    if (!this.deepseek) throw new Error("DEEPSEEK_API_KEY未配置");
    
    this.messages.push({ role: "user", content: query });
    
    try {
      // 检查模型是否支持函数调用
      const supportsToolCalls = !DEEPSEEK_MODEL.includes("reasoner");
      
      const completion = await this.deepseek!.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: this.messages,
        // 只有在模型支持工具调用时才添加工具参数
        ...(supportsToolCalls ? {
          tools: this.tools.map(tool => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema
            }
          })),
          tool_choice: "auto"
        } : {})
      });

      const response = completion.choices[0].message;
      const finalText = [];

      // 只有在模型支持工具调用且有工具调用时才处理工具调用
      if (supportsToolCalls && response.tool_calls && response.tool_calls.length > 0) {
        // 添加助手消息（带工具调用）
        this.messages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.tool_calls
        });

        // 处理每个工具调用
        for (const toolCall of response.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments);

          console.log(`调用工具 ${toolName} 参数 ${JSON.stringify(toolArgs)}`);
          finalText.push(`[调用工具 ${toolName} 参数 ${JSON.stringify(toolArgs)}]`);

          // 执行工具调用
          const result = await this.mcp.callTool({
            name: toolName,
            arguments: toolArgs,
          });

          // 添加工具响应消息
          this.messages.push({
            role: "tool",
            content: JSON.stringify(result.content),
            tool_call_id: toolCall.id
          });
        }

        // 发送后续请求处理工具结果
        const followUpResponse = await this.deepseek!.chat.completions.create({
          model: DEEPSEEK_MODEL,
          messages: this.messages
        });

        finalText.push(followUpResponse.choices[0].message.content || "");
      } else {
        // 没有工具调用，直接返回响应内容
        finalText.push(response.content || "");
        
        // 添加助手消息（不带工具调用）
        this.messages.push({
          role: "assistant",
          content: response.content || ""
        });
      }

      return finalText.join("\n");
    } catch (error) {
      console.error("DeepSeek API调用失败:", error);
      return `DeepSeek API调用失败: ${error}`;
    }
  }

  // 解析XML格式的工具调用
  private parseXmlToolCall(content: string): { toolName: string, toolArgs: Record<string, any> } | null {
    // 匹配工具名称
    const toolNameMatch = content.match(/<([a-zA-Z_]+)>/);
    if (!toolNameMatch) return null;
    
    const toolName = toolNameMatch[1];
    const toolEndTag = `</${toolName}>`;
    
    // 确保有结束标签
    if (!content.includes(toolEndTag)) return null;
    
    // 提取工具调用的内容部分
    const startIndex = content.indexOf(`<${toolName}>`) + toolName.length + 2;
    const endIndex = content.indexOf(toolEndTag);
    const toolContent = content.substring(startIndex, endIndex).trim();
    
    // 解析参数
    const toolArgs: Record<string, any> = {};
    const paramRegex = /<([a-zA-Z_]+)>([\s\S]*?)<\/\1>/g;
    let match;
    
    while ((match = paramRegex.exec(toolContent)) !== null) {
      const paramName = match[1];
      let paramValue = match[2].trim();
      
      // 尝试解析JSON参数
      if (paramName === 'arguments') {
        try {
          paramValue = JSON.parse(paramValue);
        } catch (e) {
          console.error('解析JSON参数失败:', e);
        }
      }
      
      toolArgs[paramName] = paramValue;
    }
    
    return { toolName, toolArgs };
  }

  // 处理XML格式的工具调用
  private async handleXmlToolCall(content: string) {
    const parsedTool = this.parseXmlToolCall(content);
    if (!parsedTool) return null;
    
    const { toolName, toolArgs } = parsedTool;
    
    // 处理MCP工具调用
    if (toolName === 'use_mcp_tool') {
      const serverName = toolArgs.server_name;
      const mcpToolName = toolArgs.tool_name;
      const mcpToolArgs = toolArgs.arguments;
      
      console.log(`调用MCP服务名称 ${serverName} 工具名称 ${mcpToolName} 参数 ${JSON.stringify(mcpToolArgs)}`);
      
      try {
        const result = await this.mcp.callTool({
          name: mcpToolName,
          arguments: mcpToolArgs,
        });
        
        return result;
      } catch (e) {
        console.error(`MCP工具调用失败: ${e}`);
        return { content: `MCP工具调用失败: ${e}`, error: true };
      }
    }
    
    // 这里可以添加其他XML工具的处理逻辑
    
    return null;
  }

  async processQuery(query: string) {
    // 检查是否是XML格式的工具调用
    if (query.trim().startsWith('<') && query.trim().endsWith('>')) {
      const toolResult = await this.handleXmlToolCall(query);
      if (toolResult) {
        return JSON.stringify(toolResult.content, null, 2);
      }
    }
    
    // 根据可用模型选择API
    if (query.startsWith("/anhropic")) {
      return this.handleAnhropicAIQuery(query.slice(9).trim());
    } else if (query.startsWith("/openai")) {
      return this.handleOpenAIQuery(query.slice(7).trim());
    } else if (query.startsWith("/deepseek")) {
      return this.handleDeepSeekQuery(query.slice(9).trim());
    }
    
    // 默认使用OpenAI
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

  /**
   * 初始化系统提示词，应用自定义配置
   */
  public initializeSystemPrompt() {
    // 使用导入的变量
    let assistantIdentity = ASSISTANT_IDENTITY;
    let workingDirectory = WORKING_DIRECTORY;
    let tools = { ...TOOLS };
    let mcpServers = { ...MCP_SERVERS };
    
    // 应用自定义配置
    if (this.promptConfig.assistantIdentity) {
      assistantIdentity = this.promptConfig.assistantIdentity;
    }
    
    if (this.promptConfig.workingDirectory) {
      workingDirectory = this.promptConfig.workingDirectory;
    }
    
    if (this.promptConfig.customTools) {
      tools = { ...tools, ...this.promptConfig.customTools };
    }
    
    if (this.promptConfig.customMcpServers) {
      mcpServers = { ...mcpServers, ...this.promptConfig.customMcpServers };
    }
    
    // 重新生成系统提示词
    const customSystemPrompt = `${assistantIdentity}

====

${TOOL_USE_INTRO}

${generateToolsSection()}

${generateMcpServersSection()}

====

EXAMPLES

Here are a few examples of how to use the tools:

## Example 1: Reading a file

<read_file>
<path>src/main.js</path>
</read_file>

## Example 2: Writing to a file

<write_to_file>
<path>src/utils/helper.js</path>
<content>
// Helper functions
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = {
  formatDate,
  capitalize
};
</content>
</write_to_file>

## Example 3: Replacing content in a file

<replace_in_file>
<path>src/components/App.js</path>
<diff>
<<<<<<< SEARCH
return (
  <div>
=======
function handleSubmit() {
  saveData();
  setLoading(false);
}

return (
  <div>
>>>>>>> REPLACE
</diff>
</replace_in_file>

## Example 4: Executing a command

<execute_command>
<command>npm run build</command>
<requires_approval>false</requires_approval>
</execute_command>

## Example 5: Using an MCP tool

<use_mcp_tool>
<server_name>api-server</server_name>
<tool_name>getUserPage</tool_name>
<arguments>
{
  "pageNo": "1",
  "pageSize": "10"
}
</arguments>
</use_mcp_tool>

====

CURRENT ENVIRONMENT

Current working directory: ${workingDirectory}
`;
    
    // 设置系统提示词
    this.messages = [{ role: "system", content: customSystemPrompt }];
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

    const listTools = mcpClient.getMcp().listTools();
    console.log("Connected to servers:", listTools);
    // mcpClient.initializeSystemPrompt();
    await mcpClient.chatLoop();
  } catch (e) {
    console.error('初始化失败:', e);
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();
