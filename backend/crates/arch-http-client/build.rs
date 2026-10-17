fn main() {
    for name in ["LIBCURL_STATIC", "PKG_CONFIG_ALL_STATIC"] {
        println!("cargo:rerun-if-env-changed={name}");
        assert!(
            std::env::var_os(name).is_none(),
            "system libcurl must be linked dynamically; unset {name}"
        );
    }
    pkg_config::Config::new()
        .statik(false)
        .probe("libcurl")
        .expect("arch-http-client requires system libcurl and pkg-config");
    assert!(
        std::env::var_os("DEP_CURL_STATIC").is_none(),
        "arch-http-client requires shared system libcurl"
    );
}
