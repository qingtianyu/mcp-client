/**
 * 工具类型定义
 */
export interface Tool {
  /**
   * 工具名称
   */
  name: string;
  
  /**
   * 工具描述
   */
  description: string;
  
  /**
   * 输入模式
   */
  input_schema: any;
}
