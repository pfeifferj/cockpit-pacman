use arch_http_client::{Client, Error, Options, Session};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

fn listener() -> TcpListener {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    listener
}

fn accept(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                return stream;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "missing connection");
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => panic!("accept: {e}"),
        }
    }
}

fn request(stream: &mut impl Read) -> String {
    let mut reader = BufReader::new(stream);
    let mut request = String::new();
    let mut length = 0;
    loop {
        let mut line = String::new();
        assert_ne!(reader.read_line(&mut line).unwrap(), 0);
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap();
        }
        request.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    request.push_str(&String::from_utf8(body).unwrap());
    request
}

fn server(response: String) -> (String, JoinHandle<String>) {
    let listener = listener();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let thread = thread::spawn(move || {
        let mut stream = accept(&listener);
        let request = request(&mut stream);
        let _ = stream.write_all(response.as_bytes());
        request
    });
    (url, thread)
}

fn response(headers: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn child(url: &str, expected: &str, env: &[(&str, &str)]) {
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "request_child", "--nocapture"])
        .env_clear()
        .env("PROBE_URL", url)
        .env("PROBE_EXPECT", expected)
        .envs(env.iter().copied())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn request_child() {
    let Ok(url) = std::env::var("PROBE_URL") else {
        return;
    };
    let expected = std::env::var("PROBE_EXPECT").unwrap();
    if matches!(expected.as_str(), "upload-timeout" | "body-timeout") {
        let session = Session::new(Options {
            timeout: Duration::from_secs(4),
            upload_timeout: Some(Duration::from_millis(100)),
            body_timeout: Some(Duration::from_millis(100)),
            ..Options::default()
        })
        .unwrap();
        let start = Instant::now();
        let result = if expected == "upload-timeout" {
            session.post_form(&url, &[("data", &"x".repeat(16 * 1024 * 1024))])
        } else {
            session.get(&url)
        };
        assert_eq!(result.err(), Some(Error::Timeout));
        assert!(start.elapsed() < Duration::from_secs(3));
        return;
    }
    let options = Options {
        timeout: Duration::from_millis(800),
        connect_timeout: Duration::from_millis(500),
        max_body: 64,
        max_headers: 512,
        ..Options::default()
    };
    if expected == "session" {
        let session = Session::new(options).unwrap();
        session.get(&format!("{url}/login/")).unwrap();
        assert_eq!(
            session
                .cookie(&format!("{url}/login/"), "csrf")
                .unwrap()
                .as_deref(),
            Some("first")
        );
        assert!(
            session
                .cookie("http://unrelated.invalid/", "csrf")
                .unwrap()
                .is_none()
        );
        session
            .post_form(&format!("{url}/login/"), &[("password", "päss☃&")])
            .unwrap();
        assert_eq!(
            session
                .cookie(&format!("{url}/login/"), "csrf")
                .unwrap()
                .as_deref(),
            Some("second")
        );
        session.get(&format!("{url}/data")).unwrap();
        let other = Session::new(Options::default()).unwrap();
        assert!(other.cookie(&url, "csrf").unwrap().is_none());
        return;
    }
    let start = Instant::now();
    let client = Client::new(options);
    let result = if expected == "head" {
        client.head(&url)
    } else {
        client.get(&url)
    };
    match expected.as_str() {
        "ok" => assert_eq!(result.unwrap().text().unwrap(), "ok"),
        "head" => assert!(result.unwrap().body.is_empty()),
        "final" => {
            let result = result.unwrap();
            assert_eq!(result.header("X-Final"), Some("yes"));
            assert!(result.header("X-Interim").is_none());
        }
        expected => {
            let error = result.err().expect("request should fail");
            match expected {
                "timeout" => assert_eq!(error, Error::Timeout),
                "407" => assert_eq!(error, Error::Status(407)),
                "503" => assert_eq!(error, Error::Status(503)),
                "body" => assert_eq!(error, Error::BodyLimit),
                "headers" => assert_eq!(error, Error::HeaderLimit),
                "tls" => assert_eq!(error, Error::Tls),
                "protocol" => assert!(matches!(error, Error::Transport(_) | Error::Url)),
                "connect" => assert_eq!(error, Error::Connect),
                _ => panic!("unknown expectation"),
            }
            assert!(!format!("{error:?} {error}").contains("secret"));
        }
    }
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn http_forwarding_authentication_and_no_proxy() {
    let (proxy, thread) = server(response("", "ok"));
    let authenticated = proxy.replacen("http://", "http://user:secret@", 1);
    child(
        "http://origin.invalid/path",
        "ok",
        &[("all_proxy", &authenticated)],
    );
    let request = thread.join().unwrap();
    assert!(request.starts_with("GET http://origin.invalid/path HTTP/1.1"));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("proxy-authorization: basic dxnlcjpzzwnyzxq=")
    );
    let (origin, thread) = server(response("", "ok"));
    child(
        &origin,
        "ok",
        &[
            ("all_proxy", "http://127.0.0.1:1"),
            ("no_proxy", "127.0.0.0/8"),
        ],
    );
    assert!(thread.join().unwrap().starts_with("GET / HTTP/1.1"));
}

#[test]
fn scheme_proxy_overrides_all_proxy_and_dead_proxy_never_falls_back() {
    let (proxy, thread) = server(response("", "ok"));
    child(
        "http://origin.invalid/",
        "ok",
        &[("all_proxy", "http://127.0.0.1:1"), ("http_proxy", &proxy)],
    );
    thread.join().unwrap();
    let origin = listener();
    child(
        &format!("http://{}", origin.local_addr().unwrap()),
        "connect",
        &[("all_proxy", "http://user:secret@127.0.0.1:1")],
    );
    assert!(origin.accept().is_err());
}

#[test]
fn proxy_authentication_failure() {
    for url in ["http://origin.invalid/", "https://origin.invalid/"] {
        let (proxy, thread) = server("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into());
        child(url, "407", &[("all_proxy", &proxy)]);
        let request = thread.join().unwrap();
        assert_eq!(
            request.starts_with("CONNECT origin.invalid:443"),
            url.starts_with("https:")
        );
    }
}

#[test]
fn socks_dns_modes_and_authentication() {
    for (scheme, target, expected_type) in
        [("socks5", "localhost", 0), ("socks5h", "origin.invalid", 3)]
    {
        let listener = listener();
        let proxy = format!("{scheme}://user:secret@{}", listener.local_addr().unwrap());
        let thread = thread::spawn(move || {
            let mut stream = accept(&listener);
            let mut prefix = [0; 2];
            stream.read_exact(&mut prefix).unwrap();
            assert_eq!(prefix[0], 5);
            let mut methods = vec![0; prefix[1] as usize];
            stream.read_exact(&mut methods).unwrap();
            assert!(methods.contains(&2));
            stream.write_all(&[5, 2]).unwrap();
            stream.read_exact(&mut prefix).unwrap();
            assert_eq!(prefix, [1, 4]);
            let mut user = [0; 4];
            stream.read_exact(&mut user).unwrap();
            assert_eq!(&user, b"user");
            let mut length = [0];
            stream.read_exact(&mut length).unwrap();
            let mut password = vec![0; length[0] as usize];
            stream.read_exact(&mut password).unwrap();
            assert_eq!(&password, b"secret");
            stream.write_all(&[1, 0]).unwrap();
            let mut connect = [0; 4];
            stream.read_exact(&mut connect).unwrap();
            assert_eq!(&connect[..3], &[5, 1, 0]);
            if expected_type == 3 {
                assert_eq!(connect[3], 3);
                stream.read_exact(&mut length).unwrap();
                let mut host = vec![0; length[0] as usize];
                stream.read_exact(&mut host).unwrap();
                assert_eq!(&host, b"origin.invalid");
            } else if connect[3] == 1 {
                let mut address = [0; 4];
                stream.read_exact(&mut address).unwrap();
                assert_eq!(address, [127, 0, 0, 1]);
            } else {
                assert_eq!(connect[3], 4);
                let mut address = [0; 16];
                stream.read_exact(&mut address).unwrap();
                assert_eq!(
                    std::net::Ipv6Addr::from(address),
                    std::net::Ipv6Addr::LOCALHOST
                );
            }
            let mut port = [0; 2];
            stream.read_exact(&mut port).unwrap();
            assert_eq!(port, [0, 80]);
            stream
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                .unwrap();
            let request = request(&mut stream);
            assert!(!request.to_lowercase().contains("proxy-authorization"));
            stream.write_all(response("", "ok").as_bytes()).unwrap();
        });
        child(&format!("http://{target}/"), "ok", &[("all_proxy", &proxy)]);
        thread.join().unwrap();
    }
}

#[test]
fn stalled_proxy_handshakes_are_bounded() {
    for scheme in ["http", "socks5", "socks5h"] {
        let listener = listener();
        let proxy = format!("{scheme}://{}", listener.local_addr().unwrap());
        let thread = thread::spawn(move || {
            let _stream = accept(&listener);
            thread::sleep(Duration::from_secs(1));
        });
        child("https://127.0.0.2/", "timeout", &[("all_proxy", &proxy)]);
        thread.join().unwrap();
    }
}

#[test]
fn response_limits_and_interim_headers() {
    for (wire, expected) in [
        (response("", &"x".repeat(65)), "body"),
        (
            response(&format!("X-Large: {}\r\n", "x".repeat(512)), ""),
            "headers",
        ),
        (
            format!(
                "HTTP/1.1 100 Continue\r\nX-Interim: yes\r\n\r\n{}",
                response("X-Final: yes\r\n", "ok")
            ),
            "final",
        ),
        (
            "HTTP/1.1 302 Found\r\nLocation: file:///etc/passwd\r\nContent-Length: 0\r\n\r\n"
                .into(),
            "protocol",
        ),
    ] {
        let (origin, thread) = server(wire);
        child(&origin, expected, &[]);
        thread.join().unwrap();
    }
}

#[test]
fn redirects_reselect_the_proxy() {
    let (second, thread2) = server(response("", "ok"));
    let (first, thread1) = server("HTTP/1.1 302 Found\r\nLocation: http://other.invalid/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into());
    child(
        &first,
        "ok",
        &[("http_proxy", &second), ("no_proxy", "127.0.0.1")],
    );
    assert!(thread1.join().unwrap().starts_with("GET / HTTP/1.1"));
    assert!(
        thread2
            .join()
            .unwrap()
            .starts_with("GET http://other.invalid/final HTTP/1.1")
    );
}

#[test]
fn session_cookies_forms_and_methods_are_isolated() {
    let listener = listener();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let thread = thread::spawn(move || {
        let mut requests = Vec::new();
        for wire in [
            response("Set-Cookie: csrf=first; Path=/\r\n", ""),
            "HTTP/1.1 302 Found\r\nSet-Cookie: csrf=second; Path=/\r\nLocation: /unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            response("", ""),
        ] {
            let mut stream = accept(&listener);
            requests.push(request(&mut stream));
            stream.write_all(wire.as_bytes()).unwrap();
        }
        requests
    });
    child(&origin, "session", &[]);
    let requests = thread.join().unwrap();
    assert!(requests[1].starts_with("POST /login/ HTTP/1.1"));
    assert!(requests[1].contains("password=p%C3%A4ss%E2%98%83%26"));
    assert!(requests[2].starts_with("GET /data HTTP/1.1"));
    assert!(requests[2].contains("csrf=second"));
    assert!(!requests[2].contains("password="));
}

#[test]
fn untrusted_origin_and_https_proxy_certificates_are_rejected() {
    for proxy in [false, true] {
        let listener = listener();
        let address = listener.local_addr().unwrap();
        let thread = thread::spawn(move || {
            let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
            let config = rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(
                    vec![cert.cert.der().clone()],
                    rustls::pki_types::PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der())
                        .into(),
                )
                .unwrap();
            let mut stream = rustls::StreamOwned::new(
                rustls::ServerConnection::new(std::sync::Arc::new(config)).unwrap(),
                accept(&listener),
            );
            assert!(stream.read(&mut [0; 1]).is_err());
        });
        let endpoint = format!("https://{address}");
        if proxy {
            child("http://origin.invalid/", "tls", &[("all_proxy", &endpoint)]);
        } else {
            child(&endpoint, "tls", &[]);
        }
        thread.join().unwrap();
    }
}

#[test]
fn head_and_error_status_do_not_wait_for_bodies() {
    for (expected, wire) in [
        ("head", "HTTP/1.1 200 OK\r\nContent-Length: 9999\r\n\r\n"),
        (
            "503",
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 9999\r\n\r\n",
        ),
    ] {
        let listener = listener();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = thread::spawn(move || {
            let mut stream = accept(&listener);
            let request = request(&mut stream);
            stream.write_all(wire.as_bytes()).unwrap();
            thread::sleep(Duration::from_secs(1));
            request
        });
        child(&url, expected, &[]);
        assert_eq!(
            thread.join().unwrap().starts_with("HEAD "),
            expected == "head"
        );
    }
}

#[test]
fn decoded_body_and_aggregate_headers_are_bounded() {
    let listener = listener();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let thread = thread::spawn(move || {
        let mut stream = accept(&listener);
        request(&mut stream);
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&[b'x'; 1000]).unwrap();
        let compressed = gzip.finish().unwrap();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\n\r\n",
            compressed.len()
        )
        .unwrap();
        stream.write_all(&compressed).unwrap();
    });
    child(&url, "body", &[]);
    thread.join().unwrap();
    let wire = format!(
        "{}{}",
        "HTTP/1.1 100 Continue\r\nX-Interim: value\r\n\r\n".repeat(20),
        response("", "ok")
    );
    let (url, thread) = server(wire);
    child(&url, "headers", &[]);
    thread.join().unwrap();
}

#[test]
fn stalled_tls_and_response_bodies_are_bounded() {
    for tls in [false, true] {
        let listener = listener();
        let url = format!(
            "{}://{}",
            if tls { "https" } else { "http" },
            listener.local_addr().unwrap()
        );
        let thread = thread::spawn(move || {
            let mut stream = accept(&listener);
            if !tls {
                request(&mut stream);
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n")
                    .unwrap();
            }
            thread::sleep(Duration::from_secs(1));
        });
        child(&url, "timeout", &[]);
        thread.join().unwrap();
    }
}

#[test]
#[ignore = "requires the temporary CA installed by test/e2e/transport-tests.sh"]
fn trusted_https_and_connect_use_system_ca() {
    use rustls::pki_types::pem::PemObject;
    for mode in ["origin", "connect", "proxy", "wrong-origin", "wrong-proxy"] {
        let cert = rustls::pki_types::CertificateDer::from_pem_file(
            std::env::var("PROXY_TEST_CERT").unwrap(),
        )
        .unwrap();
        let key = rustls::pki_types::PrivateKeyDer::from_pem_file(
            std::env::var("PROXY_TEST_KEY").unwrap(),
        )
        .unwrap();
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key)
            .unwrap();
        let listener = listener();
        let port = listener.local_addr().unwrap().port();
        let thread = thread::spawn(move || {
            let mut stream = accept(&listener);
            if mode == "connect" {
                assert!(request(&mut stream).starts_with("CONNECT localhost:443 HTTP/1.1"));
                stream
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .unwrap();
            }
            let mut tls = rustls::StreamOwned::new(
                rustls::ServerConnection::new(std::sync::Arc::new(config)).unwrap(),
                stream,
            );
            if mode.starts_with("wrong") {
                assert!(tls.read(&mut [0; 1]).is_err());
            } else {
                let request = request(&mut tls);
                if mode == "proxy" {
                    assert!(request.starts_with("GET http://origin.invalid/ HTTP/1.1"));
                } else {
                    assert!(request.starts_with("GET / HTTP/1.1"));
                }
                tls.write_all(response("", "ok").as_bytes()).unwrap();
            }
        });
        match mode {
            "origin" => child(&format!("https://localhost:{port}/"), "ok", &[]),
            "wrong-origin" => child(&format!("https://127.0.0.1:{port}/"), "tls", &[]),
            "connect" => child(
                "https://localhost/",
                "ok",
                &[("https_proxy", &format!("http://127.0.0.1:{port}"))],
            ),
            "proxy" => child(
                "http://origin.invalid/",
                "ok",
                &[("all_proxy", &format!("https://localhost:{port}"))],
            ),
            "wrong-proxy" => child(
                "http://origin.invalid/",
                "tls",
                &[("all_proxy", &format!("https://127.0.0.1:{port}"))],
            ),
            _ => unreachable!(),
        }
        thread.join().unwrap();
    }
}

#[test]
fn phase_deadlines_expire_before_the_total_deadline() {
    for expected in ["upload-timeout", "body-timeout"] {
        let listener = listener();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = thread::spawn(move || {
            let mut stream = accept(&listener);
            if expected == "body-timeout" {
                request(&mut stream);
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n")
                    .unwrap();
            }
            thread::sleep(Duration::from_secs(3));
        });
        child(&url, expected, &[]);
        thread.join().unwrap();
    }
}
