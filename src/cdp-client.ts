import { EventEmitter } from "node:events";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";

type Commands = ProtocolMapping.Commands;
type CommandParams<Method extends keyof Commands> = Commands[Method]["paramsType"][0];
type CommandArguments<Method extends keyof Commands> = Commands[Method]["paramsType"] extends []
  ? [params?: undefined, sessionId?: string]
  : Commands[Method]["paramsType"] extends [infer Params]
    ? [params: Params, sessionId?: string]
    : Commands[Method]["paramsType"] extends [(infer Params)?]
      ? [params?: Params, sessionId?: string]
      : never;

export type CdpEvent = {
  method: string;
  params?: unknown;
  sessionId?: string;
};

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: string;
  };
};

type PendingCommand = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export class CdpClient extends EventEmitter {
  readonly #pending = new Map<number, PendingCommand>();
  readonly #socket: WebSocket;
  #nextCommandId = 1;

  private constructor(socket: WebSocket) {
    super();
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#handleMessage(event.data));
    socket.addEventListener("close", () => this.#handleDisconnect());
  }

  static connect(endpoint: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const onError = (): void => reject(new Error(`无法连接 Chrome DevTools：${endpoint}`));
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener(
        "open",
        () => {
          socket.removeEventListener("error", onError);
          resolve(new CdpClient(socket));
        },
        { once: true },
      );
    });
  }

  send<Method extends keyof Commands>(
    method: Method,
    ...args: CommandArguments<Method>
  ): Promise<Commands[Method]["returnType"]> {
    if (this.#socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Chrome DevTools 连接已关闭"));

    const [params, sessionId] = args as [CommandParams<Method> | undefined, string?];
    const id = this.#nextCommandId++;
    const message: {
      id: number;
      method: Method;
      params?: CommandParams<Method>;
      sessionId?: string;
    } = { id, method };
    if (params !== undefined) message.params = params;
    if (sessionId !== undefined) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
      });
      try {
        this.#socket.send(JSON.stringify(message));
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) =>
      this.#socket.addEventListener("close", () => resolve(), { once: true }),
    );
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close();
    await closed;
  }

  #handleMessage(data: string | ArrayBuffer | Blob): void {
    if (typeof data !== "string") return;
    const message = JSON.parse(data) as CdpResponse | CdpEvent;
    if ("id" in message) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        const detail = message.error.data ? `：${message.error.data}` : "";
        pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}${detail}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    this.emit("event", message);
  }

  #handleDisconnect(): void {
    const error = new Error("Chrome DevTools 连接已关闭");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.emit("disconnect");
  }
}
