//! 游戏联机 /sock(WebSocket)的本地 TCP 中继。
//!
//! 为什么需要: 游戏自带的联机客户端在 WebView 里直连 `ws://<服务端>:8101/sock`。
//! macOS 的 WKWebView 会拦掉从 tauri:// 页面发起的**明文 ws://**(和 /1/* 的 http 同一条
//! 命, 见 host/bridge/umgr-elc.js 里 requestUrl 的注释), 而 loopback(127.0.0.1)属于
//! "potentially trustworthy", 不会被拦 —— 游戏自带的 LED 客户端连 ws://localhost:8090
//! 一直是通的(实机验证过)。所以宿主在 127.0.0.1 上开一个字节透传端口, 游戏连它, 由
//! Rust 转发给真正的服务端。
//!
//! 刻意只做**纯 TCP 透传**(不解析 WebSocket): 握手、帧、心跳端到端原样走, 服务端看到的
//! 就是游戏自己那条连接 —— 协议怎么变、服务端换到哪都不用动这里。
//!
//! 同一个 host:port 只开一条中继(端口复用), 游戏侧每次连拿到的都是同一个本地端口。
use std::collections::HashMap;
use std::io;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;

/// /sock 中继池(挂在 Tauri state 上, 进程生命周期内不回收)。
#[derive(Default)]
pub struct RelayPool {
    ports: Mutex<HashMap<String, u16>>,
}

impl RelayPool {
    /// 起一条到 `host:port` 的中继, 返回本地透传端口; 同一目标复用已有的。
    pub fn start(&self, host: &str, port: u16) -> io::Result<u16> {
        let key = format!("{host}:{port}");
        if let Some(local) = self.ports.lock().unwrap().get(&key) {
            return Ok(*local);
        }
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let local = listener.local_addr()?.port();
        let target = key.clone();
        thread::Builder::new()
            .name("umg-sock-relay".into())
            .spawn(move || {
                eprintln!("[umg][relay] /sock 中继 127.0.0.1:{local} -> {target}");
                for stream in listener.incoming() {
                    match stream {
                        Ok(client) => {
                            let target = target.clone();
                            thread::Builder::new()
                                .name("umg-sock-relay-conn".into())
                                .spawn(move || {
                                    if let Err(e) = forward(client, &target) {
                                        eprintln!("[umg][relay] 连接结束: {e}");
                                    }
                                })
                                .ok();
                        }
                        Err(e) => eprintln!("[umg][relay] accept 失败: {e}"),
                    }
                }
            })?;
        self.ports.lock().unwrap().insert(key, local);
        Ok(local)
    }
}

/// 一条连接: 连上真正的服务端, 然后两个方向各一个线程对拷字节。
/// 收尾用 shutdown(Write) 而不是直接关掉整个 socket —— 一个方向断了不能把另一个方向
/// 还在传的数据切断(TCP 半关闭)。
fn forward(client: TcpStream, target: &str) -> io::Result<()> {
    let server = TcpStream::connect(target)?;
    client.set_nodelay(true).ok();
    server.set_nodelay(true).ok();
    let mut client_read = client.try_clone()?;
    let mut client_write = client;
    let mut server_read = server.try_clone()?;
    let mut server_write = server;
    thread::Builder::new()
        .name("umg-sock-relay-up".into())
        .spawn(move || {
            let _ = io::copy(&mut client_read, &mut server_write);
            let _ = server_write.shutdown(Shutdown::Write);
        })?;
    let _ = io::copy(&mut server_read, &mut client_write);
    let _ = client_write.shutdown(Shutdown::Write);
    Ok(())
}
