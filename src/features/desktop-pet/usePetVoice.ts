import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { desktopPetClient as client, type PetComputerAction, type PetSettings } from "../../platform/clients/desktopPet";
import { platformErrorMessage } from "../../platform/api";

export interface PetVoiceCallbacks {
  /** 打开聊天面板并填入/自动发送文本 */
  openChat: (text: string, autoSend: boolean) => void;
  /** 需要人工确认的系统动作（关机/重启），由现有 ConfirmDialog 承接 */
  requestComputer: (action: "shutdown" | "restart") => void;
  /** 直接执行的低风险动作 */
  runComputer: (action: "lock" | "taskManager" | "explorer") => void;
  /** 状态提示气泡 */
  showHint: (text: string) => void;
  showError: (message: string) => void;
}

interface ListeningEvent {
  active: boolean;
  error: string | null;
}

const VOICE_ACTIONS: Record<string, string> = {
  lock: "已锁定电脑",
  taskManager: "已打开任务管理器",
  explorer: "已打开文件资源管理器",
};

/// 桌宠语音编排：订阅常驻唤醒事件，转写结果经 AI 意图分类后调用既有白名单动作。
export function usePetVoice(settings: PetSettings, callbacks: PetVoiceCallbacks) {
  const [listening, setListening] = useState(false);
  const [listeningError, setListeningError] = useState("");
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const busy = useRef(false);
  const runRef = useRef<(text: string) => void>(() => {});

  useEffect(() => {
    async function runCommand(text: string) {
      const trimmed = text.trim();
      if (!trimmed || busy.current) return;
      const voice = settingsRef.current.voice;
      if (!voice.enabled) return;
      if (!voice.autoSend) { callbacksRef.current.openChat(trimmed, false); return; }
      busy.current = true;
      try {
        const services = await client.chatServices();
        const service = services[0];
        if (!service) { callbacksRef.current.showError("请先在AI设置中配置并启用一个服务"); return; }
        callbacksRef.current.showHint(`正在理解“${trimmed.slice(0, 20)}”…`);
        const intent = await client.voiceIntent(crypto.randomUUID(), service, trimmed);
        switch (intent.action) {
          case "shutdown":
          case "restart":
            callbacksRef.current.requestComputer(intent.action);
            break;
          case "lock":
          case "taskManager":
          case "explorer":
            await client.computerAction(intent.action as PetComputerAction);
            callbacksRef.current.showHint(VOICE_ACTIONS[intent.action] || intent.summary || "已完成");
            break;
          case "openApp":
            await client.open("resources");
            callbacksRef.current.showHint("已打开云枢工具箱");
            break;
          case "weather": {
            const state = await client.lifeWeather();
            const active = state.notices.filter(notice => notice.kind === "weather" && notice.expiresAt > Date.now() / 1000);
            callbacksRef.current.showHint(active.length
              ? `天气预警：${active.slice(0, 3).map(notice => notice.title).join("；")}`
              : `已查询${state.region || "所在地区"}：当前没有生效的天气预警`);
            break;
          }
          default:
            callbacksRef.current.openChat(intent.text || trimmed, true);
        }
      } catch (error) {
        callbacksRef.current.showError(platformErrorMessage(error));
      } finally {
        busy.current = false;
      }
    }
    runRef.current = text => void runCommand(text);
    const subscriptions = [
      listen<ListeningEvent>("pet-voice-listening", e => { setListening(!!e.payload?.active); setListeningError(e.payload?.error || ""); }),
      listen("pet-voice-awake", () => callbacksRef.current.showHint("我在听，请说指令…")),
      listen<{ text: string }>("pet-voice-command", e => runRef.current(e.payload?.text || "")),
    ];
    return () => subscriptions.forEach(promise => void promise.then(unlisten => unlisten()));
  }, []);
  return { listening, listeningError, submit: (text: string) => runRef.current(text) };
}
