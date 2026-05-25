declare module '@ampcode/plugin' {
  export type PluginToolResultContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string };

  export type PluginToolResult = string | PluginToolResultContentBlock[];

  export interface PluginToolContext {
    ui: PluginUI;
    logger: PluginLogger;
  }

  export interface PluginToolDefinition {
    name: string;
    description: string;
    inputSchema: {
      type: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
      [key: string]: unknown;
    };
    execute: (
      input: Record<string, unknown>,
      ctx: PluginToolContext,
    ) => Promise<PluginToolResult | void>;
  }

  export interface PluginCommandOptions {
    title: string;
    category?: string;
    description?: string;
  }

  export interface PluginThread {
    id: string;
    append(messages: UserMessage[]): Promise<void>;
  }

  export interface UserMessage {
    type: 'user-message';
    content: string;
  }

  export interface PluginInputOptions {
    title?: string;
    helpText?: string;
    initialValue?: string;
    submitButtonText?: string;
  }

  export interface PluginUI {
    notify(message: string): Promise<void>;
    input(options: PluginInputOptions): Promise<string | undefined>;
  }

  export interface PluginSystem {
    open(url: string | URL): Promise<void>;
    readonly ampURL: URL;
  }

  export type ShellFunction = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

  export interface PluginCommandContext {
    ui: PluginUI;
    system: PluginSystem;
    $: ShellFunction;
    thread?: PluginThread;
  }

  export interface PluginLogger {
    log: (...args: unknown[]) => void;
  }

  export interface PluginAPI {
    logger: PluginLogger;
    system: PluginSystem;
    registerCommand(
      id: string,
      options: PluginCommandOptions,
      handler: (ctx: PluginCommandContext) => void | Promise<void>,
    ): unknown;
    registerTool(definition: PluginToolDefinition): unknown;
  }
}
