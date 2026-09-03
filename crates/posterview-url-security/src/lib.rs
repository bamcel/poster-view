use url::Url;

/// Validate a user-configured media-server base URL. Private and loopback hosts are
/// intentionally supported because PosterView is designed to reach LAN services.
pub fn media_server_base(value: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(value).map_err(|_| "Enter a valid HTTP or HTTPS server URL.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Media-server URLs must use HTTP or HTTPS.".to_owned());
    }
    if url.host_str().is_none() {
        return Err("The media-server URL must include a host.".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Put credentials in the token field, not in the server URL.".to_owned());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The media-server URL cannot contain a query or fragment.".to_owned());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// Require HTTPS and a provider-owned domain for externally supplied URLs.
pub fn provider_https(value: &str, allowed_domains: &[&str]) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "The artwork URL is invalid.".to_owned())?;
    if url.scheme() != "https" {
        return Err("Artwork URLs must use HTTPS.".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Artwork URLs cannot contain credentials.".to_owned());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "The artwork URL must include a host.".to_owned())?;
    let trusted = allowed_domains.iter().any(|allowed| {
        host.eq_ignore_ascii_case(allowed)
            || host
                .strip_suffix(allowed)
                .is_some_and(|prefix| prefix.ends_with('.'))
    });
    if !trusted {
        return Err(format!(
            "Refusing an artwork URL from untrusted host {host}."
        ));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_servers_allow_lan_but_reject_embedded_credentials() {
        assert!(media_server_base("http://192.168.1.8:8096").is_ok());
        assert!(media_server_base("https://server.tailnet.ts.net/emby").is_ok());
        assert!(media_server_base("http://user:pass@server.local").is_err());
        assert!(media_server_base("file:///etc/passwd").is_err());
    }

    #[test]
    fn provider_urls_require_https_and_an_exact_host() {
        let domains = &["example.com"];
        assert!(provider_https("https://images.example.com/a.jpg", domains).is_ok());
        assert!(provider_https("http://images.example.com/a.jpg", domains).is_err());
        assert!(provider_https("https://images.example.com.evil.test/a.jpg", domains).is_err());
        assert!(provider_https("https://127.0.0.1/a.jpg", domains).is_err());
    }
}
