//! What a report may say: a fault's text with everything that could name a person, a machine or a
//! secret replaced by a placeholder, before the preview shows it. What the preview shows is what
//! is sent, so this runs once, here, and nothing downstream sees the text before it.
//!
//! The rules are ordered: a secret is caught by the rule for its own shape (a JSON field, a
//! header, a `key: value` in prose, a vendor's key prefix, a long token) before the general rules
//! for URLs and hosts run over what is left. When a rule has to choose between hiding too much and
//! too little, it hides too much: a report that says `token: <secret>` where it could have said
//! more is a worse issue, and one that leaks a token is an incident. Every vector that once leaked
//! is a test below.

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// What this Mac knows that a pattern cannot: the names a person gave things. A Bot called
/// "Acme Jira Sync" is as identifying as an email, and no regex finds it.
#[derive(Debug, Clone, Default)]
pub struct Known {
    /// The home directory, `/Users/someone`.
    pub home: Option<String>,
    /// Names to hide wherever they appear as whole words: Bots, plugins, sites, usernames.
    pub names: Vec<String>,
}

/// The shortest name hidden by [`Known::names`]: a two-letter Bot name would take every "ai"
/// out of the text with it.
const SHORTEST_NAME: usize = 3;

/// File extensions a dotted word may end in and still be a file, not a host: `build.sh`,
/// `state.rs`, `Cargo.toml` and `libssl.so` are what a failure names when it names code, and a
/// report without them loses its most useful line.
const FILE_EXTENSIONS: &[&str] = &[
    "rs", "sh", "so", "dylib", "a", "o", "rlib", "toml", "lock", "json", "yml", "yaml", "md",
    "txt", "log", "ts", "tsx", "js", "jsx", "mjs", "py", "go", "c", "h", "cc", "cpp", "hpp", "m",
    "mm", "swift", "html", "css", "svg", "png", "jpg", "ips", "plist", "sql", "db", "env", "app",
    "zip", "gz", "tar", "dmg", "pkg", "wasm", "run", "page", "csv", "pem", "crt", "key",
];

/// The server's id prefixes (`cw_…`, `ntf_…`), exactly. A word is one of the server's ids only
/// with one of these and a body of eight or more characters holding a digit: `cw_unavailable`
/// and `run_cancelled` are code words, and `usage_window2024` has no id prefix.
const ID_PREFIXES: &[&str] = &[
    "acct", "art", "attempt", "bm", "bx", "conn", "cw", "hook", "inv", "mac", "mcp", "msg", "ntf",
    "og", "ogr", "org", "pum", "rcp", "refuse", "req", "rrun", "run", "sch", "sched", "skl", "sl",
    "span", "th", "thr", "thread", "tl", "tpl",
];

/// Path words the app's own requests use (the literal segments of the routes in
/// `src/opengrok/client.rs`, kept in step by a test). Any other segment of a request's path is
/// somebody's: a plugin's name, a site, a skill. It becomes `{x}`.
const ROUTE_WORDS: &[&str] = &[
    "accept",
    "account",
    "ag-ui",
    "answer",
    "approvals",
    "artifacts",
    "attempts",
    "auth",
    "authorize",
    "bots",
    "bytes",
    "catalog",
    "ceiling",
    "computer",
    "connections",
    "connectors",
    "coworkers",
    "credentials",
    "daemon",
    "decline",
    "docs",
    "egress-policy",
    "events",
    "from-tape",
    "grants",
    "health",
    "hide",
    "host-settings",
    "icon",
    "inference-relay",
    "inference-source",
    "installations",
    "lend",
    "local-exec",
    "login",
    "logout",
    "models",
    "office",
    "own-computer",
    "pages",
    "password",
    "pause",
    "pending",
    "pins",
    "plugin-skills",
    "plugins",
    "policy",
    "profile",
    "recipes",
    "reconnect",
    "refresh",
    "reopen",
    "requests",
    "reset",
    "responses",
    "resume",
    "reveal",
    "revoke",
    "rotate-key",
    "rule",
    "run",
    "runs",
    "saved-login",
    "schedules",
    "screen",
    "share",
    "sharing",
    "sign-in",
    "site-logins",
    "skills",
    "stop",
    "threads",
    "tool-mode",
    "tools",
    "update",
    "usage",
    "versions",
];

pub(crate) fn re(pattern: &str) -> Regex {
    // The patterns are constants in this module; one that does not compile is a bug the first
    // test finds, not a condition a person can cause.
    #[allow(clippy::expect_used)]
    Regex::new(pattern).expect("a redaction pattern compiles")
}

/// The words a secret is filed under, as a key in JSON, a header or prose.
const SECRET_WORDS: &str = r"[a-z0-9_\-]*(?:token|secret|password|passwd|api[_-]?key|session|cookie|credential)[a-z0-9_\-]*";

/// `"access_token" : "…"` or `: 999`, any spacing.
static JSON_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r#"(?i)"({SECRET_WORDS}|authorization)"\s*:\s*(?:"(?:[^"\\]|\\.)*"|-?[0-9][0-9.]*|true|false)"#
    ))
});
/// A header that carries a credential: everything after its colon, to the end of the line.
static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?im)(^|[\s,;{(])(proxy-authorization|authorization|set-cookie|cookie|x-api-key|api-key|x-auth-token)\s*:\s*[^\r\n]*",
    )
});
/// `Bearer <token>` or `Basic <token>`: the scheme word followed by something token-shaped, so
/// "basic plan" is still prose.
static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/\-]{8,}=*"));
/// `token: abc def`, `password=abc`: everything after the marker, to the end of the line.
static KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?im)(^|[\s,;{{(?&])({SECRET_WORDS})\s*[:=]\s*[^\r\n]*"
    ))
});
/// Keys recognisable by their vendor prefix, standing alone in prose.
static PREFIXED_KEY: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"\b(?:sk-[A-Za-z0-9_\-]{8,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9\-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,}|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,})",
    )
});
/// A long run of letters and digits mixed: the shape of a token whatever its vendor. Without
/// `_`, so a snake_case name like `settle_coworker_usage` is not one.
static LONG_TOKEN: LazyLock<Regex> = LazyLock::new(|| re(r"[A-Za-z0-9+/=\-]{16,}"));
static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| re(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+"));
/// `scheme://authority/path?query`: the host goes, the path keeps its route words, the query
/// goes (it is where tokens ride).
static URL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r#"(?i)\b([a-z][a-z0-9+.\-]*)://[^\s/?#"'<>)\]]+(/[^\s?#"'<>)\]]*)?(?:\?[^\s#"'<>)\]]*)?(?:#[^\s"'<>)\]]*)?"#,
    )
});
static HOME: LazyLock<Regex> = LazyLock::new(|| re(r"/(?:Users|home)/[^/\s:]+"));
static IPV6: LazyLock<Regex> =
    LazyLock::new(|| re(r"\[[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*\](?::\d{1,5})?"));
static IPV4: LazyLock<Regex> = LazyLock::new(|| re(r"\b((?:\d{1,3}\.){3}\d{1,3})(:\d{1,5})?\b"));
/// A dotted name, with or without a port: a host unless it ends in a file extension.
static DOTTED: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?\.)+([a-z][a-z0-9\-]*)\b(:\d{1,5})?|\blocalhost(?::\d{1,5})?\b",
    )
});
/// A name in single quotes, as an error quotes what it could not find: `plugin 'Acme' failed`.
static QUOTED: LazyLock<Regex> = LazyLock::new(|| re(r"(^|[\s(:])'([^'\r\n]{1,80})'"));
static UUID: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"));
static PREFIXED_ID: LazyLock<Regex> = LazyLock::new(|| re(r"\b([a-z]{2,8})_([A-Za-z0-9\-]{8,})\b"));
static LONG_HEX: LazyLock<Regex> = LazyLock::new(|| re(r"\b[0-9a-fA-F]{16,}\b"));

/// Each match of `pattern` in `text` replaced by what `with` makes of it.
fn swap(text: String, pattern: &Regex, with: impl Fn(&Captures) -> String) -> String {
    pattern
        .replace_all(&text, |c: &Captures| with(c))
        .into_owned()
}

/// Whether a `prefix_body` word (`cw_018f…`) is one of the server's ids.
fn is_server_id(prefix: &str, body: &str) -> bool {
    ID_PREFIXES.contains(&prefix) && body.chars().any(|c| c.is_ascii_digit())
}

/// Every id in `text` as `{id}`: the server's prefixed ids, UUIDs and long hex runs.
pub fn hide_ids(text: &str) -> String {
    let text = UUID.replace_all(text, "{id}").into_owned();
    let text = swap(text, &PREFIXED_ID, |c| {
        if is_server_id(&c[1], &c[2]) {
            "{id}".into()
        } else {
            c[0].into()
        }
    });
    LONG_HEX.replace_all(&text, "{id}").into_owned()
}

/// A request's path as the app's routes spell it: ids as `{id}`, any word the routes do not use
/// as `{x}`. `/plugins/catalog/acme-jira` names a plugin; `/plugins/catalog/{x}` does not.
pub fn route_shape(path: &str) -> String {
    hide_ids(path)
        .split('/')
        .map(|segment| {
            if segment.is_empty() || segment == "{id}" || ROUTE_WORDS.contains(&segment) {
                segment.to_string()
            } else {
                "{x}".to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// `text` as a report may carry it.
pub fn redact(text: &str, known: &Known) -> String {
    let mut out = text.to_string();
    // The person's own names first, while they are whole: a name can contain a dot or an `@`
    // that a later rule would split. Longest first, so "Acme Jira Sync" goes before "Acme".
    let mut names: Vec<&str> = known
        .names
        .iter()
        .map(|name| name.trim())
        .filter(|name| name.chars().count() >= SHORTEST_NAME)
        .collect();
    names.sort_by_key(|name| std::cmp::Reverse(name.len()));
    for name in names {
        out = replace_word(&out, name, "{name}");
    }
    if let Some(home) = known.home.as_deref().filter(|home| !home.is_empty()) {
        out = out.replace(home, "~");
    }
    out = swap(out, &JSON_SECRET, |c| {
        format!("\"{}\": \"<secret>\"", &c[1])
    });
    out = swap(out, &HEADER, |c| format!("{}{}: <secret>", &c[1], &c[2]));
    out = swap(out, &SCHEME, |c| format!("{} <secret>", &c[1]));
    out = swap(out, &KEY_VALUE, |c| format!("{}{}: <secret>", &c[1], &c[2]));
    out = swap(out, &PREFIXED_KEY, |_| "<secret>".into());
    out = swap(out, &EMAIL, |_| "{email}".into());
    out = swap(out, &URL, |c| {
        let path = c.get(2).map_or("", |m| m.as_str());
        format!("{}://{{host}}{}", &c[1], route_shape(path))
    });
    out = swap(out, &HOME, |_| "~".into());
    out = swap(out, &IPV6, |_| "{ip}".into());
    out = swap(out, &IPV4, |c| {
        // An address has an octet of two digits or a port; `0.9.3.4` is a version.
        let address = c.get(2).is_some() || c[1].split('.').any(|octet| octet.len() > 1);
        if address { "{ip}".into() } else { c[0].into() }
    });
    out = swap(out, &DOTTED, |c| match c.get(1) {
        Some(last) if FILE_EXTENSIONS.contains(&last.as_str().to_ascii_lowercase().as_str()) => {
            c[0].into()
        }
        Some(last) if last.as_str().len() < 2 => c[0].into(),
        _ => "{host}".into(),
    });
    out = swap(out, &QUOTED, |c| format!("{}'{{name}}'", &c[1]));
    out = hide_ids(&out);
    swap(out, &LONG_TOKEN, |c| {
        let token = &c[0];
        let mixed = token.chars().any(|ch| ch.is_ascii_digit())
            && token.chars().any(|ch| ch.is_ascii_alphabetic());
        if mixed {
            "<secret>".into()
        } else {
            token.into()
        }
    })
}

/// `haystack` with every whole-word, case-insensitive `needle` replaced: a Bot called "Ada" is
/// hidden in "Ada said" and not in "adapter".
fn replace_word(haystack: &str, needle: &str, with: &str) -> String {
    let pattern = re(&format!(
        r"(?i)(^|[^\p{{L}}\p{{N}}_]){}($|[^\p{{L}}\p{{N}}_])",
        regex::escape(needle)
    ));
    // Twice, because a match consumes the boundary character the next match would start with:
    // "Ada Ada" is two names.
    let once = swap(haystack.to_string(), &pattern, |c| {
        format!("{}{with}{}", &c[1], &c[2])
    });
    swap(once, &pattern, |c| format!("{}{with}{}", &c[1], &c[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known() -> Known {
        Known {
            home: Some("/Users/exampleuser".into()),
            names: vec![
                "Acme Jira Sync".into(),
                "person@example.test".into(),
                "Ada".into(),
            ],
        }
    }

    // Key-shaped vectors are built with `concat!` so the source holds no literal a secret
    // scanner would take for a real key.
    /// Every vector that leaked in the grounding probe, the validation's adversarial pass or the
    /// spec review, with the words that must not survive. One table, so a new leak is one row.
    #[test]
    fn nothing_that_names_a_person_a_machine_or_a_secret_survives() {
        let none = Known::default();
        let cases: &[(&str, &[&str], &Known)] = &[
            (
                "error sending request for url (http://127.0.0.1:1447/coworkers/cw_018f3a2b9c7d7e10a1b2c3d4e5f60718/usage?window=month)",
                &[
                    "127.0.0.1",
                    "1447",
                    "cw_018f3a2b9c7d7e10a1b2c3d4e5f60718",
                    "window=month",
                ],
                &none,
            ),
            ("Authorization: Bearer abc.def.ghi", &["abc.def.ghi"], &none),
            ("Set-Cookie: session=s3cr3t; Path=/", &["s3cr3t"], &none),
            ("Cookie: abc123", &["abc123"], &none),
            (
                r#"{"error":"bad","access_token":"tok_live_123"}"#,
                &["tok_live_123"],
                &none,
            ),
            (
                "could not read /Users/exampleuser/Library/Caches/x",
                &["exampleuser"],
                &known(),
            ),
            (
                "could not read /Users/otheruser/Library/Caches/x",
                &["otheruser"],
                &none,
            ),
            (
                "person@example.test failed on opengrok.example.test:1447",
                &["person@example.test", "opengrok.example.test", "1447"],
                &none,
            ),
            (
                "coworker cw_018f3a2b9c7d7e10a1b2c3d4e5f60718 not found; login.example.test:443 refused",
                &["cw_018f3a2b9c7d7e10a1b2c3d4e5f60718", "login.example.test"],
                &none,
            ),
            (
                "upstream returned 503 at 10.0.0.4:29080 after 1200 ms",
                &["10.0.0.4", "29080"],
                &none,
            ),
            ("upstream says [::1]:1447 is down", &["::1", "1447"], &none),
            ("ntf_0190a2b3c4d5e6f7 said", &["0190a2b3c4d5e6f7"], &none),
            (
                "person@example.test on https://login.example.test/: keychain locked",
                &["person@example.test", "login.example.test"],
                &none,
            ),
            (
                "connect to opengrok.example.test failed",
                &["opengrok.example.test"],
                &none,
            ),
            (
                "someone.else@corp.example.com could not sign in",
                &["someone.else", "corp.example.com"],
                &none,
            ),
            (
                r#"{"error":"bad","access_token": "tok_live_123"}"#,
                &["tok_live_123"],
                &none,
            ),
            (
                "Authorization: Basic dXNlcjpwYXNz",
                &["dXNlcjpwYXNz"],
                &none,
            ),
            (
                concat!("X-Api-Key: sk", "-ant-api03-ABCDEF123"),
                &[concat!("sk", "-ant-api03-ABCDEF123"), "ABCDEF123"],
                &none,
            ),
            (
                concat!("invalid key sk", "-ant-api03-ZZZZ9999"),
                &[concat!("sk", "-ant-api03-ZZZZ9999"), "ZZZZ9999"],
                &none,
            ),
            ("token: abc123xyz", &["abc123xyz"], &none),
            ("login.example.test refused", &["login.example.test"], &none),
            (
                "plugin 'Acme Jira Sync' failed",
                &["Acme Jira Sync", "Acme"],
                &known(),
            ),
            (
                "request failed: Authorization: Bearer abc.def.ghi and retry",
                &["abc.def.ghi"],
                &none,
            ),
            // The spec review's: hosts on any domain, names nobody passed, secrets of more than
            // one word, tokens of no known vendor, numbers in JSON, names in a request's path.
            (
                "opengrok.example.ru refused",
                &["opengrok.example.ru", "example"],
                &none,
            ),
            (
                "build.acme.corp refused",
                &["build.acme.corp", "acme"],
                &none,
            ),
            ("login.example refused", &["login.example"], &none),
            (
                "plugin 'Acme Jira Sync' failed",
                &["Acme Jira Sync", "Acme"],
                &none,
            ),
            ("token: abc123 xyz is the value", &["abc123", "xyz"], &none),
            (
                "refused with Zk3pQ9rT2vX8mN4bW7cY",
                &["Zk3pQ9rT2vX8mN4bW7cY"],
                &none,
            ),
            (r#"{"token": 999}"#, &["999"], &none),
            (
                "GET https://host.test/plugins/catalog/acme-jira failed",
                &["acme-jira", "host.test"],
                &none,
            ),
        ];
        for (input, gone, known) in cases {
            let out = redact(input, known);
            for word in *gone {
                assert!(
                    !out.contains(word),
                    "{word:?} survived in {out:?} (from {input:?})"
                );
            }
        }
    }

    /// What a report is for stays: the failure's own words, code words, the status, file names
    /// and lines, versions, function paths, and the shape of the request.
    #[test]
    fn the_failure_itself_is_kept() {
        let cases: &[(&str, &str)] = &[
            (
                "upstream anthropic returned 400",
                "upstream anthropic returned 400",
            ),
            (
                "Connection refused (os error 61)",
                "Connection refused (os error 61)",
            ),
            ("raised at src/state.rs:8258", "raised at src/state.rs:8258"),
            ("plan_unavailable: no plan", "plan_unavailable: no plan"),
            (
                "cw_unavailable and run_cancelled",
                "cw_unavailable and run_cancelled",
            ),
            ("usage_window2024 missing", "usage_window2024 missing"),
            ("basic plan unavailable", "basic plan unavailable"),
            ("build.sh failed", "build.sh failed"),
            ("could not load libssl.so", "could not load libssl.so"),
            ("setup.run exited", "setup.run exited"),
            ("bad Cargo.toml", "bad Cargo.toml"),
            ("app 0.9.3.4 needs 0.9.4", "app 0.9.3.4 needs 0.9.4"),
            ("e.g. the bot's usage", "e.g. the bot's usage"),
            ("the adapter failed", "the adapter failed"),
            (
                "nativechat::state::AppState::settle_coworker_usage",
                "nativechat::state::AppState::settle_coworker_usage",
            ),
            (
                "error sending request for url (http://127.0.0.1:1458/coworkers/cw_018f3a2b9c7d7e10a1b2c3d4e5f60718/usage?window=month)",
                "error sending request for url (http://{host}/coworkers/{id}/usage)",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(redact(input, &known()), *want, "{input:?}");
        }
    }

    /// A name is hidden as a whole word only, and one shorter than three letters not at all.
    #[test]
    fn names_are_hidden_as_whole_words() {
        assert_eq!(
            redact("Ada said no; ask ADA", &known()),
            "{name} said no; ask {name}"
        );
        let short = Known {
            home: None,
            names: vec!["AI".into()],
        };
        assert_eq!(redact("AI said no", &short), "AI said no");
    }

    /// A request's path keeps the app's own route words and nothing of anybody's.
    #[test]
    fn a_request_path_keeps_only_route_words() {
        assert_eq!(
            route_shape("/plugins/catalog/acme-jira"),
            "/plugins/catalog/{x}"
        );
        assert_eq!(
            route_shape("/coworkers/cw_018f3a2b9c7d7e10a1b2c3d4e5f60718/usage"),
            "/coworkers/{id}/usage"
        );
        assert_eq!(
            route_shape("/site-logins/facebook.com/bots"),
            "/site-logins/{x}/bots"
        );
    }

    /// The route words are exactly the literal segments of the routes the client sends: a new
    /// route keeps its words in reports, and nothing else counts as one.
    #[test]
    fn the_route_words_are_the_clients_own() {
        let client = include_str!("../opengrok/client.rs");
        let shipped = client.split("#[cfg(test)]").next().unwrap_or(client);
        let literal = re(r#""(/[a-z][^"\s]*)""#);
        let mut used: Vec<&str> = literal
            .captures_iter(shipped)
            .filter_map(|c| c.get(1))
            .flat_map(|m| m.as_str().split(['?', '#']).next().unwrap_or("").split('/'))
            .filter(|segment| !segment.is_empty() && !segment.contains(['{', '}']))
            .collect();
        used.sort_unstable();
        used.dedup();
        let mut words = ROUTE_WORDS.to_vec();
        words.sort_unstable();
        assert_eq!(
            used, words,
            "src/opengrok/client.rs's routes and ROUTE_WORDS differ"
        );
    }
}
