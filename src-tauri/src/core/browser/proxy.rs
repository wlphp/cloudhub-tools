//! Loopback relay keeps upstream credentials out of process arguments and CDP.
//! DNS resolution of destination hosts is delegated to the upstream proxy.
use super::{error, model::ProxyConfig};
use crate::core::error::PlatformResult;
use base64::{Engine, engine::general_purpose::STANDARD};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, task::{JoinHandle, JoinSet}};
use std::time::Duration;

pub struct Relay { pub port: u16, task: JoinHandle<()> }
impl Drop for Relay { fn drop(&mut self) { self.task.abort(); } }
pub async fn start(config: ProxyConfig, password: Option<String>) -> PlatformResult<Relay> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| error("无法创建本机代理通道"))?;
    let port = listener.local_addr().map_err(|_| error("无法创建本机代理通道"))?.port();
    let task = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                result = listener.accept(), if connections.len() < 128 => {
                    let Ok((socket, _)) = result else { break; };
                    let config = config.clone(); let password = password.clone();
                    connections.spawn(async move { let _ = serve(socket, config, password).await; });
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        // Dropping JoinSet aborts every active connection, including on cancellation.
    });
    Ok(Relay { port, task })
}
async fn serve(mut browser: TcpStream, proxy: ProxyConfig, password: Option<String>) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop { let b = browser.read_u8().await?; bytes.push(b); if bytes.ends_with(b"\r\n\r\n") { return Ok::<_,std::io::Error>(()); } if bytes.len() >= 65536 { return Err(std::io::Error::other("header limit")); } }
    }).await??;
    let text = std::str::from_utf8(&bytes).map_err(|_| std::io::Error::other("invalid header"))?;
    let first = text.lines().next().ok_or(std::io::Error::other("missing header"))?;
    let parts: Vec<_> = first.split_whitespace().collect();
    if parts.len() != 3 { return Err(std::io::Error::other("invalid request")); }
    let connect = parts[0] == "CONNECT";
    let target = if connect { reqwest::Url::parse(&format!("https://{}", parts[1])) } else { reqwest::Url::parse(parts[1]) }
        .map_err(|_| std::io::Error::other("invalid destination"))?;
    if !matches!(target.scheme(), "http" | "https" | "ws" | "wss") || target.host_str().is_none() { return Err(std::io::Error::other("invalid destination")); }
    if proxy.kind == "https" {
        // reqwest verifies the upstream proxy certificate and upgrades a CONNECT
        // request into a raw stream. Browser TLS remains end-to-end inside it.
        let mut upstream = http_tunnel(&proxy,password.as_deref(),&target).await?;
        if connect { browser.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?; }
        else { upstream.write_all(origin_request(&parts,&target,text).as_bytes()).await?; }
        tokio::io::copy_bidirectional(&mut browser,&mut upstream).await?;
        return Ok(());
    }
    let proxy_host = proxy.host.trim_start_matches('[').trim_end_matches(']');
    let mut upstream = tokio::time::timeout(Duration::from_secs(20), TcpStream::connect((proxy_host,proxy.port))).await??;
    if proxy.kind == "http" {
        let mut request = format!("{first}\r\n");
        for header in text.lines().skip(1) {
            if header.is_empty() { break; }
            if header.split_once(':').is_some_and(|(h,_)| h.eq_ignore_ascii_case("proxy-authorization")) { continue; }
            request.push_str(header); request.push_str("\r\n");
        }
        if !proxy.username.is_empty() || password.is_some() {
            let auth = STANDARD.encode(format!("{}:{}", proxy.username, password.as_deref().unwrap_or_default()));
            request.push_str(&format!("Proxy-Authorization: Basic {auth}\r\n"));
        }
        request.push_str("\r\n"); upstream.write_all(request.as_bytes()).await?;
    } else if proxy.kind == "socks5" {
        let auth = !proxy.username.is_empty() || password.is_some();
        upstream.write_all(&[5,1,if auth {2} else {0}]).await?;
        let mut response = [0;2]; upstream.read_exact(&mut response).await?;
        if response != [5,if auth {2} else {0}] { return Err(std::io::Error::other("proxy auth rejected")); }
        if auth {
            let user = proxy.username.as_bytes(); let password = password.as_deref().unwrap_or_default().as_bytes();
            if user.len() > 255 || password.len() > 255 { return Err(std::io::Error::other("proxy auth length")); }
            let mut request = vec![1,user.len() as u8]; request.extend_from_slice(user); request.push(password.len() as u8); request.extend_from_slice(password);
            upstream.write_all(&request).await?; upstream.read_exact(&mut response).await?;
            if response != [1,0] { return Err(std::io::Error::other("proxy auth rejected")); }
        }
        let host = target.host_str().unwrap().trim_start_matches('[').trim_end_matches(']');
        let port = target.port_or_known_default().unwrap_or(443);
        let mut request = vec![5,1,0];
        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            match ip { std::net::IpAddr::V4(ip) => { request.push(1); request.extend_from_slice(&ip.octets()); }, std::net::IpAddr::V6(ip) => { request.push(4); request.extend_from_slice(&ip.octets()); } }
        } else { if host.len() > 255 { return Err(std::io::Error::other("host length")); } request.extend_from_slice(&[3,host.len() as u8]); request.extend_from_slice(host.as_bytes()); }
        request.extend_from_slice(&port.to_be_bytes()); upstream.write_all(&request).await?;
        let mut reply = [0;4]; upstream.read_exact(&mut reply).await?;
        if reply[0] != 5 || reply[1] != 0 { return Err(std::io::Error::other("proxy connect rejected")); }
        let n = match reply[3] { 1 => 4, 4 => 16, 3 => upstream.read_u8().await? as usize, _ => return Err(std::io::Error::other("proxy address invalid")) };
        let mut rest = vec![0;n+2]; upstream.read_exact(&mut rest).await?;
        if connect { browser.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?; }
        else {
            upstream.write_all(origin_request(&parts,&target,text).as_bytes()).await?;
        }
    } else { return Err(std::io::Error::other("proxy kind unsupported")); }
    tokio::io::copy_bidirectional(&mut browser, &mut upstream).await?;
    Ok(())
}

fn origin_request(parts: &[&str], target: &reqwest::Url, text: &str) -> String {
    let mut request = format!("{} {}{} HTTP/1.1\r\n",parts[0],target.path(),target.query().map(|q|format!("?{q}")).unwrap_or_default());
    for header in text.lines().skip(1) {
        if header.is_empty() { break; }
        if header.split_once(':').is_some_and(|(h,_)|["proxy-authorization","proxy-connection","connection"].iter().any(|v|h.eq_ignore_ascii_case(v))) { continue; }
        request.push_str(header);request.push_str("\r\n");
    }
    let websocket = text.lines().any(|line| line.split_once(':').is_some_and(|(h,v)|h.eq_ignore_ascii_case("upgrade") && v.trim().eq_ignore_ascii_case("websocket")));
    request.push_str(if websocket { "Connection: Upgrade\r\n\r\n" } else { "Connection: close\r\n\r\n" });request
}
async fn http_tunnel(proxy: &ProxyConfig, password: Option<&str>, target: &reqwest::Url) -> std::io::Result<reqwest::Upgraded> {
    let host = if proxy.host.contains(':') && !proxy.host.starts_with('[') { format!("[{}]",proxy.host) } else {proxy.host.clone()};
    let mut upstream = reqwest::Proxy::all(format!("{}://{}:{}",proxy.kind,host,proxy.port)).map_err(|_| std::io::Error::other("proxy configuration invalid"))?;
    if !proxy.username.is_empty() || password.is_some() { upstream = upstream.basic_auth(&proxy.username,password.unwrap_or_default()); }
    let client = reqwest::Client::builder().no_proxy().proxy(upstream).http1_only().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(30)).build().map_err(|_| std::io::Error::other("proxy client failed"))?;
    connect_with_client(client,target).await
}
async fn connect_with_client(client: reqwest::Client, target: &reqwest::Url) -> std::io::Result<reqwest::Upgraded> {
    let authority = format!("http://{}:{}/",target.host_str().ok_or(std::io::Error::other("destination invalid"))?,target.port_or_known_default().unwrap_or(443));
    let response=client.request(reqwest::Method::CONNECT,authority).send().await.map_err(|_| std::io::Error::other("TLS proxy connect failed"))?;
    if response.status() != reqwest::StatusCode::OK { return Err(std::io::Error::other("proxy connect rejected")); }
    response.upgrade().await.map_err(|_| std::io::Error::other("proxy upgrade failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn http_proxy_forwards_remote_authority_and_closes_on_stop() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (mut stream,_) = listener.accept().await.unwrap();
            let mut request = Vec::new(); while !request.ends_with(b"\r\n\r\n") { request.push(stream.read_u8().await.unwrap()); }
            assert!(String::from_utf8(request).unwrap().starts_with("CONNECT remote.example.test:443 HTTP/1.1\r\n"));
            stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.unwrap();
            let mut data = [0;4]; stream.read_exact(&mut data).await.unwrap(); assert_eq!(&data,b"ping");
            stream.write_all(b"pong").await.unwrap();
            let mut byte = [0]; assert_eq!(stream.read(&mut byte).await.unwrap(),0);
        });
        let relay = start(ProxyConfig { kind:"http".into(), host:"127.0.0.1".into(),port:upstream_port,username:String::new() },None).await.unwrap();
        let mut client = TcpStream::connect(("127.0.0.1",relay.port)).await.unwrap();
        client.write_all(b"CONNECT remote.example.test:443 HTTP/1.1\r\nHost: remote.example.test:443\r\n\r\n").await.unwrap();
        let mut response = Vec::new(); while !response.ends_with(b"\r\n\r\n") { response.push(client.read_u8().await.unwrap()); }
        client.write_all(b"ping").await.unwrap(); let mut reply = [0;4]; client.read_exact(&mut reply).await.unwrap(); assert_eq!(&reply,b"pong");
        drop(relay);
        let mut byte=[0]; assert_eq!(tokio::time::timeout(Duration::from_secs(2),client.read(&mut byte)).await.unwrap().unwrap(),0);
        tokio::time::timeout(Duration::from_secs(2),upstream).await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn socks5_delegates_dns_to_upstream() {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap(); let port=listener.local_addr().unwrap().port();
        let task=tokio::spawn(async move {
            let (mut stream,_)=listener.accept().await.unwrap(); let mut hello=[0;3]; stream.read_exact(&mut hello).await.unwrap(); assert_eq!(hello,[5,1,0]); stream.write_all(&[5,0]).await.unwrap();
            let mut request=[0;4];stream.read_exact(&mut request).await.unwrap();assert_eq!(request,[5,1,0,3]);let length=stream.read_u8().await.unwrap() as usize; let mut host=vec![0;length];stream.read_exact(&mut host).await.unwrap();assert_eq!(host,b"remote.example.test");let mut port=[0;2];stream.read_exact(&mut port).await.unwrap();assert_eq!(u16::from_be_bytes(port),443);
            stream.write_all(&[5,0,0,1,127,0,0,1,0,0]).await.unwrap();stream.write_all(b"remote").await.unwrap();
        });
        let relay=start(ProxyConfig {kind:"socks5".into(),host:"127.0.0.1".into(),port,username:String::new()},None).await.unwrap();
        let mut client=TcpStream::connect(("127.0.0.1",relay.port)).await.unwrap();client.write_all(b"CONNECT remote.example.test:443 HTTP/1.1\r\nHost: remote.example.test:443\r\n\r\n").await.unwrap();let mut response=Vec::new();while !response.ends_with(b"\r\n\r\n") {response.push(client.read_u8().await.unwrap());}let mut data=[0;6];client.read_exact(&mut data).await.unwrap();assert_eq!(&data,b"remote");task.await.unwrap();
    }
    #[tokio::test]
    async fn reqwest_connect_upgrade_preserves_raw_tunnel() {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap(); let port=listener.local_addr().unwrap().port();
        let task=tokio::spawn(async move {
            let (mut stream,_)=listener.accept().await.unwrap();let mut request=Vec::new();while !request.ends_with(b"\r\n\r\n") {request.push(stream.read_u8().await.unwrap());}
            assert!(String::from_utf8(request).unwrap().starts_with("CONNECT remote.example.test:443 HTTP/1.1\r\n"));
            stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.unwrap(); let mut data=[0;4];stream.read_exact(&mut data).await.unwrap();assert_eq!(&data,b"ping");stream.write_all(b"pong").await.unwrap();
        });
        let proxy=ProxyConfig {kind:"http".into(),host:"127.0.0.1".into(),port,username:String::new()};
        let mut tunnel=http_tunnel(&proxy,None,&reqwest::Url::parse("https://remote.example.test").unwrap()).await.unwrap();
        tunnel.write_all(b"ping").await.unwrap();let mut data=[0;4];tunnel.read_exact(&mut data).await.unwrap();assert_eq!(&data,b"pong");task.await.unwrap();
    }
    #[tokio::test]
    async fn https_proxy_rejects_untrusted_certificate() {
        let cert=rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let key=rustls::pki_types::PrivatePkcs8KeyDer::from(cert.key_pair.serialize_der());
        let config=rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(vec![cert.cert.der().clone()],key.into()).unwrap();
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let port=listener.local_addr().unwrap().port();
        let task=std::thread::spawn(move || {
            use std::io::Read;
            let (socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let connection=rustls::ServerConnection::new(std::sync::Arc::new(config)).unwrap();
            let mut tls=rustls::StreamOwned::new(connection,socket);let mut byte=[0];let _=tls.read(&mut byte);
        });
        let proxy=ProxyConfig {kind:"https".into(),host:"127.0.0.1".into(),port,username:String::new()};
        assert!(http_tunnel(&proxy,None,&reqwest::Url::parse("https://remote.example.test").unwrap()).await.is_err());
        task.join().unwrap();
    }
    #[tokio::test]
    async fn https_proxy_carries_connect_tunnel_inside_verified_tls() {
        let cert=rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let trusted=reqwest::Certificate::from_der(cert.cert.der()).unwrap();
        let key=rustls::pki_types::PrivatePkcs8KeyDer::from(cert.key_pair.serialize_der());
        let config=rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(vec![cert.cert.der().clone()],key.into()).unwrap();
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let port=listener.local_addr().unwrap().port();
        let task=std::thread::spawn(move || {
            use std::io::{Read,Write};
            let (socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let connection=rustls::ServerConnection::new(std::sync::Arc::new(config)).unwrap();
            let mut tls=rustls::StreamOwned::new(connection,socket);let mut header=Vec::new();let mut byte=[0];
            while !header.ends_with(b"\r\n\r\n") {tls.read_exact(&mut byte).unwrap();header.push(byte[0]);assert!(header.len()<8192);}
            assert!(String::from_utf8(header).unwrap().starts_with("CONNECT remote.example.test:443 HTTP/1.1\r\n"));
            tls.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").unwrap();tls.flush().unwrap();let mut data=[0;4];tls.read_exact(&mut data).unwrap();assert_eq!(&data,b"ping");tls.write_all(b"pong").unwrap();tls.flush().unwrap();
        });
        let client=reqwest::Client::builder().no_proxy().proxy(reqwest::Proxy::all(format!("https://localhost:{port}")).unwrap()).http1_only().add_root_certificate(trusted)
            .timeout(Duration::from_secs(5)).build().unwrap();
        let mut tunnel=connect_with_client(client,&reqwest::Url::parse("https://remote.example.test").unwrap()).await.unwrap();
        tunnel.write_all(b"ping").await.unwrap();let mut data=[0;4];tunnel.read_exact(&mut data).await.unwrap();assert_eq!(&data,b"pong");task.join().unwrap();
    }
}
