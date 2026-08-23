use cockpit_pacman_backend::util::classify_error;
use std::net::TcpListener;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn dead_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("can bind a loopback port");
    let port = listener.local_addr().expect("bound address").port();
    drop(listener);
    format!("http://127.0.0.1:{port}")
}

fn ipv4() -> ureq::config::IpFamily {
    ureq::config::IpFamily::Ipv4Only
}

#[tokio::test]
async fn a_404_from_the_security_tracker_is_an_error_not_an_empty_answer() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/issues/vulnerable.json"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let client = arch_security_client::SecurityClient::with_base_url(&server.uri(), ipv4());
    let err = client.fetch_vulnerable().expect_err("404 is a failure");

    assert_eq!(
        classify_error(&err),
        Some("not_found"),
        "a missing feed must not read as an empty one: {err:#}"
    );
}

#[tokio::test]
async fn a_refused_connection_reads_as_a_network_error() {
    let client = arch_security_client::SecurityClient::with_base_url(&dead_url(), ipv4());
    let err = client.fetch_vulnerable().expect_err("nothing is listening");

    assert_eq!(classify_error(&err), Some("network_error"), "{err:#}");
}

fn valid_feed_of_bytes(at_least: usize) -> String {
    let element = |i: usize| {
        format!(
            r#"{{"name":"AVG-{i}","packages":["bash"],"status":"Vulnerable","severity":"High",
            "type":"arbitrary code execution","affected":"5.0-1","fixed":null,
            "issues":["CVE-2024-{i}"],"advisories":[]}}"#
        )
    };
    let mut elements = Vec::new();
    let mut len = 2;
    let mut i = 0;
    while len < at_least {
        let e = element(i);
        len += e.len() + 1;
        elements.push(e);
        i += 1;
    }
    format!("[{}]", elements.join(","))
}

#[tokio::test]
async fn a_body_past_the_cap_fails_instead_of_parsing_a_truncated_feed() {
    let cap = 2 * 1024 * 1024;
    let huge = valid_feed_of_bytes(cap + 1024);
    let under = valid_feed_of_bytes(1024);

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/issues/vulnerable.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(huge))
        .mount(&server)
        .await;

    let client = arch_security_client::SecurityClient::with_base_url(&server.uri(), ipv4());
    client
        .fetch_vulnerable()
        .expect_err("a capped read truncates the body mid-element");

    // The same shape under the cap parses, so only the truncation can fail it.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/issues/vulnerable.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(under))
        .mount(&server)
        .await;
    let client = arch_security_client::SecurityClient::with_base_url(&server.uri(), ipv4());
    assert!(!client.fetch_vulnerable().expect("parses").is_empty());
}

#[tokio::test]
async fn a_well_formed_feed_parses() {
    let server = MockServer::start().await;
    let body = r#"[{"name":"AVG-1","packages":["bash"],"status":"Vulnerable","severity":"High",
        "type":"arbitrary code execution","affected":"5.0-1","fixed":"5.1-1",
        "issues":["CVE-2024-1"],"advisories":[]}]"#;
    Mock::given(method("GET"))
        .and(path("/issues/vulnerable.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let client = arch_security_client::SecurityClient::with_base_url(&server.uri(), ipv4());
    let avgs = client.fetch_vulnerable().expect("parses");

    assert_eq!(avgs.len(), 1);
    assert_eq!(avgs[0].name, "AVG-1");
    assert_eq!(avgs[0].fixed.as_deref(), Some("5.1-1"));
}

#[tokio::test]
async fn a_mirror_report_past_the_cap_fails_instead_of_parsing_truncated() {
    let mirror = r#"{"url":"https://a.example/","protocol":"https","last_sync":"2026-01-01T00:00:00Z",
        "completion_pct":1.0,"delay":60,"score":1.5,"active":true,"country":"Germany","country_code":"DE",
        "duration_avg":0.1,"duration_stddev":0.01,"ipv4":true,"ipv6":false,"isos":true,"details":""}"#;
    let per = mirror.len() + 1;
    let count = (8 * 1024 * 1024) / per + 2;
    let body = format!("{{\"urls\":[{}]}}", vec![mirror; count].join(","));

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/mirrors/status/json/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let agent =
        ureq::Agent::new_with_config(ureq::Agent::config_builder().ip_family(ipv4()).build());
    let url = format!("{}/mirrors/status/json/", server.uri());
    assert!(arch_mirror_client::fetch_from(&agent, &url).is_err());
}

#[tokio::test]
async fn the_mirror_status_report_parses() {
    let server = MockServer::start().await;
    let body = r#"{"urls":[{"url":"https://a.example/","protocol":"https","last_sync":"2026-01-01T00:00:00Z",
        "completion_pct":1.0,"delay":60,"score":1.5,"active":true,"country":"Germany","country_code":"DE",
        "duration_avg":0.1,"duration_stddev":0.01,"ipv4":true,"ipv6":false,"isos":true,"details":""}]}"#;
    Mock::given(method("GET"))
        .and(path("/mirrors/status/json/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let agent =
        ureq::Agent::new_with_config(ureq::Agent::config_builder().ip_family(ipv4()).build());
    let url = format!("{}/mirrors/status/json/", server.uri());
    let status = arch_mirror_client::fetch_from(&agent, &url).expect("parses");

    assert_eq!(status.mirrors.len(), 1);
    assert_eq!(status.mirrors[0].score, Some(1.5));
}

#[tokio::test]
async fn a_mirror_status_failure_is_reported_not_swallowed() {
    let agent =
        ureq::Agent::new_with_config(ureq::Agent::config_builder().ip_family(ipv4()).build());
    let url = format!("{}/mirrors/status/json/", dead_url());

    assert!(arch_mirror_client::fetch_from(&agent, &url).is_err());
}
