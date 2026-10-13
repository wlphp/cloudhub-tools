import type { AiFields } from "../../platform/clients/ai";
import type { FrpProxy } from "../../shared/types";

function hostname(value: string) { return value.length<=253 && value.split(".").every(part=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)); }
function address(value: string) {
  if(value.includes(":")) {try{return !!new URL(`http://[${value}]/`).hostname;}catch{return false;}}
  if(/^\d+(?:\.\d+){3}$/.test(value))return value.split(".").every(part=>Number(part)<=255);
  return hostname(value);
}
export function frpAiRule(current: FrpProxy, fields: AiFields): FrpProxy {
  const allowed=["name","kind","local_ip","local_port","remote_port","custom_domain"];
  if(Object.keys(fields).some(key=>!allowed.includes(key)))throw new Error("FRP草稿包含不允许的字段");
  const next={...current};
  if(fields.kind!=null){if(typeof fields.kind!=="string"||!["tcp","udp","http","https"].includes(fields.kind))throw new Error("FRP协议类型无效");if(fields.kind!==current.kind){next.remotePort=null;next.customDomain=null;next.customDomains=[];next.plugin=null;}next.kind=fields.kind as FrpProxy["kind"];}
  if(fields.name!=null){if(typeof fields.name!=="string"||!/^[a-z0-9_.-]{1,64}$/i.test(fields.name.trim()))throw new Error("规则名称只能包含1至64个英文、数字、点、下划线或连字符");next.name=fields.name.trim();}
  if(fields.local_ip!=null){if(typeof fields.local_ip!=="string"||!address(fields.local_ip.trim()))throw new Error("本地IP或域名无效");next.localIp=fields.local_ip.trim();}
  for(const key of ["local_port","remote_port"] as const){if(fields[key]==null)continue;const raw=fields[key];const port=typeof raw==="number"?raw:typeof raw==="string"&&/^\d+$/.test(raw)?Number(raw):NaN;if(!Number.isInteger(port)||port<1||port>65535)throw new Error("FRP端口必须为1至65535的整数");if(key==="local_port")next.localPort=port;else next.remotePort=port;}
  if(fields.custom_domain!=null){if(typeof fields.custom_domain!=="string")throw new Error("访问域名无效");const domains=fields.custom_domain.trim().split(/[,，\s]+/).filter(Boolean);if(!domains.length||domains.length>20||domains.some(domain=>!hostname(domain))||new Set(domains.map(domain=>domain.toLowerCase())).size!==domains.length)throw new Error("访问域名须为1至20个不重复的纯域名");next.customDomain=domains.map(domain=>domain.toLowerCase()).join(", ");next.customDomains=[];}
  if(next.kind==="http"||next.kind==="https"){if(fields.remote_port!=null)throw new Error("HTTP/HTTPS规则使用域名，不能填写远端端口");next.remotePort=null;}
  else{if(fields.custom_domain!=null)throw new Error("TCP/UDP规则使用远端端口，不能填写访问域名");next.customDomain=null;next.customDomains=[];next.plugin=null;}
  return next;
}
