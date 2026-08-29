import { useEffect, useRef, useState } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { invoke, runningInTauri } from "../../platform/api";
import type { TerminalWorkspaceTab } from "../../shared/types";

const terminalThemeStorageKey = "cloudhub-tools-terminal-theme";

export const terminalThemes = {
  dark: {
    label: "深色",
    background: "#000000", foreground: "#f5f5f5", cursor: "#f5f5f5", selectionBackground: "#295b91",
    black: "#000000", brightBlack: "#8a8a8a", red: "#ff6b6b", brightRed: "#ff8b8b", green: "#61d095", brightGreen: "#7ff0b0", yellow: "#f6d365", brightYellow: "#ffe38c", blue: "#70b7ff", brightBlue: "#9dceff", magenta: "#d29cff", brightMagenta: "#e5bfff", cyan: "#66d9ef", brightCyan: "#9beaff", white: "#e6e6e6", brightWhite: "#ffffff",
  },
  blue: {
    label: "蓝墨",
    background: "#071523", foreground: "#dceeff", cursor: "#7fc8ff", selectionBackground: "#22527d",
    black: "#071523", brightBlack: "#607d98", red: "#ff7788", brightRed: "#ff9dab", green: "#69dca5", brightGreen: "#9befc2", yellow: "#f4cf72", brightYellow: "#ffe39c", blue: "#6ab6ff", brightBlue: "#9ad2ff", magenta: "#d4a5ff", brightMagenta: "#e8c7ff", cyan: "#65d7e8", brightCyan: "#a7f0f7", white: "#c6dceb", brightWhite: "#ffffff",
  },
  green: {
    label: "松绿",
    background: "#081914", foreground: "#d5f2df", cursor: "#7ce6a4", selectionBackground: "#1e5741",
    black: "#081914", brightBlack: "#668b7b", red: "#f07878", brightRed: "#ffaaaa", green: "#5fd492", brightGreen: "#8df1bb", yellow: "#e8c96a", brightYellow: "#ffe596", blue: "#68bfff", brightBlue: "#9bd5ff", magenta: "#d1a7ff", brightMagenta: "#e4c6ff", cyan: "#65d8c5", brightCyan: "#a4f4e5", white: "#cce4d5", brightWhite: "#ffffff",
  },
  amber: {
    label: "暖琥珀",
    background: "#1a1208", foreground: "#f8ead2", cursor: "#ffd080", selectionBackground: "#65451a",
    black: "#1a1208", brightBlack: "#927957", red: "#ef7e72", brightRed: "#ffafa2", green: "#9ed27d", brightGreen: "#c6ef9e", yellow: "#f2c35f", brightYellow: "#ffe19a", blue: "#79b7ed", brightBlue: "#a9d5ff", magenta: "#d6a2ed", brightMagenta: "#eac5fb", cyan: "#6ed3c7", brightCyan: "#aaf0e6", white: "#e7d4b5", brightWhite: "#fff7e9",
  },
} as const;

export type TerminalThemeName = keyof typeof terminalThemes;

type UseSshTerminalOptions = {
  onError: (message: string) => void;
};

export function useSshTerminal({ onError }: UseSshTerminalOptions) {
  const onErrorRef = useRef(onError);
  const [sessionId, setSessionId] = useState("");
  const [tabs, setTabs] = useState<TerminalWorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [themeName, setThemeName] = useState<TerminalThemeName>(() => {
    const saved = localStorage.getItem(terminalThemeStorageKey);
    return saved && saved in terminalThemes ? saved as TerminalThemeName : "dark";
  });
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const pendingOutputRef = useRef("");
  const tabsRef = useRef<TerminalWorkspaceTab[]>([]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    const read = async () => {
      try {
        const output = await invoke<string>("ssh_read", { sessionId });
        if (!disposed && output) {
          setTabs((current) => current.map((tab) => tab.sessionId === sessionId
            ? { ...tab, output: `${tab.output}${output}`.slice(-160_000) }
            : tab));
          terminalRef.current?.write(output);
        }
      } catch (error) {
        if (!disposed) onErrorRef.current(`SSH 会话已断开：${String(error)}`);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 250);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !terminalHostRef.current) return;
    let disposed = false;
    let terminal: XtermTerminal | null = null;
    let observer: ResizeObserver | null = null;
    let inputSubscription: { dispose: () => void } | null = null;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, addon]) => {
      if (disposed || !terminalHostRef.current) return;
      terminal = new xterm.Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
        fontSize: 14,
        lineHeight: 1.25,
        scrollback: 8_000,
        theme: terminalThemes[themeName],
      });
      const fitAddon = new addon.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalHostRef.current);
      terminalRef.current = terminal;
      const savedOutput = tabsRef.current.find((tab) => tab.sessionId === sessionId)?.output || pendingOutputRef.current;
      if (savedOutput) terminal.write(savedOutput);
      pendingOutputRef.current = "";

      const syncSize = () => {
        fitAddon.fit();
        void invoke("ssh_resize", { sessionId, cols: terminal?.cols, rows: terminal?.rows })
          .catch((error) => onErrorRef.current(`调整 SSH 终端大小失败：${String(error)}`));
      };
      inputSubscription = terminal.onData((data) => {
        void invoke("ssh_write", { sessionId, data })
          .catch((error) => onErrorRef.current(`发送 SSH 输入失败：${String(error)}`));
      });
      observer = new ResizeObserver(syncSize);
      observer.observe(terminalHostRef.current);
      window.requestAnimationFrame(() => {
        syncSize();
        terminal?.focus();
      });
    }).catch((error) => {
      if (!disposed) onErrorRef.current(`加载 SSH 终端失败：${String(error)}`);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      inputSubscription?.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      terminal?.dispose();
    };
  }, [sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalThemes[themeName];
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  }, [themeName]);

  function clear() {
    terminalRef.current?.clear();
  }

  function completeCommand() {
    if (!sessionId) return;
    void invoke("ssh_write", { sessionId, data: "\t" })
      .catch((error) => onErrorRef.current(`发送命令补全失败：${String(error)}`));
    terminalRef.current?.focus();
  }

  async function disconnectSession(value: string) {
    if (!value || !runningInTauri) return;
    try { await invoke("ssh_disconnect", { sessionId: value }); } catch { /* session already closed */ }
  }

  return {
    sessionId,
    setSessionId,
    tabs,
    setTabs,
    tabsRef,
    activeTabId,
    setActiveTabId,
    themeName,
    setThemeName,
    themeMenuOpen,
    setThemeMenuOpen,
    terminalHostRef,
    pendingOutputRef,
    clear,
    completeCommand,
    disconnectSession,
  };
}
