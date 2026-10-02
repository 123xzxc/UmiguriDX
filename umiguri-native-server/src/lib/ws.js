// 极简 WebSocket 服务端(RFC6455) —— 只服务于游戏内 /sock, 不追求通用性。
// 不引依赖: 握手用 node:crypto 的 sha1, 帧解析手写。
//
// 支持: 二进制/文本帧、分片、ping/pong/close。客户端必须带掩码(RFC 要求, 浏览器都带)。
// 不支持: 任何扩展(permessage-deflate 等)与 TLS —— 需要 https/wss 时前面挂反代。

import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// 单帧上限: 游戏侧最大的是选曲时的曲目元数据(几百字节), 给足余量防内存被撑爆。
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

export function isWebSocketUpgrade(req) {
  return String(req.headers.upgrade || "").toLowerCase() === "websocket";
}

export function websocketAccept(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

// 组一个服务端帧(服务端发出的帧不加掩码)。
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// 完成握手并进入帧循环。
// handlers: { onMessage(buf, isBinary), onClose(code, reason) }
// 返回 { send(buf), close(code), socket, alive }
export function acceptWebSocket(req, socket, head, handlers) {
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  if (!key || String(version) !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }

  const accept = websocketAccept(String(key));
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  socket.setNoDelay(true);

  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragment = null;
  let fragmentOpcode = 0;
  let closed = false;
  let gotClose = false;

  const send = (payload) => {
    if (closed) return false;
    try {
      socket.write(encodeFrame(OPCODE_BINARY, Buffer.from(payload)));
      return true;
    } catch {
      return false;
    }
  };

  const close = (code) => {
    if (closed) return;
    closed = true;
    try {
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code || 1000, 0);
      socket.write(encodeFrame(OPCODE_CLOSE, body));
    } catch {
      /* 对端可能已经断了, 忽略 */
    }
    socket.end();
  };

  const fail = (code, reason) => {
    if (closed) return;
    closed = true;
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    handlers.onClose(code, reason);
  };

  const handleFrame = (opcode, payload) => {
    if (opcode === OPCODE_CLOSE) {
      gotClose = true;
      close(1000);
      return;
    }
    if (opcode === OPCODE_PING) {
      if (!closed) socket.write(encodeFrame(OPCODE_PONG, payload));
      return;
    }
    if (opcode === OPCODE_PONG) return;
    if (opcode === OPCODE_CONTINUATION) {
      if (!fragment) return; // 没有开头帧的续帧: 丢弃
      fragment = Buffer.concat([fragment, payload]);
      if (fragment.length > MAX_PAYLOAD_BYTES) return fail(1009, "payload too large");
      if (lastFin) {
        const full = fragment;
        const op = fragmentOpcode;
        fragment = null;
        handlers.onMessage(full, op === OPCODE_BINARY);
      }
      return;
    }
    if (opcode === OPCODE_BINARY || opcode === OPCODE_TEXT) {
      if (lastFin) {
        handlers.onMessage(payload, opcode === OPCODE_BINARY);
      } else {
        fragment = Buffer.from(payload);
        fragmentOpcode = opcode;
      }
      return;
    }
  };

  let lastFin = false;

  const pump = () => {
    while (!closed) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_PAYLOAD_BYTES) return fail(1009, "payload too large");
      let maskKey = null;
      if (masked) {
        if (buf.length < off + 4) return;
        maskKey = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      buf = buf.subarray(off + len);
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      lastFin = fin;
      try {
        handleFrame(opcode, payload);
      } catch (err) {
        return fail(1011, String((err && err.message) || err));
      }
      if (gotClose) return;
    }
  };

  socket.on("data", (chunk) => {
    if (closed) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    pump();
  });
  socket.on("error", () => {
    closed = true;
    handlers.onClose(1006, "socket error");
  });
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    handlers.onClose(1006, "socket closed");
  });

  pump();

  return {
    send,
    close,
    get closed() {
      return closed;
    }
  };
}
