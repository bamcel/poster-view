use reqwest::RequestBuilder;

pub(crate) trait TmdbAuth {
    fn tmdb_auth(self, credential: &str) -> Self;
}
impl TmdbAuth for RequestBuilder {
    fn tmdb_auth(self, credential: &str) -> Self {
        let value = credential.trim();
        let value = if value.get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer ")) { value[7..].trim() } else { value };
        if value.len() == 32 && value.bytes().all(|c| c.is_ascii_hexdigit()) {
            self.query(&[("api_key", value)])
        } else {
            self.bearer_auth(value)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supports_api_keys_and_normalizes_bearer_tokens() {
        let client = reqwest::Client::new();
        let key = "0123456789abcdef0123456789abcdef";
        let request = client.get("https://api.themoviedb.org/3/movie/11").tmdb_auth(key).build().unwrap();
        assert_eq!(request.url().query_pairs().find(|(k, _)| k == "api_key").unwrap().1, key);
        assert!(!request.headers().contains_key("authorization"));
        for token in ["example.token.value", " Bearer example.token.value "] {
            let request = client.get("https://api.themoviedb.org/3/movie/11").tmdb_auth(token).build().unwrap();
            assert_eq!(request.headers()["authorization"], "Bearer example.token.value");
            assert!(request.url().query().is_none());
        }
    }
}
