// Adapted from user-provided worker.fixed.js; VLESS-only, credentials supplied by secret bindings.
import { connect } from 'cloudflare:sockets';

function createWorker(env) {

const uuid = env.UUID;
const bufferSize = 640 * 1024;
const flushTime = 2;

const proxyIpAddrs = { EU: 'ProxyIP.DE.CMLiussss.net', AS: 'ProxyIP.SG.CMLiussss.net', JP: 'ProxyIP.JP.CMLiussss.net', US: 'ProxyIP.US.CMLiussss.net' };//分区域proxyip
const coloRegions = {
	JP: new Set(['FUK', 'ICN', 'KIX', 'NRT', 'OKA']),
	EU: new Set([
		'ACC', 'ADB', 'ALA', 'ALG', 'AMM', 'AMS', 'ARN', 'ATH', 'BAH', 'BCN', 'BEG', 'BGW', 'BOD', 'BRU', 'BTS', 'BUD', 'CAI',
		'CDG', 'CPH', 'CPT', 'DAR', 'DKR', 'DMM', 'DOH', 'DUB', 'DUR', 'DUS', 'DXB', 'EBB', 'EDI', 'EVN', 'FCO', 'FRA', 'GOT',
		'GVA', 'HAM', 'HEL', 'HRE', 'IST', 'JED', 'JIB', 'JNB', 'KBP', 'KEF', 'KWI', 'LAD', 'LED', 'LHR', 'LIS', 'LOS', 'LUX',
		'LYS', 'MAD', 'MAN', 'MCT', 'MPM', 'MRS', 'MUC', 'MXP', 'NBO', 'OSL', 'OTP', 'PMO', 'PRG', 'RIX', 'RUH', 'RUN', 'SKG',
		'SOF', 'STR', 'TBS', 'TLL', 'TLV', 'TUN', 'VIE', 'VNO', 'WAW', 'ZAG', 'ZRH']),
	AS: new Set([
		'ADL', 'AKL', 'AMD', 'BKK', 'BLR', 'BNE', 'BOM', 'CBR', 'CCU', 'CEB', 'CGK', 'CMB', 'COK', 'DAC', 'DEL', 'HAN', 'HKG',
		'HYD', 'ISB', 'JHB', 'JOG', 'KCH', 'KHH', 'KHI', 'KTM', 'KUL', 'LHE', 'MAA', 'MEL', 'MFM', 'MLE', 'MNL', 'NAG', 'NOU',
		'PAT', 'PBH', 'PER', 'PNH', 'SGN', 'SIN', 'SYD', 'TPE', 'ULN', 'VTE'])
};
const coloToProxyMap = new Map();
for (const [region, colos] of Object.entries(coloRegions)) { for (const colo of colos) coloToProxyMap.set(colo, proxyIpAddrs[region]) }
const uuidBytes = new Uint8Array(16), offsets = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 4, 4];
for (let i = 0, c; i < 16; i++) uuidBytes[i] = (((c = uuid.charCodeAt(i * 2 + offsets[i])) > 64 ? c + 9 : c) & 0xF) << 4 | (((c = uuid.charCodeAt(i * 2 + offsets[i] + 1)) > 64 ? c + 9 : c) & 0xF);
const [textEncoder, textDecoder] = [new TextEncoder(), new TextDecoder()];
const thirdPartyEntrances = [
	{ name: '优选-日本AI', server: 'jp.111000.cc.cd' },
	{ name: '优选-030101', server: 'bestcf.030101.xyz' },
	{ name: '优选-sin.fan', server: 'saas.sin.fan' },
	{ name: '优选-云闪88', server: 'freeyx.cloudflare88.eu.org' },
	{ name: '优选-090227', server: 'cf.090227.xyz' }
];
const createClashSubscription = (host) => {
	const preferredEntrances = env.THIRD_PARTY === 'true' ? thirdPartyEntrances : [{ name: 'CloudHub VLESS', server: host }];
	const names = preferredEntrances.map(item => item.name);
	const proxyBlocks = preferredEntrances.map(({ name, server }) => `  - name: "${name}"
    type: vless
    server: ${server}
    port: 443
    uuid: ${uuid}
    network: ws
    tls: true
    udp: false
    sni: ${host}
    client-fingerprint: chrome
    ws-opts:
      path: "/"
      headers:
        host: ${host}`).join('\n\n');
	const proxyNames = names.map(name => `      - "${name}"`).join('\n');
	return `port: 7890
socks-port: 7891
allow-lan: false
mode: rule
log-level: info

proxies:
${proxyBlocks}

proxy-groups:
  - name: "自动优选"
    type: url-test
    proxies:
${proxyNames}
    url: "http://www.gstatic.com/generate_204"
    interval: 30

  - name: "节点选择"
    type: select
    proxies:
      - "自动优选"
${proxyNames}
      - "DIRECT"

rules:
  - GEOIP,CN,DIRECT
  - MATCH,节点选择
`;
};
const binaryAddrToString = (addrType, addrBytes) => {
	if (addrType === 3) return textDecoder.decode(addrBytes);
	if (addrType === 1) return `${addrBytes[0]}.${addrBytes[1]}.${addrBytes[2]}.${addrBytes[3]}`;
	if (addrType === 4) {
		let ipv6 = ((addrBytes[0] << 8) | addrBytes[1]).toString(16);
		for (let i = 1; i < 8; i++) ipv6 += ':' + ((addrBytes[i * 2] << 8) | addrBytes[i * 2 + 1]).toString(16);
		return `[${ipv6}]`;
	}
};
const parseHostPort = (addr, defaultPort) => {
	if (addr.charCodeAt(0) === 91) {
		const sepIndex = addr.indexOf(']:');
		if (sepIndex !== -1) return [addr.substring(0, sepIndex + 1), addr.substring(sepIndex + 2)];
		return [addr, defaultPort];
	}
	const tpIndex = addr.indexOf('.tp');
	const lastColon = addr.lastIndexOf(':');
	if (tpIndex !== -1 && lastColon === -1) return [addr, addr.substring(tpIndex + 3, addr.indexOf('.', tpIndex + 3))];
	if (lastColon === -1) return [addr, defaultPort];
	return [addr.substring(0, lastColon), addr.substring(lastColon + 1)];
};
const createConnect = (hostname, port, socket = connect({ hostname, port })) => socket.opened.then(() => socket);
const parseAddress = (buffer, offset, addrType) => {
	const addressLength = addrType === 3 ? buffer[offset++] : addrType === 1 ? 4 : addrType === 4 ? 16 : null;
	if (addressLength === null) return null;
	const dataOffset = offset + addressLength;
	if (dataOffset > buffer.length) return null;
	const addrBytes = buffer.subarray(offset, dataOffset);
	return { addrBytes, dataOffset };
};
const parseRequestData = (firstChunk) => {
	if (firstChunk.length < 24 || firstChunk[18 + firstChunk[17]] !== 1) return null;
	for (let i = 0; i < 16; i++) if (firstChunk[i + 1] !== uuidBytes[i]) return null;
	let offset = 19 + firstChunk[17];
	const port = (firstChunk[offset] << 8) | firstChunk[offset + 1];
	let addrType = firstChunk[offset + 2];
	if (addrType !== 1) addrType += 1;
	const addrInfo = parseAddress(firstChunk, offset + 3, addrType);
	if (!addrInfo) return null;
	return { addrType, addrBytes: addrInfo.addrBytes, dataOffset: addrInfo.dataOffset, port };
};
const strategyExecutorMap = new Map([
  [0, async ({ addrType, port, addrBytes }) => createConnect(binaryAddrToString(addrType, addrBytes), port)],
  [3, async (_parsedRequest, param) => { if (!param) return null; const [host, port] = parseHostPort(param, 443); return createConnect(host, port); }],
]);
const establishTcpConnection = async (parsedRequest, request) => {
  const list = [{ type: 0 }];
  if (env.THIRD_PARTY === 'true') list.push({ type: 3, param: coloToProxyMap.get(request.cf?.colo) ?? proxyIpAddrs.US });
  for (const strategy of list) {
    try { const socket = await strategyExecutorMap.get(strategy.type)?.(parsedRequest, strategy.param); if (socket) return socket; } catch {}
  }
  return null;
};
const safeBufferSize = bufferSize - 4096;
const manualPipe = async (readable, writable) => {
	let buffer = new Uint8Array(bufferSize), offset = 0, timerId = null, resume = null;
	const flushBuffer = () => {
		offset > 0 && (writable.send(buffer.slice(0, offset)), offset = 0);
		timerId && (clearTimeout(timerId), timerId = null), resume?.(), resume = null;
	};
	const reader = readable.getReader();
	try {
		while (true) {
			const { done, value: chunk } = await reader.read();
			if (done) break;
			if (chunk.length < 4096) {
				flushBuffer();
				writable.send(chunk);
			} else {
				buffer.set(chunk, offset);
				offset += chunk.length;
				timerId || (timerId = setTimeout(flushBuffer, flushTime));
				if (offset > safeBufferSize) await new Promise(resolve => resume = resolve);
			}
		}
	} finally { flushBuffer(), reader.releaseLock() }
};
const normalizeWebSocketChunk = async (chunk) => {
	if (chunk instanceof Uint8Array) return chunk;
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
	if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	if (typeof chunk === 'string') return textEncoder.encode(chunk);
	if (chunk && typeof chunk.arrayBuffer === 'function') return new Uint8Array(await chunk.arrayBuffer());
	return new Uint8Array(chunk);
};
const handleWebSocketConn = async (webSocket, request) => {
	const protocolHeader = request.headers.get('sec-websocket-protocol');
	// @ts-ignore
	let earlyData = null;
	try { earlyData = protocolHeader ? Uint8Array.from(atob(protocolHeader.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) : null; } catch { webSocket.close(1008, 'Invalid request'); return; }
	const webSocketStream = new ReadableStream({
		start(controller) {
			if (earlyData) controller.enqueue(earlyData);
			webSocket.addEventListener("message", event => controller.enqueue(event.data));
			webSocket.addEventListener("close", () => { try { controller.close(); } catch {} });
			webSocket.addEventListener("error", () => { try { controller.error(new Error('WebSocket failed')); } catch {} });
		},
		cancel() { webSocket.close() }
	});
	let messageHandler, tcpSocket;
	const closeSocket = () => { tcpSocket?.close(); try { webSocket.close(); } catch {} };
	webSocketStream.pipeTo(new WritableStream({
		async write(chunk) {
			chunk = await normalizeWebSocketChunk(chunk);
			if (messageHandler) return messageHandler(chunk);
			if (chunk.byteLength === 0) return;
			let parsedRequest;
			if ((parsedRequest = parseRequestData(chunk))) {
				webSocket.send(new Uint8Array([chunk[0], 0]));
			}
			if (!parsedRequest) throw new Error();
			const payload = chunk.subarray(parsedRequest.dataOffset);
			tcpSocket = await establishTcpConnection(parsedRequest, request);
			if (!tcpSocket) throw new Error();
			const tcpWriter = tcpSocket.writable.getWriter();
			if (payload.byteLength) await tcpWriter.write(payload);
			messageHandler = (chunk) => tcpWriter.write(chunk);
			void manualPipe(tcpSocket.readable, webSocket).catch(closeSocket).finally(closeSocket);
		}
	})).catch(() => closeSocket()).finally(() => closeSocket());
};
return {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname !== '/' && url.pathname !== `/sub/${env.SUB_TOKEN}`) return new Response('Not found', { status: 404 });
		if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
			const { 0: clientSocket, 1: webSocket } = new WebSocketPair();
			webSocket.accept();
			handleWebSocketConn(webSocket, request);
			return new Response(null, { status: 101, webSocket: clientSocket });
		}
		if (url.pathname !== `/sub/${env.SUB_TOKEN}`) return new Response('Not found', { status: 404 });
		const host = url.hostname;
		return new Response(createClashSubscription(host), {
			status: 200,
			headers: {
				'Content-Type': 'text/yaml; charset=UTF-8',
				'Cache-Control': 'no-store'
			}
		});
	}
};

}

export default {
  fetch(request, env) {
    if (!/^[a-f0-9-]{36}$/.test(env.UUID || '') || !/^[a-f0-9]{32}$/.test(env.SUB_TOKEN || '')) return new Response('Not configured', { status: 503 });
    return createWorker(env).fetch(request);
  },
};
