import { PetConfirmDialog } from "./PetDialog";
import { ToastNotice } from "../../shared/ToastNotice";
import { createPortal } from "react-dom";
import { petChatParentPage } from "./PetChatSettings";
import type { PetComputerAction, PetMonitor } from "../../platform/clients/desktopPet";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { Bell, Box, Copy, Droplets, History, Home, Moon, Move, Settings, X, EyeOff, MessageCircle, Footprints, Briefcase, Heart, Plane, Power, RotateCw, MonitorCog, LockKeyhole, FolderOpen, Mic, Minus, Pin, PinOff, Trash2, Maximize2, Minimize2, MoreHorizontal } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { defaultPetSettings, isMimoSpeechPreset, sortPetAlerts, desktopPetClient as client, type PetSettings, type PetSnapshot, type PetAlert, type PetSpeechPreset } from "../../platform/clients/desktopPet";
import { platformErrorMessage, runningInTauri, runningOnWindows } from "../../platform/api";
import { petAppearances, petSpriteStyle, petFrameFor, type PetPose } from "./appearances";
import { PetPortrait } from "./PetPortrait";
import { PetHumanoid } from "./PetHumanoid";
import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { ContextMenu, type ContextMenuItem } from "../../shared/ContextMenu";
import { PetChat, type PetChatPage, type PetVoiceTurn } from "./PetChat";
import { usePetLife } from "./usePetLife";
import { usePetVoice } from "./usePetVoice";
import { PetLifeBubble } from "./PetLifeBubble";
import { PetAlertsPage } from "./PetAlertsPage";
import { usePetWindowTheme } from "./usePetWindowTheme";
import { PetActionGroups, type PetActionGroup } from "./PetActionGroups";
import { PetChatResizeEdges } from "./PetChatResizeEdges";
import type { PetComputerCommand } from "./petComputerCommand";
import "./desktop-pet.css";

type Pose = PetPose;
const useWindowsSpeech = runningInTauri && runningOnWindows;
const speechTuning = {
  system: { pitch: 1, rate: 1 },
  warm: { pitch: 1.12, rate: 0.92 },
  clear: { pitch: 1, rate: 1.04 },
  bright: { pitch: 1.28, rate: 1.14 },
  steady: { pitch: 0.8, rate: 0.84 },
} satisfies Record<Exclude<PetSpeechPreset, "mimoBingtang" | "mimoMoli">, { pitch: number; rate: number }>;
const petPanelRegions = ".shared-dialog-backdrop,.app-confirm-backdrop,.pet-floating-card,.pet-speech-bubble,.pet-inline-error";

export function PetWindow() {
  usePetWindowTheme();
  useLayoutEffect(() => {
    document.documentElement.classList.add("pet-window-page");
    return () => document.documentElement.classList.remove("pet-window-page");
  }, []);
  const [computerConfirm, setComputerConfirm] = useState<"shutdown" | "restart" | null>(null);
  const [brightnessChoice, setBrightnessChoice] = useState<{ monitors: PetMonitor[]; percent: number; resolve: (target: string) => void } | null>(null);
  const [brightnessTarget, setBrightnessTarget] = useState("");
  const [computerBusy, setComputerBusy] = useState(false);
  const computerPending = useRef(false);
  /// AI 提议的 CMD 命令：弹窗展示完整命令，用户确认后才调用 pet_shell_command 执行。
  const [shellConfirm, setShellConfirm] = useState<{ command: string; summary: string } | null>(null);
  const [shellBusy, setShellBusy] = useState(false);
  const shellPending = useRef(false);
  const [docked, setDocked] = useState(false);
  const [dockEdge, setDockEdge] = useState<"left" | "right" | "top" | "bottom">("right");
  const [dragging, setDragging] = useState(false);
  const [settings, setSettings] = useState<PetSettings>(defaultPetSettings);
  const [snapshot, setSnapshot] = useState<PetSnapshot>({ alerts: [], checkedAt: 0, lastError: null });
  const [pose, setPose] = useState<Pose>("idle");
  const [frame, setFrame] = useState(0);
  const [panel, setPanel] = useState<"menu" | "chat" | null>(null);
  const [notice, setNotice] = useState<PetAlert | null>(null);
  const [focusedAlert, setFocusedAlert] = useState<PetAlert | null>(null);
  const [error, setError] = useState("");
  const [direction, setDirection] = useState(1);
  const [sleeping, setSleeping] = useState(false);
  const [hover, setHover] = useState(false);
  const [visible, setVisible] = useState(true);
  const [protest, setProtest] = useState(false);
  /// 桌宠贴屏幕边缘时窗口部分在屏幕外：气泡与徽标向屏幕内平移，避免文字被裁切。
  const [edgeShift, setEdgeShift] = useState(0);
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    const update = async () => {
      try {
        const pos = await win.outerPosition();
        const scale = await win.scaleFactor();
        setEdgeShift(Math.max(0, Math.round(-pos.x / scale)));
      } catch { /* 读取失败时保持当前偏移 */ }
    };
    void update();
    void win.onMoved(() => void update()).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const visibleRef = useRef(true);
  visibleRef.current = visible;
  const [systemReduced, setSystemReduced] = useState(matchMedia("(prefers-reduced-motion: reduce)").matches);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = settings.reducedMotion || systemReduced;
  const stopLifePose = useCallback(() => setPose(p => (p === "run" || p === "walk") ? "idle" : p), []);
  const life = usePetLife({ settings, blocked: dragging || panel !== null || notice !== null || hover || sleeping, visible, reduced, setPose, setDirection, stopPose: stopLifePose, onError: e => setError(platformErrorMessage(e)) });
  const [voiceHint, setVoiceHint] = useState("");
  const [chatStarted, setChatStarted] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [historyClearOpen, setHistoryClearOpen] = useState(false);
  const [historyClearBusy, setHistoryClearBusy] = useState(false);
  const [historyClearError, setHistoryClearError] = useState("");
  const historyClearPending = useRef(false);
  const [chatPage, setChatPage] = useState<PetChatPage>("chat");
  const [chatPinned, setChatPinned] = useState(true);
  const [chatMaximized, setChatMaximized] = useState(false);
  const [chatTraceSplit, setChatTraceSplit] = useState(400);
  const [chatTraceWidth, setChatTraceWidth] = useState<number | null>(null);
  const chatCard = useRef<HTMLElement>(null);
  const chatTraceSplitDrag = useRef<{ pointerId: number; clientX: number; split: number } | null>(null);
  const maxChatTraceSplit = Math.max(400, window.innerWidth - 320);
  /// 标题栏右键快捷菜单：记录指针位置，菜单项复用同一套聊天操作。
  const [chatMenu, setChatMenu] = useState<{ x: number; y: number; copyText?: string } | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const [pendingVoice, setPendingVoice] = useState<PetVoiceTurn[]>([]);
  const activeSystemSpeech = useRef<SpeechSynthesisUtterance | null>(null);
  const [systemSpeaking, setSystemSpeaking] = useState(false);
  function stopSystemSpeech() {
    activeSystemSpeech.current = null;
    setSystemSpeaking(false);
    window.speechSynthesis?.cancel();
  }

  function speak(text: string, options: { interrupt?: boolean; previewPreset?: PetSpeechPreset; preparedId?: string; onUnavailable?: (error: unknown) => void; onDone?: () => void } = {}) {
    const { voice, quiet } = settingsRef.current;
    const { interrupt = false, previewPreset, onUnavailable = error => setVoiceHint(platformErrorMessage(error)), onDone } = options;
    if (quiet || (!previewPreset && (!text.trim() || !voice.enabled || !voice.speak))) { onDone?.(); return; }
    const preset = previewPreset ?? voice.speechPreset ?? "system";
    if (useWindowsSpeech) {
      void client.voiceSpeak(previewPreset ? null : text, interrupt, previewPreset, options.preparedId).catch(onUnavailable).finally(onDone);
      return;
    }
    if (runningInTauri && isMimoSpeechPreset(preset)) {
      if (interrupt) stopSystemSpeech();
      void client.voiceSpeak(previewPreset ? null : text, interrupt, previewPreset, options.preparedId).then(onDone).catch(error => {
        if (previewPreset) { onUnavailable(error); onDone?.(); return; }
        const current = settingsRef.current;
        if (current.quiet || !current.voice.enabled || !current.voice.speak || current.voice.speechPreset !== preset) { onDone?.(); return; }
        setVoiceHint(`${platformErrorMessage(error)}，已切换到系统语音`);
        speakUsingSystem(text, "system", options);
      });
      return;
    }
    speakUsingSystem(text, preset, options);
  }
  function speakUsingSystem(text: string, preset: PetSpeechPreset, options: Parameters<typeof speak>[1] = {}) {
    const { interrupt = false, previewPreset, onUnavailable = error => setVoiceHint(platformErrorMessage(error)), onDone } = options;
    const { voice } = settingsRef.current;
    const synth = window.speechSynthesis;
    const unavailable = () => onUnavailable(new Error("系统语音播报不可用，请检查播放设备和系统语音包。"));
    if (!synth) { unavailable(); onDone?.(); return; }
    try {
      if (interrupt) stopSystemSpeech();
      const sample = voice.language === "en" ? "Hello, I'm your desktop companion. I'll be here whenever you need me." : "你好，我是你的桌面伙伴。有需要的时候，随时叫我。";
      const utter = new SpeechSynthesisUtterance(previewPreset ? sample : text.replace(/[…]+$/, ""));
      utter.lang = voice.language === "en" ? "en-US" : "zh-CN";
      if (preset !== "system" && !isMimoSpeechPreset(preset)) {
        const voices = synth.getVoices().filter(item => item.localService && item.lang.slice(0, 2) === utter.lang.slice(0, 2));
        utter.voice = voices.find(item => item.lang === utter.lang && item.default)
          ?? voices.find(item => item.lang === utter.lang) ?? voices[0] ?? null;
        Object.assign(utter, speechTuning[preset]);
      }
      utter.onstart = () => { activeSystemSpeech.current = utter; setSystemSpeaking(true); };
      const finish = () => {
        if (activeSystemSpeech.current === utter) {
          activeSystemSpeech.current = null;
          setSystemSpeaking(false);
        }
      };
      utter.onend = () => { finish(); onDone?.(); };
      utter.onerror = event => {
        finish();
        if (event.error !== "interrupted" && event.error !== "canceled") unavailable();
        if (previewPreset || (event.error !== "interrupted" && event.error !== "canceled")) onDone?.();
      };
      synth.speak(utter);
      synth.resume();
    } catch { unavailable(); onDone?.(); }
  }
  const speechSelection = `${settings.voice.speechPreset}:${settings.voice.speechMimoProfileId}`;
  const previousSpeech = useRef(speechSelection);
  useEffect(() => {
    const changed = previousSpeech.current !== speechSelection;
    previousSpeech.current = speechSelection;
    if (!changed && settings.voice.enabled && settings.voice.speak && !settings.quiet) return;
    if (runningInTauri) void client.voiceSpeak(null).catch(() => {});
    stopSystemSpeech();
  }, [settings.voice.enabled, settings.voice.speak, speechSelection, settings.quiet]);
  const petVoice = usePetVoice(settings, {
    openVoiceDraft: () => openChatPage("chat"),
    queueChat: (text, autoSend, commandId, localReply) => {
      setChatStarted(true);
      if (typeof localReply === "string") openChatPage("chat");
      setPendingVoice(turns => [...turns, { text, autoSend, commandId, localReply }]);
      if (!autoSend && panel !== "chat") setVoiceHint("语音内容已留在聊天输入框");
    },
    requestComputer: action => { setError(""); setComputerConfirm(action); },
    requestShell: (command, summary) => { setError(""); setShellConfirm({ command, summary }); },
    runComputer: action => { void work(async () => { await client.computerAction(action); }); },
    showHint: (text, speakHint = false) => { setVoiceHint(text); if (speakHint) speak(text); },
    acknowledgeWake: hasCommand => {
      const message = hasCommand ? "我在。" : "我在，请说。";
      setVoiceHint(message);
      if (!useWindowsSpeech) speak(message, { interrupt: true });
    },
    showError: message => setError(message),
  });
  useEffect(() => { if (!voiceHint) return; const timer = setTimeout(() => setVoiceHint(""), 8000); return () => clearTimeout(timer); }, [voiceHint]);
  const pause = dragging || docked || panel !== null || hover || sleeping || notice !== null || life.notice !== null;
  const [ready, setReady] = useState(false);
  const work = async (fn: () => Promise<unknown>) => { try { await fn(); setError(""); } catch (e) { setError(platformErrorMessage(e)); } };
  useEffect(() => {
    document.documentElement.classList.add("pet-window-page");
    let disposed = false;
    const edgeSubscription = listen<"left" | "right" | "top" | "bottom">("pet-dock-edge", e => setDockEdge(e.payload));
    void Promise.all([client.settings(), client.snapshot()]).then(([s,a]) => { if (!disposed) { setSettings(s); setSnapshot({ ...a, alerts: sortPetAlerts(a.alerts) }); setReady(true); if (s.monitoring && !s.quiet) setNotice(sortPetAlerts(a.alerts).find(alert => alert.active && !alert.ignored && alert.snoozedUntil <= Date.now()/1000) || null); } }).catch(e => setError(platformErrorMessage(e)));
    const subscriptions = [listen<boolean>("pet-docked", e => { setDocked(e.payload); if (e.payload) { setPanel(null); setNotice(null); life.suppressDueNotices(); setHover(false); setSleeping(false); setPose("idle"); setDirection(1); if (actionTimer.current) clearTimeout(actionTimer.current); } }), listen<boolean>("pet-visibility", e => { setVisible(e.payload); if (!e.payload) { setPanel(null); setNotice(null); setPose("idle"); } }), listen<PetSettings>("pet-settings-changed", e => setSettings(e.payload)), listen<PetSnapshot>("pet-alerts-changed", e => setSnapshot({ ...e.payload, alerts: sortPetAlerts(e.payload.alerts) })), listen<PetAlert>("pet-notification", e => { if (visibleRef.current && !settingsRef.current.quiet) { if(actionTimer.current) clearTimeout(actionTimer.current); setNotice(e.payload); setPose(e.payload.active ? "alert" : "happy"); } })];
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setSystemReduced(media.matches); media.addEventListener("change", change);
    return () => { disposed = true; void edgeSubscription.then(fn => fn()); media.removeEventListener("change", change); subscriptions.forEach(p => void p.then(fn => fn())); if (actionTimer.current) clearTimeout(actionTimer.current); if (holdTimer.current) clearTimeout(holdTimer.current); document.documentElement.classList.remove("pet-window-page"); };
  }, []);
  useEffect(() => { if (settings.quiet) setNotice(null); }, [settings.quiet]);
  const panelOpen = panel !== null || notice !== null || life.notice !== null || historyClearOpen || computerConfirm !== null || shellConfirm !== null;
  const chatVisible = panel === "chat" && !docked;
  const largeLayout = computerConfirm !== null || historyClearOpen || shellConfirm !== null;
  const expandedLayout = chatVisible ? chatMaximized : largeLayout;
  const activePin = !chatVisible || chatPinned;
  useEffect(() => { if (!chatVisible) setChatMaximized(false); }, [chatVisible]);
  useEffect(() => { if (!chatVisible) setChatMenu(null); }, [chatVisible]);
  useEffect(() => {
    let disposed = false;
    void work(async () => {
      try {
        await client.layout(panelOpen, expandedLayout, chatVisible, activePin, chatVisible && settings.harnessTraceEnabled);
      } finally {
        if (!disposed && !settings.harnessTraceEnabled) setChatTraceWidth(null);
      }
    });
    return () => { disposed = true; };
  }, [panelOpen, expandedLayout, chatVisible, activePin, settings.harnessTraceEnabled]);
  useEffect(() => {
    if (!chatVisible || !settings.harnessTraceEnabled) return;
    const clampSplit = () => setChatTraceSplit(value => Math.min(value, Math.max(400, window.innerWidth - 320)));
    window.addEventListener("resize", clampSplit);
    return () => window.removeEventListener("resize", clampSplit);
  }, [chatVisible, settings.harnessTraceEnabled]);
  useEffect(() => {
    const update = () => {
      const regions = chatVisible ? [] : [...document.querySelectorAll(`${petPanelRegions},.pet-alert-badge`)].map(el => el.getBoundingClientRect()).filter(r => r.width && r.height).map(r => [r.left,r.top,r.right,r.bottom]);
      void client.regions(regions).catch(e => setError(platformErrorMessage(e)));
    };
    const observer=new ResizeObserver(update); observer.observe(document.body); document.querySelectorAll(petPanelRegions).forEach(el=>observer.observe(el));
    const portals = new MutationObserver(update);
    portals.observe(document.body, { childList: true });
    update(); return () => { observer.disconnect(); portals.disconnect(); };
  }, [panel, chatVisible, notice, snapshot, error, life.notice, docked, computerConfirm, shellConfirm, historyClearOpen, protest, voiceHint]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (historyClearOpen || brightnessChoice) return;
      if (chatVisible && chatPage !== "chat") {
        setFocusedAlert(null);
        setChatPage(petChatParentPage(chatPage));
        return;
      }
      setPanel(null); setNotice(null); setProtest(false); setPose(sleeping ? "sleep" : "idle");
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [sleeping, chatVisible, chatPage, historyClearOpen, brightnessChoice]);
  useEffect(() => {
    if (docked || !visible || reduced || !["idle", "walk", "run", "spray"].includes(pose)) { setFrame(0); return; }
    const timer = setInterval(() => setFrame(f => (f + 1) % 6), pose === "idle" ? 480 : pose === "walk" ? 240 : 130);
    return () => clearInterval(timer);
  }, [pose, reduced, visible, docked]);
  useEffect(() => {
    if (!ready || !visible || pause || reduced || settings.activity === 0) return;
    const timer = setInterval(() => {
      if (Math.random() < .25) { perform("spray"); return; }
      if (settings.roam !== "still") { setDirection(Math.random() < .5 ? -1 : 1); perform(settings.appearance !== "alpaca" && settings.activity !== 2 ? "walk" : "run", 2600); }
      else perform("curious");
    }, settings.activity === 2 ? 10000 : 25000);
    return () => clearInterval(timer);
  }, [ready, visible, pause, reduced, settings.activity, settings.roam]);
  useEffect(() => {
    if (!visible || !(["run", "walk"].includes(pose)) || pause || reduced) return;
    let pending = false;
    const timer = setInterval(() => { if (!pending) { pending = true; void client.move(direction * (pose === "walk" ? 2 : 4), settings.roam === "free" ? -direction * 2 : 0).catch(e => setError(platformErrorMessage(e))).finally(() => { pending = false; }); } }, 65);
    return () => clearInterval(timer);
  }, [visible, pose, pause, reduced, settings.roam, direction]);
  useEffect(() => { if (pause && !life.roaming && (pose === "run" || pose === "walk")) setPose(sleeping ? "sleep" : "idle"); }, [pause, pose, sleeping, life.roaming]);
  function perform(next: Pose, duration = 1800) {
    if (actionTimer.current) clearTimeout(actionTimer.current);
    setPose(next); setFrame(0);
    if (next === "spray" && settings.sound && !settings.quiet) {
      const audio = new AudioContext(); const osc = audio.createOscillator(); const gain = audio.createGain();
      osc.type = "sine"; osc.frequency.setValueAtTime(700, audio.currentTime); osc.frequency.exponentialRampToValueAtTime(180, audio.currentTime + .18);
      gain.gain.setValueAtTime(.025, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .2);
      osc.connect(gain); gain.connect(audio.destination); osc.start(); osc.stop(audio.currentTime + .22); osc.onended = () => { void audio.close(); };
    }
    actionTimer.current = setTimeout(() => setPose(sleeping ? "sleep" : "idle"), duration);
  }
  const [column, row] = petFrameFor(settings.appearance, pose, frame);
  useEffect(() => { void client.sprite(column, row, direction < 0, settings.appearance).catch(e => setError(platformErrorMessage(e))); }, [column, row, direction, settings.appearance]);
  const pending = snapshot.alerts.filter(a => a.active && !a.ignored && a.snoozedUntil <= Date.now()/1000);
  useEffect(() => { setNotice(current => current && snapshot.alerts.some(a => a.key === current.key && (a.ignored || a.snoozedUntil > Date.now()/1000)) ? null : current); }, [snapshot]);
  async function computerAction(action: PetComputerAction) {
    if (computerPending.current) return;
    computerPending.current = true; setComputerBusy(true);
    await work(async () => { await client.computerAction(action); setComputerConfirm(null); });
    computerPending.current = false; setComputerBusy(false);
  }
  async function chatComputerCommand(command: PetComputerCommand): Promise<string> {
    if ("folders" in command) {
      if (command.folders === null) throw new Error("每次可以创建 1 到 20 个桌面文件夹。");
      openChatPage("chat");
      const { created, error } = await client.createDesktopFolders(command.folders);
      if (!created.length && error) throw new Error(error);
      return [`已在桌面创建 ${created.length} 个空文件夹。`, ...created, error].filter(Boolean).join("\n");
    }
    if (!runningOnWindows) throw new Error("电脑快捷操作目前仅支持 Windows 桌面端。");
    openChatPage("chat");
    if ("brightness" in command) {
      if (command.brightness === null) throw new Error("亮度须在 0 到 100 之间。");
      const percent = command.brightness;
      const monitors = await client.monitors();
      if (!monitors.length) throw new Error("未检测到可用显示器。");
      let targets = monitors;
      if (monitors.length > 1) {
        const target = await new Promise<string>(resolve => {
          setBrightnessTarget("");
          setBrightnessChoice({ monitors, percent, resolve });
        });
        if (!target) return "已取消亮度调整。";
        const current = await client.monitors();
        if (current.length !== monitors.length || current.some((monitor, index) => monitor.name !== monitors[index].name || monitor.index !== monitors[index].index)) {
          throw new Error("显示器列表已变化，请重新发送亮度指令。");
        }
        targets = target === "all" ? current : current.filter(monitor => String(monitor.index) === target);
      }
      const results: string[] = [];
      for (const monitor of targets) {
        const label = `屏幕 ${monitor.index + 1} · ${monitor.name}`;
        if (!monitor.supported) {
          results.push(`${label}：系统无法通过软件调节，外接屏可检查 DDC/CI 是否开启。`);
          continue;
        }
        try {
          const updated = await client.setBrightness(monitor.index, percent);
          results.push(`${label}：当前亮度 ${updated.current ?? "未知"}${updated.current == null ? "" : "%"}。`);
        } catch (error) {
          results.push(`${label}：${platformErrorMessage(error)}`);
        }
      }
      return results.join("\n");
    }
    if (command.action === "shutdown" || command.action === "restart") {
      requestPowerAction(command.action);
      return command.action === "shutdown" ? "请在弹窗中确认是否关机。" : "请在弹窗中确认是否重启。";
    }
    await client.computerAction(command.action);
    return { lock: "已提交锁屏请求。", taskManager: "已打开任务管理器。", explorer: "已打开文件资源管理器。" }[command.action];
  }
  /// 执行用户确认过的 CMD 命令：短状态气泡 + 语音播报，完整输出经本地回复显示在聊天面板。
  async function runShellCommand(command: string) {
    if (shellPending.current) return;
    shellPending.current = true; setShellBusy(true);
    await work(async () => {
      const result = await client.shellCommand(command);
      setShellConfirm(null);
      const status = result.timedOut ? "命令超时，已中止" : result.exitCode === 0 ? "命令执行完成" : `命令已退出，退出码 ${result.exitCode}`;
      const message = `${status}（耗时 ${(result.durationMs / 1000).toFixed(1)} 秒）`;
      setVoiceHint(message);
      speak(status);
      const output = result.output.trim();
      const reply = output ? `${message}。\n\n${output.length > 4000 ? `${output.slice(0, 4000)}\n…（输出过长已截断）` : output}` : `${message}，命令没有输出。`;
      setChatStarted(true);
      openChatPage("chat");
      setPendingVoice(turns => [...turns, { text: `执行命令：${command}`, autoSend: true, localReply: reply }]);
    });
    shellPending.current = false; setShellBusy(false);
  }
  function closePanel() { setChatMenu(null); setPanel(null); setPose(sleeping ? "sleep" : "idle"); }
  function changeChatPage(page: PetChatPage) {
    setFocusedAlert(null);
    setChatPage(page);
  }
  function openChatPage(page: PetChatPage, alert: PetAlert | null = null) {
    setNotice(null);
    setChatStarted(true);
    setFocusedAlert(alert);
    setChatPage(page);
    setPanel("chat");
  }
  function playPetAction(next: Pose, duration?: number) {
    closePanel();
    perform(next, duration);
  }
  function openChatMenu(event: MouseEvent<HTMLElement>) {
    if (!(event.target instanceof Element)) return;
    if (chatPage !== "chat" && !event.target.closest(".pet-panel-titlebar")) return;
    event.preventDefault();
    const body = event.target.closest("[data-pet-message-text]");
    const selection = body?.ownerDocument.getSelection();
    const selected = body?.contains(selection?.anchorNode ?? null) && body.contains(selection?.focusNode ?? null)
      ? selection?.toString() : undefined;
    const copyText = selected?.trim() ? selected : body?.textContent?.trim() ? body.textContent : undefined;
    setChatMenu({ x: event.clientX, y: event.clientY, copyText });
  }

  async function copyChatText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyNotice("已复制到剪贴板");
    } catch {
      setCopyNotice("复制失败，请选择文本后手动复制。");
    }
  }
  function requestPowerAction(action: "shutdown" | "restart") {
    setError("");
    setComputerConfirm(action);
  }
  async function clearChatHistory() {
    if (historyClearPending.current) return;
    historyClearPending.current = true;
    setHistoryClearBusy(true);
    setHistoryClearError("");
    try {
      await client.clearChatHistory();
      setHistoryVersion(version => version + 1);
      setHistoryClearOpen(false);
    } catch (e) {
      setHistoryClearError(platformErrorMessage(e));
    } finally {
      historyClearPending.current = false;
      setHistoryClearBusy(false);
    }
  }
  /// 右键菜单「清理聊天记录」与聊天页清空按钮共用同一确认流程；取消或关闭后回到原页面。
  function requestClearHistory() {
    setHistoryClearError("");
    setHistoryClearOpen(true);
  }
  function dragPanel(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0 || (chatVisible && chatMaximized) || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    void work(async () => { await getCurrentWindow().startDragging(); await client.move(0, 0, false, true); });
  }
  async function dragAvatar(reveal = false) {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    setProtest(false);
    setDragging(true);
    await work(async () => {
      if (reveal) { await client.reveal(); setDocked(false); }
      await getCurrentWindow().startDragging();
      // Native pet_move waits for mouse release before docking and saving the final position.
      await client.move(0,0,false,true,true);
    });
    drag.current = null;
    setDragging(false); setPose("idle");
  }
  const petName = petAppearances[settings.appearance].label;
  const appearance = settings.appearance;
  const voicePlaying = petVoice.playing || systemSpeaking;
  const companionActions: PetActionGroup = {
    label: "桌宠互动",
    actions: [
      { label: "喷水玩一下", icon: Droplets, onClick: () => playPetAction("spray") },
      { label: sleeping ? "起来活动" : "休息一下", icon: Moon, onClick: () => { closePanel(); setSleeping(!sleeping); setPose(sleeping ? "idle" : "sleep"); } },
    ],
  };
  if (appearance !== "alpaca") companionActions.actions.push(
    { label: appearance === "fish" ? "游动一会" : "散步一会", icon: Footprints, onClick: () => { setSleeping(false); playPetAction("walk", 4000); } },
    { label: appearance === "dog" ? "趴着陪伴" : "坐着玩耍", icon: Heart, onClick: () => playPetAction("lie_down", 6000) },
    { label: "陪我工作", icon: Briefcase, onClick: () => playPetAction("work", 6000) },
  );
  if (appearance === "penguin" || appearance === "fish") {
    companionActions.actions.push({ label: "飞行玩一下", icon: Plane, onClick: () => playPetAction("hanging", 4000) });
  }
  const chatActions: PetActionGroup = {
    label: "聊天与提醒",
    actions: [
      { label: "和宠物聊天", icon: MessageCircle, onClick: () => openChatPage("chat") },
      { label: "查看提醒", icon: Bell, count: pending.length || undefined, onClick: () => openChatPage("alerts") },
      { label: "桌宠设置", icon: Settings, onClick: () => openChatPage("settings") },
      { label: "清空聊天记录", icon: Trash2, danger: true, onClick: requestClearHistory },
    ],
  };
  const desktopActions: PetActionGroup[] = [
    { label: "桌面管理", actions: [
      { label: "回到屏幕下沿", icon: Move, onClick: () => void work(() => client.move(0, 0, true, true)) },
      { label: "打开云枢", icon: Home, onClick: () => void work(() => client.open("resources")) },
      { label: "隐藏桌宠", icon: EyeOff, title: "隐藏桌宠后，运维预警仍会继续运行", onClick: () => void work(client.hide) },
    ] },
  ];
  if (runningOnWindows) desktopActions.push({
    label: "电脑快捷操作",
    actions: [
      { label: "任务管理器", icon: MonitorCog, disabled: computerBusy, onClick: () => void computerAction("taskManager") },
      { label: "文件资源管理器", icon: FolderOpen, disabled: computerBusy, onClick: () => void computerAction("explorer") },
      { label: "锁定电脑", icon: LockKeyhole, disabled: computerBusy, onClick: () => void computerAction("lock") },
      { label: "重启电脑", icon: RotateCw, disabled: computerBusy, danger: true, onClick: () => requestPowerAction("restart") },
      { label: "关闭电脑", icon: Power, disabled: computerBusy, danger: true, onClick: () => requestPowerAction("shutdown") },
    ],
  });
  const quickChatActions = {
    ...chatActions,
    actions: [...chatActions.actions, { label: "全部技能", icon: Box, onClick: () => openChatPage("skills") }],
  };
  const textToCopy = chatMenu?.copyText;
  const chatMenuItems: ContextMenuItem[] = [
    ...(textToCopy ? [{ id: "copy", label: "复制", icon: <Copy size={14} aria-hidden="true" />, onSelect: () => void copyChatText(textToCopy) }] : []),
    ...(chatPage !== "chat" ? [{ id: "chat", label: "回到聊天", icon: <MessageCircle size={14} aria-hidden="true" />, onSelect: () => setChatPage("chat") }] : []),
    ...(chatPage !== "settings" ? [{ id: "settings", label: "设置", icon: <Settings size={14} aria-hidden="true" />, onSelect: () => setChatPage("settings") }] : []),
    { id: "records", label: "调用记录", icon: <History size={14} aria-hidden="true" />, onSelect: () => changeChatPage("records") },
    { id: "skills", label: "全部技能", icon: <Box size={14} aria-hidden="true" />, onSelect: () => changeChatPage("skills") },
    { id: "maximize", label: chatMaximized ? "还原窗口" : "最大化", icon: chatMaximized ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />, onSelect: () => {
      const expanded = !chatMaximized;
      setChatMaximized(expanded);
      if (!expanded && settings.harnessTraceEnabled) void client.save({ ...settings, harnessTraceEnabled: false }).catch(reason => setError(platformErrorMessage(reason, "无法关闭步骤面板")));
    } },
    { id: "pin", label: chatPinned ? "取消置顶" : "置顶窗口", icon: chatPinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />, onSelect: () => setChatPinned(value => !value) },
    { id: "more", label: "更多操作…", icon: <MoreHorizontal size={14} aria-hidden="true" />, onSelect: () => setPanel("menu") },
    { id: "clear", label: "清理聊天记录", icon: <Trash2 size={14} aria-hidden="true" />, danger: true, separated: true, onSelect: requestClearHistory },
    { id: "close", label: "关闭", icon: <X size={14} aria-hidden="true" />, onSelect: () => { setChatPage("chat"); closePanel(); } },
  ];
  return <main className={`pet-stage ${docked ? "pet-docked-stage" : dockEdge === "top" && panelOpen ? "pet-top-stage" : ""} ${reduced ? "pet-reduced" : ""}`} data-chat-open={chatVisible || undefined} data-docked={docked ? "true" : undefined} data-edge={docked ? dockEdge : undefined} style={{ "--pet-size": `${settings.size}px`, ...(petAppearances[appearance].sprite ? { "--pet-sprite-image": `url("${petAppearances[appearance].sprite}")` } : {}), "--pet-edge-shift": `${edgeShift}px` } as React.CSSProperties}>
    {chatStarted && <section ref={chatCard} hidden={!chatVisible} style={chatVisible ? { "--pet-chat-trace-split": `${chatTraceSplit}px`, "--pet-chat-main-width": chatTraceWidth === null ? undefined : `${chatTraceWidth}px` } as React.CSSProperties : { display: "none" }} className="modal-form-layout dialog-common-theme pet-floating-card pet-chat-card" data-page={chatPage} data-maximized={chatMaximized || undefined} data-trace-visible={chatVisible && settings.harnessTraceEnabled || undefined} role="dialog" aria-label={`与${petName}聊天`} onContextMenu={openChatMenu}>
      <header className="pet-panel-titlebar" onPointerDown={dragPanel} title="拖动标题栏移动 · 右键打开菜单">
        <strong><PetPortrait appearance={settings.appearance} pose="happy" /><span>{petName}</span></strong>
        <div className="pet-chat-title-tools">
          <button type="button" aria-label="置顶窗口" title={chatPinned ? "取消置顶" : "置顶窗口"} aria-pressed={chatPinned} onClick={() => setChatPinned(value => !value)}>{chatPinned ? <Pin size={15} aria-hidden="true" /> : <PinOff size={15} aria-hidden="true" />}</button>
          {chatPage === "chat" && <button type="button" aria-label="设置" title="设置" onClick={() => setChatPage("settings")}><Settings size={16} aria-hidden="true" /></button>}
          <button type="button" aria-label="收起到桌宠" title="收起到桌宠" onClick={closePanel}><Minus size={16} aria-hidden="true" /></button>
          <DialogHeaderActions expanded={chatMaximized} onExpandedChange={expanded => {
            setChatMaximized(expanded);
            if (!expanded && settings.harnessTraceEnabled) void client.save({ ...settings, harnessTraceEnabled: false }).catch(reason => setError(platformErrorMessage(reason, "无法关闭步骤面板")));
          }} resizeLabels={{ expand: "最大化窗口", restore: "还原窗口" }}>
            <button type="button" className="pet-chat-close" aria-label="关闭" title="关闭（Esc）" onClick={() => { setChatPage("chat"); closePanel(); }}><X size={16} aria-hidden="true" /></button>
          </DialogHeaderActions>
        </div>
      </header>
      <div className="modal-body pet-panel-body">
        {chatVisible && error && <div className="pet-chat-error" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="关闭错误提示" title="关闭错误提示" onClick={() => setError("")}><X size={14} aria-hidden="true" /></button>
        </div>}
        <PetChat settings={settings} settingsReady={ready} onSettingsSave={async next => {
          if (next.harnessTraceEnabled && !settings.harnessTraceEnabled) {
            const width = chatCard.current?.querySelector(".pet-chat-main")?.getBoundingClientRect().width;
            if (width) { setChatTraceWidth(width); setChatTraceSplit(width + 20); }
          }
          try { await client.save(next); }
          catch (reason) { if (!settings.harnessTraceEnabled) setChatTraceWidth(null); throw reason; }
        }} page={chatPage} onPageChange={changeChatPage}
        skillsActions={<PetActionGroups groups={[companionActions, chatActions, ...desktopActions]} />}
        alerts={{ count: pending.length, page: <PetAlertsPage key={focusedAlert?.key ?? "alerts"} snapshot={snapshot} monitoring={settings.monitoring} initialAlert={focusedAlert} onSnapshotChange={setSnapshot} /> }}
        visible={chatVisible} historyVersion={historyVersion} clearingHistory={historyClearOpen} pendingVoice={pendingVoice[0]}
        voiceActivity={{ listening: petVoice.listening, listeningError: petVoice.listeningError, recognizing: petVoice.recognizing, processing: petVoice.processing, playing: voicePlaying }}
        onVoiceConsumed={() => setPendingVoice(turns => turns.slice(1))}
        onVoiceTranscript={transcript => petVoice.submit(transcript)}
        voiceDraftText={petVoice.draftText} onVoiceDraftSend={petVoice.sendDraft} onVoiceDraftCancel={petVoice.cancelDraft}
        onComputerCommand={chatComputerCommand}
        onReplay={(reply, done) => speak(reply, { interrupt: true, onDone: done })}
        onVoicePreview={preset => new Promise<void>((resolve, reject) => {
          speak("", { interrupt: true, previewPreset: preset, onUnavailable: reject, onDone: resolve });
        })}
        onVoiceError={setError}
        onPrepareSentence={(text, id) => {
          const { voice, quiet } = settingsRef.current;
          return runningInTauri && !quiet && voice.enabled && voice.speak && (useWindowsSpeech || isMimoSpeechPreset(voice.speechPreset))
            ? client.voicePrepare(text, id) : Promise.resolve();
        }}
        onSpeakSentence={(text, done, preparedId) => speak(text, { preparedId, onDone: done, onUnavailable: error => setVoiceHint(platformErrorMessage(error)) })}
        onInterruptSpeech={() => { stopSystemSpeech(); void client.voiceSpeak(null, true).catch(() => {}); }}
        onVoiceReplyDone={commandId => { if (commandId !== undefined) void client.voiceContinue(commandId).catch(() => {}); }} /></div>
    {chatVisible && !chatMaximized && settings.harnessTraceEnabled && <div className="pet-chat-trace-splitter" role="separator" aria-label="调整聊天与步骤面板宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={maxChatTraceSplit} aria-valuenow={chatTraceSplit} tabIndex={0}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); chatTraceSplitDrag.current = { pointerId: event.pointerId, clientX: event.clientX, split: chatTraceSplit }; }}
      onPointerMove={event => { const drag = chatTraceSplitDrag.current; if (drag?.pointerId === event.pointerId) setChatTraceSplit(Math.max(320, Math.min(maxChatTraceSplit, drag.split + event.clientX - drag.clientX))); }}
      onPointerUp={event => { if (chatTraceSplitDrag.current?.pointerId === event.pointerId) chatTraceSplitDrag.current = null; }}
      onPointerCancel={() => { chatTraceSplitDrag.current = null; }}
      onLostPointerCapture={() => { chatTraceSplitDrag.current = null; }}
      onKeyDown={event => { if (event.key === "ArrowLeft") { event.preventDefault(); setChatTraceSplit(value => Math.max(320, value - 16)); } else if (event.key === "ArrowRight") { event.preventDefault(); setChatTraceSplit(value => Math.min(maxChatTraceSplit, value + 16)); } }} />}
    </section>}
    {chatVisible && !chatMaximized && <PetChatResizeEdges onError={setError} />}

    {chatVisible && chatMenu && <ContextMenu x={chatMenu.x} y={chatMenu.y} label={`${petName}聊天窗口操作`} items={chatMenuItems} onClose={() => setChatMenu(null)} />}
    {chatVisible && copyNotice && <ToastNotice message={copyNotice} onDismiss={() => setCopyNotice("")} />}
    {docked ?
    <button className="pet-dock-handle" aria-label="拉出宠物" title="点击绳环拉出宠物，也可以按住拖动"
      onClick={() => { if (!drag.current?.moved && !dragging) void work(() => client.reveal()); }}
      onPointerDown={e => { if (e.button !== 0) return; drag.current = { x: e.screenX, y: e.screenY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { const start=drag.current; if (start && !start.moved && Math.hypot(e.screenX-start.x,e.screenY-start.y)>5) { start.moved=true; void dragAvatar(true); } }}
      onPointerUp={() => { if (!drag.current?.moved) drag.current=null; }} onPointerCancel={() => { drag.current=null; }}>
      <svg className="pet-dock-rope" viewBox="0 0 24 64" aria-hidden="true" fill="none">
        <path className="pet-rope-outline" d="M12 -3V33M12 33C8 33 5 39 5 46C5 53 8 57 12 57C16 57 19 53 19 46C19 39 16 33 12 33Z" />
        <path className="pet-rope-cord" d="M12 -3V33M12 33C8 33 5 39 5 46C5 53 8 57 12 57C16 57 19 53 19 46C19 39 16 33 12 33Z" />
        <path className="pet-rope-thread" d="M12 0V31M12 35C9 35 7 40 7 46C7 51 9 55 12 55" />
        <path className="pet-rope-knot" d="M9 30L15 32M9 33L15 35" />
      </svg>
    </button> : <>
    {life.notice && <PetLifeBubble notice={life.notice} action={life.action} roaming={life.roaming} appearance={settings.appearance} />}
    {!panel && !notice && !life.notice && protest && <div className="pet-speech-bubble pet-protest" role="status" aria-label="宠物在抗议被抓住">坏人，快放开我！放开我！</div>}
    {!panel && !notice && !life.notice && !protest && (voiceHint || petVoice.listeningError) && <div className={`pet-speech-bubble${petVoice.listeningError && !voiceHint ? " pet-voice-warning" : " pet-voice-hint"}`} role="status" aria-label="语音助手状态">{petVoice.listeningError && !voiceHint ? petVoice.listeningError : voiceHint}</div>}
    {!panel && notice && <div className={`pet-speech-bubble ${notice.active ? notice.severity : "recovered"}`} role="status" aria-label="运维消息气泡">
      <button className="pet-speech-open" onClick={() => openChatPage("alerts", notice)} aria-label={`查看运维消息：${notice.title}`}>
        <span className="pet-speech-caption"><PetPortrait appearance={settings.appearance} pose={notice.active ? "alert" : "happy"} /><Bell size={13} aria-hidden="true" />{notice.active ? notice.severity === "emergency" ? "超级严重，请尽快处理" : "有件事想提醒你" : "好消息，状态恢复了"}</span>
        <strong>{notice.title}</strong><span className="pet-speech-detail">{notice.detail}</span><span className="pet-speech-hint">点击查看{pending.length > 1 ? ` · 共 ${pending.length} 项待处理` : ""}</span>
      </button><button className="pet-speech-close" aria-label="关闭消息气泡" title="关闭消息气泡" onClick={() => { setNotice(null); setPose(sleeping ? "sleep" : "idle"); }}><X size={14} /></button>
    </div>}
    {panel === "menu" && <section className="modal-form-layout dialog-common-theme pet-floating-card pet-quick-menu" role="dialog" aria-label="宠物快捷菜单">
      <header className="pet-panel-titlebar" onPointerDown={dragPanel} title="拖动标题栏移动">
        <strong><PetPortrait appearance={settings.appearance} />{petName}</strong>
        <DialogHeaderActions showResize={false}><button className="pet-menu-close" aria-label="关闭" title="关闭（Esc）" onClick={closePanel}><X size={16} /></button></DialogHeaderActions>
      </header>
      <div className="modal-body pet-panel-body"><PetActionGroups groups={[quickChatActions, companionActions, ...desktopActions]} /></div>
    </section>}
    {historyClearOpen && createPortal(<PetConfirmDialog title="清空聊天记录" message="确定永久删除本机保存的桌宠聊天记录和已发送图片？" tone="danger" confirmLabel="清空聊天记录" busy={historyClearBusy} error={historyClearError} onResolve={confirmed => { if (confirmed) void clearChatHistory(); else setHistoryClearOpen(false); }} />, document.body)}
    {brightnessChoice && createPortal(<PetConfirmDialog title="选择显示器" message={`检测到 ${brightnessChoice.monitors.length} 台显示器。请选择要调到 ${brightnessChoice.percent}% 的屏幕。`} confirmLabel="调整亮度" confirmDisabled={!brightnessTarget}
      onResolve={confirmed => { brightnessChoice.resolve(confirmed ? brightnessTarget : ""); setBrightnessChoice(null); }}>
      <label className="pet-brightness-choice">目标显示器
        <select value={brightnessTarget} onChange={event => setBrightnessTarget(event.target.value)}>
          <option value="">请选择显示器</option>
          {brightnessChoice.monitors.map(monitor => <option key={monitor.index} value={monitor.index} disabled={!monitor.supported}>
            {monitor.index + 1} · {monitor.name}{!monitor.supported ? "（无法软件调节）" : monitor.current == null ? "" : `（当前 ${monitor.current}%）`}
          </option>)}
          <option value="all" disabled={!brightnessChoice.monitors.some(monitor => monitor.supported)}>全部调整</option>
        </select>
      </label>
    </PetConfirmDialog>, document.body)}
    {computerConfirm && createPortal(<PetConfirmDialog title={computerConfirm === "shutdown" ? "关闭电脑" : "重启电脑"} message={`确定${computerConfirm === "shutdown" ? "关闭" : "重启"}当前电脑吗？请先保存正在编辑的文件，操作会立即提交给 Windows。`} confirmLabel={computerConfirm === "shutdown" ? "确认关机" : "确认重启"} busy={computerBusy} error={error} onResolve={confirmed => { if (confirmed) void computerAction(computerConfirm); else setComputerConfirm(null); }} />, document.body)}
    {shellConfirm && createPortal(<PetConfirmDialog title="执行电脑命令" tone="danger" message={`${shellConfirm.summary || "AI 建议执行以下 CMD 命令"}。请核对命令内容，确认后才会在本机执行，高危命令会被直接拒绝。`} confirmLabel="确认执行" busy={shellBusy} error={error} onResolve={confirmed => { if (confirmed) void runShellCommand(shellConfirm.command); else setShellConfirm(null); }}><pre className="pet-shell-command">{shellConfirm.command}</pre></PetConfirmDialog>, document.body)}
    {!chatVisible && error && <div className="pet-inline-error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError("")}>关闭</button></div>}
    <div className="pet-avatar-wrap" data-voice-listening={petVoice.listening ? (petVoice.listeningError ? "error" : "on") : undefined} data-voice-playing={voicePlaying ? "on" : undefined} onMouseEnter={() => { setHover(true); if (pose === "idle") setPose("curious"); }} onMouseLeave={() => { setHover(false); if (pose === "curious") setPose("idle"); }}>
      <button className="pet-avatar" aria-label="宠物：点击查看提醒，右键打开菜单，拖动可移动" title="点击查看提醒 · 右键菜单 · 拖动移动"
        onContextMenu={e => { e.preventDefault(); setPanel("menu"); setPose("idle"); }}
        onPointerDown={e => { if (e.button !== 0) return; drag.current = { x: e.screenX, y: e.screenY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); if (holdTimer.current) clearTimeout(holdTimer.current); holdTimer.current = setTimeout(() => { if (drag.current && !drag.current.moved) setProtest(true); }, 700); }}
        onPointerMove={e => { const start = drag.current; if (start && !start.moved && Math.hypot(e.screenX-start.x,e.screenY-start.y)>5) { start.moved = true; if (holdTimer.current) clearTimeout(holdTimer.current); setProtest(false); setPose("hanging"); void dragAvatar(); } }}
        onPointerUp={() => { if (holdTimer.current) clearTimeout(holdTimer.current); setProtest(false); const d=drag.current; drag.current=null; if (d && !d.moved) { openChatPage("alerts"); perform("happy",650); } }}
        onPointerCancel={() => { if (holdTimer.current) clearTimeout(holdTimer.current); setProtest(false); drag.current=null; setPose("idle"); }}
        onClick={e => { if (e.detail === 0) openChatPage("alerts"); }}>
        {appearance === "human"
          ? <PetHumanoid pose={pose} talking={voicePlaying} amplitude={petVoice.amplitude} direction={direction < 0 ? -1 : 1} />
          : <span className={`pet-sprite pet-pose-${pose}`} style={{ ...petSpriteStyle(appearance, column, row), transform: `scaleX(${direction})` }} />}
      </button>
      {pose === "spray" && !reduced && <div className={`pet-water ${direction < 0 ? "to-left" : ""}`} aria-hidden="true">{Array.from({ length: 7 },(_,i) => <i key={i} style={{ "--drop": i } as React.CSSProperties} />)}</div>}
      {petVoice.listening && <span className={`pet-voice-badge${petVoice.listeningError ? " pet-voice-badge-error" : ""}`} role="status" aria-label={petVoice.listeningError ? `语音监听异常：${petVoice.listeningError}` : `正在监听唤醒词：${settings.voice.wakeWord}`} title={`正在监听唤醒词“${settings.voice.wakeWord}”${petVoice.listeningError ? `（${petVoice.listeningError}）` : ""}`}><Mic size={12} aria-hidden="true" />{petVoice.listeningError ? "监听异常" : "监听中"}</span>}
      {pending.length > 0 && <button className="pet-alert-badge" aria-label={`${pending.length}项待处理提醒`} onClick={() => openChatPage("alerts")}>{pending.length}</button>}
    </div>
    </>}
  </main>;
}
