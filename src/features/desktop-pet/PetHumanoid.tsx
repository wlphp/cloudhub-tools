import { useEffect, useState } from "react";
import type { PetPose } from "./appearances";

/// 程序化绘制的"小人"桌宠形象：SVG 助手机器人，不依赖精灵图素材。
/// 口型由 talking + amplitude（MiMo 声纹事件）驱动；无声纹时回落伪随机开合。
/// 其余姿态映射为表情与轻微动作；颜色固定，保证任意壁纸上可见。
/// 结构分层：根节点只承载播报弹跳/光晕动画，inner 承载待机浮动，svg 承载翻转与歪头。
export function PetHumanoid({ pose = "idle", talking = false, amplitude = null, direction = 1, className = "", hidden = false }: {
  pose?: PetPose;
  talking?: boolean;
  amplitude?: number | null;
  direction?: 1 | -1;
  className?: string;
  hidden?: boolean;
}) {
  const [mouth, setMouth] = useState(0);
  useEffect(() => {
    if (!talking) { setMouth(0); return; }
    if (amplitude !== null) { setMouth(Math.max(.12, Math.min(1, amplitude * 3.2))); return; }
    const timer = setInterval(() => setMouth(Math.random() < .3 ? .1 : .35 + Math.random() * .6), 132);
    return () => clearInterval(timer);
  }, [talking, amplitude]);
  const sleeping = pose === "sleep";
  const happy = pose === "happy";
  const alert = pose === "alert";
  const curious = pose === "curious";
  const mouthRy = sleeping ? 1 : 1.2 + mouth * 5.4;
  return <span
    className={`pet-humanoid${curious ? " pet-humanoid-tilt" : ""}${happy ? " pet-humanoid-happy" : ""}${alert ? " pet-humanoid-alert" : ""}${sleeping ? " pet-humanoid-sleep" : ""}${talking ? " pet-humanoid-talking" : ""}${hidden ? " pet-humanoid-static" : ""}${className ? ` ${className}` : ""}`}
    data-appearance="human"
    aria-hidden={hidden || undefined}
    style={direction < 0 ? { "--pet-humanoid-flip": "scaleX(-1)" } as React.CSSProperties : undefined}>
    <span className="pet-humanoid-inner">
      <svg viewBox="0 0 120 120" focusable="false">
        <ellipse className="pet-humanoid-shadow" cx="60" cy="114" rx="22" ry="4" />
        <g className="pet-humanoid-antenna">
          <line x1="60" y1="21" x2="60" y2="11" />
          <circle cx="60" cy="8.5" r="3.6" />
        </g>
        <rect className="pet-humanoid-head" x="26" y="19" width="68" height="54" rx="20" />
        <rect className="pet-humanoid-face" x="33" y="26" width="54" height="40" rx="13" />
        <g className="pet-humanoid-eyes">
          {happy
            ? <><path d="M44 46 q5 -7 10 0" /><path d="M66 46 q5 -7 10 0" /></>
            : sleeping
              ? <><path d="M45 45 h8" /><path d="M67 45 h8" /></>
              : <><circle className="pet-humanoid-eye" cx="49" cy="45" r={alert ? 5 : 4} /><circle className="pet-humanoid-eye" cx="71" cy="45" r={alert ? 5 : 4} /></>}
        </g>
        <ellipse className="pet-humanoid-mouth" cx="60" cy={sleeping ? 56.5 : 55} rx="5.5" ry={mouthRy} style={{ transition: "ry 70ms ease" }} />
        <rect className="pet-humanoid-body" x="38" y="75" width="44" height="31" rx="12" />
        <circle className="pet-humanoid-chest" cx="60" cy="89" r="5" />
        <rect className="pet-humanoid-arm pet-humanoid-arm-left" x="26" y="77" width="10" height="21" rx="5" />
        <rect className="pet-humanoid-arm pet-humanoid-arm-right" x="84" y="77" width="10" height="21" rx="5" />
        <rect className="pet-humanoid-leg pet-humanoid-leg-left" x="46" y="104" width="9" height="11" rx="4" />
        <rect className="pet-humanoid-leg pet-humanoid-leg-right" x="65" y="104" width="9" height="11" rx="4" />
      </svg>
    </span>
  </span>;
}
