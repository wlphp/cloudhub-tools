// Terminal ANSI colors keep their own blue/cyan/magenta hues so that `ls`, `git diff`,
// and other CLI output remain readable. The rest of the app stays in the JetBrains
// neutral sage palette via the --jb-* tokens.
import { useEffect, useRef, useState } from "react";

// Terminal ANSI colors keep their own blue/cyan/magenta hues so that `ls`, `git diff`,
// and other CLI output remain readable. The rest of the app stays in the JetBrains
// neutral sage palette via the --jb-* tokens.
const ANSI_BLUE = "#6fb1ff";
const ANSI_CYAN = "#7fdfe0";
const ANSI_MAGENTA = "#c08df0";
const ANSI_SELECTION = "#2a4664";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { invoke, runningInTauri } from "../../platform/api";
import type { TerminalWorkspaceTab } from "../../shared/types";

const terminalThemeStorageKey = "cloudhub-tools-terminal-theme";

export const terminalThemes = {
  dark: {
    label: "深色",
    background: "var(--jb-bg)", foreground: "var(--jb-text)", cursor: "var(--jb-text)", selectionBackground: ANSI_SELECTION,
    black: "var(--jb-bg)", brightBlack: "var(--jb-muted)", red: "var(--jb-red)", brightRed: "var(--jb-red)", green: "var(--jb-green)", brightGreen: "var(--jb-green)", yellow: "var(--jb-yellow)", brightYellow: "var(--jb-yellow)", blue: ANSI_BLUE, brightBlue: ANSI_BLUE, magenta: ANSI_MAGENTA, brightMagenta: ANSI_MAGENTA, cyan: ANSI_CYAN, brightCyan: ANSI_CYAN, white: "var(--jb-text)", brightWhite: "var(--jb-text)",
  },
  blue: {
    label: "蓝墨",
    background: "var(--jb-bg)", foreground: "var(--jb-blue)", cursor: "var(--jb-blue)", selectionBackground: ANSI_SELECTION,
    black: "var(--jb-bg)", brightBlack: "var(--jb-muted)", red: "var(--jb-red)", brightRed: "var(--jb-red)", green: "var(--jb-green)", brightGreen: "var(--jb-green)", yellow: "var(--jb-yellow)", brightYellow: "var(--jb-yellow)", blue: ANSI_BLUE, brightBlue: ANSI_BLUE, magenta: ANSI_MAGENTA, brightMagenta: ANSI_MAGENTA, cyan: ANSI_CYAN, brightCyan: ANSI_CYAN, white: "var(--jb-blue)", brightWhite: "var(--jb-text)",
  },
  green: {
    label: "松绿",
    background: "var(--jb-bg)", foreground: "var(--jb-green)", cursor: "var(--jb-green)", selectionBackground: "var(--jb-accent-soft)",
    black: "var(--jb-bg)", brightBlack: "var(--jb-muted)", red: "var(--jb-red)", brightRed: "var(--jb-red)", green: "var(--jb-green)", brightGreen: "var(--jb-green)", yellow: "var(--jb-yellow)", brightYellow: "var(--jb-yellow)", blue: ANSI_BLUE, brightBlue: ANSI_BLUE, magenta: ANSI_MAGENTA, brightMagenta: ANSI_MAGENTA, cyan: "var(--jb-green)", brightCyan: "var(--jb-green)", white: "var(--jb-green)", brightWhite: "var(--jb-text)",
  },
  amber: {
    label: "暖琥珀",
    background: "var(--jb-bg)", foreground: "var(--jb-yellow)", cursor: "var(--jb-yellow)", selectionBackground: "var(--jb-yellow)",
    black: "var(--jb-bg)", brightBlack: "var(--jb-yellow)", red: "var(--jb-red)", brightRed: "var(--jb-red)", green: "var(--jb-accent)", brightGreen: "var(--jb-green)", yellow: "var(--jb-yellow)", brightYellow: "var(--jb-yellow)", blue: ANSI_BLUE, brightBlue: ANSI_BLUE, magenta: ANSI_MAGENTA, brightMagenta: ANSI_MAGENTA, cyan: "var(--jb-green)", brightCyan: "var(--jb-green)", white: "var(--jb-yellow)", brightWhite: "var(--jb-yellow)",
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
