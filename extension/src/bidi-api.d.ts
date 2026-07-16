declare global {
  namespace browser.bidi {
    function send(moduleName: string, commandName: string, params?: object): Promise<any>;
    function subscribe(events: string[], contexts?: string[]): Promise<any>;
    function unsubscribe(events: string[]): Promise<any>;
    function getAutostartConfig(): Promise<{
      autostart: boolean;
      port: number | null;
    }>;
    function startServer(port: number): Promise<number>;
    function stopServer(): Promise<void>;
    function sendHttpResponse(
      requestId: number,
      status: number,
      headers: Record<string, string>,
      body: string
    ): Promise<void>;
    function getPref(name: string): Promise<{ type: string; value: unknown }>;
    function setPref(name: string, value: unknown): Promise<void>;
    const onEvent: {
      addListener(cb: (event: { name: string; data: any }) => void): void;
    };
    const onHttpRequest: {
      addListener(
        cb: (req: {
          id: number;
          method: string;
          path: string;
          headers: Record<string, string>;
          body: string;
        }) => void
      ): void;
    };
  }
}

export {};
