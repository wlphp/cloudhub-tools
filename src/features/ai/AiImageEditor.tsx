import { useEffect,useRef,useState,type PointerEvent } from "react";
import type { AiImage } from "../../platform/clients/ai";
import { sourceDimensions } from "./image";
import { platformErrorMessage } from "../../platform/api";

type MaskPoint={x:number;y:number};
type MaskStroke={points:MaskPoint[];width:number};

function paintStroke(ctx:CanvasRenderingContext2D,stroke:MaskStroke,scale=1){
  const [first,...rest]=stroke.points;
  if(!first)return;
  ctx.fillStyle="#000";ctx.strokeStyle="#000";ctx.lineWidth=stroke.width*scale;ctx.lineCap="round";ctx.lineJoin="round";
  if(!rest.length){ctx.beginPath();ctx.arc(first.x*scale,first.y*scale,stroke.width*scale/2,0,Math.PI*2);ctx.fill();return;}
  ctx.beginPath();ctx.moveTo(first.x*scale,first.y*scale);rest.forEach(point=>ctx.lineTo(point.x*scale,point.y*scale));ctx.stroke();
}

export function AiImageEditor({onPrepared,onCancel,initialFile}:{onPrepared:(image:AiImage)=>void;onCancel:()=>void;initialFile?:File}){
  const [bitmap,setBitmap]=useState<ImageBitmap|null>(null);
  const [masks,setMasks]=useState<MaskStroke[]>([]),[error,setError]=useState("");
  const [brushSize,setBrushSize]=useState(24);
  const canvas=useRef<HTMLCanvasElement>(null),stroke=useRef<MaskStroke|null>(null),alive=useRef(true),latest=useRef(0);
  const area=useRef<HTMLElement>(null);
  const [loading,setLoading]=useState(false);
  useEffect(()=>{area.current?.focus();},[]);
  useEffect(()=>{if(initialFile)void load(initialFile);},[initialFile]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;latest.current++;};},[]);
  useEffect(()=>()=>bitmap?.close(),[bitmap]);
  useEffect(()=>{if(!bitmap||!canvas.current)return;const c=canvas.current;c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext("2d");if(ctx){ctx.drawImage(bitmap,0,0);masks.forEach(mask=>paintStroke(ctx,mask));}},[bitmap]);
  async function load(file:File){setError("");setLoading(true);stroke.current=null;const generation=++latest.current;try{if(file.size>12*1024*1024)throw new Error("原图超过12MB，请先缩小");const dims=sourceDimensions(new Uint8Array(await file.arrayBuffer()));if(!dims.width||!dims.height||dims.width*dims.height>20_000_000||dims.width>12000||dims.height>12000)throw new Error("原图尺寸过大，请先缩小");const image=await createImageBitmap(file);if(!alive.current||generation!==latest.current){image.close();return;}setBitmap(image);setMasks([]);}catch(e){if(alive.current&&generation===latest.current)setError(e instanceof Error && ["原图超过12MB，请先缩小","原图尺寸过大，请先缩小","请使用有效的PNG或JPEG图片","JPEG图片头无效","图片格式无效"].includes(e.message)?e.message:platformErrorMessage(e));}finally{if(alive.current&&generation===latest.current)setLoading(false);}}
  function point(event:PointerEvent<HTMLCanvasElement>){const box=event.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(bitmap!.width,Math.round((event.clientX-box.x)*bitmap!.width/box.width))),y:Math.max(0,Math.min(bitmap!.height,Math.round((event.clientY-box.y)*bitmap!.height/box.height)))};}
  function finish(event:PointerEvent<HTMLCanvasElement>){const finished=stroke.current;stroke.current=null;if(finished)setMasks(values=>[...values,finished]);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}
  function paint(event:PointerEvent<HTMLCanvasElement>){const current=stroke.current;if(!current)return;const next=point(event);const previous=current.points[current.points.length-1];current.points.push(next);const ctx=event.currentTarget.getContext("2d");if(!ctx)return;ctx.strokeStyle="#000";ctx.lineWidth=current.width;ctx.lineCap="round";ctx.lineJoin="round";ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(next.x,next.y);ctx.stroke();}
  function begin(event:PointerEvent<HTMLCanvasElement>){if(!bitmap||event.button!==0)return;const next=point(event),bounds=event.currentTarget.getBoundingClientRect();const nextStroke={points:[next],width:brushSize*bitmap.width/bounds.width};stroke.current=nextStroke;event.currentTarget.setPointerCapture(event.pointerId);const ctx=event.currentTarget.getContext("2d");if(ctx)paintStroke(ctx,nextStroke);}
  function undo(){const next=masks.slice(0,-1);setMasks(next);if(!bitmap||!canvas.current)return;const ctx=canvas.current.getContext("2d");if(!ctx)return;ctx.clearRect(0,0,bitmap.width,bitmap.height);ctx.drawImage(bitmap,0,0);next.forEach(mask=>paintStroke(ctx,mask));}
  function prepare(){if(!bitmap)return;setError("");try{const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));const output=document.createElement("canvas");output.width=Math.max(1,Math.round(bitmap.width*scale));output.height=Math.max(1,Math.round(bitmap.height*scale));const ctx=output.getContext("2d");if(!ctx)throw new Error("当前环境无法处理图片");ctx.drawImage(bitmap,0,0,output.width,output.height);masks.forEach(mask=>paintStroke(ctx,mask,scale));const dataUrl=output.toDataURL("image/jpeg",.85);if(dataUrl.length>2_800_000)throw new Error("处理后的图片过大，请换一张较小图片");onPrepared({dataUrl,reviewed:true});}catch(e){setError(String(e));}}
  return <section ref={area} tabIndex={0} className="ai-image-editor" aria-label="图片遮罩处理"><h3>图片遮罩处理</h3><p>拖动涂黑敏感内容；调整笔刷粗细以适配不同区域，可撤销上一笔。</p>{loading&&<p role="status">正在处理图片…</p>}
    {bitmap&&<><div className="ai-image-canvas"><canvas ref={canvas} aria-label="拖动涂抹以遮挡图片内容" style={{touchAction:"none",cursor:"crosshair"}} onPointerDown={begin} onPointerMove={paint} onPointerUp={finish} onPointerCancel={finish}/></div><div className="ai-mask-toolbar"><label htmlFor="ai-mask-brush-size">笔刷粗细 <output htmlFor="ai-mask-brush-size">{brushSize}px</output></label><input id="ai-mask-brush-size" type="range" min="8" max="48" step="2" value={brushSize} aria-label="遮罩笔刷粗细" onChange={event=>setBrushSize(Number(event.target.value))}/><button type="button" onClick={undo} disabled={!masks.length}>撤销上一笔</button><span>已遮挡 {masks.length} 处</span></div></>}
    {error&&<p className="ai-feedback" role="alert">{error}</p>}<div className="ai-actions"><button type="button" onClick={onCancel}>取消</button><button type="button" className="ai-primary" disabled={loading||!bitmap} onClick={prepare}>使用处理后的图片</button></div>
  </section>;
}
