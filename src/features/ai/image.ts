export type ImageRect={x:number;y:number;width:number;height:number};
export function sourceDimensions(bytes:Uint8Array):{width:number;height:number}{
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length>=24 && [137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value))return{width:view.getUint32(16),height:view.getUint32(20)};
  if(bytes[0]===255&&bytes[1]===216){let offset=2;while(offset+4<bytes.length){if(bytes[offset]!==255)throw new Error("JPEG图片头无效");while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===217||marker===218)break;if(marker===1||(marker>=208&&marker<=215))continue;const length=view.getUint16(offset);if(length<2||offset+length>bytes.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8)return{height:view.getUint16(offset+3),width:view.getUint16(offset+5)};offset+=length;}}
  throw new Error("请使用有效的PNG或JPEG截图");
}
export function validRect(rect:ImageRect,width:number,height:number):boolean{return Object.values(rect).every(Number.isInteger)&&rect.x>=0&&rect.y>=0&&rect.width>0&&rect.height>0&&rect.x+rect.width<=width&&rect.y+rect.height<=height;}
