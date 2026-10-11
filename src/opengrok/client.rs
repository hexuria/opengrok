use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use futures::StreamExt;
use futures::future::{FutureExt, Shared};
use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{ACCEPT, CACHE_CONTROL, CONTENT_TYPE, HeaderValue};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex as AsyncMutex;

use super::error::OpenGrokError;
use super::inference::{InferenceSource, InferenceSourceUpdate, TurnSource};
use super::pending::{
    PendingCustom, PendingList, PendingMutation, PendingUserMessage, PendingWrite,
};
use super::relay::{RelayAnswer, RelayAnswered};
use super::types::{
    Account, AguiMessage, Coworker, CoworkerPatch, ModelCatalogue, ProfileUpdate, ThreadListing,
    error_code_from_body, error_message_from_body, written_by_opengrok,
};
use crate::private_file::write_private;
use crate::threads::conversation_for_thread;

/// The cookie the server puts the access JWT in. It is also what goes out as the Bearer.
const ACCESS_COOKIE: &str = "og_access";

/// The cookie that can be traded for a new access token, and therefore the difference between a
/// session the app can still rescue by itself and one only a person can.
const REFRESH_COOKIE: &str = "og_refresh";

/// How close to its expiry an access token is refreshed rather than used. Enough for a request
/// that is slow to leave; short enough that a token is not thrown away while it still works.
const REFRESH_SLACK: std::time::Duration = std::time::Duration::from_secs(30);

/// RFC 7240's word for "answer now and do the work after". A route that honours it answers
/// `202`; one that does not answers exactly as it would have without it.
const RESPOND_ASYNC: &str = "respond-async";

/// What the app says when the session is gone and the server sent no sentence of its own.
///
/// Addressed to the person, because signing in is a thing only a person can do, and it names no
/// machine: nothing is broken and nothing is out of reach.
const SIGNED_OUT_MESSAGE: &str = "OpenGrok does not know who this app is signed in as.";

/// Whether the access token needs replacing before the next request goes out.
///
/// The argument is seconds left on the token, and `None` is the answer that matters: it means
/// the question could not be answered at all, which almost always means there is no token to
/// ask about. This used to read `None` as "no deadline, carry on", and that one reading is the
/// bug — the cookie jar drops a cookie the moment it expires, so a token that has run out does
/// not present as a token with no time left, it presents as nothing at all. The request then
/// went out with no `Authorization` header and the server, with no principal to bill, held it.
fn needs_refresh(seconds_left: Option<i64>) -> bool {
    match seconds_left {
        Some(left) => left < REFRESH_SLACK.as_secs() as i64,
        None => true,
    }
}

/// Cloneable result of one `/auth/refresh` so concurrent callers can join
/// the same in-flight POST.
#[derive(Clone)]
enum RefreshOutcome {
    Ok,
    Failed {
        status: Option<u16>,
        message: String,
    },
}

type RefreshShared = Shared<futures::future::BoxFuture<'static, RefreshOutcome>>;

/// An id as one segment of a path. A thread's id is whatever the server chose (a schedule's id
/// is the thread its routine runs in), and a `/`, `?` or `#` in it must not turn one route into
/// another. `+` is only a space in a query, so a space is written the way a path spells it.
fn path_segment(id: &str) -> String {
    url::form_urlencoded::byte_serialize(id.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

#[derive(Clone)]
pub struct OpenGrokClient {
    base: Url,
    http: Client,
    jar: Arc<Jar>,
    session_path: Option<PathBuf>,
    /// Single-flight `/auth/refresh`. Concurrent `ensure_fresh_token` / 401
    /// retry must await this instead of each POSTing: the first 200 rotates
    /// the refresh cookie, and a second POST with the old cookie is 401 and
    /// used to `clear_session` (SignedOut banner).
    ///
    /// OpenGrok today: one-time rotate. They are shipping a short grace so
    /// presenting the just-rotated-away refresh returns the current pair
    /// (idempotent). NativeChat single-flight is still required either way.
    refresh_flight: Arc<AsyncMutex<Option<RefreshShared>>>,
}

#[derive(Serialize, Deserialize)]
struct StoredSession {
    base_url: String,
    cookies: Vec<(String, String)>,
}

impl OpenGrokClient {
    pub fn new(base_url: &str) -> Result<Self, OpenGrokError> {
        let base = Url::parse(base_url)
            .map_err(|e| OpenGrokError::message(format!("invalid OpenGrok URL {base_url}: {e}")))?;
        let jar = Arc::new(Jar::default());
        let http = Client::builder()
            .cookie_provider(jar.clone())
            .tcp_nodelay(true)
            .build()
            .map_err(|e| OpenGrokError::message(e.to_string()))?;
        Ok(Self {
            base,
            http,
            jar,
            session_path: None,
            refresh_flight: Arc::new(AsyncMutex::new(None)),
        })
    }

    pub fn with_session_file(mut self, path: PathBuf) -> Self {
        self.session_path = Some(path);
        self
    }

    fn cookie_pairs(&self) -> Vec<(String, String)> {
        let Some(header) = CookieStore::cookies(self.jar.as_ref(), &self.base) else {
            return Vec::new();
        };
        let Ok(raw) = header.to_str() else {
            return Vec::new();
        };
        raw.split(';')
            .filter_map(|pair| {
                let pair = pair.trim();
                let (name, value) = pair.split_once('=')?;
                let name = name.trim();
                if name.is_empty() {
                    return None;
                }
                Some((name.to_string(), value.trim().to_string()))
            })
            .collect()
    }

    fn restore_cookies(&self, pairs: &[(String, String)]) {
        let headers: Vec<HeaderValue> = pairs
            .iter()
            .filter_map(|(name, value)| {
                HeaderValue::from_str(&format!("{name}={value}; Path=/")).ok()
            })
            .collect();
        if headers.is_empty() {
            return;
        }
        CookieStore::set_cookies(self.jar.as_ref(), &mut headers.iter(), &self.base);
    }

    pub fn load_session(&self) -> bool {
        let Some(path) = self.session_path.as_ref() else {
            return false;
        };
        let Ok(bytes) = fs::read(path) else {
            return false;
        };
        let Ok(stored) = serde_json::from_slice::<StoredSession>(&bytes) else {
            return false;
        };
        if stored.base_url.trim_end_matches('/') != self.base.as_str().trim_end_matches('/') {
            return false;
        }
        if stored.cookies.is_empty() {
            return false;
        }
        self.restore_cookies(&stored.cookies);
        true
    }

    pub fn save_session(&self) {
        let Some(path) = self.session_path.as_ref() else {
            return;
        };
        let cookies = self.cookie_pairs();
        if cookies.is_empty() {
            self.clear_session();
            return;
        }
        let stored = StoredSession {
            base_url: self.base.as_str().to_string(),
            cookies,
        };
        let Ok(json) = serde_json::to_vec(&stored) else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // A session that could not be kept privately is not kept: the old file stays as it was,
        // and the next launch signs in again.
        if let Err(error) = write_private(path, &json) {
            eprintln!("NativeChat: the session was not saved: {error}");
        }
    }

    pub fn clear_session(&self) {
        if let Some(path) = self.session_path.as_ref() {
            let _ = fs::remove_file(path);
        }
    }

    /// One cookie out of the jar, by name.
    ///
    /// The jar only ever hands back cookies that have not expired yet — `Jar::cookies` goes
    /// through `cookie_store`'s `matches`, which filters on `is_expired` — so a name that is
    /// missing here means one of two things that look identical from the outside: it was never
    /// set, or it was set and its moment has passed. Both are "the app is holding nothing".
    fn cookie(&self, name: &str) -> Option<String> {
        let header = CookieStore::cookies(self.jar.as_ref(), &self.base)?;
        let raw = header.to_str().ok()?;
        for pair in raw.split(';') {
            let pair = pair.trim();
            if let Some((found, value)) = pair.split_once('=')
                && found.trim() == name
            {
                return Some(value.trim().to_string());
            }
        }
        None
    }

    /// AG-UI `principal_from_bearer` only reads `Authorization`, not cookies.
    /// The console login stores the same JWT as `og_access`; send it as Bearer
    /// the way the desktop sends it as `x-opengrok-account` on Seam A.
    fn access_token(&self) -> Option<String> {
        self.cookie(ACCESS_COOKIE)
    }

    /// Whether the app is holding anything at all that could authenticate a request: a token to
    /// send, or the refresh cookie that can still be traded for one.
    ///
    /// This is not "is the person signed in". That is the app's belief about itself, and the
    /// belief is exactly what went wrong: the roster stayed on screen, the composer stayed
    /// ready, and the jar had nothing left in it. This question is about what is actually there
    /// to put in the header, and it is answerable without a round trip.
    pub fn has_session(&self) -> bool {
        self.access_token().is_some() || self.cookie(REFRESH_COOKIE).is_some()
    }

    /// Seconds until the access token expires, read from the JWT's `exp` without verifying
    /// it — the server verifies; this only decides whether to refresh first.
    ///
    /// `None` does not mean "plenty of time". It means the question could not be answered, and
    /// the commonest reason for that is that there is no token to ask about — see
    /// [`Self::ensure_fresh_token`], where reading `None` as "nothing to do" is the bug.
    fn token_seconds_left(&self) -> Option<i64> {
        use base64::Engine as _;
        let token = self.access_token()?;
        let payload = token.split('.').nth(1)?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .ok()?;
        let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        let exp = claims.get("exp")?.as_i64()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs() as i64;
        Some(exp - now)
    }

    /// Refresh before a token dies, not after. An expired bearer is not always a 401: `/ag-ui`
    /// runs it as nobody and the turn is held with no word to the person. [`REFRESH_SLACK`] of
    /// slack covers a request that is slow to leave. Best effort; the request goes out either
    /// way and a 401 gets one more chance below.
    ///
    /// A token that could not be read at all counts as a token that needs replacing, and that
    /// sentence is the whole of today's bug. The check used to be "some time left, and less than
    /// the slack" — which is never true once the token is *gone*, because the jar drops a cookie
    /// the moment it expires. So an app left idle past the access token's lifetime read `None`
    /// here, did nothing about it, and sent the next turn with no `Authorization` header at all.
    /// The server had no principal to bill and held the turn, and its sentence about spend
    /// arrived in the transcript as a red line.
    async fn ensure_fresh_token(&self, path: &str) {
        if path.starts_with("/auth/") {
            return;
        }
        // Nothing in the jar to trade. This runs before every request, so asking anyway would
        // be a round trip per request whose answer is already here.
        if !self.has_session() {
            return;
        }
        if needs_refresh(self.token_seconds_left()) {
            let _ = self.refresh().await;
        }
    }

    /// Access cookie is present and not inside [`REFRESH_SLACK`]. After a
    /// joined refresh, waiters see this and must not POST again or clear.
    fn has_fresh_access(&self) -> bool {
        self.access_token().is_some() && !needs_refresh(self.token_seconds_left())
    }

    fn url(&self, path: &str) -> Result<Url, OpenGrokError> {
        self.base
            .join(path)
            .map_err(|e| OpenGrokError::message(e.to_string()))
    }

    async fn send_json<T: Serialize>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&T>,
    ) -> Result<reqwest::Response, OpenGrokError> {
        self.send_json_within(method, path, body, None, None).await
    }

    /// [`Self::send_json`] asking not to be waited on (`Prefer: respond-async`), for a route
    /// that can answer `202` and finish the work after it has answered. Whether it did is in the
    /// status, not in what was asked: a server that does not honour the preference answers the
    /// way it always has.
    async fn send_json_with_prefer_async<T: Serialize>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&T>,
    ) -> Result<reqwest::Response, OpenGrokError> {
        self.send_json_within(method, path, body, None, Some(RESPOND_ASYNC))
            .await
    }

    /// [`Self::send_json`] with a deadline of its own: for a route that waits on a model, and for
    /// the connection routes, whose controls are dead until they answer ([`CONNECTIONS_TIMEOUT`]).
    /// `None` is every other route, which takes the client's default and has no deadline of its
    /// own. `prefer` is an RFC 7240 `Prefer` header, for the routes that honour one.
    async fn send_json_within<T: Serialize>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&T>,
        timeout: Option<std::time::Duration>,
        prefer: Option<&str>,
    ) -> Result<reqwest::Response, OpenGrokError> {
        let url = self.url(path)?;
        self.ensure_fresh_token(path).await;
        let build = |token: Option<String>| {
            let mut req = self.http.request(method.clone(), url.clone());
            if let Some(token) = token {
                req = req.bearer_auth(token);
            }
            if let Some(body) = body {
                req = req.json(body);
            }
            if let Some(timeout) = timeout {
                req = req.timeout(timeout);
            }
            if let Some(prefer) = prefer {
                req = req.header("Prefer", prefer);
            }
            req
        };
        // Which request this was, for a fault the person opens: method and path, never a body.
        let endpoint = format!("{method} {path}");
        let failed =
            |e: reqwest::Error| OpenGrokError::transport(&e).with_endpoint(Some(endpoint.clone()));
        let mut response = build(self.access_token()).send().await.map_err(failed)?;
        // A 401 on a signed-in session is a token that died between checks: refresh once and
        // send again. Auth routes are exempt, or a bad password would loop here.
        if response.status() == StatusCode::UNAUTHORIZED && !path.starts_with("/auth/") {
            if self.refresh_after_unauthorized().await.is_ok() {
                response = build(self.access_token()).send().await.map_err(failed)?;
            }
            // Still refused after the one thing the app can do about it on its own. The session
            // is gone, and that is decided here because here is where the route is known: the
            // same status on `/auth/login` is a wrong password, which is a verdict about what
            // somebody typed and belongs under the field they typed it in.
            if response.status() == StatusCode::UNAUTHORIZED {
                return Err(Self::signed_out_error(response)
                    .await
                    .with_endpoint(Some(endpoint)));
            }
        }
        // Carried on the answer, so a refusal read from it later says which request it was.
        response.extensions_mut().insert(SentAs(endpoint));
        Ok(response)
    }

    /// A `401` read as the session being gone, keeping the server's own sentence.
    ///
    /// The sentence is kept and not matched on. The server has one for this case today and it
    /// may have a different one tomorrow; what makes this a signed-out failure is the status and
    /// the route, both of which the caller already knows.
    async fn signed_out_error(response: reqwest::Response) -> OpenGrokError {
        let body = response.text().await.unwrap_or_default();
        Self::signed_out_refusal(&body)
    }

    /// [`Self::signed_out_error`] on a body already read, for the wire conformance tests.
    pub(super) fn signed_out_refusal(body: &str) -> OpenGrokError {
        let message = error_message_from_body(body);
        let error = if message.trim().is_empty() {
            OpenGrokError::signed_out(SIGNED_OUT_MESSAGE)
        } else {
            OpenGrokError::signed_out(message)
        };
        error.with_code(error_code_from_body(body))
    }

    async fn read_error(response: reqwest::Response) -> OpenGrokError {
        let status = response.status().as_u16();
        let endpoint = sent_as(&response);
        let body = response.text().await.unwrap_or_default();
        Self::refusal(status, &body).with_endpoint(endpoint)
    }

    /// [`Self::read_error`] on a status and a body already read. Apart from the response so the
    /// wire conformance tests read a recorded refusal with this very code.
    ///
    /// The person is shown the server's sentence and a caller branches on its code word, which
    /// are kept apart: see [`error_message_from_body`] and [`OpenGrokError::code`]. What kind of
    /// failure it is comes from who wrote it, which the body says and the status does not: a
    /// `502` or a `503` the server wrote itself is its verdict, and only one nothing says the
    /// server wrote is something in front of it that could not reach it.
    pub(super) fn refusal(status: u16, body: &str) -> OpenGrokError {
        let event = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|body| body.get("event").cloned());
        let message = error_message_from_body(body);
        // Neither reading takes a refusal at its word alone: "the gateway could not be reached"
        // is the server reporting a machine it could not get to, which is a state and not a
        // verdict about the request.
        let error = if written_by_opengrok(body) {
            OpenGrokError::from_opengrok(status, message)
        } else {
            OpenGrokError::from_server(Some(status), message)
        };
        error
            .with_code(error_code_from_body(body))
            .with_pending_event(event)
            .with_said_nothing(body.trim().is_empty())
    }

    /// Nothing on a 2xx, the server's error otherwise. For the doors that answer 204.
    async fn empty_or_error(response: reqwest::Response) -> Result<(), OpenGrokError> {
        if response.status().is_success() {
            return Ok(());
        }
        Err(Self::read_error(response).await)
    }

    /// The body as `T` on a 2xx, the server's error otherwise.
    async fn json_or_error<T: serde::de::DeserializeOwned>(
        response: reqwest::Response,
    ) -> Result<T, OpenGrokError> {
        if !response.status().is_success() {
            return Err(Self::read_error(response).await);
        }
        response
            .json()
            .await
            .map_err(|e| OpenGrokError::transport(&e))
    }

    pub async fn health(&self) -> Result<(), OpenGrokError> {
        let url = self.url("/health")?;
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| OpenGrokError::transport(&e))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    /// Cookie session. Request body is `{ email, password }`; tokens stay in the jar.
    pub async fn login(&self, email: &str, password: &str) -> Result<(), OpenGrokError> {
        let response = self
            .send_json(
                reqwest::Method::POST,
                "/auth/login",
                Some(&json!({ "email": email, "password": password })),
            )
            .await?;
        if response.status() == StatusCode::OK {
            self.save_session();
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    /// Trade the refresh cookie for a new access token. Sent directly rather than through
    /// `send_json`, which would refresh before refreshing.
    ///
    /// Single-flight: concurrent callers await one POST. A second `/auth/refresh`
    /// with the cookie the first just rotated is 401 today (OpenGrok one-time
    /// rotate) and must not `clear_session` if the jar already holds a new pair.
    /// OG short grace (idempotent current pair for the just-rotated-away
    /// refresh) does not replace this join.
    pub async fn refresh(&self) -> Result<(), OpenGrokError> {
        self.refresh_inner(false).await
    }

    /// `refresh` for the 401 path. The server has already ruled on the token, so
    /// the local "still looks fresh" check must not short-circuit: a revoked
    /// session, a rotated signing key and clock skew all present as a fresh-
    /// looking token the server refuses, and skipping the refresh here sends
    /// the same dead token again and signs the person out.
    pub async fn refresh_after_unauthorized(&self) -> Result<(), OpenGrokError> {
        self.refresh_inner(true).await
    }

    async fn refresh_inner(&self, force: bool) -> Result<(), OpenGrokError> {
        let shared = {
            let mut flight = self.refresh_flight.lock().await;
            // Join only a flight that is still running. One left behind finished
            // (every waiter was cancelled before it could clear the slot) would
            // hand a fresh caller its cached outcome instead of a real refresh.
            let live = flight.as_ref().filter(|f| f.peek().is_none()).cloned();
            match live {
                Some(shared) => shared,
                None if !force && self.has_fresh_access() => return Ok(()),
                None => {
                    let this = self.clone();
                    let shared = async move { this.refresh_once().await }.boxed().shared();
                    *flight = Some(shared.clone());
                    shared
                }
            }
        };
        let outcome = shared.clone().await;
        {
            let mut flight = self.refresh_flight.lock().await;
            // Clear only the flight this caller joined. `*flight = None` evicted
            // whatever was there, so a late waiter from flight A could drop a
            // newer flight B, and the next caller would start C beside it: two
            // concurrent `/auth/refresh`, which is the sign-out this exists to stop.
            if flight
                .as_ref()
                .is_some_and(|current| current.ptr_eq(&shared))
            {
                *flight = None;
            }
        }
        match outcome {
            RefreshOutcome::Ok => Ok(()),
            RefreshOutcome::Failed { status, message } => {
                Err(OpenGrokError::from_server(status, message))
            }
        }
    }

    async fn refresh_once(&self) -> RefreshOutcome {
        let url = match self.url("/auth/refresh") {
            Ok(url) => url,
            Err(error) => {
                return RefreshOutcome::Failed {
                    status: error.status,
                    message: error.message,
                };
            }
        };
        let mut req = self.http.post(url);
        if let Some(token) = self.access_token() {
            req = req.bearer_auth(token);
        }
        let response = match req.send().await {
            Ok(response) => response,
            Err(error) => {
                let mapped = OpenGrokError::transport(&error);
                return RefreshOutcome::Failed {
                    status: mapped.status,
                    message: mapped.message,
                };
            }
        };
        if response.status().is_success() {
            self.save_session();
            return RefreshOutcome::Ok;
        }
        let error = Self::read_error(response).await;
        if error.is_unauthorized() {
            // Concurrent refresh already wrote a new pair. Do not throw it away.
            if self.has_fresh_access() {
                return RefreshOutcome::Ok;
            }
            // "session expired": the refresh token is gone, so the saved session is worthless
            // and every later request would try this again. Forget it; the next request fails
            // plainly with 401 and the person signs in.
            self.clear_session();
        }
        RefreshOutcome::Failed {
            status: error.status,
            message: error.message,
        }
    }

    pub async fn logout(&self) -> Result<(), OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::POST, "/auth/logout", None)
            .await?;
        self.clear_session();
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    pub async fn me(&self) -> Result<Account, OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::GET, "/account", None)
            .await?;
        Self::json_or_error(response).await
    }

    /// `PUT /account` `{timeZone}`: keep `zone`, this computer's IANA time zone, as the one the
    /// person's routines default to, answered with the account as `GET /account` answers it
    /// (opengrok-server #322, on main since c0bb6ae: `put_me` in
    /// `crates/opengrok-server/src/account_api.rs`, #316). The same zone again changes nothing
    /// there. A zone its database does not know is a 422 `{error}` in its words, a body naming
    /// none a 400, and signed out a 401.
    pub async fn set_time_zone(&self, zone: &str) -> Result<Account, OpenGrokError> {
        let response = self
            .send_json(
                reqwest::Method::PUT,
                "/account",
                Some(&json!({ "timeZone": zone })),
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// The person's saved site logins on the server. Never the passwords.
    pub async fn list_site_logins(&self) -> Result<Vec<RemoteSiteLogin>, OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::GET, "/site-logins", None)
            .await?;
        Self::json_or_error(response).await
    }

    /// Save (or replace) one site login on the server. The reply is the row without the
    /// password; its id is the id the local keychain copy is filed under.
    pub async fn save_site_login(
        &self,
        origin: &str,
        username: &str,
        label: &str,
        notes: &str,
        kind: &str,
        password: &str,
    ) -> Result<RemoteSiteLogin, OpenGrokError> {
        self.save_site_login_full(&SiteLoginSave {
            origin,
            username,
            label,
            notes,
            kind,
            password: Some(password),
            otpauth: None,
        })
        .await
    }

    /// Save a row with what it has: a password, an authenticator-code seed, or both.
    pub async fn save_site_login_full(
        &self,
        save: &SiteLoginSave<'_>,
    ) -> Result<RemoteSiteLogin, OpenGrokError> {
        let mut body = serde_json::json!({
            "origin": save.origin,
            "username": save.username,
            "label": save.label,
            "notes": save.notes,
            "kind": save.kind,
        });
        if let Some(password) = save.password {
            body["password"] = serde_json::Value::String(password.to_string());
        }
        if let Some(otpauth) = save.otpauth {
            body["otpauth"] = serde_json::Value::String(otpauth.to_string());
        }
        let response = self
            .send_json(reqwest::Method::POST, "/site-logins", Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    /// Both secrets of one of the person's own site logins, after Touch ID on this Mac:
    /// the password and the authenticator-code seed, whichever the row has.
    pub async fn reveal_site_login_secrets(
        &self,
        id: &str,
    ) -> Result<RevealedSecrets, OpenGrokError> {
        let response = self
            .send_json::<()>(
                reqwest::Method::POST,
                &format!("/site-logins/{id}/reveal"),
                None,
            )
            .await?;
        let body: serde_json::Value = Self::json_or_error(response).await?;
        let text = |key: &str| {
            body.get(key)
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        Ok(RevealedSecrets {
            password: text("password"),
            otpauth: text("otpauth"),
        })
    }

    /// Change the title or the notes of one of the person's site logins. The reply is the
    /// row as the server now has it.
    pub async fn update_site_login(
        &self,
        id: &str,
        update: &SiteLoginUpdate,
    ) -> Result<RemoteSiteLogin, OpenGrokError> {
        let response = self
            .send_json(
                reqwest::Method::PATCH,
                &format!("/site-logins/{id}"),
                Some(update),
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// The site's icon for a saved login, as image bytes: `None` when the server has none
    /// (204), or has no such route (404). The format is whatever the site serves; the
    /// caller reads the first bytes to tell.
    pub async fn site_login_icon(&self, origin: &str) -> Result<Option<Vec<u8>>, OpenGrokError> {
        let response = self
            .send_json::<()>(
                reqwest::Method::GET,
                &format!("/site-logins/icon/{origin}"),
                None,
            )
            .await?;
        match response.status().as_u16() {
            204 | 404 => Ok(None),
            _ if response.status().is_success() => {
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|e| OpenGrokError::transport(&e))?;
                Ok((!bytes.is_empty()).then(|| bytes.to_vec()))
            }
            _ => Err(Self::read_error(response).await),
        }
    }

    /// Delete one of the person's site logins on the server. A row the server no longer has
    /// counts as deleted.
    pub async fn delete_site_login(&self, id: &str) -> Result<(), OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::DELETE, &format!("/site-logins/{id}"), None)
            .await?;
        if response.status().as_u16() == 404 || response.status().is_success() {
            return Ok(());
        }
        Err(Self::read_error(response).await)
    }

    /// The password of one of the person's own site logins, for a fill on this Mac after
    /// Touch ID. Cached into the keychain by the caller; never painted.
    pub async fn reveal_site_login(&self, id: &str) -> Result<String, OpenGrokError> {
        let response = self
            .send_json::<()>(
                reqwest::Method::POST,
                &format!("/site-logins/{id}/reveal"),
                None,
            )
            .await?;
        let body: serde_json::Value = Self::json_or_error(response).await?;
        body.get("password")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                OpenGrokError::from_server(Some(200), "the reveal carried no password".to_string())
            })
    }

    pub async fn update_profile(&self, update: &ProfileUpdate) -> Result<Account, OpenGrokError> {
        let response = self
            .send_json(reqwest::Method::POST, "/account/profile", Some(update))
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn change_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> Result<(), OpenGrokError> {
        let response = self
            .send_json(
                reqwest::Method::POST,
                "/account/password",
                Some(&json!({
                    "currentPassword": current_password,
                    "newPassword": new_password,
                })),
            )
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    pub async fn list_coworkers(&self) -> Result<Vec<Coworker>, OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::GET, "/coworkers", None)
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn hire(&self, name: &str, model: Option<&str>) -> Result<Coworker, OpenGrokError> {
        let mut body = json!({ "name": name });
        if let Some(model) = model.filter(|m| !m.is_empty()) {
            body["model"] = json!(model);
        }
        let response = self
            .send_json(reqwest::Method::POST, "/coworkers", Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn list_models(&self) -> Result<ModelCatalogue, OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::GET, "/models", None)
            .await?;
        Self::json_or_error(response).await
    }

    /// `GET /account/inference-source` — where the account's replies are paid from: the server's
    /// paid keys, or the person's own subscription through opencodex (the inference-source
    /// contract agreed with open-ai-gateway and opengrok-server, 2026-09-30, built in
    /// opengrok-server #294: `get_source` in `crates/opengrok-server/src/inference.rs`, answered
    /// by `described` in
    /// `crates/opengrok-harness/src/local_proxy.rs`). A signed-in account always gets a 200, the
    /// default `{"kind": "gateway", ...}` until it has saved one. A server from before the route
    /// answers a bare 404, which the caller reads as a server that cannot switch. Given
    /// [`INFERENCE_SOURCE_TIMEOUT`].
    pub async fn inference_source(&self) -> Result<InferenceSource, OpenGrokError> {
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                "/account/inference-source",
                None,
                Some(INFERENCE_SOURCE_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// `PUT /account/inference-source` — keep a change to the account's setting, answered with the
    /// setting as the server now keeps it, with a fresh `healthy` (the same contract: `put_source`
    /// in `crates/opengrok-server/src/inference.rs`, `apply` in
    /// `crates/opengrok-harness/src/local_proxy.rs`). A field left out is kept and a `null`
    /// clears it ([`InferenceSourceUpdate`]). A body the server will not keep is refused whole,
    /// with a 400 and `{"error": sentence}`, and nothing is kept. Given
    /// [`INFERENCE_SOURCE_TIMEOUT`].
    pub async fn set_inference_source(
        &self,
        update: &InferenceSourceUpdate,
    ) -> Result<InferenceSource, OpenGrokError> {
        let response = self
            .send_json_within(
                reqwest::Method::PUT,
                "/account/inference-source",
                Some(update),
                Some(INFERENCE_SOURCE_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn delete_coworker(&self, coworker_id: &str) -> Result<(), OpenGrokError> {
        let path = format!("/coworkers/{coworker_id}");
        let response = self
            .send_json::<()>(reqwest::Method::DELETE, &path, None)
            .await?;
        if Self::gone_after_delete(response.status().as_u16()) {
            return Ok(());
        }
        Err(Self::read_error(response).await)
    }

    /// Whether a delete that answered `status` left the coworker gone. A coworker the server no
    /// longer has is as gone as one it has just deleted (a second click, or another machine that
    /// got there first), so a 404 is done and not an error to show. Apart from the response so
    /// the wire conformance tests read a recorded answer with this very rule.
    pub(super) fn gone_after_delete(status: u16) -> bool {
        (200..300).contains(&status) || status == StatusCode::NOT_FOUND.as_u16()
    }

    pub async fn patch_coworker(
        &self,
        coworker_id: &str,
        patch: &CoworkerPatch,
    ) -> Result<Coworker, OpenGrokError> {
        if patch.is_empty() {
            return Err(OpenGrokError::message("nothing to change".to_string()));
        }
        let path = format!("/coworkers/{coworker_id}");
        let response = self
            .send_json(reqwest::Method::PATCH, &path, Some(patch))
            .await?;
        Self::json_or_error(response).await
    }

    /// One turn. Desktop Grok Bot POSTs `/api/sendPrompt` then paints from `GET /events`.
    /// NativeChat is a new client: same coworker + transcript, `POST /ag-ui` SSE instead.
    ///
    /// A recipe the person put on this turn goes in `forwardedProps` beside the coworker, with
    /// the values its parameters were given, and a skill goes there as its id. The messages are
    /// untouched by either: a parameter value is not prose, and there is no `/name` left in the
    /// text for the server to read a skill out of — the id is a field or the skill does not go.
    ///
    /// `pending_id` is the `pum_…` row this turn is firing, when the send was queued. The
    /// server drains that row atomically before the harness starts so two machines cannot both
    /// post it. Absent, a last user-message id that matches `clientMessageId` still drains.
    ///
    /// `retry_of` is the run whose reply this turn sends again: "Try again" and "Send this reply
    /// on Server" name the run of the reply they replace, as `forwardedProps.retryOf`. A queued
    /// send's row stays consumed by the run that fired it, and its bubble posted again without
    /// that run named is the send firing twice, refused `already-consumed`. Named, and the run
    /// over, the server hands the send to this run and the turn runs afresh; a run still going,
    /// or any other, is refused as before (opengrok-server #300, server main 06db932 (#309, after
    /// #308), pin b6ca457: `consume_for_turn` in `crates/opengrok-server/src/agui/pending.rs`).
    /// A retry never names a queued send: beside `pendingId` the server reads no `retryOf` and
    /// fires, or refuses, the send as a send, so `pending_id` is left off when this is given.
    ///
    /// `inference_source` is the Bot's own door for this turn, or for a held send the door the
    /// Bot had when it was queued: it goes as `forwardedProps.inferenceSource` and wins over the
    /// Bot's and the account's for this turn only, so a held send goes where it was typed to go
    /// even when the Bot has been moved since
    /// (the inference-source contract agreed with open-ai-gateway and opengrok-server,
    /// 2026-09-30, built in opengrok-server #294: `named` in
    /// `crates/opengrok-server/src/inference.rs`,
    /// `route` in `crates/opengrok-harness/src/local_proxy.rs`). It is the bare word, or with a
    /// way to the plan named `{"kind", "via"}` (#292: server main cad36fd (#303, after #298), pin
    /// 47a5d6b; see [`TurnSource`]). Absent, for a Bot that follows the account's door, the
    /// server decides, and the turn is the one sent before reply sources existed.
    ///
    /// The run id is the caller's. The server keeps every frame a run emits under it and will
    /// hand the whole lot back from `GET /ag-ui/runs/{run_id}`, which is of no use whatever to a
    /// client that only learns the id from the frames it already saw: the one moment the id is
    /// needed is the moment the stream has been lost. So it is minted before the turn is sent,
    /// by whoever will have to ask about it later.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_turn<F>(
        &self,
        coworker_id: &str,
        thread_id: &str,
        run_id: &str,
        messages: &[AguiMessage],
        recipe: Option<&TurnRecipe>,
        skill: Option<&str>,
        pending_id: Option<&str>,
        retry_of: Option<&str>,
        inference_source: Option<TurnSource>,
        on_event: F,
    ) -> Result<String, OpenGrokError>
    where
        F: FnMut(&serde_json::Value, std::time::Instant),
    {
        let ids = (pending_id, retry_of);
        let tags = TurnTags::default();
        self.run_turn_tagged(
            (coworker_id, thread_id, run_id),
            messages,
            (recipe, skill),
            ids,
            inference_source,
            &tags,
            on_event,
        )
        .await
    }

    /// [`Self::run_turn`] with what the message tagged (`@cloudflare`, `@shell`) and the account a
    /// "Which account?" card picked for it ([`TurnTags`]).
    #[allow(clippy::too_many_arguments)]
    pub async fn run_turn_tagged<F>(
        &self,
        (coworker_id, thread_id, run_id): (&str, &str, &str),
        messages: &[AguiMessage],
        (recipe, skill): (Option<&TurnRecipe>, Option<&str>),
        (pending_id, retry_of): (Option<&str>, Option<&str>),
        inference_source: Option<TurnSource>,
        tags: &TurnTags,
        mut on_event: F,
    ) -> Result<String, OpenGrokError>
    where
        F: FnMut(&serde_json::Value, std::time::Instant),
    {
        let mut forwarded = json!({ "coworkerId": coworker_id });
        // Each key only when there is something in it, so an untagged turn is the turn that was
        // sent before tags existed, byte for byte.
        if !tags.plugins.is_empty() {
            forwarded["mentionedPlugins"] = json!(tags.plugins);
        }
        if !tags.accounts.is_empty() {
            forwarded["pluginAccounts"] = json!(tags.accounts);
        }
        if !tags.tools.is_empty() {
            forwarded["preferTools"] = json!(tags.tools);
        }
        if let Some(source) = inference_source {
            forwarded["inferenceSource"] = source.to_value();
        }
        if let Some(recipe) = recipe {
            forwarded["recipe"] = Value::String(recipe.id.clone());
            forwarded["recipeValues"] = Value::Object(recipe.values.clone());
        }
        // The key is only written when there is a skill, so a turn sent without one is the turn
        // that was sent before any of this existed, byte for byte. An unknown id is the server's
        // to refuse, and it says so in the frame that ends the run.
        if let Some(skill) = skill {
            forwarded["skill"] = Value::String(skill.to_string());
        }
        if let Some(retried) = retry_of.filter(|run| !run.is_empty()) {
            forwarded["retryOf"] = Value::String(retried.to_string());
        } else if let Some(pending_id) = pending_id.filter(|id| !id.is_empty()) {
            forwarded["pendingId"] = Value::String(pending_id.to_string());
        }
        let body = json!({
            "threadId": thread_id,
            "runId": run_id,
            "messages": messages,
            "tools": super::gen_ui::agui_tools(),
            "forwardedProps": forwarded,
        });
        let url = self.url("/ag-ui")?;
        self.ensure_fresh_token("/ag-ui").await;
        // The turn does not leave without a credential on it. It used to: the header was
        // attached only `if let Some(token)`, and the `else` was to send the turn anyway. A turn
        // with no principal on it is a turn the server cannot bill to anybody, so it held it and
        // said so — a round trip, and a red line in the transcript, for something knowable here.
        let Some(token) = self.access_token() else {
            return Err(OpenGrokError::signed_out(SIGNED_OUT_MESSAGE));
        };
        let response = self
            .http
            .post(url)
            .header(ACCEPT, "text/event-stream")
            .header(CACHE_CONTROL, "no-cache")
            .json(&body)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| OpenGrokError::transport(&e))?;
        // `ensure_fresh_token` has already spent the app's one refresh, so a 401 here is the
        // session being gone rather than a token that aged out mid-flight. Read before the
        // general failure path, which would file it as a verdict about the turn.
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(Self::signed_out_error(response).await);
        }
        // A 202 is no stream: the queued send this turn fired is held for the person's Mac, and
        // no run started. Read as every 2xx was, it was a turn that said nothing.
        if response.status() == StatusCode::ACCEPTED {
            let body = response.text().await.unwrap_or_default();
            return Err(Self::turn_held(&body));
        }
        if !response.status().is_success() {
            return Err(Self::read_error(response).await);
        }
        let mut stream = response.bytes_stream();
        let mut buf = String::new();
        let mut assistant = String::new();
        let mut persons = super::gen_ui::PersonsText::default();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| OpenGrokError::transport(&e))?;
            // Every frame decoded from one delivery shares its arrival boundary. Parsing time
            // is not tool time, and buffered END/RESULT pairs cannot be measured individually.
            let arrived_at = std::time::Instant::now();
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = buf.find("\n\n") {
                let frame = buf[..idx].to_string();
                buf = buf[idx + 2..].to_string();
                for line in frame.lines() {
                    let Some(data) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let data = data.trim();
                    if data.is_empty() || data == "[DONE]" {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                        continue;
                    };
                    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if kind == "RUN_ERROR" {
                        return Err(Self::run_ended_badly(&value));
                    }
                    // The person's own words, if a stream ever carries them, are not the reply.
                    let persons = kind.starts_with("TEXT_MESSAGE") && persons.is_persons(&value);
                    if !persons
                        && (kind == "TEXT_MESSAGE_CONTENT" || kind == "TEXT_MESSAGE_CHUNK")
                        && let Some(delta) = value.get("delta").and_then(|v| v.as_str())
                    {
                        assistant.push_str(delta);
                    }
                    on_event(&value, arrived_at);
                }
            }
        }
        Ok(assistant)
    }

    /// The turn's error from its `RUN_ERROR` frame. The stream itself is a `200`: the run began
    /// and the server ended it badly, and the sentence it ends with is the only thing that says
    /// whether the model refused or the gateway was never reached. A run the person's plan could
    /// not answer names why beside the sentence ([`crate::opengrok::RunErrorCode`]: the Mac
    /// relay's `relay_offline`, `relay_timeout` and `relay_failed`, and `plan_unavailable`), and
    /// that code is what offers the turn again on the server's keys. Apart from the stream so the
    /// wire conformance tests read a recorded frame with this very code.
    pub(super) fn run_ended_badly(frame: &Value) -> OpenGrokError {
        let message = frame
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("run failed");
        let code = frame
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string);
        OpenGrokError::from_server(None, message).with_code(code)
    }

    /// `POST /ag-ui`'s 202, `{v, id, heldFor, message, event}`: the queued send this turn fired
    /// is one the person's Mac would carry, and no Mac holds the relay, so the server left it
    /// queued and started no run (opengrok-server main cad36fd (#303, after #298), pin 47a5d6b:
    /// `consume_for_turn` in
    /// `crates/opengrok-server/src/agui/pending.rs`). It sends the send itself when a Mac opens
    /// the relay. Read as the turn not starting: the server's sentence, its `heldFor` word as the
    /// code ([`OpenGrokError::is_held_for_mac`]), and the row as it now stands as the queue's
    /// CUSTOM. Apart from the response so the wire conformance tests read the recorded answer
    /// with this very code.
    pub(super) fn turn_held(body: &str) -> OpenGrokError {
        let body: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let said = |key: &str| body.get(key).and_then(Value::as_str).map(str::to_string);
        OpenGrokError::from_opengrok(202, said("message").unwrap_or_default())
            .with_code(said("heldFor"))
            .with_pending_event(body.get("event").cloned())
    }

    pub async fn answer_run(
        &self,
        run_id: &str,
        call_id: &str,
        approved: bool,
    ) -> Result<AnswerReply, OpenGrokError> {
        let path = format!("/ag-ui/runs/{run_id}/answer");
        let body = json!({ "call_id": call_id, "approved": approved });
        let response = self
            .send_json(reqwest::Method::POST, &path, Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    /// Fill the box page from the in-chat card. Account bearer. Not
    /// `/ag-ui/runs/{id}/answer` and not `submitSecret`. `entryId` is the
    /// gateway card id — an empty id is not sent as `callId`.
    pub async fn submit_user_form(
        &self,
        entry_id: &str,
        agent_id: &str,
        values: &super::user_form::UserFormValues,
        saved_login: bool,
        saved_login_id: Option<&str>,
    ) -> Result<super::user_form::UserFormActionReply, OpenGrokError> {
        if entry_id.trim().is_empty() {
            return Ok(super::user_form::UserFormActionReply::MissingEntryId);
        }
        let body = super::user_form::submit_request_body_for(
            entry_id,
            agent_id,
            values,
            saved_login,
            saved_login_id,
        );
        let response = self
            .send_json(
                reqwest::Method::POST,
                super::user_form::USER_FORM_SUBMIT_PATH,
                Some(&body),
            )
            .await?;
        Self::user_form_action_response(response).await
    }

    /// Dismiss or escalate the card. `mode` is `dismissed` or `escalated`
    /// (Open the screen). Same `entryId` rule as submit.
    pub async fn dismiss_user_form(
        &self,
        entry_id: &str,
        agent_id: &str,
        mode: super::user_form::UserFormDismissMode,
    ) -> Result<super::user_form::UserFormActionReply, OpenGrokError> {
        if entry_id.trim().is_empty() {
            return Ok(super::user_form::UserFormActionReply::MissingEntryId);
        }
        let body = super::user_form::dismiss_request_body(entry_id, agent_id, mode);
        let response = self
            .send_json(
                reqwest::Method::POST,
                super::user_form::USER_FORM_DISMISS_PATH,
                Some(&body),
            )
            .await?;
        Self::user_form_action_response(response).await
    }

    /// Hand back / decline / timeout. `entry_id` is dismiss `handoffEntryId`
    /// (sibling Computer card). Never the form gateway id.
    pub async fn resolve_box_handoff(
        &self,
        handoff_entry_id: &str,
        agent_id: &str,
        resolution: super::user_form::BoxHandoffResolution,
    ) -> Result<super::user_form::BoxHandoffReply, OpenGrokError> {
        if handoff_entry_id.trim().is_empty() {
            return Ok(super::user_form::BoxHandoffReply::MissingEntryId);
        }
        let body =
            super::user_form::resolve_handoff_request_body(handoff_entry_id, agent_id, resolution);
        let response = self
            .send_json(
                reqwest::Method::POST,
                super::user_form::BOX_HANDOFF_RESOLVE_PATH,
                Some(&body),
            )
            .await?;
        Self::box_handoff_action_response(response).await
    }

    async fn user_form_action_response(
        response: reqwest::Response,
    ) -> Result<super::user_form::UserFormActionReply, OpenGrokError> {
        let status = response.status().as_u16();
        let text = response
            .text()
            .await
            .map_err(|e| OpenGrokError::transport(&e))?;
        let value: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        if status == 404 || status == 403 {
            return Ok(super::user_form::user_form_action_from_http(status, &value));
        }
        if !(200..300).contains(&status) {
            return Err(Self::refusal(status, &text));
        }
        Ok(super::user_form::user_form_action_from_http(status, &value))
    }

    async fn box_handoff_action_response(
        response: reqwest::Response,
    ) -> Result<super::user_form::BoxHandoffReply, OpenGrokError> {
        let status = response.status().as_u16();
        let text = response
            .text()
            .await
            .map_err(|e| OpenGrokError::transport(&e))?;
        let value: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        if status == 404 {
            return Ok(super::user_form::box_handoff_action_from_http(
                status, &value,
            ));
        }
        if !(200..300).contains(&status) {
            return Err(Self::refusal(status, &text));
        }
        Ok(super::user_form::box_handoff_action_from_http(
            status, &value,
        ))
    }

    /// The host's settings record, on the AG-UI door: `GET /ag-ui/host-settings`, with
    /// `egressTunnelAvailable` for the coworker named — host intent AND that coworker's box
    /// advertising the tunnel. Ordinary account auth, like every other AG-UI call; the desktop
    /// client's `POST /api/{method}` door this once went through is closing with that client.
    pub async fn host_settings(&self, coworker: Option<&str>) -> Result<Value, OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::GET, &host_settings_path(coworker), None)
            .await?;
        Self::json_or_error(response).await
    }

    /// A partial record, merged on the host key by key; the whole record comes back, with the
    /// same `egressTunnelAvailable` the GET carries.
    pub async fn patch_host_settings(
        &self,
        coworker: Option<&str>,
        patch: &Value,
    ) -> Result<Value, OpenGrokError> {
        let response = self
            .send_json(
                reqwest::Method::PUT,
                &host_settings_path(coworker),
                Some(patch),
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// Stop a run that is still going.
    ///
    /// The turn is not the app's to abandon. A run drives a box — it opens pages and types into
    /// them — and closing the stream here would only stop the app watching it do that, which is
    /// the difference between a stop and looking away. So "stop" is a thing said to the server,
    /// and this is the saying of it.
    ///
    /// Idempotent by the route's own contract: stopping a run that has already ended answers as
    /// a success, so nothing has to be checked about the run before asking. A `404` is a run the
    /// server has never heard of or one belonging to somebody else, which from here means the
    /// same thing — there is nothing of ours left running under that id.
    pub async fn stop_run(&self, run_id: &str) -> Result<StopReply, OpenGrokError> {
        let path = format!("/ag-ui/runs/{run_id}/stop");
        let response = self
            .send_json::<()>(reqwest::Method::POST, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn replay_run(&self, run_id: &str) -> Result<RunReplay, OpenGrokError> {
        let path = format!("/ag-ui/runs/{run_id}");
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// Every run this thread has, oldest first, with the frames each one emitted.
    ///
    /// This is the thread as the server has it, which is the only copy that survives the app
    /// being closed. `limit` is not politeness: a run carries every frame it emitted and a
    /// computer-use run's frames carry screenshots, so asking for a whole thread's history is
    /// asking for megabytes. Only the newest runs can disagree with what is already on disk.
    pub async fn replay_thread(
        &self,
        thread_id: &str,
        limit: usize,
    ) -> Result<ThreadReplay, OpenGrokError> {
        let path = format!("/ag-ui/threads/{}?limit={limit}", path_segment(thread_id));
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// One page of the account's conversations, newest first, from `GET /ag-ui/threads`.
    ///
    /// Nothing here names the account: the server lists whoever the bearer belongs to. Nothing
    /// asks for one coworker either (`coworkerId`), because the sidebar wants every thread.
    ///
    /// The next page is keyed by the last row of this one: its `updatedAtMs` as `before` and its
    /// `threadId` as `beforeThreadId`, since a page can end partway through a millisecond. A
    /// thread id with no time is a `400` on the server, and one refused here costs no round trip.
    /// `None` for `limit` takes the server's page size, and the server caps whatever is asked.
    ///
    /// An empty list is an answer, from an account with no history yet.
    pub async fn list_threads(
        &self,
        before: Option<i64>,
        before_thread_id: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<ThreadListing>, OpenGrokError> {
        if before_thread_id.is_some() && before.is_none() {
            return Err(OpenGrokError::message("beforeThreadId needs before"));
        }
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        if let Some(limit) = limit {
            query.append_pair("limit", &limit.to_string());
        }
        if let Some(before) = before {
            query.append_pair("before", &before.to_string());
        }
        // Encoded, because it is the server's id handed back and nothing here chose its letters.
        if let Some(thread_id) = before_thread_id {
            query.append_pair("beforeThreadId", thread_id);
        }
        let query = query.finish();
        let path = if query.is_empty() {
            "/ag-ui/threads".to_string()
        } else {
            format!("/ag-ui/threads?{query}")
        };
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// Live follow-ups on this thread, oldest first.
    ///
    /// A 404 is either an OpenGrok that has not shipped the store yet, or a thread this
    /// account has never run — same status the server uses so a pending id is not a probe.
    /// Callers keep the local queue.
    pub async fn list_pending_user_messages(
        &self,
        thread_id: &str,
    ) -> Result<PendingList, OpenGrokError> {
        let path = format!("/ag-ui/threads/{}/pending", path_segment(thread_id));
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// Hold a follow-up on the server until the thread is idle. Idempotent on
    /// `clientMessageId`: a retry returns the existing pending row. `409 already-consumed`
    /// means that bubble already became a run. The CUSTOM is `op: created`.
    pub async fn enqueue_pending_user_message(
        &self,
        thread_id: &str,
        body: &PendingWrite,
    ) -> Result<PendingMutation, OpenGrokError> {
        let path = format!("/ag-ui/threads/{}/pending", path_segment(thread_id));
        let response = self
            .send_json(reqwest::Method::POST, &path, Some(body))
            .await?;
        Self::json_or_error(response).await
    }

    /// Change a live follow-up's words. `404` means it is no longer this account's pending
    /// row — drained, canceled, or somebody else's. The CUSTOM is `op: edited`.
    pub async fn edit_pending_user_message(
        &self,
        thread_id: &str,
        pending_id: &str,
        body: &PendingWrite,
    ) -> Result<PendingMutation, OpenGrokError> {
        let path = format!(
            "/ag-ui/threads/{}/pending/{}",
            path_segment(thread_id),
            path_segment(pending_id)
        );
        let response = self
            .send_json(reqwest::Method::PATCH, &path, Some(body))
            .await?;
        Self::json_or_error(response).await
    }

    /// Take a follow-up back so it never becomes a run. Idempotent: drained, already
    /// canceled, and never-heard-of ids on a thread this account owns are the same 200.
    /// The CUSTOM is `op: canceled` and omits `message`.
    pub async fn cancel_pending_user_message(
        &self,
        thread_id: &str,
        pending_id: &str,
    ) -> Result<PendingMutation, OpenGrokError> {
        let path = format!(
            "/ag-ui/threads/{}/pending/{}",
            path_segment(thread_id),
            path_segment(pending_id)
        );
        let response = self
            .send_json::<()>(reqwest::Method::DELETE, &path, None)
            .await?;
        if !response.status().is_success() {
            return Err(Self::read_error(response).await);
        }
        match response.json::<PendingMutation>().await {
            Ok(mutation) => Ok(mutation),
            Err(_) => Ok(PendingMutation {
                v: 1,
                thread_id: thread_id.to_string(),
                pending_user_message: None,
                event: None,
            }),
        }
    }

    /// Hide a turn for this account, on every machine it signs in from.
    ///
    /// Nothing is destroyed: the run keeps its frames and the coworker keeps its memory of the
    /// turn. The server simply stops offering it, here and everywhere else.
    pub async fn hide_run(&self, run_id: &str) -> Result<(), OpenGrokError> {
        let path = format!("/ag-ui/runs/{run_id}/hide");
        let response = self
            .send_json::<()>(reqwest::Method::POST, &path, None)
            .await?;
        Self::empty_or_error(response).await
    }

    pub async fn list_approvals(&self) -> Result<Vec<QueuedApproval>, OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::GET, "/ag-ui/approvals", None)
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn list_computers(&self) -> Result<Vec<ConnectedComputer>, OpenGrokError> {
        let machines = self.list_daemons().await?;
        let mut computers = Vec::new();
        for machine in machines {
            if machine.revoked {
                continue;
            }
            let stored = self
                .local_exec_mode(&machine.machine_id)
                .await
                .unwrap_or_default();
            let label = if machine.label.trim().is_empty() {
                "Computer".to_string()
            } else {
                machine.label
            };
            computers.push(ConnectedComputer {
                machine_id: machine.machine_id,
                label,
                mode: LocalExecMode::from_stored(&stored),
                this_machine: false,
                online: machine.connected,
                relay_enabled: machine.relay_enabled,
                relaying: machine.relaying,
                folded: Vec::new(),
            });
        }
        Ok(collapse_computers_by_machine_id(computers))
    }

    pub async fn list_daemons(&self) -> Result<Vec<DaemonMachine>, OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::GET, "/local-exec/daemon", None)
            .await?;
        let body: DaemonList = Self::json_or_error(response).await?;
        Ok(body.machines)
    }

    /// `PATCH /local-exec/daemon/{machine_id}` `{relayEnabled}`: one computer's own relay switch,
    /// answered with its row (opengrok-server #342 (main 2136ffc): `switch_relay` in
    /// `crates/opengrok-server/src/local_exec.rs`, recorded in `fixtures/wire/`). It names only the
    /// caller's own computers, from any computer of the
    /// account. The server refuses in `{error, code}`, and nothing is switched: `404 not_found`
    /// ("no computer of yours has that id", the same for another account's computer as for an id
    /// nobody enrolled), `409 revoked` ("this computer was revoked; enrol it again to use it") and
    /// `400 bad_request` ("relayEnabled must be true or false"). Switched off, the computer's open
    /// relay stream is sent `disabled` and closed (`super::relay`).
    pub async fn switch_computer_relay(
        &self,
        machine_id: &str,
        on: bool,
    ) -> Result<DaemonMachine, OpenGrokError> {
        let path = format!("/local-exec/daemon/{}", path_segment(machine_id));
        let response = self
            .send_json(
                reqwest::Method::PATCH,
                &path,
                Some(&json!({ "relayEnabled": on })),
            )
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn coworker_computer(
        &self,
        coworker_id: &str,
    ) -> Result<CoworkerComputer, OpenGrokError> {
        let path = format!("/coworkers/{coworker_id}/computer");
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// `GET /coworkers/{id}/usage?window=` — what the bot used in `window`, per model (#138). The
    /// Usage card asks for the month, the server's own default, and the Usage modal for any of
    /// its chips' windows.
    pub async fn coworker_usage(
        &self,
        coworker_id: &str,
        window: UsageWindow,
    ) -> Result<CoworkerUsage, OpenGrokError> {
        let path = format!(
            "/coworkers/{}/usage?window={}",
            path_segment(coworker_id),
            window.word()
        );
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// `GET /coworkers/{id}/tools` — exactly what the model is offered on this bot's next turn,
    /// assembled from its grant, its computer and its plugins, under its ceiling. The app changes
    /// the ceiling ([`Self::set_coworker_ceiling`]) and only ever reads this, since what comes of
    /// a change is the server's to work out.
    pub async fn coworker_tools(
        &self,
        coworker_id: &str,
    ) -> Result<Vec<CoworkerTool>, OpenGrokError> {
        let path = format!("/coworkers/{}/tools", path_segment(coworker_id));
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        let listing: ToolListing = Self::json_or_error(response).await?;
        Ok(listing.tools)
    }

    /// `GET /connections` — the person's own connections, each with the Bots it is lent to
    /// (opengrok-server#267, `list_connections` in `connections/routes.rs`). Always an array, and
    /// an empty one is an answer: nothing connected yet.
    pub async fn list_connections(&self) -> Result<Vec<ConnectionView>, OpenGrokError> {
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                "/connections",
                None,
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// `POST /connections/{id}/lend` — let a Bot use one of the person's connections without
    /// signing in again. The body is `LendRequest`, snake_case, and the answer is the connection
    /// as `GET /connections` lists it (`mutate` in opengrok-server
    /// `crates/opengrok-server/src/connections/routes.rs`, #267). A 404 ("no such connection") is
    /// a connection that is not this person's or does not exist, and a 409 is the server
    /// refusing the change, each as `{"error": sentence}`.
    ///
    /// `None` is a 2xx whose body is not that row: none at all, or one this app cannot read. The
    /// server took the change all the same, so it is never read as a refusal; the caller reads
    /// the list again rather than guess what the row is now.
    pub async fn lend_connection(
        &self,
        connection_id: &str,
        coworker_id: &str,
    ) -> Result<Option<ConnectionView>, OpenGrokError> {
        let path = format!("/connections/{}/lend", path_segment(connection_id));
        let response = self
            .send_json_within(
                reqwest::Method::POST,
                &path,
                Some(&json!({ "coworker_id": coworker_id })),
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::changed_row(response).await
    }

    /// `POST /connections/{id}/revoke` — take a connection back from a Bot; the same body and the
    /// same answers as [`Self::lend_connection`].
    pub async fn revoke_connection(
        &self,
        connection_id: &str,
        coworker_id: &str,
    ) -> Result<Option<ConnectionView>, OpenGrokError> {
        let path = format!("/connections/{}/revoke", path_segment(connection_id));
        let response = self
            .send_json_within(
                reqwest::Method::POST,
                &path,
                Some(&json!({ "coworker_id": coworker_id })),
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::changed_row(response).await
    }

    /// `PATCH /connections/{id}` with `{"label"}` — what the person calls one of their accounts,
    /// so two accounts of one service can be told apart, answered with the connection as
    /// `GET /connections` lists it (opengrok-server #359 (agreed shape; branch
    /// gol/service-accounts)). A label that is empty or longer than 80 characters is refused with
    /// 422 and the server's sentence, and nothing changes. As with a lend, `None` is a 2xx whose
    /// body is not that row: the change was taken, and the caller reads the list again.
    pub async fn rename_connection(
        &self,
        connection_id: &str,
        label: &str,
    ) -> Result<Option<ConnectionView>, OpenGrokError> {
        let path = format!("/connections/{}", path_segment(connection_id));
        let response = self
            .send_json_within(
                reqwest::Method::PATCH,
                &path,
                Some(&json!({ "label": label })),
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::changed_row(response).await
    }

    /// `GET /connections/pins` — which of the person's accounts each of their Bots uses for each
    /// service (opengrok-server #359 (agreed shape; branch gol/service-accounts)). Always an
    /// array. A Bot with no row for a service has no account picked for it, and asks each time.
    pub async fn list_connection_pins(&self) -> Result<Vec<ConnectionPin>, OpenGrokError> {
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                "/connections/pins",
                None,
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// `PUT /coworkers/{id}/pins/{connector}` with `{"connectionId"}` — the Bot uses this account
    /// for the service, answered with the pin as the list has it (opengrok-server #359 (agreed
    /// shape; branch gol/service-accounts)). An account the server will not pin for this Bot and
    /// service is refused with 422 and its sentence, which the picker shows. `None` is a 2xx
    /// whose body is not a pin: taken all the same, and the caller reads the pins again.
    pub async fn pin_connection(
        &self,
        coworker_id: &str,
        connector: &str,
        connection_id: &str,
    ) -> Result<Option<ConnectionPin>, OpenGrokError> {
        let path = format!(
            "/coworkers/{}/pins/{}",
            path_segment(coworker_id),
            path_segment(connector)
        );
        let response = self
            .send_json_within(
                reqwest::Method::PUT,
                &path,
                Some(&json!({ "connectionId": connection_id })),
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::changed_row(response).await
    }

    /// `DELETE /coworkers/{id}/pins/{connector}` — Ask each time: the Bot has no account picked
    /// for the service any more. The server answers 204 with no body (opengrok-server #359
    /// (agreed shape; branch gol/service-accounts)), and any 2xx is the pin gone.
    pub async fn unpin_connection(
        &self,
        coworker_id: &str,
        connector: &str,
    ) -> Result<(), OpenGrokError> {
        let path = format!(
            "/coworkers/{}/pins/{}",
            path_segment(coworker_id),
            path_segment(connector)
        );
        let response = self
            .send_json_within::<()>(
                reqwest::Method::DELETE,
                &path,
                None,
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::empty_or_error(response).await
    }

    /// `DELETE /connections/{id}` — disconnect it, and every loan goes with it. The server
    /// answers 204 with no body: a disconnected connection is not listed, so there is no row left
    /// to answer with (opengrok-server#267). Any 2xx is the connection gone, whatever its body.
    /// Since opengrok-server #359 (agreed shape; branch gol/service-accounts) the server drops
    /// every pin that named it as well, and those Bots ask each time again.
    pub async fn disconnect_connection(&self, connection_id: &str) -> Result<(), OpenGrokError> {
        let path = format!("/connections/{}", path_segment(connection_id));
        let response = self
            .send_json_within::<()>(
                reqwest::Method::DELETE,
                &path,
                None,
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::empty_or_error(response).await
    }

    /// `GET /plugins/catalog` — the plugin marketplace this server reads (xai-org/plugin-marketplace),
    /// at the registry commit it reads now (opengrok-server `crates/opengrok-plugin-api/src/lib.rs`,
    /// #356/#366). The app never reads the registry itself: what the server will install is the
    /// server's to say, and each entry says why when it will not (`unavailableReason`).
    pub async fn plugin_catalog(&self) -> Result<PluginCatalog, OpenGrokError> {
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                "/plugins/catalog",
                None,
                Some(PLUGINS_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// `GET /plugins/catalog/{name}?revision=` — what one plugin brings, read from its pinned bundle
    /// before anything is installed: its parts (skills, MCP servers, and anything this server will
    /// not run, with why) and the services its accounts are for (`connectors`). Pinned to the
    /// registry commit the marketplace was read at, so the detail is of the plugin Add installs.
    pub async fn plugin_detail(
        &self,
        name: &str,
        revision: &str,
    ) -> Result<PluginDetail, OpenGrokError> {
        let mut path = format!("/plugins/catalog/{}?revision=", path_segment(name));
        path.extend(url::form_urlencoded::byte_serialize(revision.as_bytes()));
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                &path,
                None,
                Some(PLUGINS_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// `GET /plugins/installations` — the person's installed plugins, each pinned to the commit it
    /// was installed at, whether or not the marketplace still lists it.
    pub async fn plugin_installations(&self) -> Result<Vec<PluginInstallation>, OpenGrokError> {
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                "/plugins/installations",
                None,
                Some(PLUGINS_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// `POST /plugins/installations` with `{"name","registryRevision"}` — install the plugin at the
    /// registry commit the person was looking at, never "whatever is newest": a 409 is one already
    /// installed, a 422 a plugin this server will not take, each with the server's sentence. Any 2xx
    /// is installed; the caller reads the installations again rather than trust a reply's shape.
    pub async fn install_plugin(
        &self,
        name: &str,
        registry_revision: &str,
    ) -> Result<(), OpenGrokError> {
        let response = self
            .send_json_within(
                reqwest::Method::POST,
                "/plugins/installations",
                Some(&json!({ "name": name, "registryRevision": registry_revision })),
                Some(PLUGINS_TIMEOUT),
                None,
            )
            .await?;
        Self::empty_or_error(response).await
    }

    /// `DELETE /plugins/installations/{name}` — uninstall it. Its pasted accounts go with it, and
    /// the Bots switch it off. 204 with no body; any 2xx is gone.
    pub async fn uninstall_plugin(&self, name: &str) -> Result<(), OpenGrokError> {
        let path = format!("/plugins/installations/{}", path_segment(name));
        let response = self
            .send_json_within::<()>(
                reqwest::Method::DELETE,
                &path,
                None,
                Some(PLUGINS_TIMEOUT),
                None,
            )
            .await?;
        Self::empty_or_error(response).await
    }

    /// `POST /plugins/installations/{name}/credentials/{connector}` with `{"token"}` — add another
    /// pasted account for an installed plugin's service, always beside any it has (opengrok-server
    /// #359, `add_credential` in `crates/opengrok-plugin-api/src/lib.rs`; uncommitted on
    /// gol/service-accounts). Answered 201 `{"connectionId"}`, the new account's id. The token goes
    /// to the server and nowhere else: the app keeps no copy.
    pub async fn add_plugin_token(
        &self,
        name: &str,
        connector: &str,
        token: &str,
    ) -> Result<String, OpenGrokError> {
        let path = format!(
            "/plugins/installations/{}/credentials/{}",
            path_segment(name),
            path_segment(connector)
        );
        let response = self
            .send_json_within(
                reqwest::Method::POST,
                &path,
                Some(&json!({ "token": token })),
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        let added: AddedToken = Self::json_or_error(response).await?;
        Ok(added.connection_id)
    }

    /// `PUT /plugins/installations/{name}/credentials/{connector}` with `{"token","connectionId"}`
    /// — a new token for THAT pasted account, the Reconnect of a token account (same provenance as
    /// [`Self::add_plugin_token`]). 204; a 404 is no such account of this install's.
    pub async fn replace_plugin_token(
        &self,
        name: &str,
        connector: &str,
        connection_id: &str,
        token: &str,
    ) -> Result<(), OpenGrokError> {
        let path = format!(
            "/plugins/installations/{}/credentials/{}",
            path_segment(name),
            path_segment(connector)
        );
        let response = self
            .send_json_within(
                reqwest::Method::PUT,
                &path,
                Some(&json!({ "token": token, "connectionId": connection_id })),
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::empty_or_error(response).await
    }

    /// `GET /plugins/installations/{name}/connectors/{connector}/sign-in` — how an account of an
    /// installed plugin's service is added: `"oauth"` when its server signs people in itself, so
    /// Add opens the provider's page, and `"token"` when a token is pasted (opengrok-server #364,
    /// `method` in `crates/opengrok-server/src/connections/plugin_signin.rs`; uncommitted on
    /// gol/service-accounts).
    pub async fn plugin_sign_in_method(
        &self,
        name: &str,
        connector: &str,
    ) -> Result<String, OpenGrokError> {
        let path = format!(
            "/plugins/installations/{}/connectors/{}/sign-in",
            path_segment(name),
            path_segment(connector)
        );
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                &path,
                None,
                Some(PLUGINS_TIMEOUT),
                None,
            )
            .await?;
        let method: SignInMethod = Self::json_or_error(response).await?;
        Ok(method.method)
    }

    /// `GET /plugins/installations/{name}/connectors/{connector}/authorize?format=json` — the
    /// provider's consent page for a new account of an installed plugin's service, or with
    /// `connection_id` for that MCP account again (same provenance as
    /// [`Self::plugin_sign_in_method`]). Answered and checked as [`Self::connect_link`] is; the
    /// server starts a sign-in it lists as waiting until the provider sends the person back.
    pub async fn plugin_authorize_link(
        &self,
        name: &str,
        connector: &str,
        connection_id: Option<&str>,
    ) -> Result<String, OpenGrokError> {
        let mut path = format!(
            "/plugins/installations/{}/connectors/{}/authorize?format=json",
            path_segment(name),
            path_segment(connector)
        );
        if let Some(id) = connection_id {
            path.push_str("&connection_id=");
            path.extend(url::form_urlencoded::byte_serialize(id.as_bytes()));
        }
        self.sign_in_link(&path).await
    }

    /// `GET /connections/attempts` — the person's sign-ins that have not finished: an account they
    /// asked to add that the service has not connected yet, or refused (opengrok-server #359,
    /// `list_attempts` in `crates/opengrok-server/src/connections/routes.rs`; uncommitted on
    /// gol/service-accounts). What the app shows as Needs Auth. Always an array.
    pub async fn connection_attempts(&self) -> Result<Vec<ConnectionAttempt>, OpenGrokError> {
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                "/connections/attempts",
                None,
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// `GET /connections/attempts/{id}/reopen?format=json` — the sign-in page for THAT unfinished
    /// sign-in, so finishing it adds the account the person saw waiting, under its label, and no
    /// second row appears. Answered and checked as [`Self::connect_link`] is.
    pub async fn reopen_link(&self, attempt_id: &str) -> Result<String, OpenGrokError> {
        let path = format!(
            "/connections/attempts/{}/reopen?format=json",
            path_segment(attempt_id)
        );
        self.sign_in_link(&path).await
    }

    /// `PATCH /connections/attempts/{id}` with `{"label"}` — rename a sign-in before it finishes,
    /// by the rule an account is renamed by (422 with the server's sentence for an empty or
    /// too-long label). `None` is a 2xx whose body is not that row.
    pub async fn rename_attempt(
        &self,
        attempt_id: &str,
        label: &str,
    ) -> Result<Option<ConnectionAttempt>, OpenGrokError> {
        let path = format!("/connections/attempts/{}", path_segment(attempt_id));
        let response = self
            .send_json_within(
                reqwest::Method::PATCH,
                &path,
                Some(&json!({ "label": label })),
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::changed_row(response).await
    }

    /// `DELETE /connections/attempts/{id}` — give up on a sign-in. 204.
    pub async fn dismiss_attempt(&self, attempt_id: &str) -> Result<(), OpenGrokError> {
        let path = format!("/connections/attempts/{}", path_segment(attempt_id));
        let response = self
            .send_json_within::<()>(
                reqwest::Method::DELETE,
                &path,
                None,
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::empty_or_error(response).await
    }

    /// A lend's, a revoke's, a rename's or a pin's answer: the row when the body is one, `None`
    /// for any other 2xx, and the server's refusal otherwise. A 2xx is the change taken, and a
    /// body that is empty, unreadable or cut short does not undo that.
    async fn changed_row<T: serde::de::DeserializeOwned>(
        response: reqwest::Response,
    ) -> Result<Option<T>, OpenGrokError> {
        if !response.status().is_success() {
            return Err(Self::read_error(response).await);
        }
        let body = response.text().await.unwrap_or_default();
        Ok(serde_json::from_str(&body).ok())
    }

    /// `GET /connectors` — the services this server is configured to connect (opengrok-server
    /// #269, as agreed). An empty list is a server that offers none.
    pub async fn list_connectors(&self) -> Result<Vec<Connector>, OpenGrokError> {
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                "/connectors",
                None,
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error(response).await
    }

    /// `GET /connections/{connector}/authorize?format=json` — the service's sign-in page, for the
    /// person's browser (opengrok-server#269, as agreed). The route wants the bearer, which a
    /// browser cannot send, so the app asks for the page and opens it; the browser comes back to
    /// the server's callback, never to the app, and no token ever reaches the app. `coworker_id`
    /// makes the connection that Bot's own rather than the person's. Since opengrok-server #359
    /// (agreed shape; branch gol/service-accounts) a sign-in through it always adds an account,
    /// beside any the person has of the service already, rather than replacing one.
    ///
    /// Only a web address is handed back, and only as it was read: the address the check passed
    /// is the address opened. The system opens a file or another program for any other kind of
    /// link just as readily, and the server's own text, with whatever surrounds it, is not what
    /// was checked.
    pub async fn connect_link(
        &self,
        connector: &str,
        coworker_id: Option<&str>,
    ) -> Result<String, OpenGrokError> {
        let mut path = format!(
            "/connections/{}/authorize?format=json",
            path_segment(connector)
        );
        if let Some(coworker_id) = coworker_id {
            path.push_str("&coworker_id=");
            path.extend(url::form_urlencoded::byte_serialize(coworker_id.as_bytes()));
        }
        self.sign_in_link(&path).await
    }

    /// `GET /connections/{id}/reconnect?format=json` — the sign-in page for one of the person's
    /// accounts, to sign that same account in again rather than add another (opengrok-server
    /// #359 (agreed shape; branch gol/service-accounts)). Answered in [`ConnectLink`]'s shape, as
    /// [`Self::connect_link`] is, and checked the same way before anything opens. `coworker_id`
    /// names the Bot whose own account it is, as it does for a Connect.
    pub async fn reconnect_link(
        &self,
        connection_id: &str,
        coworker_id: Option<&str>,
    ) -> Result<String, OpenGrokError> {
        let mut path = format!(
            "/connections/{}/reconnect?format=json",
            path_segment(connection_id)
        );
        if let Some(coworker_id) = coworker_id {
            path.push_str("&coworker_id=");
            path.extend(url::form_urlencoded::byte_serialize(coworker_id.as_bytes()));
        }
        self.sign_in_link(&path).await
    }

    /// Ask for a sign-in page at `path` and hand back its address, only if it is a web address.
    async fn sign_in_link(&self, path: &str) -> Result<String, OpenGrokError> {
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                path,
                None,
                Some(CONNECTIONS_TIMEOUT),
                None,
            )
            .await?;
        let link: ConnectLink = Self::json_or_error(response).await?;
        match Url::parse(&link.url) {
            Ok(url) if matches!(url.scheme(), "https" | "http") => Ok(url.to_string()),
            _ => Err(OpenGrokError::message(
                "the server's sign-in link is not a web address",
            )),
        }
    }

    /// `GET /coworkers/{id}/ceiling` — every tool the server has and every plugin it knows, and
    /// which of them this bot may be offered at all (opengrok-server#268). Owner only: anybody
    /// else is answered 404, `{"error": "no such coworker"}`, which a server without the route
    /// never writes (its 404 is empty). Given [`CEILING_TIMEOUT`].
    pub async fn coworker_ceiling(
        &self,
        coworker_id: &str,
    ) -> Result<CoworkerCeiling, OpenGrokError> {
        self.ceiling_within(reqwest::Method::GET, coworker_id, None, CEILING_TIMEOUT)
            .await
    }

    /// `PUT /coworkers/{id}/ceiling` with `{"enabled": [names], "version": n}` — the whole
    /// ceiling, replaced by exactly these, answered with the body `GET` gives
    /// (opengrok-server#268). An empty list is allowed and allows nothing.
    ///
    /// `version` is the one the rows the change was built from came with, and it is left out
    /// when they came with none, as an older server sends them. The server checks it and writes
    /// in one step: a ceiling changed since answers 409 with the code `ceiling-changed`
    /// ([`OpenGrokError::is_ceiling_changed`]), and nothing is written.
    ///
    /// A name the server does not list is refused with 422 and its sentence, and nothing changes.
    /// Every builtin it lists may be named, whether or not it can be offered now: the ceiling
    /// records what the owner allows, and `user_machine_shell` is offered the day a machine can
    /// run it. A plugin the server no longer loads is listed only while it is on, so it may be
    /// named to keep it and never to switch it back on. Given [`CEILING_TIMEOUT`].
    pub async fn set_coworker_ceiling(
        &self,
        coworker_id: &str,
        enabled: &[String],
        version: Option<i64>,
    ) -> Result<CoworkerCeiling, OpenGrokError> {
        let mut body = json!({ "enabled": enabled });
        if let Some(version) = version {
            body["version"] = json!(version);
        }
        self.ceiling_within(
            reqwest::Method::PUT,
            coworker_id,
            Some(&body),
            CEILING_TIMEOUT,
        )
        .await
    }

    /// `PUT /coworkers/{id}/tool-mode` `{tool, mode}`: one tool's choice for this Bot, `always`,
    /// `ask` or `never` (opengrok-server `put_tool_mode` in `crates/opengrok-server/src/agui/
    /// ceiling.rs`, gol/tools-and-skill-packs, uncommitted). `tool` is a built-in's name or a
    /// plugin tool's dotted name. A refusal comes back as its sentence.
    pub async fn set_tool_mode(
        &self,
        coworker_id: &str,
        tool: &str,
        mode: &str,
    ) -> Result<(), OpenGrokError> {
        let path = format!("/coworkers/{}/tool-mode", path_segment(coworker_id));
        let body = json!({ "tool": tool, "mode": mode });
        let response = self
            .send_json_within(
                reqwest::Method::PUT,
                &path,
                Some(&body),
                Some(CEILING_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error::<Value>(response).await.map(|_| ())
    }

    /// `GET /site-logins/{id}/bots`: the person's Bots this saved login is shared with
    /// (opengrok-server `login_bots` in `crates/opengrok-server/src/agui/site_logins.rs`,
    /// gol/tools-and-skill-packs).
    pub async fn site_login_bots(&self, login_id: &str) -> Result<Vec<String>, OpenGrokError> {
        #[derive(Deserialize)]
        struct Bots {
            bots: Vec<String>,
        }
        let path = format!("/site-logins/{}/bots", path_segment(login_id));
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                &path,
                None,
                Some(CEILING_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error::<Bots>(response).await.map(|b| b.bots)
    }

    /// `PUT /site-logins/{id}/bots/{coworker}` `{shared}`: one Bot may use this login, or no
    /// longer (`share_with_bot`, same file). A share is a permission; the secret is not copied.
    pub async fn set_site_login_shared(
        &self,
        login_id: &str,
        coworker_id: &str,
        shared: bool,
    ) -> Result<(), OpenGrokError> {
        let path = format!(
            "/site-logins/{}/bots/{}",
            path_segment(login_id),
            path_segment(coworker_id)
        );
        let body = json!({ "shared": shared });
        let response = self
            .send_json_within(
                reqwest::Method::PUT,
                &path,
                Some(&body),
                Some(CEILING_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error::<Value>(response).await.map(|_| ())
    }

    /// `GET /coworkers/{id}/site-logins`: the person's logins this Bot may use, for its login
    /// cards (`shared_with_bot`, same file).
    pub async fn logins_shared_with(
        &self,
        coworker_id: &str,
    ) -> Result<Vec<String>, OpenGrokError> {
        #[derive(Deserialize)]
        struct Logins {
            logins: Vec<String>,
        }
        let path = format!("/coworkers/{}/site-logins", path_segment(coworker_id));
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                &path,
                None,
                Some(CEILING_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error::<Logins>(response)
            .await
            .map(|l| l.logins)
    }

    /// `GET /coworkers/{id}/saved-login`: whether a saved login can be used for this Bot, asked
    /// before Touch ID (opengrok-server `get_saved_login`, `agui/ceiling.rs`).
    pub async fn saved_login_check(
        &self,
        coworker_id: &str,
    ) -> Result<SavedLoginCheck, OpenGrokError> {
        let path = format!("/coworkers/{}/saved-login", path_segment(coworker_id));
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                &path,
                None,
                Some(CEILING_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error::<SavedLoginCheck>(response).await
    }

    /// `GET /site-logins/sharing`: whether every saved login is shared with every one of the
    /// person's Bots (opengrok-server `sharing` in `crates/opengrok-server/src/agui/
    /// site_logins.rs`, gol/global-login-share).
    pub async fn logins_for_all_bots(&self) -> Result<bool, OpenGrokError> {
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                "/site-logins/sharing",
                None,
                Some(CEILING_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error::<AllBots>(response)
            .await
            .map(|a| a.all_bots)
    }

    /// `PUT /site-logins/sharing` `{allBots}` (`set_sharing`, same file): the switch, answered
    /// with what the server now holds.
    pub async fn set_logins_for_all_bots(&self, all: bool) -> Result<bool, OpenGrokError> {
        let body = json!({ "allBots": all });
        let response = self
            .send_json_within(
                reqwest::Method::PUT,
                "/site-logins/sharing",
                Some(&body),
                Some(CEILING_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error::<AllBots>(response)
            .await
            .map(|a| a.all_bots)
    }

    /// `PUT /coworkers/{id}/own-computer` `{on}`: this Bot gets a computer of its own while the
    /// account's others keep sharing (opengrok-server `put_own_computer`, `agui/ceiling.rs`).
    /// Making the computer can take a while, so it is given the computer's own patience.
    pub async fn set_own_computer(&self, coworker_id: &str, on: bool) -> Result<(), OpenGrokError> {
        let path = format!("/coworkers/{}/own-computer", path_segment(coworker_id));
        let body = json!({ "on": on });
        let response = self
            .send_json_within(
                reqwest::Method::PUT,
                &path,
                Some(&body),
                Some(std::time::Duration::from_secs(180)),
                None,
            )
            .await?;
        Self::json_or_error::<Value>(response).await.map(|_| ())
    }

    /// `GET /coworkers/{id}/plugin-skills`: every installed plugin's skills with their switch for
    /// this Bot (opengrok-server `list_plugin_skills` in `crates/opengrok-server/src/agui/
    /// ceiling.rs`, gol/tools-and-skill-packs, uncommitted).
    pub async fn plugin_skills(
        &self,
        coworker_id: &str,
    ) -> Result<Vec<PluginSkill>, OpenGrokError> {
        #[derive(Deserialize)]
        struct Listed {
            skills: Vec<PluginSkill>,
        }
        let path = format!("/coworkers/{}/plugin-skills", path_segment(coworker_id));
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                &path,
                None,
                Some(CEILING_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error::<Listed>(response)
            .await
            .map(|l| l.skills)
    }

    /// `GET /coworkers/{id}/plugin-skills/{plugin}/{skill}`: one plugin skill with its text, for
    /// its read-only page (`get_plugin_skill`, same file).
    pub async fn plugin_skill(
        &self,
        coworker_id: &str,
        plugin: &str,
        skill: &str,
    ) -> Result<PluginSkill, OpenGrokError> {
        let path = format!(
            "/coworkers/{}/plugin-skills/{}/{}",
            path_segment(coworker_id),
            path_segment(plugin),
            path_segment(skill)
        );
        let response = self
            .send_json_within::<()>(
                reqwest::Method::GET,
                &path,
                None,
                Some(CEILING_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error::<PluginSkill>(response).await
    }

    /// `PUT /coworkers/{id}/plugin-skills` `{plugin, skill, on}`: one plugin skill on or off for
    /// this Bot, the rest of its plugin untouched (`put_plugin_skill`, same file).
    pub async fn set_plugin_skill(
        &self,
        coworker_id: &str,
        plugin: &str,
        skill: &str,
        on: bool,
    ) -> Result<(), OpenGrokError> {
        let path = format!("/coworkers/{}/plugin-skills", path_segment(coworker_id));
        let body = json!({ "plugin": plugin, "skill": skill, "on": on });
        let response = self
            .send_json_within(
                reqwest::Method::PUT,
                &path,
                Some(&body),
                Some(CEILING_TIMEOUT),
                None,
            )
            .await?;
        Self::json_or_error::<Value>(response).await.map(|_| ())
    }

    /// A read or a write of a bot's ceiling, given `timeout` to answer in. Apart from the two
    /// routes so a test can hold one to a deadline it can wait out.
    pub(crate) async fn ceiling_within(
        &self,
        method: reqwest::Method,
        coworker_id: &str,
        body: Option<&Value>,
        timeout: std::time::Duration,
    ) -> Result<CoworkerCeiling, OpenGrokError> {
        let path = format!("/coworkers/{}/ceiling", path_segment(coworker_id));
        let response = self
            .send_json_within(method, &path, body, Some(timeout), None)
            .await?;
        Self::json_or_error(response).await
    }

    /// `GET /coworkers/{id}/skills` — every skill of the account's library this bot's owner may
    /// use, and which of them are attached to it (opengrok-server#270). Owner only, as the
    /// ceiling is: anybody else is answered 404, `{"error": "no such coworker"}`, which a server
    /// without the route never writes (its 404 is empty), and an owner whose grant was withdrawn
    /// is answered 403 in words. Given [`CEILING_TIMEOUT`], for the ceiling's reason: a switch on
    /// the Skills card holds every other one until it is answered.
    pub async fn coworker_skills(
        &self,
        coworker_id: &str,
    ) -> Result<CoworkerSkills, OpenGrokError> {
        self.skills_within(reqwest::Method::GET, coworker_id, None, CEILING_TIMEOUT)
            .await
    }

    /// `PUT /coworkers/{id}/skills` with `{"attached": [ids], "version": n}` — the whole attached
    /// set, replaced by exactly these, answered with the body `GET` gives (opengrok-server#270).
    /// An empty list is allowed and attaches nothing.
    ///
    /// `version` is the one the rows the change was built from came with, and it is left out
    /// when they came with none. A set somebody changed since is refused with 409 and the code
    /// `skills-changed` ([`OpenGrokError::is_skills_changed`]); an id that is not one of the rows
    /// with 422 (`no skill …`), and a set past the server's cap of 20 with 422 and its sentence
    /// (`a coworker takes at most 20 skills, and this is {n}`).
    /// Nothing is written on any of them. A skill switched off is still one of the rows, so naming
    /// it keeps it attached and leaving it out detaches it. Given [`CEILING_TIMEOUT`].
    pub async fn set_coworker_skills(
        &self,
        coworker_id: &str,
        attached: &[String],
        version: Option<i64>,
    ) -> Result<CoworkerSkills, OpenGrokError> {
        let mut body = json!({ "attached": attached });
        if let Some(version) = version {
            body["version"] = json!(version);
        }
        self.skills_within(
            reqwest::Method::PUT,
            coworker_id,
            Some(&body),
            CEILING_TIMEOUT,
        )
        .await
    }

    /// A read or a write of a bot's skills, given `timeout` to answer in. Apart from the two
    /// routes so a test can hold one to a deadline it can wait out.
    pub(crate) async fn skills_within(
        &self,
        method: reqwest::Method,
        coworker_id: &str,
        body: Option<&Value>,
        timeout: std::time::Duration,
    ) -> Result<CoworkerSkills, OpenGrokError> {
        let path = format!("/coworkers/{}/skills", path_segment(coworker_id));
        let response = self
            .send_json_within(method, &path, body, Some(timeout), None)
            .await?;
        Self::json_or_error(response).await
    }

    /// `POST /artifacts` for a file the person attaches to a message (#90): the bytes go up first,
    /// and the message then names the returned `art_` id. `threadId` is the conversation's own
    /// thread, the one `POST /ag-ui` sends. Transcribed from opengrok-server `artifacts.rs`
    /// `create` (the body) and #259, merged at 68ace2e (`kind: "attachment"`; image, video, PDF and text accepted,
    /// 25 MiB at most, a 400 or 413 with a sentence otherwise).
    pub async fn upload_attachment(
        &self,
        thread_id: &str,
        filename: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<crate::opengrok::Attachment, OpenGrokError> {
        use base64::Engine as _;
        // Over the server's cap the body is refused before its handler runs, with the web
        // framework's words or a dropped connection rather than the server's sentence: say the
        // sentence here, before a large file is encoded at all.
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(OpenGrokError::from_server(
                Some(413),
                "artifacts must be under 25 MiB",
            ));
        }
        let body = json!({
            "kind": "attachment",
            "mime": upload_mime(mime),
            "filename": upload_filename(filename),
            "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "threadId": thread_id,
        });
        let response = self
            .send_json(reqwest::Method::POST, "/artifacts", Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    /// `GET /artifacts?threadId=` — the files sent on a thread, and which message each rode on
    /// (opengrok-server#259 `list_for_thread`). A replay draws them from this: the replayed
    /// frames carry a message's words, not its files. A file uploaded and never sent is left out.
    pub async fn sent_attachments(
        &self,
        thread_id: &str,
    ) -> Result<Vec<crate::opengrok::SentAttachment>, OpenGrokError> {
        let path = format!("/artifacts?threadId={}", path_segment(thread_id));
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        let rows: Vec<crate::opengrok::types::ArtifactListing> =
            Self::json_or_error(response).await?;
        Ok(rows.into_iter().filter_map(|row| row.sent()).collect())
    }

    /// The coworker's screen right now: `{mime, base64, width, height, visibility?}`,
    /// the same shape as `TOOL_CALL_RESULT.image`. `GET /coworkers/{id}/screen`
    /// is the `transcript` observe pin; `ScreenshotSpec::from_frame` decodes both.
    pub async fn coworker_screen(&self, coworker_id: &str) -> Result<Value, OpenGrokError> {
        let path = format!("/coworkers/{coworker_id}/screen");
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// `PUT /coworkers/{id}/computer/egress-policy` — the standing answer for this coworker's
    /// computer to the egress tunnel's card. The server keys it by the computer's scope, so
    /// every bot sharing the box sees the same choice.
    pub async fn set_egress_policy(
        &self,
        coworker_id: &str,
        mode: LocalExecMode,
    ) -> Result<(), OpenGrokError> {
        let path = format!("/coworkers/{coworker_id}/computer/egress-policy");
        let body = json!({ "mode": mode.as_stored() });
        let response = self
            .send_json(reqwest::Method::PUT, &path, Some(&body))
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    /// Rebuild the coworker's computer on the newest image, keeping its files. The server
    /// answers at once; `coworker_computer` carries the phases.
    pub async fn update_coworker_computer(
        &self,
        coworker_id: &str,
    ) -> Result<CoworkerComputer, OpenGrokError> {
        let path = format!("/coworkers/{coworker_id}/computer/update");
        let response = self
            .send_json::<()>(reqwest::Method::POST, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// Destroy the coworker's computer, data and all, and start fresh.
    pub async fn reset_coworker_computer(
        &self,
        coworker_id: &str,
    ) -> Result<CoworkerComputer, OpenGrokError> {
        let path = format!("/coworkers/{coworker_id}/computer/reset");
        let response = self
            .send_json::<()>(reqwest::Method::POST, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn ensure_coworker_computer(
        &self,
        coworker_id: &str,
    ) -> Result<CoworkerComputer, OpenGrokError> {
        let path = format!("/coworkers/{coworker_id}/computer");
        let response = self
            .send_json::<()>(reqwest::Method::POST, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// Upload a taught task as a recipe: the tape (thinned first, see [`thin_tape`]) with a
    /// name and a description. The server keeps the tape as v1 and writes the filtered steps
    /// as v2. A tape over the size limit is refused here, before any of it goes out.
    pub async fn create_recipe(
        &self,
        name: &str,
        description: &str,
        raw: &[Value],
    ) -> Result<RecipeDetail, OpenGrokError> {
        let body = json!({
            "name": name,
            "description": description,
            "screen": { "width": RECIPE_SCREEN.0, "height": RECIPE_SCREEN.1 },
            "raw": raw,
        });
        let size = serde_json::to_vec(&body)
            .map(|bytes| bytes.len())
            .map_err(|e| OpenGrokError::message(e.to_string()))?;
        if size > RECIPE_UPLOAD_LIMIT {
            return Err(OpenGrokError::message(format!(
                "The recording is {:.1} MB; a recipe can be at most 5 MB. Teach a shorter task.",
                size as f64 / (1024. * 1024.)
            )));
        }
        let response = self
            .send_json(reqwest::Method::POST, "/recipes", Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    /// The recipes the person can see: `mine`, `shared` (with them) or `org`; everything when
    /// `filter` is `None`.
    pub async fn list_recipes(
        &self,
        filter: Option<&str>,
    ) -> Result<Vec<RecipeSummary>, OpenGrokError> {
        let path = match filter {
            Some(filter) => format!("/recipes?filter={filter}"),
            None => "/recipes".to_string(),
        };
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        let body: RecipeList = Self::json_or_error(response).await?;
        Ok(body.recipes)
    }

    pub async fn recipe(&self, id: &str) -> Result<RecipeDetail, OpenGrokError> {
        let path = format!("/recipes/{id}");
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn rename_recipe(
        &self,
        id: &str,
        name: &str,
        description: &str,
    ) -> Result<RecipeDetail, OpenGrokError> {
        let path = format!("/recipes/{id}");
        let body = json!({ "name": name, "description": description });
        let response = self
            .send_json(reqwest::Method::PUT, &path, Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    /// The edited steps as a new version of the recipe (the owner's).
    pub async fn add_recipe_version(
        &self,
        id: &str,
        steps: &[RecipeStep],
        note: &str,
    ) -> Result<RecipeDetail, OpenGrokError> {
        let path = format!("/recipes/{id}/versions");
        let body = json!({ "steps": steps, "note": note });
        let response = self
            .send_json(reqwest::Method::POST, &path, Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn share_recipe(
        &self,
        id: &str,
        target: &RecipeShareTarget,
    ) -> Result<RecipeDetail, OpenGrokError> {
        let path = format!("/recipes/{id}/share");
        let response = self
            .send_json(reqwest::Method::POST, &path, Some(target))
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn unshare_recipe(
        &self,
        id: &str,
        scope: &str,
        scope_id: &str,
    ) -> Result<RecipeDetail, OpenGrokError> {
        let path = format!("/recipes/{id}/share/{scope}/{scope_id}");
        let response = self
            .send_json::<()>(reqwest::Method::DELETE, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn accept_recipe(&self, id: &str) -> Result<RecipeDetail, OpenGrokError> {
        self.recipe_post(&format!("/recipes/{id}/accept")).await
    }

    pub async fn decline_recipe(&self, id: &str) -> Result<RecipeDetail, OpenGrokError> {
        self.recipe_post(&format!("/recipes/{id}/decline")).await
    }

    /// A bodiless POST that answers with the recipe's detail.
    async fn recipe_post(&self, path: &str) -> Result<RecipeDetail, OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::POST, path, None)
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn grant_recipe(
        &self,
        id: &str,
        coworker_id: &str,
    ) -> Result<RecipeDetail, OpenGrokError> {
        let path = format!("/recipes/{id}/grants");
        let body = json!({ "coworkerId": coworker_id });
        let response = self
            .send_json(reqwest::Method::POST, &path, Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn revoke_recipe_grant(
        &self,
        id: &str,
        coworker_id: &str,
    ) -> Result<RecipeDetail, OpenGrokError> {
        let path = format!("/recipes/{id}/grants/{coworker_id}");
        let response = self
            .send_json::<()>(reqwest::Method::DELETE, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// Play the recipe's current version on one of the person's bots.
    ///
    /// Asked for without waiting. Since opengrok-server #217 a run is the server's from the
    /// moment its row is written, and it plays on whether or not anybody still holds this
    /// request — so what is worth having back is the `202` with the run's id, and what the run
    /// came to is read off that run's row in [`Self::recipe`] once its [`RecipeRun::state`]
    /// says it is over. A server that waits anyway (one from before #217) answers `200` with
    /// the outcome itself, read as it always was.
    ///
    /// THIS IS THE CLIENT THAT READS THE ASYNC REPLY (hexuria/opengrok-server#227): with it
    /// shipped, the server can make `202` its default.
    pub async fn run_recipe(
        &self,
        id: &str,
        coworker_id: &str,
    ) -> Result<RunRecipeResponse, OpenGrokError> {
        let path = format!("/recipes/{id}/run");
        let body = json!({ "coworkerId": coworker_id });
        let response = self
            .send_json_with_prefer_async(reqwest::Method::POST, &path, Some(&body))
            .await?;
        if !response.status().is_success() {
            return Err(Self::run_error(response).await);
        }
        if response.status() == StatusCode::ACCEPTED {
            return Self::json_or_error(response)
                .await
                .map(RunRecipeResponse::Async);
        }
        Self::json_or_error(response)
            .await
            .map(RunRecipeResponse::Sync)
    }

    /// What a refusal from `POST /recipes/{id}/run` says.
    ///
    /// Read apart from [`Self::read_error`] for one answer that is not a refusal of the run at
    /// all: a `503` with `historyMissed` is a run that played and whose history could not be
    /// written. Its body is the receipt with that sentence beside it, and the receipt's `error`
    /// — what the general reader would take — is about a step, not about why the answer is not
    /// a `200`. So the sentence is what the refusal says; see [`OpenGrokError::history_missed`].
    ///
    /// Only an answer that waited carries it. The server that writes `historyMissed` is the one
    /// that honours `Prefer: respond-async` (both opengrok-server 1ca8756), so this reads it
    /// when the preference did not reach the route — something between them dropped it. A run
    /// that was not waited on and could not be written down has only its row to say so, and
    /// the row reads `interrupted` once its lease lapses.
    ///
    /// Every other refusal is the server's own sentence, as anywhere else. Among them is the
    /// `409` "this bot is already playing a recipe", which since opengrok-server #246 a recipe
    /// played from chat can cause as well as one played from here.
    async fn run_error(response: reqwest::Response) -> OpenGrokError {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        Self::run_refusal(status, &body)
    }

    /// [`Self::run_error`] on a status and a body already read, for the wire conformance tests.
    pub(super) fn run_refusal(status: u16, body: &str) -> OpenGrokError {
        let missed = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|body| Some(body.get("historyMissed")?.as_str()?.trim().to_string()))
            .filter(|missed| !missed.is_empty());
        match missed {
            Some(missed) => OpenGrokError::status(status, missed).with_history_missed(),
            None => Self::refusal(status, body),
        }
    }

    pub async fn delete_recipe(&self, id: &str) -> Result<(), OpenGrokError> {
        let path = format!("/recipes/{id}");
        let response = self
            .send_json::<()>(reqwest::Method::DELETE, &path, None)
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    /// Remove one edited version and the runs that played it. The tape (v1) and the steps the
    /// server filtered from it (v2) are what the recipe is, so the server refuses those with a
    /// sentence saying as much; it is that sentence the page shows.
    pub async fn delete_recipe_version(&self, id: &str, version: u32) -> Result<(), OpenGrokError> {
        let path = format!("/recipes/{id}/versions/{version}");
        let response = self
            .send_json::<()>(reqwest::Method::DELETE, &path, None)
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    // ---- skills ----
    //
    // A SKILL is prose the model reads before it works: a `SKILL.md` with a name and a
    // description in its frontmatter, kept on the server and invoked by typing `/name`. It is
    // not a RECIPE, which is a taped replay of clicks; the two are different kinds of thing
    // that happen to share a slash.

    /// The skills the person can see: `mine`, `shared` (with them) or `org`; everything when
    /// `filter` is `None`.
    ///
    /// The answer is the rows themselves, not an object with a key in it — `/skills` differs
    /// from `/recipes` there, and reading it the other way gets an empty list rather than an
    /// error.
    pub async fn list_skills(
        &self,
        filter: Option<&str>,
    ) -> Result<Vec<SkillSummary>, OpenGrokError> {
        let path = match filter {
            Some(filter) => format!("/skills?filter={filter}"),
            None => "/skills".to_string(),
        };
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// Write one down, or take one that was uploaded: one door, and what tells them apart is
    /// the word on `source` and whether files came with it.
    ///
    /// The body is the whole `SKILL.md`, frontmatter and all. The server has the one parser for
    /// it and reads the name and the description out of the frontmatter when the fields here are
    /// blank, so a skill's file and its row cannot come to disagree about what it is called.
    ///
    /// The cap on the body is the server's, and so is the sentence naming it: the
    /// refusal comes back as the server's own words and goes to the person unchanged, rather
    /// than through a second copy of the number here that would have to be kept in step.
    pub async fn create_skill(&self, new: &NewSkill) -> Result<SkillDetail, OpenGrokError> {
        let mut body = json!({
            "name": new.name,
            "source": new.source.word(),
        });
        if !new.description.trim().is_empty() {
            body["description"] = json!(new.description);
        }
        // Absent leaves a draft — a row with a name and no prose yet — which is not the same as
        // a skill whose body is the empty string.
        if !new.body.trim().is_empty() {
            body["body"] = json!(new.body);
        }
        if !new.files.is_empty() {
            body["files"] = json!(new.files);
        }
        let response = self
            .send_json(reqwest::Method::POST, "/skills", Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    /// A taped task written up as a skill: the raw tape goes to the server, a model reads it,
    /// and what comes back is a skill whose prose says what was being done.
    ///
    /// The tape is the one `POST /recipes` takes — thinned first, see [`thin_tape`] — and this
    /// is the other thing that can be made of it. A RECIPE replays the clicks; a SKILL is the
    /// lesson, and the two are made from one recording by two different routes.
    ///
    /// Both words are optional and both are left out when blank, because the server has an
    /// answer for each: a name it mints as `taught-<hex>`, and a description the same model
    /// writes. Sending `""` would be asking it to keep an empty one.
    ///
    /// What comes back is switched off (`enabled: false`). Nobody has read it yet, and the
    /// server refuses a switched-off skill even to the person who owns it, so the caller has
    /// something to say to the person rather than a row to file.
    ///
    /// Every refusal is the server's own sentence and reaches the caller as written — including
    /// the `502` it answers when the model wrote nothing that can be kept, which is a verdict
    /// about a model and not a hop that could not be reached. See [`Self::tape_error`]: this
    /// route's failures are told apart here, where the route is known, because their status
    /// lines mean something different here than anywhere else in this client.
    pub async fn create_skill_from_tape(
        &self,
        coworker_id: &str,
        name: &str,
        description: &str,
        raw: &[Value],
    ) -> Result<SkillDetail, OpenGrokError> {
        let mut body = json!({
            "coworkerId": coworker_id,
            "screen": { "width": RECIPE_SCREEN.0, "height": RECIPE_SCREEN.1 },
            "raw": raw,
        });
        if !name.trim().is_empty() {
            body["name"] = json!(name);
        }
        if !description.trim().is_empty() {
            body["description"] = json!(description);
        }
        let response = self
            .send_json_within(
                reqwest::Method::POST,
                "/skills/from-tape",
                Some(&body),
                Some(SKILL_FROM_TAPE_TIMEOUT),
                None,
            )
            .await?;
        if !response.status().is_success() {
            return Err(Self::tape_error(response).await);
        }
        response
            .json()
            .await
            .map_err(|e| OpenGrokError::transport(&e))
    }

    /// What a refusal from `/skills/from-tape` IS, which its status line does not say on its own.
    ///
    /// [`Self::read_error`] reads any `502`-`504` as something standing in front of OpenGrok
    /// that could not reach it — true everywhere else, because nothing this app talks to answers
    /// those itself. THIS ROUTE DOES. A `502` here is OpenGrok saying the model ran and produced
    /// nothing that can be kept (it refused, said nothing, wrote something unfenced, or overran
    /// the cap), and a `504` is that model overrunning the server's own sixty seconds. Both are
    /// decisions about this recording, and the same bytes earn the same decision — which is
    /// exactly what a caller needs to know before it offers to send them again.
    ///
    /// Told apart here for the same reason a `401` is: only the caller that knows the route can
    /// know what the number meant. What is still out of reach is out of reach — OpenGrok saying
    /// it could not get to the model gateway is a state, nothing ran, and that one keeps its
    /// kind.
    async fn tape_error(response: reqwest::Response) -> OpenGrokError {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        Self::tape_refusal(status, &body)
    }

    /// [`Self::tape_error`] on a status and a body already read, for the wire conformance tests.
    /// Every answer from this route is read as the server's own, whatever its shape, for the
    /// reason above.
    pub(super) fn tape_refusal(status: u16, body: &str) -> OpenGrokError {
        OpenGrokError::from_opengrok(status, error_message_from_body(body))
            .with_code(error_code_from_body(body))
    }

    pub async fn skill(&self, id: &str) -> Result<SkillDetail, OpenGrokError> {
        let path = format!("/skills/{id}");
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// Rename it, re-describe it, switch it on or off. A field left `None` is left alone, which
    /// is what the server reads from a field that is not in the JSON at all.
    pub async fn update_skill(
        &self,
        id: &str,
        patch: &SkillPatch,
    ) -> Result<SkillDetail, OpenGrokError> {
        let path = format!("/skills/{id}");
        let response = self
            .send_json(reqwest::Method::PUT, &path, Some(patch))
            .await?;
        Self::json_or_error(response).await
    }

    /// Drop one. The server keeps the row so a turn that cited this skill can still say what it
    /// cited; what goes is the person's ability to find it or invoke it.
    pub async fn delete_skill(&self, id: &str) -> Result<(), OpenGrokError> {
        let path = format!("/skills/{id}");
        let response = self
            .send_json::<()>(reqwest::Method::DELETE, &path, None)
            .await?;
        Self::empty_or_error(response).await
    }

    /// New prose for a skill that already exists. The files ride along because they are kept per
    /// version: what is not sent here is not beside this body, so a version that dropped a
    /// reference sheet does not go on finding the old one.
    ///
    /// `source` is sent rather than left to the server to work out. Left off, the server reads a
    /// version with no files beside it as hand-authored — so an upload whose whole bundle is one
    /// `SKILL.md` would be recorded as something somebody typed here.
    pub async fn add_skill_version(
        &self,
        id: &str,
        body: &str,
        note: &str,
        source: SkillSource,
        files: &[SkillFile],
    ) -> Result<SkillVersion, OpenGrokError> {
        let path = format!("/skills/{id}/versions");
        let mut payload = json!({ "body": body, "kind": source.word() });
        if !note.trim().is_empty() {
            payload["note"] = json!(note);
        }
        if !files.is_empty() {
            payload["files"] = json!(files);
        }
        let response = self
            .send_json(reqwest::Method::POST, &path, Some(&payload))
            .await?;
        Self::json_or_error(response).await
    }

    /// The coworker's schedules, which is what a routine is on the server.
    ///
    /// The `?coworker=` is the server's filter; the answer is filtered again here on the same
    /// field, because a server that ignores the query would otherwise put another bot's
    /// routines under this one's name.
    pub async fn list_schedules(
        &self,
        coworker_id: &str,
    ) -> Result<Vec<ScheduleRow>, OpenGrokError> {
        let path = format!("/schedules?coworker={coworker_id}");
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        let rows: Vec<ScheduleRow> = Self::json_or_error(response).await?;
        Ok(rows
            .into_iter()
            .filter(|row| row.coworker_id.is_empty() || row.coworker_id == coworker_id)
            .collect())
    }

    /// Put one on the server. The answer is the whole row, and for a webhook it is the one
    /// time the app is told the key by anything other than a rotate.
    pub async fn create_schedule(&self, new: &NewSchedule) -> Result<ScheduleRow, OpenGrokError> {
        let mut body = json!({
            "coworkerId": new.coworker_id,
            "prompt": new.prompt,
            "kind": new.kind.word(),
        });
        if !new.name.trim().is_empty() {
            body["name"] = json!(new.name);
        }
        if let Some(cron) = &new.cron {
            body["cron"] = json!(cron);
        }
        let response = self
            .send_json(reqwest::Method::POST, "/schedules", Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn pause_schedule(&self, id: &str) -> Result<(), OpenGrokError> {
        self.schedule_action(&format!("/schedules/{id}/pause"))
            .await
    }

    pub async fn resume_schedule(&self, id: &str) -> Result<(), OpenGrokError> {
        self.schedule_action(&format!("/schedules/{id}/resume"))
            .await
    }

    pub async fn delete_schedule(&self, id: &str) -> Result<(), OpenGrokError> {
        let path = format!("/schedules/{id}");
        let response = self
            .send_json::<()>(reqwest::Method::DELETE, &path, None)
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    /// A new key for the webhook. The old one stops working the moment this answers, so the
    /// row it brings back is the only copy of the new one.
    pub async fn rotate_webhook_key(&self, id: &str) -> Result<ScheduleRow, OpenGrokError> {
        let path = format!("/schedules/{id}/rotate-key");
        let response = self
            .send_json::<()>(reqwest::Method::POST, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// Save what the person changed on a routine the server already has. Only the fields named
    /// are sent: an absent one keeps what the routine has, and a webhook's URL and key never
    /// move on an edit (opengrok-server `autonomy/routes.rs`, `edit_schedule`). The answer is
    /// the row as the server now has it.
    pub async fn edit_schedule(
        &self,
        id: &str,
        edit: &ScheduleEdit,
    ) -> Result<ScheduleRow, OpenGrokError> {
        let path = format!("/schedules/{id}");
        let response = self
            .send_json(reqwest::Method::PATCH, &path, Some(edit))
            .await?;
        Self::json_or_error(response).await
    }

    /// The person's "Test run": the routine's own prompt, started now, in the routine's own
    /// thread. A paused routine runs and stays paused. The answer is `202` and the id of the run
    /// it started (`run_schedule_now`).
    pub async fn run_schedule_now(&self, id: &str) -> Result<String, OpenGrokError> {
        let path = format!("/schedules/{id}/run");
        let response = self
            .send_json(reqwest::Method::POST, &path, Some(&json!({})))
            .await?;
        let started: ScheduleRunStarted = Self::json_or_error(response).await?;
        Ok(started.run_id)
    }

    /// What the routine started, newest first: the clock, its webhook, or a person's Test run.
    /// A person replying in the routine's thread is no firing of the routine's, and the server
    /// leaves those out (`schedule_runs`).
    pub async fn schedule_runs(&self, id: &str) -> Result<Vec<ScheduleRun>, OpenGrokError> {
        let path = format!("/schedules/{id}/runs");
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    /// A bodiless POST that answers with nothing worth reading.
    async fn schedule_action(&self, path: &str) -> Result<(), OpenGrokError> {
        let response = self
            .send_json::<()>(reqwest::Method::POST, path, None)
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    pub async fn enrol_daemon(
        &self,
        label: &str,
        machine_id: Option<&str>,
    ) -> Result<DaemonEnrol, OpenGrokError> {
        let mut body = json!({ "label": label });
        if let Some(machine_id) = machine_id.filter(|id| !id.is_empty()) {
            body["machineId"] = json!(machine_id);
        }
        let response = self
            .send_json(reqwest::Method::POST, "/local-exec/daemon", Some(&body))
            .await?;
        Self::json_or_error(response).await
    }

    /// A machine's mode and the standing rules kept for it: see [`LocalExecPolicy`].
    pub async fn local_exec_policy(
        &self,
        machine_id: &str,
    ) -> Result<LocalExecPolicy, OpenGrokError> {
        let path = format!("/local-exec/policy?machine={machine_id}");
        let response = self
            .send_json::<()>(reqwest::Method::GET, &path, None)
            .await?;
        Self::json_or_error(response).await
    }

    pub async fn local_exec_mode(&self, machine_id: &str) -> Result<String, OpenGrokError> {
        Ok(self.local_exec_policy(machine_id).await?.mode)
    }

    pub async fn set_local_exec_mode(
        &self,
        machine_id: &str,
        mode: &str,
    ) -> Result<(), OpenGrokError> {
        let body = json!({ "machineId": machine_id, "mode": mode });
        let response = self
            .send_json(reqwest::Method::PUT, "/local-exec/policy", Some(&body))
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    pub async fn add_local_exec_rule(
        &self,
        machine_id: &str,
        kind: &str,
        pattern: &str,
    ) -> Result<(), OpenGrokError> {
        let body = json!({
            "machineId": machine_id,
            "kind": kind,
            "pattern": pattern,
        });
        let response = self
            .send_json(
                reqwest::Method::POST,
                "/local-exec/policy/rule",
                Some(&body),
            )
            .await?;
        Self::empty_or_error(response).await
    }

    /// Take one standing rule off a machine: the same body [`Self::add_local_exec_rule`] kept it
    /// with, sent to `DELETE` (opengrok-server `remove_rule` in
    /// `crates/opengrok-server/src/local_exec.rs`).
    ///
    /// The server deletes by exact match and answers `204` whether or not a row went, so
    /// `pattern` is the command exactly as the listing gave it, and a rule that had already
    /// gone is not an error. A store that failed answers `500` with a sentence of its own.
    pub async fn remove_local_exec_rule(
        &self,
        machine_id: &str,
        kind: &str,
        pattern: &str,
    ) -> Result<(), OpenGrokError> {
        let body = json!({
            "machineId": machine_id,
            "kind": kind,
            "pattern": pattern,
        });
        let response = self
            .send_json(
                reqwest::Method::DELETE,
                "/local-exec/policy/rule",
                Some(&body),
            )
            .await?;
        Self::empty_or_error(response).await
    }

    pub async fn post_local_exec_responses(
        &self,
        daemon_token: &str,
        body: &serde_json::Value,
    ) -> Result<(), OpenGrokError> {
        let url = self.url("/local-exec/responses")?;
        let response = self
            .http
            .post(url)
            .bearer_auth(daemon_token)
            .json(body)
            .send()
            .await
            .map_err(|e| OpenGrokError::transport(&e))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(Self::read_error(response).await)
        }
    }

    /// `GET /inference-relay/requests`: the Mac relay's stream (opengrok-server #292: server main
    /// cad36fd (#303, after #298), pin 47a5d6b), opened with this Mac's
    /// machine token as the local-exec stream is. Answered with the response as it opens, for the
    /// relay to read its frames off as they come ([`super::relay`]); a refusal is read as every
    /// other, and a `401` is the server no longer taking the token, which the relay stops for.
    pub async fn open_inference_relay(
        &self,
        machine_token: &str,
    ) -> Result<reqwest::Response, OpenGrokError> {
        let url = self.url("/inference-relay/requests")?;
        let response = self
            .http
            .get(url)
            .header(ACCEPT, "text/event-stream")
            .header(CACHE_CONTROL, "no-cache")
            .bearer_auth(machine_token)
            .send()
            .await
            .map_err(|e| OpenGrokError::transport(&e))?;
        if !response.status().is_success() {
            return Err(Self::read_error(response).await);
        }
        Ok(response)
    }

    /// `GET /ag-ui/events`: the account's events stream, answered with the response as it opens,
    /// for [`super::events`] to read its notes off as they come (opengrok-server #348, shaped from
    /// its branch account-events-stream @ 85ce00c: `account_events` in
    /// `crates/opengrok-server/src/agui/routes.rs`; not recorded yet). It goes with the session's
    /// bearer, which is the one thing the route takes the account from. `last_event_id` is the id of the
    /// last note a stream carried, which the server replays after; one it cannot replay from is
    /// answered with `reset` first.
    ///
    /// A `401` is the session's to answer, as on every other route: its refresh is tried once and
    /// the stream asked again with what it brought, and a second `401` is the session gone. A
    /// refresh that never reached the server says nothing about the session, so it is handed back
    /// as it is, for the stream to try again after a wait like any other drop.
    pub async fn open_account_events(
        &self,
        last_event_id: Option<&str>,
    ) -> Result<reqwest::Response, OpenGrokError> {
        let url = self.url("/ag-ui/events")?;
        self.ensure_fresh_token("/ag-ui/events").await;
        // An id that cannot go in a header is not resumed from; the server starts the stream
        // over with `reset`, which reads everything again.
        let resume = last_event_id.and_then(|id| HeaderValue::from_str(id).ok());
        let open = |token: Option<String>| {
            let mut request = self
                .http
                .get(url.clone())
                .header(ACCEPT, "text/event-stream")
                .header(CACHE_CONTROL, "no-cache");
            if let Some(id) = resume.clone() {
                request = request.header("Last-Event-ID", id);
            }
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            request
        };
        let mut response = open(self.access_token())
            .send()
            .await
            .map_err(|e| OpenGrokError::transport(&e))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            match self.refresh_after_unauthorized().await {
                Ok(()) => {
                    response = open(self.access_token())
                        .send()
                        .await
                        .map_err(|e| OpenGrokError::transport(&e))?;
                }
                Err(error) if error.status.is_none() => return Err(error),
                Err(_) => {}
            }
            if response.status() == StatusCode::UNAUTHORIZED {
                return Err(Self::signed_out_error(response).await);
            }
        }
        if !response.status().is_success() {
            return Err(Self::read_error(response).await);
        }
        Ok(response)
    }

    /// `POST /inference-relay/responses/{requestId}`: this Mac's answer to one call off the relay
    /// stream, with its machine token (the same contract). opencodex's stream goes as
    /// `text/event-stream`, uploaded as it arrives rather than gathered first; its model list, and
    /// a failure as `{"error": sentence}`, as `application/json`. `204` is taken, `404` a call the
    /// server no longer has (as good as cancelled), `409` one answered already, `401` the token
    /// refused, and `413` an answer past the server's 32 MiB, cut off there; anything else is read
    /// as the server's refusal.
    pub(crate) async fn answer_inference_relay(
        &self,
        machine_token: &str,
        request_id: &str,
        answer: RelayAnswer,
    ) -> Result<RelayAnswered, OpenGrokError> {
        let url = self.url(&format!(
            "/inference-relay/responses/{}",
            path_segment(request_id)
        ))?;
        let (content_type, body) = match answer {
            RelayAnswer::Stream(body) => ("text/event-stream", body),
            RelayAnswer::Models(models) => {
                ("application/json", reqwest::Body::from(models.to_string()))
            }
            RelayAnswer::Error(sentence) => (
                "application/json",
                reqwest::Body::from(json!({ "error": sentence }).to_string()),
            ),
        };
        let response = self
            .http
            .post(url)
            .bearer_auth(machine_token)
            .header(CONTENT_TYPE, content_type)
            .body(body)
            .send()
            .await
            .map_err(|e| OpenGrokError::transport(&e))?;
        match Self::relay_answered(response.status().as_u16()) {
            Some(answered) => Ok(answered),
            None => Err(Self::read_error(response).await),
        }
    }

    /// What the server made of an answer, by its status alone, or `None` for a refusal to read as
    /// every other. Apart from the response so the wire conformance tests read a recorded answer
    /// with this very code.
    pub(super) fn relay_answered(status: u16) -> Option<RelayAnswered> {
        match status {
            200..=299 => Some(RelayAnswered::Taken),
            401 => Some(RelayAnswered::TokenRefused),
            404 => Some(RelayAnswered::Gone),
            409 => Some(RelayAnswered::AlreadyAnswered),
            413 => Some(RelayAnswered::TooLarge),
            _ => None,
        }
    }

    /// Hold `GET /local-exec/requests` and call `on_frame` for each JSON `data:` event.
    pub async fn stream_local_exec_requests<F>(
        &self,
        daemon_token: &str,
        mut on_frame: F,
    ) -> Result<(), OpenGrokError>
    where
        F: FnMut(serde_json::Value) + Send,
    {
        let url = self.url("/local-exec/requests")?;
        let response = self
            .http
            .get(url)
            .header(ACCEPT, "text/event-stream")
            .header(CACHE_CONTROL, "no-cache")
            .bearer_auth(daemon_token)
            .send()
            .await
            .map_err(|e| OpenGrokError::transport(&e))?;
        if !response.status().is_success() {
            return Err(Self::read_error(response).await);
        }
        let mut stream = response.bytes_stream();
        let mut buf = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| OpenGrokError::transport(&e))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = buf.find("\n\n") {
                let frame = buf[..idx].to_string();
                buf = buf[idx + 2..].to_string();
                for line in frame.lines() {
                    let Some(data) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let data = data.trim();
                    if data.is_empty() {
                        continue;
                    }
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                        on_frame(value);
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AnswerReply {
    #[serde(rename = "alreadyAnswered", default)]
    pub already_answered: bool,
    #[serde(default)]
    pub continuing: bool,
}

/// What `POST /ag-ui/runs/{run_id}/stop` answers with: the run, and what it is now.
#[derive(Debug, Clone, Deserialize)]
pub struct StopReply {
    #[serde(rename = "runId", default)]
    pub run_id: String,
    /// `stopped`, including for a run that had already ended — the route is idempotent, so this
    /// says what is true of the run now rather than whether this call is what made it true.
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunReplay {
    #[serde(rename = "runId", default)]
    pub run_id: String,
    #[serde(default)]
    pub status: String,
    /// When the turn began. A run picked up after a restart has no bubble here yet, and one
    /// made for it is stamped with this rather than the moment it was noticed. Zero from a
    /// server that does not say.
    #[serde(rename = "startedAtMs", default)]
    pub started_at_ms: i64,
    /// Why a `failed` run failed, in the server's words. A turn that died after the app stopped
    /// listening has no error to report from its own stream, so this is the only account of it.
    #[serde(default)]
    pub failure: Option<String>,
    #[serde(default)]
    pub events: Vec<serde_json::Value>,
    #[serde(default)]
    pub pending: Option<serde_json::Value>,
}

/// A thread's runs as the server kept them, from `GET /ag-ui/threads/{thread_id}`.
/// A list, or nothing at all. A server that has no answer may leave the field out or send a
/// null, and a thread that will not load is a worse answer than an empty list.
fn list_or_nothing<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<Vec<String>>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ThreadReplay {
    #[serde(rename = "threadId", default)]
    pub thread_id: String,
    /// Oldest first, so the list reads in the order things happened.
    #[serde(default)]
    pub runs: Vec<ThreadRun>,
    /// The turns this account hid, which the server withheld from `runs`. A thread is cached
    /// on each machine, so without being told, the machine that did not do the hiding would
    /// go on painting from its own copy what the person deleted on another.
    #[serde(rename = "hiddenRunIds", default, deserialize_with = "list_or_nothing")]
    pub hidden_run_ids: Vec<String>,
    /// Live follow-ups that have not become a run. `None` when the server has never heard of
    /// this field (OpenGrok before #171): the local queue is left alone. `Some` is the
    /// snapshot to replace synced holds with — empty meaning none are pending.
    #[serde(rename = "pendingUserMessages", default)]
    pub pending_user_messages: Option<Vec<PendingUserMessage>>,
    /// CUSTOM `pending-user-message` snapshots for the live queue. `None` on
    /// OpenGrok before #171; `Some` (even empty) is preferred over
    /// `pending_user_messages` when hydrating.
    #[serde(rename = "pendingEvents", default)]
    pub pending_events: Option<Vec<Value>>,
}

impl ThreadReplay {
    /// Live pending rows: snapshot CUSTOMs when `pendingEvents` is present,
    /// otherwise `pendingUserMessages`. `None` means the server predates the
    /// field and the local queue must be left alone.
    pub fn live_pending_messages(&self) -> Option<Vec<PendingUserMessage>> {
        match &self.pending_events {
            Some(events) => Some(PendingCustom::snapshot_messages(events)),
            None => self.pending_user_messages.clone(),
        }
    }
}

/// One turn of a thread, as the server kept it.
///
/// `events` are the frames the run *emitted*, which is to say the coworker's side of the turn.
/// What the person typed was consumed by the run and never journaled, so a thread rebuilt from
/// these alone would be a conversation with one voice in it.
#[derive(Debug, Clone, Deserialize)]
pub struct ThreadRun {
    #[serde(rename = "runId", default)]
    pub run_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(rename = "startedAtMs", default)]
    pub started_at_ms: i64,
    #[serde(rename = "updatedAtMs", default)]
    pub updated_at_ms: i64,
    #[serde(default)]
    pub failure: Option<String>,
    #[serde(default)]
    pub events: Vec<serde_json::Value>,
}

impl ThreadRun {
    /// The run has not ended: it is still working, or parked on a permission card.
    pub fn is_live(&self) -> bool {
        self.status == "running" || self.status == "awaiting-approval"
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct QueuedApproval {
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "threadId", default)]
    pub thread_id: String,
    #[serde(rename = "callId")]
    pub call_id: String,
    pub tool: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
    /// Why the run stopped, in the server's word for it — `exec-consent`,
    /// `policy-approval`, `auto-review`. Any word at all: the app reads the
    /// ones it has a card for and shows the rest as they come.
    #[serde(default)]
    pub reason: Option<String>,
    /// The sentence the card puts under the command. A server that does not
    /// send one leaves the app to say something generic, which is what it
    /// said for every card before this.
    #[serde(default)]
    pub why: Option<String>,
}

impl QueuedApproval {
    /// One suspended run at a time in the transcript. Older unanswered
    /// host-shell runs stay on the server; they are not stacked on this turn.
    ///
    /// By conversation, not by thread: a card the MCP door filed under
    /// `mcp-{coworker}` is that coworker's card, and this is the only place
    /// the person will be shown it.
    pub fn latest_for_conversation<'a>(
        queue: &'a [Self],
        conversation_id: &str,
    ) -> Option<&'a Self> {
        queue
            .iter()
            .rev()
            .find(|item| conversation_for_thread(&item.thread_id) == conversation_id)
    }
}

/// `GET /local-exec/daemon`: the machines sit under `machines`. `pub(super)` for the wire
/// conformance tests.
#[derive(Debug, Clone, Deserialize)]
pub(super) struct DaemonList {
    #[serde(default)]
    pub(super) machines: Vec<DaemonMachine>,
}

/// One computer of the account as `GET /local-exec/daemon` lists it, and as
/// `PATCH /local-exec/daemon/{machine_id}` answers: `{machineId, label, enrolledAtMs, revoked,
/// connected, relayEnabled, relaying}`.
///
/// `relayEnabled` and `relaying` are #342's (opengrok-server #342 (main 2136ffc): `row` in
/// `crates/opengrok-server/src/local_exec.rs`, on every row of the recording in
/// `fixtures/wire/`). `relayEnabled` is the computer's
/// own relay switch, on for a computer enrolled before the switch existed, so a row without the key
/// reads on; `relaying` is whether the server holds the computer's relay stream now, which is live
/// and not a setting, so a row without it reads as not relaying. `connected` is the reverse-exec
/// link, as it always was.
#[derive(Debug, Clone, Deserialize)]
pub struct DaemonMachine {
    #[serde(rename = "machineId")]
    pub machine_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default)]
    pub connected: bool,
    #[serde(rename = "relayEnabled", default = "relay_on_by_default")]
    pub relay_enabled: bool,
    #[serde(default)]
    pub relaying: bool,
}

/// A computer's relay switch is on until somebody switches it off.
fn relay_on_by_default() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalExecMode {
    Ask,
    Always,
    Never,
}

impl LocalExecMode {
    pub fn from_stored(mode: &str) -> Self {
        match mode {
            "ask" => Self::Ask,
            "bypass" => Self::Always,
            _ => Self::Never,
        }
    }

    /// Exactly one of the three words, or nothing — for a field whose absence means "no such
    /// control", where `from_stored`'s catch-all would invent a Never.
    pub fn parse(mode: &str) -> Option<Self> {
        match mode.trim().to_ascii_lowercase().as_str() {
            "ask" => Some(Self::Ask),
            "bypass" => Some(Self::Always),
            "never" => Some(Self::Never),
            _ => None,
        }
    }

    pub fn as_stored(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Always => "bypass",
            Self::Never => "never",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Ask => "Ask every time",
            Self::Always => "Always allow",
            Self::Never => "Never allow",
        }
    }
}

/// Who owns this bot's box. OpenGrok `shareScope` on GET `/coworkers/{id}/computer`.
/// NativeChat chrome: dedicated → that bot's Computer pane; user → Settings → Computer;
/// group / org → hide (no group sidebar; org is the admin console).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoxShareScope {
    Dedicated,
    User,
    Group,
    Org,
}

impl BoxShareScope {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "dedicated" => Some(Self::Dedicated),
            "user" => Some(Self::User),
            "group" => Some(Self::Group),
            "org" | "organization" | "organisation" => Some(Self::Org),
            _ => None,
        }
    }
}

/// The most an upload may weigh: opengrok-server `artifacts.rs` `MAX_ARTIFACT_BYTES` (25 MiB).
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

/// A file's type as the server will take it: a plain lowercase `type/subtype`. The server
/// refuses parameters (`; charset=utf-8`) and reads its accepted kinds in lowercase, so a
/// type from the system or an extension table is trimmed, cut at `;` and lowercased first.
pub(crate) fn upload_mime(mime: &str) -> String {
    mime.split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// A file's name as the server will take it. opengrok-server#259 (merged at 68ace2e) refuses a
/// name with a control character, U+2028, U+2029 or a `"` with a 400; a real file can be called
/// that, and the person should not lose the upload over it, so those become `_`. An empty result
/// is named `file`.
pub(crate) fn upload_filename(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|ch| {
            if ch.is_control() || ch == '\u{2028}' || ch == '\u{2029}' || ch == '"' {
                '_'
            } else {
                ch
            }
        })
        .collect();
    if clean.trim().is_empty() {
        "file".to_string()
    } else {
        clean
    }
}

/// A window `GET /coworkers/{id}/usage?window=` can be asked for, as the Usage modal's chips offer
/// them: the last day, the last week, or the month, which is what the server reads when none is
/// named. The server also reads `5h`, which nothing here asks for.
///
/// Transcribed from opengrok-server `crates/opengrok-server/src/points.rs` (`WINDOWS`, `usage_for`)
/// and its route, `get_usage` in `crates/opengrok-server/src/agui/routes.rs`: any other word is a
/// 400, `'x' is not a window; one of 5h, 24h, 7d, month`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UsageWindow {
    Day,
    Week,
    #[default]
    Month,
}

impl UsageWindow {
    /// The chips, in the order they are drawn.
    pub const ALL: [UsageWindow; 3] = [Self::Day, Self::Week, Self::Month];

    /// The server's word for it: the `window` of the request, and of the answer.
    pub fn word(self) -> &'static str {
        match self {
            Self::Day => "24h",
            Self::Week => "7d",
            Self::Month => "month",
        }
    }

    /// What its chip says.
    pub fn label(self) -> &'static str {
        match self {
            Self::Day => "24h",
            Self::Week => "7d",
            Self::Month => "Month",
        }
    }
}

/// What a bot used in a window, per model, as `GET /coworkers/{id}/usage` answers it.
///
/// Transcribed from opengrok-server `crates/opengrok-server/src/points.rs` (`UsageView`,
/// `ModelUsageView`, `TotalsView`, camelCase) and its recorded answers in
/// `fixtures/wire/rest/GET__coworkers__coworker_id__usage/`. A bot that is not metered has no
/// models and every total null, and `note` says why. A metered bot whose gateway could not be
/// asked is `metered: true` with a `note`, no models and zero totals: those zeros are not a
/// measurement. Only what the Usage card shows is read.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoworkerUsage {
    pub metered: bool,
    #[serde(default)]
    pub note: Option<String>,
    pub window: String,
    #[serde(default)]
    pub models: Vec<ModelUsage>,
    #[serde(default)]
    pub totals: UsageTotals,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model_id: String,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// Dollars as the server writes them, six decimals: `"2.000000"`.
    pub cost_usd: String,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    #[serde(default)]
    pub requests: Option<i64>,
    #[serde(default)]
    pub input_tokens: Option<i64>,
    #[serde(default)]
    pub output_tokens: Option<i64>,
    #[serde(default)]
    pub cache_read_tokens: Option<i64>,
    #[serde(default)]
    pub cache_write_tokens: Option<i64>,
    #[serde(default)]
    pub cost_usd: Option<String>,
}

/// `{ "allBots": bool }`, the person's one switch over their saved logins' shares.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AllBots {
    all_bots: bool,
}

/// Whether a saved login can be filled for a Bot, asked before Touch ID (opengrok-server
/// `get_saved_login` in `crates/opengrok-server/src/agui/ceiling.rs`, gol/tools-and-skill-packs).
/// `reason` is `shared-computer` or `shared-bot` when it cannot.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedLoginCheck {
    pub usable: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub own_computer: bool,
    /// Only the person's own Bots use this computer, so sharing every login with all of them
    /// would let a saved login fill here (gol/global-login-share, 9 Oct 2026). A server from
    /// before says nothing, which reads as no.
    #[serde(default)]
    pub own_bots_only: bool,
}

/// One installed plugin skill and its switch for a Bot (opengrok-server `plugin_skill_rows` in
/// `crates/opengrok-server/src/agui/ceiling.rs`, gol/tools-and-skill-packs). `body` comes only
/// from the one-skill read.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PluginSkill {
    pub plugin: String,
    pub skill: String,
    #[serde(default)]
    pub description: String,
    pub on: bool,
    #[serde(default)]
    pub body: Option<String>,
}

/// One tool the bot is offered on a turn right now, as `GET /coworkers/{id}/tools` lists it.
///
/// Transcribed from opengrok-server `crates/opengrok-server/src/agui/routes.rs` `list_tools`
/// and its recorded answer
/// `tests/fixtures/wire/rest/GET__coworkers__coworker_id__tools/200-…json` (server #84's read
/// half): `{"tools": [{"name", "description", "kind": "builtin" | "plugin"}]}`, where `kind`
/// is "builtin" for the executor's own tools and `user_machine_shell`, and "plugin" for the rest.
///
/// On gol/tools-and-skill-packs (uncommitted when transcribed) a plugin's tool also carries
/// `plugin` (its install name), `qualified` (`<plugin>.<server>.<tool>`) and `title` when its
/// server's annotations give one; a group row (`routines`, `plugins`) carries `tools`, the tools
/// it switches, so "@routines:" and the group's page list them.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct CoworkerTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub plugin: Option<String>,
    #[serde(default)]
    pub qualified: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tools: Vec<CoworkerTool>,
    /// This Bot's choice for the tool: `always`, `ask` (a card first) or `never` (not offered;
    /// listed only for a switched-on plugin's tool, so it can be switched back on).
    #[serde(default)]
    pub mode: Option<String>,
    /// A built-in's or group's name and one sentence for people, beside `description`, which is
    /// written for the model (opengrok-server `Executor::builtin_for_people`, #359, on
    /// gol/tools-and-skill-packs, uncommitted when transcribed).
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    /// A group row's own switch (opengrok-server `list_tools`, 7 Oct 2026, gol/tools-and-skill-
    /// packs, uncommitted when transcribed): apart from its tools' choices, which it keeps.
    #[serde(default)]
    pub enabled: Option<bool>,
}

impl CoworkerTool {
    /// One of the server's own tools rather than one a plugin brought. A kind this app does not
    /// know yet is listed with the plugins' rather than claimed as built in.
    pub fn is_builtin(&self) -> bool {
        self.kind == "builtin"
    }
}

/// The envelope `GET /coworkers/{id}/tools` answers in; see [`CoworkerTool`].
#[derive(Debug, Deserialize)]
pub(crate) struct ToolListing {
    #[serde(default)]
    pub(crate) tools: Vec<CoworkerTool>,
}

/// Whose sign-in a connection is: `{"scope": "user", "id": "acct_…"}`, `{"scope": "bot", "id":
/// "cw_…"}` or `{"scope": "global"}`.
///
/// Transcribed from `Owner` in opengrok-server `crates/opengrok-core/src/connection.rs`, in the
/// shape agreed with the server session for opengrok-server#267: adjacently tagged, one `id` key
/// for every scope. On the server's main it is internally tagged, which serde cannot write for a
/// person or a Bot, so no connection of theirs could be kept at all; `global` reads the same
/// under both.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(from = "OwnerOnTheWire")]
pub enum ConnectionOwner {
    /// The whole deployment's key for something that belongs to nobody, and nobody's to lend.
    Global,
    /// A person's account, which is almost every connection.
    User(String),
    /// A Bot's own identity, so what it does is done under its name and not its owner's.
    Bot(String),
    /// A scope this app does not know yet. The server session expects more (an `org` connection
    /// shared across an organization is plausible), and one such row must not fail the whole
    /// list.
    Other,
}

/// The owner as the wire spells it, read loosely so a scope from later lands as
/// [`ConnectionOwner::Other`] instead of failing the list; serde's own `other` cannot take a
/// scope that carries an `id`.
#[derive(Deserialize)]
struct OwnerOnTheWire {
    scope: String,
    #[serde(default)]
    id: Option<String>,
}

impl From<OwnerOnTheWire> for ConnectionOwner {
    fn from(owner: OwnerOnTheWire) -> Self {
        match (owner.scope.as_str(), owner.id) {
            ("global", _) => Self::Global,
            ("user", Some(id)) => Self::User(id),
            ("bot", Some(id)) => Self::Bot(id),
            _ => Self::Other,
        }
    }
}

/// One of the person's connections, as `GET /connections` lists it: a service they signed in to
/// once, and the Bots they have lent it to. A lend and a revoke answer with the same row.
///
/// Transcribed from `ConnectionView` in opengrok-server `crates/opengrok-core/src/connection.rs`,
/// and `list_connections` and `mutate` in `crates/opengrok-server/src/connections/routes.rs`, in
/// the camelCase of opengrok-server#267 (its `connection-owner` branch; main writes it
/// snake_case, and has never had a row to write). The list is an array, empty when nothing is
/// connected, of the caller's own connections that are still connected: a disconnected one is
/// not listed. Today that is only the caller's `user`-scope rows.
///
/// Since opengrok-server #359 (agreed shape; branch gol/service-accounts) several rows can share
/// a connector, one for each account of the service, each with a label the person can tell
/// apart and change (the server starts them as "GitHub", "GitHub 2"…), and each row says how it
/// was signed in to (`kind`).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub id: String,
    /// The service, by the name `GET /connectors` lists it under: `gmail`, `github`.
    pub connector: String,
    pub owner: ConnectionOwner,
    /// What a person is shown for it: the account signed in to, or the connector's name until
    /// the server asks the service who that was. Never a secret.
    pub label: String,
    /// The Bots it is lent to, by coworker id.
    pub loans: Vec<String>,
    pub updated_at_ms: i64,
    /// When the service's token stops working. `None` is a token that does not expire, which is
    /// not one that already has.
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
    #[serde(default)]
    pub kind: ConnectionKind,
}

/// How an account was signed in to, which decides whether Reconnect has a page to send the
/// person back to: `"oauth"` through the service's own sign-in page, `"token"` with a key the
/// server was given, which has none.
///
/// opengrok-server #359 (agreed shape; branch gol/service-accounts). A server from before it
/// sends no kind, and that reads as `oauth`: the service's sign-in page
/// (`/connections/{connector}/authorize`) is the only way this app has offered to connect. A kind
/// from later reads as [`Self::Other`] rather than failing the whole list.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    #[default]
    Oauth,
    Token,
    /// Signed in to at an installed plugin's own MCP server (opengrok-server #364,
    /// `ConnectionKind::Mcp` in `crates/opengrok-core/src/connection.rs`; uncommitted on
    /// gol/service-accounts). Reconnect signs in there again.
    Mcp,
    #[serde(other)]
    Other,
}

/// Which of the person's accounts a Bot uses for a service: one row of `GET /connections/pins`,
/// and what `PUT /coworkers/{id}/pins/{connector}` answers with. A Bot with no pin for a service
/// has none picked, and asks each time.
///
/// opengrok-server #359 (agreed shape; branch gol/service-accounts): camelCase,
/// `{"coworkerId", "connector", "connectionId"}`, at most one for each Bot and service.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPin {
    pub coworker_id: String,
    /// The service, by the name a connection's `connector` says.
    pub connector: String,
    pub connection_id: String,
}

/// The plugin marketplace as `GET /plugins/catalog` answers it: the registry, the commit it was
/// read at, and its entries. Transcribed from `Catalog` and `Entry` in opengrok-server
/// `crates/opengrok-integrations/src/registry.rs` (#356/#366; `category` added on
/// gol/service-accounts, uncommitted, from the marketplace's own `category`).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalog {
    pub registry: String,
    pub revision: String,
    pub plugins: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The marketplace's own grouping (`development`, `database`…). `None` is an entry the
    /// marketplace did not file anywhere, never one this app guessed at.
    #[serde(default)]
    pub category: Option<String>,
    /// The marketplace's `homepage` for it, a web address, when it lists one.
    #[serde(default)]
    pub homepage: Option<String>,
    /// `owner/repo` of the plugin's source, and the commit it is pinned to.
    pub repository: String,
    pub revision: String,
    pub path: String,
    /// Why this server will not install it, when it will not.
    #[serde(default)]
    pub unavailable_reason: Option<String>,
}

/// One part of a plugin bundle (`Part` in opengrok-server `crates/opengrok-plugins/src/bundle.rs`):
/// `kind` is `skill`, `mcp`, `hooks`…, and an unsupported part says why it will not run here.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginPart {
    pub kind: String,
    pub name: String,
    pub supported: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `GET /plugins/catalog/{name}` (`detail` in opengrok-server
/// `crates/opengrok-plugin-api/src/lib.rs`): the entry, the registry commit, the bundle's parts and
/// the services its accounts are for.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub entry: CatalogEntry,
    pub registry_revision: String,
    pub parts: Vec<PluginPart>,
    #[serde(default)]
    pub connectors: Vec<String>,
    /// The bundle's own `plugin.json`: who made it, its version and site.
    #[serde(default)]
    pub manifest: Option<PluginManifest>,
}

/// One installed plugin as `GET /plugins/installations` lists it (`Installation` in
/// opengrok-server `crates/opengrok-integrations/src/installed.rs`, plus `connectors` added by
/// `list` in `crates/opengrok-plugin-api/src/lib.rs` on gol/service-accounts, uncommitted). Only
/// what the app shows is read of the bundle: its manifest and parts; the skill bodies and server
/// configs stay the server's business.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallation {
    pub name: String,
    pub registry: String,
    pub registry_revision: String,
    pub repository: String,
    pub revision: String,
    pub installed_at_ms: i64,
    pub bundle: InstalledBundle,
    #[serde(default)]
    pub connectors: Vec<String>,
    /// The pasted accounts this install holds (`accounts`, added by `list` on gol/service-accounts):
    /// a token account is one install's, which `GET /connections` alone cannot say.
    #[serde(default)]
    pub accounts: Vec<InstalledAccount>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAccount {
    pub connector: String,
    pub connection_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct InstalledBundle {
    pub manifest: PluginManifest,
    #[serde(default)]
    pub parts: Vec<PluginPart>,
}

/// `Manifest` in opengrok-server `crates/opengrok-plugins/src/lib.rs`, the fields a person reads.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PluginManifest {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<PluginAuthor>,
    #[serde(default)]
    pub homepage: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PluginAuthor {
    pub name: String,
}

/// How an installed plugin's service adds an account: `{"method": "oauth" | "token"}`.
#[derive(Debug, Deserialize)]
struct SignInMethod {
    method: String,
}

/// What adding a pasted account answers: the new account's id.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddedToken {
    pub(crate) connection_id: String,
}

/// A sign-in that has not finished, as `GET /connections/attempts` lists it (`Attempt` in
/// opengrok-server `crates/opengrok-integrations/src/attempts.rs`, #359, uncommitted on
/// gol/service-accounts). `status` is `pending` while the person may still be at the service (or
/// closed the window, which nothing reports) and `failed` once the service refused, with `error`.
/// Either is an account that still needs auth; neither is ever shown as connected.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAttempt {
    pub id: String,
    pub connector: String,
    pub label: String,
    #[serde(default)]
    pub coworker_id: Option<String>,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    pub updated_at_ms: i64,
    /// The installed plugin an MCP sign-in is for (#364); absent for a configured service's.
    #[serde(default)]
    pub plugin: Option<String>,
}

/// How long a marketplace read, an install or an uninstall is given. The server reads the
/// registry from GitHub (bounded there too), so this is longer than a connection route's.
pub const PLUGINS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// How long each connection route is given: [`OpenGrokClient::list_connections`], a lend, a
/// revoke, a rename, a disconnect, the pins and their changes, [`OpenGrokClient::list_connectors`],
/// [`OpenGrokClient::connect_link`] and [`OpenGrokClient::reconnect_link`].
///
/// Each is a read or a write of a few rows on the server, and while one is out, its control is
/// dead: a switch or a Disconnect until its change is answered, and every Connect while a
/// sign-in page is asked for. With no deadline, one request that never answers would leave them
/// dead until the app quits.
pub const CONNECTIONS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// How long [`OpenGrokClient::inference_source`] and [`OpenGrokClient::set_inference_source`]
/// are given. Either is a read or a write of one row on the server, and the server's word about
/// opencodex, which it gets by asking the proxy on loopback. While a Save is out every control on
/// Settings → Reply source is dead, and one that never answered would leave them dead until the
/// app quit.
pub const INFERENCE_SOURCE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// A service this server can connect, as `GET /connectors` lists it: `{name, label}`, where
/// `name` is what a connection's `connector` says and `label` is what a person reads ("Gmail").
///
/// Transcribed from the shape agreed with the server session for opengrok-server#269, which adds
/// the route; the server keeps the services it can connect as provider configs keyed by `name`
/// (`Connectors::providers` in `crates/opengrok-server/src/connections/routes.rs`). A connector
/// with no label is shown by its name.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Connector {
    pub name: String,
    #[serde(default)]
    pub label: String,
    /// The installed plugin whose service this is (#359), when it is one: its accounts are that
    /// plugin's pasted tokens, listed in the plugin's own detail rather than as an app.
    #[serde(default)]
    pub plugin: Option<String>,
}

/// What `GET /connections/{connector}/authorize?format=json` answers (opengrok-server#269, as
/// agreed): the service's own sign-in page, for the app to open in the person's browser.
/// `GET /connections/{id}/reconnect?format=json` answers in the same shape (opengrok-server #359
/// (agreed shape; branch gol/service-accounts)).
#[derive(Debug, Deserialize)]
pub(crate) struct ConnectLink {
    pub(crate) url: String,
}

/// Everything a bot could be offered, and which of it it may be: its tool ceiling, as
/// `GET /coworkers/{id}/ceiling` gives it and `PUT` answers with.
///
/// Transcribed from the shape agreed with the opengrok-server session for #268 (the server half
/// of this app's #2), and checked against its `agui/ceiling.rs` as far as that is written; the
/// `version`, and the 409 a stale one gets, were agreed after it and are not in that code yet:
/// `{"tools": [row…], "version": n}`, the array always there and possibly empty. The run path
/// reads this ceiling, so a turn is offered what is enabled here, granted and available, and
/// `GET /coworkers/{id}/tools` goes on listing that offered set. No `#[serde(default)]` on the
/// array: a body without one is not a ceiling with nothing in it.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct CoworkerCeiling {
    pub tools: Vec<CeilingRow>,
    /// Which change of the ceiling these rows are, for a `PUT` built from them to send back: the
    /// server refuses one whose version is not its own any more ([`CEILING_CHANGED`]), so a switch
    /// made from rows somebody else has since changed cannot undo that change. A server older than
    /// the version sends none, and is still read; a `PUT` then sends none either.
    #[serde(default)]
    pub version: Option<i64>,
}

/// The code of the 409 a `PUT` of a ceiling is refused with when its `version` is not the
/// server's any more, beside the sentence "the tools changed since you looked"
/// (opengrok-server#268). Nothing was written.
pub const CEILING_CHANGED: &str = "ceiling-changed";

/// How long a read or a write of a bot's tool ceiling is given. Both are one read or one write
/// the server answers at once; the deadline is there because a switch on the Tools card holds
/// every other switch until it is answered, and one whose answer never came would hold them for
/// as long as the app ran. A request out of time is one nobody knows the answer to, and the card
/// reads the ceiling again.
pub const CEILING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// One row of a bot's tool ceiling: one of the server's own tools, or one plugin. A plugin is one
/// row however many tools it brings, because enabling it admits all of them (opengrok-server#268).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct CeilingRow {
    /// What the `PUT` names it by: a builtin's wire name (`shell`), or the plugin's name.
    pub name: String,
    pub kind: CeilingKind,
    /// In the ceiling now.
    pub enabled: bool,
    /// Sent only where it can be false, and absent means available: `user_machine_shell` is
    /// unavailable while no machine of the person's runs commands for bots (none enrolled, or
    /// its local commands set to Never), and an enabled plugin the server no longer loads stays
    /// listed as unavailable. Read through [`Self::is_available`], which takes a `null` for
    /// absent too.
    #[serde(default)]
    pub available: Option<bool>,
    /// A plugin's name for people.
    #[serde(default)]
    pub label: Option<String>,
    /// A builtin's words are the ones `/tools` gives it; a plugin's are its manifest's, and a
    /// plugin the server no longer loads may have none.
    #[serde(default)]
    pub description: Option<String>,
    /// The connector a plugin's credential names (`gmail`), on a plugin whose credential names one.
    #[serde(default)]
    pub connector: Option<String>,
    /// A built-in's one sentence for people (opengrok-server `agui/ceiling.rs`, #359, on
    /// gol/tools-and-skill-packs, uncommitted when transcribed): what the Tools window lists,
    /// where `description` is the model's.
    #[serde(default)]
    pub summary: Option<String>,
}

impl CeilingRow {
    pub fn is_builtin(&self) -> bool {
        self.kind == CeilingKind::Builtin
    }

    /// Whether the server could offer it now. A builtin that could not is still switched either
    /// way, since the ceiling records what the owner allows and the server offers it once it
    /// can. A plugin that could not is one the server no longer loads, listed only while it is
    /// on: it can be kept on, and switched off, and never switched back on, because once off it
    /// is not a name the server lists.
    pub fn is_available(&self) -> bool {
        self.available != Some(false)
    }
}

/// What a ceiling row is: one of the executor's own tools, `user_machine_shell` among them, or a
/// plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CeilingKind {
    Builtin,
    /// A word this app has no name for yet is filed with the plugins rather than claimed as the
    /// server's own, as the Tools listing files one ([`CoworkerTool::is_builtin`]).
    #[serde(other)]
    Plugin,
}

/// A bot's skills: every skill of the account's library its owner may use, and which of them are
/// attached to it, as `GET /coworkers/{id}/skills` gives it and `PUT` answers with.
///
/// Transcribed from opengrok-server `crates/opengrok-server/src/skills.rs` (`attached` and
/// `attach`, #270, merged as #290 and on the server's main at 4733c0f), whose recordings the
/// ledger reads: `{"skills": [row…], "version": n}`, the array always there and possibly empty. The skills are the ones `/skills` makes (opengrok-server `skills.rs`, whose `may` says
/// who may use which); a plugin's are not among them. An attached skill that is switched on is named, with its description, in the
/// bot's standing system message on every turn, and the bot reads its body through the builtin
/// [`super::gen_ui::USE_SKILL`] when it needs it. A person's `/name` goes on working for any
/// skill they may use, attached or not. No `#[serde(default)]` on the array: a body without one
/// is not a bot with no skills.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct CoworkerSkills {
    pub skills: Vec<BotSkillRow>,
    /// Which change of the attached set these rows are, for a `PUT` built from them to send back:
    /// the server refuses one whose version is not its own any more ([`SKILLS_CHANGED`]), so a
    /// switch made from rows somebody has since changed cannot undo that change. A body without
    /// one is read all the same, and a `PUT` built from it sends none.
    #[serde(default)]
    pub version: Option<i64>,
}

/// The code of the 409 a `PUT` of a bot's skills is refused with when its `version` is not the
/// server's any more, beside the sentence "the skills changed since you looked"
/// (opengrok-server#270). Nothing was written.
pub const SKILLS_CHANGED: &str = "skills-changed";

/// One skill a bot's owner may attach to it: one of their own, or one of their organization's.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct BotSkillRow {
    /// The skill's id (`sk_…`), which a `PUT` names it by.
    pub id: String,
    /// What a person types after a slash to use it.
    pub name: String,
    /// What the skill is for, which is what the bot reads to decide whether to read the body.
    #[serde(default, deserialize_with = "null_as_default")]
    pub description: String,
    pub scope: BotSkillScope,
    /// Attached to this bot now.
    pub attached: bool,
    /// The skill itself is switched on, in Settings → Skills. One switched off stays listed, and
    /// may stay attached, but is offered to no turn.
    pub enabled: bool,
}

/// Whose skill a row is: the bot owner's own, or a colleague's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BotSkillScope {
    /// The owner's own, which they can change and switch off.
    Mine,
    /// A colleague's, shared with the owner's organization, which its author can change or
    /// switch off. A word this app has no name for yet is filed here rather than claimed as the
    /// owner's own.
    #[serde(other)]
    Org,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct CoworkerComputer {
    #[serde(rename = "agentId", default)]
    pub agent_id: String,
    #[serde(default)]
    pub state: String,
    #[serde(rename = "vncUrl", default)]
    pub vnc_url: Option<String>,
    /// The scope's live box — after an update or a heal it differs from the id on the
    /// coworker's own row, and it is the one a person is looking at.
    #[serde(rename = "boxId", default)]
    pub box_id: Option<String>,
    /// What the box runs against what a new one would get; `None` when the provider cannot say.
    #[serde(default)]
    pub image: Option<ImageStatus>,
    /// An update in flight, or the failure the last one ended in.
    #[serde(default)]
    pub update: Option<UpdateStatus>,
    /// Host env / `getHostSettings.egressTunnelEnabled`. Not box provisioned:
    /// Route traffic chrome uses nested `egress_tunnel.ready` (or a tunnel URL).
    #[serde(rename = "isEgressTunnelAvailable", default)]
    pub is_egress_tunnel_available: bool,
    /// Box-owned tunnel endpoint, when the computer JSON exposes it.
    #[serde(
        rename = "egress_tunnel",
        alias = "egressTunnel",
        alias = "boxEgressTunnel",
        default,
        deserialize_with = "deserialize_optional_egress_tunnel"
    )]
    pub egress_tunnel: Option<EgressTunnel>,
    /// OpenGrok: `dedicated` | `user` | `group` | `org`. Missing until the
    /// computer JSON grows the field; NativeChat then infers from shared `boxId`.
    #[serde(
        rename = "shareScope",
        alias = "share_scope",
        default,
        deserialize_with = "deserialize_optional_share_scope"
    )]
    pub share_scope: Option<BoxShareScope>,
    /// Present when `shareScope` is `group`.
    #[serde(rename = "groupId", alias = "group_id", default)]
    pub group_id: Option<String>,
    /// The person's standing answer, for this computer, to the egress tunnel's card:
    /// `bypass` | `ask` | `never` in the same words as this Mac's local-exec policy. `None`
    /// on a server that does not carry it, which hides the control.
    #[serde(
        rename = "egressPolicy",
        alias = "egress_policy",
        default,
        deserialize_with = "deserialize_optional_exec_mode"
    )]
    pub egress_policy: Option<LocalExecMode>,
    /// Why the server could not give this Bot a computer, as it recorded it; `None` when it has
    /// said nothing. [`Self::why_no_computer`] is when the pane shows it.
    #[serde(rename = "computerError", default)]
    pub computer_error: Option<ComputerError>,
}

/// Why the server could not give a Bot a computer: a stable code, the sentence a person reads,
/// and when the server recorded it.
///
/// Transcribed from opengrok-server `crates/opengrok-server/src/agui/provision.rs`, checked
/// against the server's main at e55a8c8. `coworker_screen` there puts it on
/// `GET /coworkers/{id}/computer`, and on the `POST` that asks for a computer, which answers the
/// same way: with `state: absent` when no box could be made and the account holds the reason,
/// with `stopped` or `unknown` when the box's provider cannot be reached, and beside a running
/// box when box.ascii.dev refused and a Local VM took over (`FELL_BACK`). `error_json_at` is its
/// one shape on every surface, the hire's reply in `agui/routes.rs` among them. The corpus
/// records it under `fixtures/wire/rest/GET__coworkers__coworker_id__computer/`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ComputerError {
    /// One of the server's stable codes (`no_org_key`, `quota_exceeded`, `provider_error`, …),
    /// kept as sent.
    pub code: String,
    /// The server's own sentence, e.g. "the box refused: 125 Unable to find image …", which is
    /// what the pane shows.
    pub message: String,
    /// When the server recorded it. The reason is kept on the account until an attempt clears
    /// or replaces it, so it can be older than the status it rides on. `0` from a server older
    /// than the stamp (opengrok-server 26abc27), which sent the other two alone.
    #[serde(rename = "updatedAtMs", default)]
    pub updated_at_ms: i64,
}

fn deserialize_optional_exec_mode<'de, D>(
    deserializer: D,
) -> Result<Option<LocalExecMode>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Option::<Value>::deserialize(deserializer)? {
        Some(Value::String(raw)) => LocalExecMode::parse(&raw),
        _ => None,
    })
}

/// Box tunnel. OpenGrok sends `{enabled, ready}` and may send a `ws://` URL.
/// `enabled` is the box's current opt-in; it is not provisioned-ness (`ready` / URL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressTunnel {
    pub ready: bool,
    pub enabled: Option<bool>,
    pub url: Option<String>,
}

fn deserialize_optional_egress_tunnel<'de, D>(
    deserializer: D,
) -> Result<Option<EgressTunnel>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(egress_tunnel_from_json(
        Option::<Value>::deserialize(deserializer)?.unwrap_or(Value::Null),
    ))
}

fn json_nonempty(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}

fn deserialize_optional_share_scope<'de, D>(
    deserializer: D,
) -> Result<Option<BoxShareScope>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Option::<Value>::deserialize(deserializer)? {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => BoxShareScope::parse(&raw),
        Some(other) => other.as_str().and_then(BoxShareScope::parse),
    })
}

fn egress_tunnel_from_json(value: Value) -> Option<EgressTunnel> {
    match value {
        Value::Null => None,
        Value::Bool(ready) => Some(EgressTunnel {
            ready,
            enabled: None,
            url: None,
        }),
        Value::String(url) => {
            let url = url.trim().to_string();
            if url.is_empty() {
                Some(EgressTunnel {
                    ready: false,
                    enabled: None,
                    url: None,
                })
            } else {
                Some(EgressTunnel {
                    ready: true,
                    enabled: None,
                    url: Some(url),
                })
            }
        }
        Value::Object(_) => {
            let url = json_nonempty(&value, &["url", "wsUrl", "ws_url", "endpoint", "uri"]);
            let ready_flag = value.get("ready").and_then(Value::as_bool);
            // Older payloads used `available` for "the box has a tunnel". That is
            // ready, not the person's opt-in (`enabled`).
            let available = value.get("available").and_then(Value::as_bool);
            let enabled = value.get("enabled").and_then(Value::as_bool);
            let ready = ready_flag.unwrap_or(false)
                || available.unwrap_or(false)
                || url.as_ref().is_some_and(|u| !u.is_empty());
            Some(EgressTunnel {
                ready,
                enabled,
                url,
            })
        }
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ImageStatus {
    #[serde(default)]
    pub running: String,
    #[serde(default)]
    pub latest: String,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UpdateStatus {
    /// `pulling` | `transferring` | `starting` | `failed`.
    pub phase: String,
    #[serde(rename = "startedAtMs", default)]
    pub started_at_ms: i64,
    #[serde(default)]
    pub error: Option<String>,
}

impl UpdateStatus {
    pub fn in_flight(&self) -> bool {
        self.phase != "failed"
    }

    /// The banner's second line for this phase.
    pub fn detail(&self) -> String {
        match self.phase.as_str() {
            "pulling" => "Fetching the newest image".to_string(),
            "transferring" => "Transferring your data".to_string(),
            "starting" => "Starting the new computer".to_string(),
            "failed" => self
                .error
                .clone()
                .unwrap_or_else(|| "The update failed".to_string()),
            other => other.to_string(),
        }
    }
}

impl CoworkerComputer {
    pub fn vnc_url(&self) -> Option<&str> {
        self.vnc_url.as_deref().filter(|url| !url.is_empty())
    }

    pub fn updating(&self) -> bool {
        self.update.as_ref().is_some_and(UpdateStatus::in_flight)
    }

    pub fn image_stale(&self) -> bool {
        self.image.as_ref().is_some_and(|image| {
            image.stale
                || (!image.running.is_empty()
                    && !image.latest.is_empty()
                    && image.running != image.latest)
        })
    }

    /// Nested `egress_tunnel.ready` or a tunnel URL. Host `isEgressTunnelAvailable`
    /// is not box provisioned — Route traffic chrome hides without this.
    pub fn box_egress_provisioned(&self) -> bool {
        self.egress_tunnel
            .as_ref()
            .is_some_and(|tunnel| tunnel.ready)
    }

    /// Same as [`Self::box_egress_provisioned`]. Review-an-action still AND-gates
    /// this with host intent.
    pub fn egress_tunnel_ready(&self) -> bool {
        self.box_egress_provisioned()
    }

    /// `Some` when the box JSON exposed a tunnel field. `None` means omit the node.
    pub fn box_egress_ready(&self) -> Option<bool> {
        self.egress_tunnel.as_ref().map(|tunnel| tunnel.ready)
    }

    pub fn group_id(&self) -> Option<&str> {
        self.group_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
    }

    /// Why the server could not give this Bot a computer, while the status names no box: the
    /// pane says it in place of "No computer yet". A status that names a box is a computer
    /// given, and the error it can carry is a takeover's note about that box (opengrok-server
    /// `provision.rs` `FELL_BACK`), not a reason to ask for another.
    pub fn why_no_computer(&self) -> Option<&ComputerError> {
        self.computer_error
            .as_ref()
            .filter(|_| self.box_id.is_none())
    }
}

/// Grok host: `SAND_EGRESS_TUNNEL_ENABLED === "1"`. OpenGrok also honors
/// `OG_EGRESS_TUNNEL_ENABLED`. Strict `"1"`, not `"true"`.
pub fn env_egress_tunnel_enabled() -> bool {
    matches!(
        std::env::var("OG_EGRESS_TUNNEL_ENABLED").as_deref(),
        Ok("1")
    ) || matches!(
        std::env::var("SAND_EGRESS_TUNNEL_ENABLED").as_deref(),
        Ok("1")
    )
}

/// `/ag-ui/host-settings`, with the coworker whose box the egress question is about.
fn host_settings_path(coworker: Option<&str>) -> String {
    match coworker {
        Some(id) if !id.is_empty() => format!("/ag-ui/host-settings?coworker={id}"),
        _ => "/ag-ui/host-settings".to_string(),
    }
}

/// `egressTunnelAvailable` on the host-settings record: the tunnel is live for the coworker
/// asked about. `Some` only when the host sent the key.
pub fn host_egress_tunnel_available(settings: &Value) -> Option<bool> {
    settings
        .get("egressTunnelAvailable")
        .and_then(Value::as_bool)
}

/// `egressTunnelEnabled` on the host-settings record: host intent.
pub fn host_egress_tunnel_enabled(settings: &Value) -> bool {
    host_egress_tunnel_flag(settings) == Some(true)
}

/// `Some` only when the host actually sent the key. Missing must not overwrite
/// NativeChat's default-on Route traffic toggle.
pub fn host_egress_tunnel_flag(settings: &Value) -> Option<bool> {
    settings.get("egressTunnelEnabled").and_then(Value::as_bool)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectedComputer {
    pub machine_id: String,
    pub label: String,
    pub mode: LocalExecMode,
    pub this_machine: bool,
    pub online: bool,
    /// The computer's own relay switch as the server keeps it ([`DaemonMachine::relay_enabled`]).
    pub relay_enabled: bool,
    /// The server holds the computer's relay stream now ([`DaemonMachine::relaying`]).
    pub relaying: bool,
    /// The machine ids of this computer's other enrolments, which the roster folds into this row
    /// because they carry its label ([`collapse_computer_roster`]): what an earlier run of the app
    /// on the same computer enrolled and never revoked. None of them has a card, so this row's
    /// relay switch moves them with it: one left on keeps the account's relay on with a computer
    /// asleep, which refuses a Subscription Bot's turn rather than giving it the Relay-off
    /// fallback. A revoked one is never listed ([`OpenGrokClient::list_computers`]).
    pub folded: Vec<String>,
}

impl ConnectedComputer {
    fn preferred_over(&self, other: &Self) -> bool {
        match (self.this_machine, other.this_machine) {
            (true, false) => true,
            (false, true) => false,
            _ => self.online && !other.online,
        }
    }

    /// `other`, folded into this row: its machine id and the ids folded into it, each once, and
    /// never this row's own (the same machine listed twice is one enrolment).
    fn fold_in(&mut self, other: ConnectedComputer) {
        for id in std::iter::once(other.machine_id).chain(other.folded) {
            if id != self.machine_id && !self.folded.contains(&id) {
                self.folded.push(id);
            }
        }
    }
}

fn computer_label_key(computer: &ConnectedComputer) -> Option<String> {
    let label = computer.label.trim().to_ascii_lowercase();
    if label.is_empty() || label == "computer" {
        None
    } else {
        Some(label)
    }
}

fn fold_computers(
    computers: Vec<ConnectedComputer>,
    key: impl Fn(&ConnectedComputer) -> Option<String>,
) -> Vec<ConnectedComputer> {
    let mut out = Vec::new();
    for computer in computers {
        let Some(k) = key(&computer) else {
            out.push(computer);
            continue;
        };
        match out
            .iter()
            .position(|existing| key(existing).as_deref() == Some(k.as_str()))
        {
            Some(i) if computer.preferred_over(&out[i]) => {
                let folded = std::mem::replace(&mut out[i], computer);
                out[i].fold_in(folded);
            }
            Some(i) => out[i].fold_in(computer),
            None => out.push(computer),
        }
    }
    out
}

/// Same `machineId` listed twice (daemon roster glitch) becomes one row.
pub fn collapse_computers_by_machine_id(
    computers: Vec<ConnectedComputer>,
) -> Vec<ConnectedComputer> {
    fold_computers(computers, |computer| Some(computer.machine_id.clone()))
}

/// Settings Computers tab: one row per machine, and a stale enrol with the
/// same label as this Mac (Online/Never + Offline/Always) collapses to the
/// live one. Prefer `this_machine`, then online. The row keeps the ids of the
/// enrolments it stands for ([`ConnectedComputer::folded`]), which its relay
/// switch moves with it.
pub fn collapse_computer_roster(computers: Vec<ConnectedComputer>) -> Vec<ConnectedComputer> {
    fold_computers(
        collapse_computers_by_machine_id(computers),
        computer_label_key,
    )
}

#[derive(Debug, Clone, Deserialize)]
pub struct DaemonEnrol {
    #[serde(rename = "machineId")]
    pub machine_id: String,
    pub token: String,
}

/// A machine's reverse-exec policy as `GET /local-exec/policy?machine=<id>` lists it:
/// `{machineId, mode, allow, deny, inert}`, transcribed from `policy_listing` in opengrok-server
/// `crates/opengrok-server/src/local_exec.rs` (`inert` since PR #246).
///
/// Every field reads as empty when it is missing. The roster only ever wanted `mode`, and a
/// server from before #246 sends no `inert`, which is the same as saying every allow it lists
/// is in effect.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExecPolicy {
    #[serde(default)]
    pub machine_id: String,
    /// `never`, `ask` or `bypass`, in the server's words: see [`LocalExecMode::from_stored`].
    #[serde(default)]
    pub mode: String,
    /// Commands the gate lets through without asking while the machine is on `ask`: each one a
    /// standing allow, the command exactly as it was kept.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Commands the gate refuses without asking while the machine is on `ask`. A deny matches
    /// any simple command in a line, and wins over an allow.
    #[serde(default)]
    pub deny: Vec<String>,
    /// Allows the gate can never match, each named again here with the reason the rule
    /// endpoint would refuse it today: a rule kept before that refusal existed, or written
    /// straight to the store. Every pattern here is also in `allow`. A sibling list rather than
    /// a flag on each row because `allow` is an array of strings this app already read, and the
    /// server kept it one.
    #[serde(default)]
    pub inert: Vec<InertRule>,
}

/// One allow the gate can never match: `{pattern, reason}` in [`LocalExecPolicy::inert`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct InertRule {
    #[serde(default)]
    pub pattern: String,
    /// The server's sentence for why it is never read, as the rule endpoint would say it
    /// (opengrok-server `standing_rule_refusal`), e.g. "sudo cannot be a standing allow".
    #[serde(default)]
    pub reason: String,
}

/// What sets a schedule off: the clock, or somebody POSTing to a URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind {
    Webhook,
    /// Last, and the catch-all: a word this client has no name for is a schedule with a line
    /// it cannot read, which is a routine that still lists, pauses and deletes.
    #[default]
    #[serde(other)]
    Cron,
}

impl ScheduleKind {
    /// The word the server sends and takes.
    pub fn word(self) -> &'static str {
        match self {
            Self::Cron => "cron",
            Self::Webhook => "webhook",
        }
    }
}

/// The URL a webhook schedule fires from, and what has to be on the request.
///
/// The server keeps the key rather than hashing it, so it comes back on every listing and not
/// only on the create — which is what lets the app show it to the person who set it up.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct WebhookInfo {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub header: String,
}

/// One schedule as `/schedules` keeps it: a coworker, a prompt, and when to send it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRow {
    pub id: String,
    #[serde(default)]
    pub coworker_id: String,
    #[serde(default)]
    pub kind: ScheduleKind,
    /// The cron line, on a cron schedule. A webhook has no clock, so this is `null`.
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub next_due_ms: Option<i64>,
    #[serde(default)]
    pub webhook: Option<WebhookInfo>,
    /// The IANA zone the server reads the routine's cron line in (opengrok-server #316, #334, on
    /// main 8e7387f: `tz` on every row, `row` in `crates/opengrok-server/src/autonomy/routes.rs`),
    /// `UTC` for one stored before zones. This app names none on a create or an edit, so a new
    /// routine takes the account's `timeZone`, else UTC (`zone_of` in `autonomy/desk.rs`), and an
    /// edit keeps the zone it had. `None` from a server before zones, which read every line in UTC.
    #[serde(default)]
    pub tz: Option<String>,
}

/// What `PATCH /schedules/{id}` is asked to change. Every field is optional on the server, and
/// one left out keeps what the routine has, so only what the person changed is sent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEdit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Only for a cron routine: the server refuses a clock on a webhook.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
}

impl ScheduleEdit {
    /// The server answers an edit that names nothing with a 422, so one is never sent.
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.prompt.is_none() && self.cron.is_none()
    }
}

/// One line of a routine's history, as `GET /schedules/{id}/runs` answers it
/// (opengrok-server `autonomy/routes.rs`, `history`): `{runId, cause, status, startedAtMs,
/// endedAtMs}` for a run; and since #316 (#334, on main 8e7387f, the same `history`) a firing the
/// server skipped, because the Bot answers on its person's own plan and the plan could not answer
/// then, as `{runId: null, cause, status: null, startedAtMs: null, endedAtMs: null, at, state:
/// "skipped", skipped, reason}`. A skip started no run, so it has nothing to open. Since #337
/// (built in #342, the same `history`) every line also carries `by`: the Bot whose `run_routine`
/// set the firing off, which is a run's `cause: "bot"` too, and `null` for every other cause (a
/// line from before it has no `by` at all).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    /// `null` on a skipped firing, which started no run.
    #[serde(default)]
    pub run_id: Option<String>,
    pub cause: RunCause,
    /// `null` on a skipped firing.
    #[serde(default)]
    pub status: Option<ScheduleRunStatus>,
    /// `null` on a skipped firing, whose time is [`Self::at`].
    #[serde(default)]
    pub started_at_ms: Option<i64>,
    /// `null` while the run is going or waiting on the person, and on a skipped firing.
    #[serde(default)]
    pub ended_at_ms: Option<i64>,
    /// [`SKIPPED_FIRING`] on a skipped firing; absent on a run.
    #[serde(default)]
    pub state: Option<String>,
    /// When a skipped firing was due.
    #[serde(default)]
    pub at: Option<i64>,
    /// Why it was skipped, as the server's code: `relay_offline` (no computer held the person's
    /// relay) or `proxy_down` (their plan's proxy did not answer), from `SKIPPED` in
    /// opengrok-server's `crates/opengrok-server/src/autonomy/mod.rs`. Nothing here branches on
    /// it: the line says [`Self::reason`].
    #[serde(default)]
    pub skipped: Option<String>,
    /// The server's sentence for why it was skipped (`skip_reason` there), which is what the
    /// line says: "Skipped: your computer was off, so your plan couldn't answer".
    #[serde(default)]
    pub reason: Option<String>,
    /// The Bot that started the firing, as the server named it then (opengrok-server #337, built in
    /// #342: `history` in `crates/opengrok-server/src/autonomy/routes.rs`): `null` for the clock,
    /// a webhook and the person's own Test run, and left out by a server from before it. The
    /// line says it ([`RunCause::Bot`]) wherever it is a Bot's.
    #[serde(default)]
    pub by: Option<RunBy>,
}

/// The Bot a firing of a routine was started by, as a line of the history and a routine's `lastRun`
/// name it: its id, and its name as it was called then, which is the name the line says (opengrok-server
/// #337, built in #342: `by` in `crates/opengrok-server/src/autonomy/routes.rs`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBy {
    pub coworker_id: String,
    pub name: String,
}

/// `state` on a line of a routine's history that is a firing the server skipped (see
/// [`ScheduleRun`]).
pub const SKIPPED_FIRING: &str = "skipped";

impl ScheduleRun {
    /// A firing the server skipped, which started no run: said so, or naming no run to open.
    pub fn is_skipped(&self) -> bool {
        self.state.as_deref() == Some(SKIPPED_FIRING) || self.run_id.is_none()
    }
}

/// What `POST /schedules/{id}/run` answers with: `202 {accepted, runId}` (opengrok-server
/// `autonomy/mod.rs`, `start_fired`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunStarted {
    pub run_id: String,
}

/// What set a routine's run off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunCause {
    /// A person pressed Test run.
    Manual,
    Webhook,
    Clock,
    /// A Bot ran the routine for its person with its `run_routine` tool (opengrok-server #337,
    /// built in #342); the line's `by` names it.
    Bot,
    /// A word this client has no name for yet: still a run, and still listed.
    #[serde(other)]
    Other,
}

/// Where a routine's run got to, in the history's own words (not the run store's).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleRunStatus {
    Running,
    /// Parked on a card for the person.
    Waiting,
    Ok,
    Error,
    #[serde(other)]
    Other,
}

/// What `POST /schedules` is asked for. `cron` is the line for a cron schedule and nothing at
/// all for a webhook, whose URL and key the server mints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSchedule {
    pub coworker_id: String,
    pub kind: ScheduleKind,
    pub prompt: String,
    pub name: String,
    pub cron: Option<String>,
}

/// The screen every recipe is taught on and played back on, in CSS pixels.
pub const RECIPE_SCREEN: (u32, u32) = (1280, 800);
/// The most a recipe upload may weigh. The server refuses more, so say so before sending.
pub const RECIPE_UPLOAD_LIMIT: usize = 5 * 1024 * 1024;
/// The least time between two `move` events that both go up: the mouse reports far more often
/// than a step needs, and a long tape must fit the upload limit.
pub const RECIPE_MOVE_INTERVAL_MS: i64 = 40;

/// The tape with its `move` events thinned to one per [`RECIPE_MOVE_INTERVAL_MS`]; every other
/// event stays, in order. The first move after a gap always goes.
pub fn thin_tape(events: &[Value]) -> Vec<Value> {
    let mut last_move_at: Option<i64> = None;
    events
        .iter()
        .filter(|event| {
            if event.get("kind").and_then(Value::as_str) != Some("move") {
                return true;
            }
            let at = event.get("at").and_then(Value::as_i64).unwrap_or(0);
            if last_move_at.is_some_and(|last| at - last < RECIPE_MOVE_INTERVAL_MS) {
                return false;
            }
            last_move_at = Some(at);
            true
        })
        .cloned()
        .collect()
}

/// A field the server may send as `null`: read it as the type's default.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Option::unwrap_or_default)
}

/// `GET /recipes`: the rows sit under `recipes`. `pub(super)` for the wire conformance tests.
#[derive(Debug, Clone, Deserialize)]
pub(super) struct RecipeList {
    #[serde(default)]
    pub(super) recipes: Vec<RecipeSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeScreen {
    pub width: u32,
    pub height: u32,
}

impl Default for RecipeScreen {
    fn default() -> Self {
        Self {
            width: RECIPE_SCREEN.0,
            height: RECIPE_SCREEN.1,
        }
    }
}

/// How the person stands to a recipe: theirs, shared with them and taken, shared and not yet
/// answered, or nothing in particular (an org listing they may look at).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecipeRelation {
    Mine,
    Shared,
    Invited,
    #[default]
    #[serde(other)]
    None,
}

/// Which of the two things a row on the listing is.
///
/// The server keeps both on one table: a workflow is a recipe version of kind `workflow`, so
/// ownership, versions, sharing, grants and run history are one set of rules rather than two
/// that drift. The listing therefore carries this word on every row — `GET /recipes` brings
/// back both and `?kind=` only drops rows it has already built — which is why the app fetches
/// once and reads the word instead of asking twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecipeKind {
    /// A decision tree that drives recipes, walked by the server, which asks Jev at each branch.
    Workflow,
    /// A taped sequence, replayed exactly by the box alone.
    ///
    /// Last because the catch-all has to be, and a word this client has no name for is read as
    /// one — the way an unknown parameter kind is read as text: a third kind arriving one day
    /// must not fail the listing and take every recipe down with it.
    #[default]
    #[serde(other)]
    Recipe,
}

impl RecipeKind {
    /// What this kind is called where a person reads it.
    pub fn label(self) -> &'static str {
        match self {
            Self::Recipe => "Recipe",
            Self::Workflow => "Workflow",
        }
    }

    /// The same word mid-sentence, for a line like "Drop the workflow".
    pub fn word(self) -> &'static str {
        match self {
            Self::Recipe => "recipe",
            Self::Workflow => "workflow",
        }
    }

    /// The icon a row of this kind carries: a tape for a recipe, a fork in the road for a tree.
    pub fn icon(self) -> &'static str {
        match self {
            Self::Recipe => "icons/record.svg",
            Self::Workflow => "icons/branch.svg",
        }
    }
}

/// Where a share stands with the person it went to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecipeShareState {
    Accepted,
    Declined,
    Pending,
    #[serde(other)]
    Unknown,
}

/// One row of the Recipes list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSummary {
    pub id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub owner_id: String,
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub description: String,
    #[serde(default)]
    pub screen: RecipeScreen,
    #[serde(default)]
    pub created_at_ms: i64,
    #[serde(default)]
    pub updated_at_ms: i64,
    #[serde(default)]
    pub deleted_at_ms: Option<i64>,
    #[serde(default)]
    pub latest_version: u32,
    #[serde(default)]
    pub relation: RecipeRelation,
    #[serde(default)]
    pub share_state: Option<RecipeShareState>,
    /// A taped sequence or a decision tree. A server that has never heard of workflows leaves
    /// the word off the row, or sends it empty; either way every row it sends is a recipe, which
    /// is what the default says.
    #[serde(default, deserialize_with = "null_as_default")]
    pub kind: RecipeKind,
    /// What the runnable version needs told before it runs. It rides on the summary so the
    /// composer knows what a recipe wants the moment it is picked, with no second fetch: a
    /// list that arrives one keystroke after the person needs it is a list they type past.
    #[serde(default)]
    pub parameters: Vec<RecipeParameter>,
}

impl RecipeSummary {
    pub fn is_mine(&self) -> bool {
        self.relation == RecipeRelation::Mine
    }

    /// A decision tree rather than a tape. What it changes is what the row is called and what
    /// can be done with it, never how its parameters are read: a workflow declares them exactly
    /// as a recipe does, on the same field of the same row.
    pub fn is_workflow(&self) -> bool {
        self.kind == RecipeKind::Workflow
    }

    /// A share the person has not answered: Accept or Decline comes before anything else.
    pub fn is_pending_invite(&self) -> bool {
        self.relation == RecipeRelation::Invited
            && matches!(self.share_state, Some(RecipeShareState::Pending) | None)
    }
}

/// What a parameter takes. The server names only these three, and a fourth this client has no
/// word for is read as text: an unknown kind should leave a field a person can still type into
/// rather than fail the whole listing and take every other recipe down with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecipeParameterKind {
    Number,
    Boolean,
    #[default]
    #[serde(other)]
    Text,
}

impl RecipeParameterKind {
    /// What this kind is called where a person reads it.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Number => "number",
            Self::Boolean => "yes or no",
            Self::Text => "text",
        }
    }
}

/// One thing a recipe needs told before it runs, as its runnable version declares it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeParameter {
    #[serde(default, deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub kind: RecipeParameterKind,
    /// What it stands at when nobody says otherwise. A number or a boolean default arrives as
    /// itself in JSON and is kept as the words a person would type for it, because that is what
    /// it is shown and compared as; [`RecipeParameter::encode`] turns it back on the way out.
    #[serde(default, deserialize_with = "scalar_text")]
    pub default: Option<String>,
    /// The only values this parameter takes, when the declaration narrows it.
    #[serde(default, deserialize_with = "scalar_text_list")]
    pub values: Option<Vec<String>>,
}

impl RecipeParameter {
    /// The values this parameter is narrowed to, if it is narrowed at all.
    pub fn allowed(&self) -> Option<&[String]> {
        self.values.as_deref().filter(|values| !values.is_empty())
    }

    /// The declared value this text names, in the declaration's own spelling. Case is not what
    /// a person is choosing between, so "Mundo" takes the declared "mundo" rather than being
    /// refused for a difference they cannot see the point of.
    pub fn declared(&self, text: &str) -> Option<&str> {
        self.allowed()?
            .iter()
            .find(|value| value.eq_ignore_ascii_case(text))
            .map(String::as_str)
    }

    /// Why this text is not a value this parameter takes, in words for the person, or `None`
    /// when it is one. The text is what they typed, trimmed and not empty — an empty field is
    /// no value at all rather than a bad one.
    ///
    /// The server checks again and is the authority; this only catches it while the composer is
    /// still open and the answer can be fixed without losing the turn.
    pub fn reject(&self, text: &str) -> Option<String> {
        if let Some(allowed) = self.allowed() {
            if self.declared(text).is_none() {
                return Some(format!(
                    "{} takes one of: {}.",
                    self.name,
                    allowed.join(", ")
                ));
            }
            return None;
        }
        match self.kind {
            RecipeParameterKind::Number => text
                .parse::<f64>()
                .is_err()
                .then(|| format!("{} takes a number, and \"{text}\" is not one.", self.name)),
            RecipeParameterKind::Boolean => boolean_text(text)
                .is_none()
                .then(|| format!("{} is a yes or a no, so pick one.", self.name)),
            RecipeParameterKind::Text => None,
        }
    }

    /// The value as it travels to the server: a declared `number` as a number and a `boolean`
    /// as a boolean, so `recipeValues` carries what the declaration asked for rather than the
    /// words that stood for it in the composer.
    pub fn encode(&self, text: &str) -> Value {
        let text = self.declared(text).unwrap_or(text);
        match self.kind {
            RecipeParameterKind::Number => text
                .parse::<i64>()
                .map(Value::from)
                .or_else(|_| text.parse::<f64>().map(Value::from))
                .unwrap_or_else(|_| Value::String(text.to_string())),
            RecipeParameterKind::Boolean => match boolean_text(text) {
                Some(flag) => Value::Bool(flag),
                None => Value::String(text.to_string()),
            },
            RecipeParameterKind::Text => Value::String(text.to_string()),
        }
    }
}

/// The yes or the no a person may have written, whichever way they wrote it.
fn boolean_text(text: &str) -> Option<bool> {
    match text.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "y" | "1" => Some(true),
        "false" | "no" | "n" | "0" => Some(false),
        _ => None,
    }
}

/// A scalar the server may send as a string, a number, a boolean or `null`, read as the words a
/// person would type for it.
fn scalar_text<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<Value>::deserialize(deserializer)?.and_then(|value| value_text(&value)))
}

/// The same, for the list of values a parameter may be narrowed to.
fn scalar_text_list<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let Some(values) = Option::<Vec<Value>>::deserialize(deserializer)? else {
        return Ok(None);
    };
    Ok(Some(values.iter().filter_map(value_text).collect()))
}

/// One JSON scalar as text. An object or an array is not something a person types into a field,
/// so it stands for no value at all.
fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// What a message tagged, as its turn carries it in `forwardedProps`.
///
/// - `plugins`: installed plugins tagged `@name`, as `mentionedPlugins`. A tag GIVES the Bot that
///   plugin for this turn even where it is switched off, when the Bot is the person's own; before
///   any model call the server answers with a card when one needs an install, an account, or a
///   choice between accounts (opengrok-server `mentioned_plugins_from` and `turn::needs` in
///   `crates/opengrok-server/src/agui/routes.rs` and `crates/opengrok-integrations/src/turn.rs`,
///   #359/#360, gol/service-accounts).
/// - `accounts`: the account a "Which account?" card picked, by plugin then service, as
///   `pluginAccounts`: `{"cloudflare": {"cloudflare": "conn_…"}}`. For this turn only.
/// - `tools`: built-in tools tagged `@shell`, as `preferTools`: a preference the server names to
///   the model, never a restriction (`preferred_tools_from`, same file).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnTags {
    pub plugins: Vec<String>,
    pub accounts: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    pub tools: Vec<String>,
}

/// The recipe a turn runs, and what its parameters were filled in with.
///
/// It travels in `forwardedProps` beside the coworker and never in the message: a parameter
/// value is not prose, and pasting it into the sentence would change what the person said.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnRecipe {
    pub id: String,
    pub values: serde_json::Map<String, Value>,
}

/// One version of a recipe: the tape (v1), the steps the server filtered from it (v2), or
/// steps a person edited; or, on a workflow's row, the decision tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "WireRecipeVersion")]
pub struct RecipeVersion {
    pub version: u32,
    /// `raw`, `filtered` or `edited`.
    #[serde(default, deserialize_with = "null_as_default")]
    pub kind: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
    #[serde(default)]
    pub created_at_ms: i64,
    /// What this version needs told before it runs. See [`RecipeVersion::declared`] for why it
    /// is read from here and from the body both.
    #[serde(default)]
    pub parameters: Vec<RecipeParameter>,
    #[serde(default)]
    pub body: RecipeVersionBody,
}

impl RecipeVersion {
    /// The tape is kept, not run; every other kind carries steps.
    pub fn is_runnable(&self) -> bool {
        self.kind != "raw"
    }

    /// What this version declares it needs told, which is the declaration a run of it binds
    /// values to. It arrives beside the version's own fields or inside its body, and either
    /// shape reads the same here, the way a tape does: the declaration belongs to the version
    /// whichever half of the row the server writes it on.
    pub fn declared(&self) -> &[RecipeParameter] {
        if !self.parameters.is_empty() {
            return &self.parameters;
        }
        &self.body.parameters
    }

    /// A version someone wrote by editing, which is the only kind the server will delete on
    /// its own: the tape is v1 and the steps filtered from it are v2, and those two are what
    /// the recipe is. A server that names no kind still numbers them, so the number stands in.
    pub fn is_edited(&self) -> bool {
        self.kind == "edited" || (self.version > 2 && self.is_runnable())
    }

    /// How many tape events a raw version holds: the server sends the count, or the events.
    pub fn event_count(&self) -> u64 {
        self.body.events.as_ref().map_or(0, RecipeTape::count)
    }

    /// The tape itself, when the server sent it rather than only its size. It arrives under
    /// `tape` beside the count; a body that puts the events under `events` reads the same.
    pub fn tape_events(&self) -> Option<&[RecipeTapeEvent]> {
        if !self.body.tape.is_empty() {
            return Some(&self.body.tape);
        }
        self.body.events.as_ref().and_then(RecipeTape::events)
    }

    /// Whether the tape that arrived is only the front of a longer one.
    pub fn tape_truncated(&self) -> bool {
        self.body.truncated
    }
}

/// A version's body: the tape for v1, the steps for every version after it. The keys are the
/// server's snake_case.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct RecipeVersionBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<RecipeTape>,
    /// The tape itself. The server sends the count under `events` and the events under `tape`,
    /// cut at a cap with `truncated` saying so; a body that carries the events under `events`
    /// instead is read the same way, so either shape shows a tape.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tape: Vec<RecipeTapeEvent>,
    #[serde(default)]
    pub truncated: bool,
    /// The steps a taught or edited version plays, in order. A workflow's version has none: its
    /// `steps` are the decision tree, which this app does not read (see `WireRecipeVersion`).
    #[serde(default)]
    pub steps: Vec<RecipeStep>,
    /// The version's declaration, when the server writes it inside the body rather than beside
    /// it. Read through [`RecipeVersion::declared`], which takes either.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<RecipeParameter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_on_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<Value>,
}

/// The kind of version that is a workflow's decision tree (opengrok-tools `workflow.rs` `KIND`).
const WORKFLOW_VERSION: &str = "workflow";

/// A recipe version as the wire carries it, before its body is read by what kind of version it
/// is.
///
/// A workflow is a recipe row too, and its version's body is the tree the server walks: `steps`
/// there is an object of named branches (`{"look": {"do": "observe", …}, …}`, opengrok-tools
/// `workflow.rs`, sent as stored by opengrok-server `recipes.rs` `detail_body`), not a sequence
/// to play. Read as a sequence it failed the whole of `GET /recipes/{id}`, and with it the
/// recipe's history, its grants and every answer that carries the detail, over a tree this app
/// draws nowhere. So a workflow's version is read without its tree, and it has no tape steps.
/// Any other version's steps are a tape and are read strictly, whatever shape they come in: an
/// object there, or a step this client cannot read, is a tape it would show and play wrong.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRecipeVersion {
    version: u32,
    #[serde(default, deserialize_with = "null_as_default")]
    kind: String,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    created_by: Option<String>,
    #[serde(default)]
    created_at_ms: i64,
    #[serde(default)]
    parameters: Vec<RecipeParameter>,
    #[serde(default)]
    body: Value,
}

impl TryFrom<WireRecipeVersion> for RecipeVersion {
    type Error = String;

    fn try_from(wire: WireRecipeVersion) -> Result<Self, Self::Error> {
        let mut body = wire.body;
        if wire.kind == WORKFLOW_VERSION
            && let Some(fields) = body.as_object_mut()
            && fields.get("steps").is_some_and(Value::is_object)
        {
            fields.remove("steps");
        }
        let body = if body.is_null() {
            RecipeVersionBody::default()
        } else {
            serde_json::from_value(body).map_err(|error| {
                format!(
                    "version {} ({}) has a body this app cannot read: {error}",
                    wire.version, wire.kind
                )
            })?
        };
        Ok(Self {
            version: wire.version,
            kind: wire.kind,
            note: wire.note,
            created_by: wire.created_by,
            created_at_ms: wire.created_at_ms,
            parameters: wire.parameters,
            body,
        })
    }
}

/// What a raw version carries under `events`: how many events were taped, or the tape itself.
/// Both shapes parse, and an unexpected third one must not fail the whole detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RecipeTape {
    Count(u64),
    Events(Vec<RecipeTapeEvent>),
    Other(Value),
}

impl RecipeTape {
    /// How many events were taped, whether the tape came with them or only with its size.
    pub fn count(&self) -> u64 {
        match self {
            Self::Count(count) => *count,
            Self::Events(events) => events.len() as u64,
            Self::Other(_) => 0,
        }
    }

    pub fn events(&self) -> Option<&[RecipeTapeEvent]> {
        match self {
            Self::Events(events) => Some(events),
            _ => None,
        }
    }
}

/// One event off a taught tape, mirroring the server's `TapeEvent`. `kind` decides which of the
/// rest matter: `down` and `up` carry a place and a button, `move` a place, `wheel` a place and
/// an amount, `keydown` and `keyup` a key. `at` is the wall clock in milliseconds, so a row's
/// offset is its own `at` less the tape's first.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RecipeTapeEvent {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub y: i32,
    #[serde(default)]
    pub button: i32,
    #[serde(default)]
    pub dx: i32,
    #[serde(default)]
    pub dy: i32,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub at: i64,
}

/// One thing a bot does when a recipe runs. Coordinates are on the recipe's 1280×800 screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RecipeStep {
    Click {
        x: i64,
        y: i64,
        /// The server's word or number for the button, kept as sent so an edit sends it back.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        button: Option<Value>,
    },
    DoubleClick {
        x: i64,
        y: i64,
    },
    Drag {
        x1: i64,
        y1: i64,
        x2: i64,
        y2: i64,
    },
    Type {
        text: String,
    },
    Key {
        key: String,
    },
    Scroll {
        x: i64,
        y: i64,
        dx: i64,
        dy: i64,
    },
    Wait {
        ms: u64,
    },
}

impl RecipeStep {
    /// The step as one readable line: `click (412, 88)`, `type "example.com"`, `wait 500 ms`.
    pub fn describe(&self) -> String {
        match self {
            Self::Click { x, y, button } => {
                // The left button is the one a click means; only another is worth a word.
                let other = button.as_ref().and_then(|button| match button {
                    Value::String(name) if name != "left" => Some(name.clone()),
                    Value::Number(number) if number.as_i64() != Some(0) => Some(number.to_string()),
                    _ => None,
                });
                match other {
                    Some(button) => format!("click ({x}, {y}) button {button}"),
                    None => format!("click ({x}, {y})"),
                }
            }
            Self::DoubleClick { x, y } => format!("double-click ({x}, {y})"),
            Self::Drag { x1, y1, x2, y2 } => format!("drag ({x1}, {y1}) to ({x2}, {y2})"),
            Self::Type { text } => format!("type {text:?}"),
            Self::Key { key } => format!("key {key}"),
            Self::Scroll { x, y, dx, dy } => format!("scroll ({x}, {y}) by ({dx}, {dy})"),
            Self::Wait { ms } => format!("wait {ms} ms"),
        }
    }
}

/// Who a recipe has been shared with (only the owner sees these).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeShare {
    #[serde(default, deserialize_with = "null_as_default")]
    pub recipe_id: String,
    /// `org` or `account`.
    #[serde(default, deserialize_with = "null_as_default")]
    pub scope: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub scope_id: String,
    #[serde(default)]
    pub granted_by: Option<String>,
    #[serde(default)]
    pub granted_at_ms: i64,
    #[serde(default)]
    pub accepted_at_ms: Option<i64>,
    #[serde(default)]
    pub declined_at_ms: Option<i64>,
}

impl RecipeShare {
    /// What the person it went to has done with it.
    pub fn state_label(&self) -> &'static str {
        if self.declined_at_ms.is_some() {
            "declined"
        } else if self.accepted_at_ms.is_some() {
            "accepted"
        } else {
            "pending"
        }
    }
}

/// A bot that may run the recipe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeGrant {
    #[serde(default, deserialize_with = "null_as_default")]
    pub recipe_id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub coworker_id: String,
    #[serde(default)]
    pub granted_by: Option<String>,
    #[serde(default)]
    pub granted_at_ms: i64,
}

/// One past run of the recipe (newest first).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRun {
    /// The run's own id, `rrun_…`, which is what the history names its rows by.
    #[serde(default, deserialize_with = "null_as_default")]
    pub id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub recipe_id: String,
    #[serde(default)]
    pub version: u32,
    #[serde(default, deserialize_with = "null_as_default")]
    pub coworker_id: String,
    #[serde(default)]
    pub ok: bool,
    /// `running`, `finished`, or `interrupted` (opengrok-server `RecipeRunRow::state`, #217),
    /// which the server reads off the lease it holds on a run while something plays it.
    ///
    /// A run is written down before the box is asked to play it, so a running row has
    /// `ok: false` because it has not finished, not because it failed: `ok` alone no longer
    /// says a run went wrong. A server from before the lease names no state, and it wrote a
    /// run down only once the run was over.
    #[serde(default, deserialize_with = "null_as_default")]
    pub state: String,
    /// The step the run stopped at, when it did not finish.
    #[serde(default)]
    pub stopped_at: Option<u64>,
    /// What the box said the run came to, step by step: `{ok, ran, stopped_at, steps}`. The
    /// server keeps it without its picture, so a stored run is what happened, not a gallery.
    #[serde(default)]
    pub receipt: Value,
    #[serde(default)]
    pub at_ms: i64,
}

impl RecipeRun {
    /// Still playing: its `ok` is false only because it has not finished yet.
    pub fn is_running(&self) -> bool {
        self.state == "running"
    }

    /// Its lease ran out with how it ended never written down: whatever was playing it stopped,
    /// or could not write what it came to. What the box did is not known, and its receipt is the
    /// placeholder it started with.
    ///
    /// Not quite an ending on the server, which does not fence a lapsed lease: a run whose
    /// renewals only stalled can read as running again, and one that finishes late is written
    /// down as finished. See `AppState::settle_recipe_run` for how the page waits on one.
    pub fn is_interrupted(&self) -> bool {
        self.state == "interrupted"
    }

    /// Over as the row stands: finished, interrupted, or from a server that wrote runs down only
    /// once they were over. A state this client has no word for is not taken for an ending.
    pub fn is_over(&self) -> bool {
        matches!(self.state.as_str(), "finished" | "interrupted" | "")
    }

    /// How many steps ran: the receipt's `ran`, read the way [`RecipeRunResult::ran_count`]
    /// reads the same word off the run route.
    pub fn ran_count(&self) -> Option<u64> {
        count_ran(self.receipt.get("ran"))
    }

    /// Every step of the run as the box reported it: whether it did what it was asked, and
    /// what went wrong where it did not.
    pub fn receipt_steps(&self) -> Vec<(bool, Option<String>)> {
        self.receipt
            .get("steps")
            .and_then(Value::as_array)
            .map(|steps| {
                steps
                    .iter()
                    .map(|step| {
                        let ok = step.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        let error = step
                            .get("error")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .filter(|error| !error.trim().is_empty());
                        (ok, error)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Why the run stopped, in the box's own words.
    pub fn error(&self) -> Option<String> {
        self.receipt_steps()
            .into_iter()
            .find_map(|(_, error)| error)
            .or_else(|| {
                self.receipt
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|error| !error.trim().is_empty())
    }
}

/// One of the person's own bots, as the detail lists them for grants and runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeBot {
    pub id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub name: String,
}

/// Everything the detail view shows about one recipe.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeDetail {
    pub recipe: RecipeSummary,
    #[serde(default)]
    pub versions: Vec<RecipeVersion>,
    #[serde(default)]
    pub shares: Vec<RecipeShare>,
    #[serde(default)]
    pub grants: Vec<RecipeGrant>,
    #[serde(default)]
    pub runs: Vec<RecipeRun>,
    #[serde(default)]
    pub my_bots: Vec<RecipeBot>,
}

impl RecipeDetail {
    /// The version a run plays: the newest one with steps.
    pub fn runnable_version(&self) -> Option<&RecipeVersion> {
        self.versions
            .iter()
            .filter(|version| version.is_runnable())
            .max_by_key(|version| version.version)
    }

    pub fn is_granted(&self, coworker_id: &str) -> bool {
        self.grants
            .iter()
            .any(|grant| grant.coworker_id == coworker_id)
    }

    /// The bot's name, or its id when it is not one of the person's.
    pub fn bot_name(&self, coworker_id: &str) -> String {
        self.my_bots
            .iter()
            .find(|bot| bot.id == coworker_id)
            .map(|bot| bot.name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| coworker_id.to_string())
    }
}

/// Who a recipe goes to: the whole org, or one person by email (same org only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "scope", rename_all = "lowercase")]
pub enum RecipeShareTarget {
    Org,
    Account { email: String },
}

/// What `POST /recipes/{id}/run` came back with.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRunResult {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub ok: bool,
    /// How many steps ran: a count, or the steps themselves.
    #[serde(default)]
    pub ran: Option<Value>,
    #[serde(default)]
    pub stopped_at: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
    /// The screen after the run, `{mime, base64, width, height}`, when the box has one.
    #[serde(default)]
    pub image: Option<Value>,
}

impl RecipeRunResult {
    pub fn ran_count(&self) -> Option<u64> {
        count_ran(self.ran.as_ref())
    }
}

/// A `ran` as the box writes it: a count, or the steps themselves.
fn count_ran(ran: Option<&Value>) -> Option<u64> {
    match ran {
        Some(Value::Number(count)) => count.as_u64(),
        Some(Value::Array(steps)) => Some(steps.len() as u64),
        _ => None,
    }
}

/// The `202` `POST /recipes/{id}/run` answers a caller that asked not to wait
/// (opengrok-server `recipes::run`, #217): `{recipe, version, runId, state: "running"}`, sent
/// once the run's row is written and before the box has done anything. Only the id is read;
/// what the run came to is on its row, see [`RecipeRun::state`].
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncRunResponse {
    /// The run's own id, `rrun_…`. It is the [`RecipeRun::id`] of the row that will say how
    /// the run went: the server writes the row under the id it answers with.
    pub run_id: String,
}

/// What `POST /recipes/{id}/run` came back with.
#[derive(Debug, Clone, PartialEq)]
pub enum RunRecipeResponse {
    /// `202`: the run is playing on the server, and its row in the history is where it ends.
    Async(AsyncRunResponse),
    /// `200`: a server that played the run before it answered, and answered with the outcome.
    Sync(RecipeRunResult),
}

/// Where a skill's prose came from.
///
/// `Taught` is the server's own word for a body a turn wrote down from a recording, and it
/// refuses a client that claims it — so a skill made from this app is `Authored` or `Uploaded`.
/// Last and the catch-all is `Authored`, because a word this client has no name for is still a
/// skill somebody has: reading it as written-by-hand keeps the row listable, and the alternative
/// is one unknown source taking the whole listing down with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    Uploaded,
    Taught,
    #[default]
    #[serde(other)]
    Authored,
}

impl SkillSource {
    /// The word the server sends and takes.
    pub fn word(self) -> &'static str {
        match self {
            Self::Authored => "authored",
            Self::Uploaded => "uploaded",
            Self::Taught => "taught",
        }
    }

    /// What the row's chip says, or `None` for a skill somebody wrote here — the plainest case,
    /// which needs no label to tell it from itself.
    pub fn chip(self) -> Option<&'static str> {
        match self {
            Self::Authored => None,
            Self::Uploaded => Some("Uploaded"),
            Self::Taught => Some("Taught"),
        }
    }
}

/// One supporting file beside a skill's `SKILL.md`: a reference sheet, a checklist, a short
/// script. Copied onto the coworker's computer before a turn that invokes the skill.
///
/// `bytes` is base64 in both directions, as `/artifacts` does it — a JSON body rather than
/// multipart, so one shape carries the whole bundle. It is the file's content, never its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillFile {
    #[serde(default, deserialize_with = "null_as_default")]
    pub path: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub bytes: String,
}

/// One row of the Skills list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub description: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub source: SkillSource,
    #[serde(default)]
    pub updated_at_ms: i64,
    #[serde(default)]
    pub version_count: u32,
    /// Named and kept, but with no prose in it yet, so there is nothing to invoke.
    #[serde(default)]
    pub draft: bool,
    /// Off means nobody in the org sees it and nothing may run it. The server sends it so a
    /// page that offers the switch can draw it in the state it is actually in.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// When the owner first switched this skill on, and `None` while nobody has.
    ///
    /// Approval as a FACT, which is the one thing `enabled` cannot say on its own: a lesson a
    /// model wrote and nobody has read is off, and a lesson somebody read and deliberately
    /// switched off is also off. The server stamps this the first time an owner switches a
    /// skill on and never unsays it, so off-and-never-stamped is "waiting to be read" and
    /// off-and-stamped is "read, and not wanted".
    ///
    /// `None` by default, so a server from before the stamp existed reads as never approved
    /// rather than as approved at the epoch.
    #[serde(default)]
    pub approved_at_ms: Option<i64>,
}

/// A server that does not send `enabled` is one from before the switch existed, and every skill
/// on it is on. `false` there would switch off a whole library that nobody turned off.
fn yes() -> bool {
    true
}

/// Everything the detail pane shows about one skill: the row, the newest prose, and the files
/// that came with that version.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    #[serde(flatten)]
    pub skill: SkillSummary,
    /// The `SKILL.md` with its frontmatter taken off: what the model reads, and nothing else.
    #[serde(default, deserialize_with = "null_as_default")]
    pub body: String,
    /// Which version that prose is. `0` is a draft: a row with no version at all.
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub files: Vec<SkillFile>,
}

/// What a new skill is made of.
///
/// `body` is the whole `SKILL.md`, frontmatter and all: the server reads the name and the
/// description out of it when the two fields here are blank. Empty leaves a draft.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewSkill {
    pub name: String,
    pub description: String,
    pub body: String,
    pub source: SkillSource,
    pub files: Vec<SkillFile>,
}

/// What a `PUT /skills/{id}` changes. A field left `None` is left alone — which is how the
/// server reads a field that is not in the JSON at all, so absent here is absent there.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

/// One version of a skill: the prose as it stood, and where that prose came from.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersion {
    #[serde(default)]
    pub version: u32,
    #[serde(default, deserialize_with = "null_as_default")]
    pub kind: SkillSource,
    #[serde(default)]
    pub created_at_ms: i64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub note: String,
}

/// How long [`OpenGrokClient::create_skill_from_tape`] is given, which is longer than anything
/// else this client sends.
///
/// Every other route is a database read and takes the client's default. This one waits on a
/// model reading a recording into words, and the server's own bound on that is 60 seconds: a
/// client that gave up sooner would turn a call the server was about to answer into a transport
/// failure with none of the server's sentence in it, and the person would be told the machine
/// could not be reached about a lesson that was written.
pub const SKILL_FROM_TAPE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// The most a skill's instructions may be, in characters.
///
/// The server owns this limit and words its own refusal when a body is over it, naming both the
/// cap and what arrived. The copy here is not a second check — nothing refuses a body on it —
/// it is so that a file far too big to be read at all can be named for what it is not. 64 KiB,
/// as `MAX_SKILL_BODY_CHARS` in opengrok-server `crates/opengrok-plugins/src/skill.rs` (raised
/// from 8000 on gol/service-accounts, uncommitted, to admit published skills).
pub const SKILL_BODY_CHARS: usize = 64 * 1024;

/// The most a skill's supporting files may weigh once decoded, and how many there may be.
///
/// Both are the server's caps, named again here because the app reads a folder off this Mac
/// before it sends any of it: without them a picked folder that is not a skill at all — a
/// checkout, a downloads directory — is read into memory whole, and only then refused.
pub const SKILL_BUNDLE_LIMIT: usize = 256 * 1024;
pub const SKILL_BUNDLE_FILES: usize = 32;

/// What a save sends. The secrets are redacted in Debug.
#[derive(Clone)]
pub struct SiteLoginSave<'a> {
    pub origin: &'a str,
    pub username: &'a str,
    pub label: &'a str,
    pub notes: &'a str,
    pub kind: &'a str,
    pub password: Option<&'a str>,
    pub otpauth: Option<&'a str>,
}

impl std::fmt::Debug for SiteLoginSave<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SiteLoginSave")
            .field("origin", &self.origin)
            .field("username", &self.username)
            .field("kind", &self.kind)
            .finish()
    }
}

/// What a reveal gives back. Redacted in Debug.
#[derive(Clone, PartialEq, Eq)]
pub struct RevealedSecrets {
    pub password: Option<String>,
    pub otpauth: Option<String>,
}

impl std::fmt::Debug for RevealedSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RevealedSecrets")
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("otpauth", &self.otpauth.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// One saved site login as the server lists it. Never the password.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSiteLogin {
    pub id: String,
    pub origin: String,
    pub username: String,
    #[serde(default)]
    pub label: String,
    /// `password`, `code` or `passkey`. Empty from a server that predates kinds.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub last_used_at_ms: Option<i64>,
    #[serde(default)]
    pub updated_at_ms: i64,
}

/// What `PATCH /site-logins/{id}` may change. A field left `None` is left as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct SiteLoginUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::super::error::{Failure, Unreachable};
    use super::super::types::assistant_text_from_sse;
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// A URL nothing is listening on. These tests only ever read the jar, and a base that
    /// cannot be connected to is the guarantee that they never do anything else.
    const NOWHERE: &str = "http://127.0.0.1:1/";

    /// The one word that tells the two apart on a listing that carries both. A kind this client
    /// has never heard of has to land somewhere readable rather than fail the whole listing and
    /// take every recipe on it down with a row nobody asked about.
    #[test]
    fn a_row_says_which_of_the_two_it_is_and_an_unknown_word_is_still_a_row() {
        let listing: Vec<RecipeSummary> = serde_json::from_value(json!([
            { "id": "rcp_1", "name": "tape", "kind": "recipe" },
            { "id": "rcp_2", "name": "tree", "kind": "workflow" },
            { "id": "rcp_3", "name": "older server", "kind": null },
            { "id": "rcp_4", "name": "something new" },
            { "id": "rcp_5", "name": "a word from the future", "kind": "lesson" }
        ]))
        .expect("an unknown kind must not fail the listing");
        assert_eq!(
            listing
                .iter()
                .map(|row| row.kind.label())
                .collect::<Vec<_>>(),
            vec!["Recipe", "Workflow", "Recipe", "Recipe", "Recipe"]
        );
        assert!(listing[1].is_workflow());
        assert!(!listing[4].is_workflow());
    }

    fn put_cookie(client: &OpenGrokClient, set_cookie: &str) {
        let header = HeaderValue::from_str(set_cookie).unwrap();
        CookieStore::set_cookies(client.jar.as_ref(), &mut [header].iter(), &client.base);
    }

    /// A `Set-Cookie` for an access token with an `exp` far enough out that nothing refreshes
    /// before using it.
    ///
    /// Tests that watch what goes over the wire need the client to send exactly one request, and
    /// a token whose expiry cannot be read is a token the client replaces first — rightly, since
    /// that is the whole fix. Assembled rather than written down as a literal, so the file
    /// carries no string shaped like a credential.
    fn live_session() -> String {
        use base64::Engine as _;
        let part = |json: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
        // 2100-01-01, which outlives any test run and any machine running one.
        let token = format!(
            "{}.{}.not-a-signature",
            part(r#"{"alg":"HS256","typ":"JWT"}"#),
            part(r#"{"exp":4102444800}"#)
        );
        format!("og_access={token}; Path=/")
    }

    /// How the token went missing, pinned.
    ///
    /// `Jar::cookies` goes through `cookie_store`'s `matches`, which filters on `is_expired`, so
    /// the moment an access cookie's `Max-Age` passes it stops existing as far as the app is
    /// concerned — indistinguishable from one that was never set. An app left idle past the
    /// token's lifetime therefore had nothing to put in the header, and nothing in the old code
    /// noticed: the freshness check only fired on a token that was still *there*.
    #[test]
    fn an_expired_access_cookie_is_gone_rather_than_old() {
        let client = OpenGrokClient::new(NOWHERE).unwrap();
        put_cookie(&client, "og_access=tok-a; Path=/; Max-Age=300");
        assert_eq!(client.access_token().as_deref(), Some("tok-a"));
        assert!(client.has_session());

        // The server's own expiry arriving, or simply time passing: same thing to the jar.
        put_cookie(&client, "og_access=tok-a; Path=/; Max-Age=0");
        assert_eq!(
            client.access_token(),
            None,
            "the jar hands back nothing, not something stale"
        );
        assert_eq!(
            client.token_seconds_left(),
            None,
            "and there is no `exp` to read, because there is no token to read it from"
        );
        assert!(
            !client.has_session(),
            "nothing left to send and nothing left to trade: this is the signed-out case"
        );
    }

    /// The refresh cookie outliving the access token is a session the app can still rescue.
    #[test]
    fn a_refresh_cookie_alone_is_still_a_session() {
        let client = OpenGrokClient::new(NOWHERE).unwrap();
        put_cookie(&client, "og_refresh=tok-r; Path=/; Max-Age=3600");
        assert_eq!(client.access_token(), None);
        assert!(
            client.has_session(),
            "there is something to trade for a token, so the turn is worth attempting"
        );
    }

    /// The one line of the bug, as a truth table.
    #[test]
    fn a_token_that_cannot_be_read_is_a_token_that_needs_replacing() {
        assert!(
            needs_refresh(None),
            "no readable token is not the same as plenty of time"
        );
        assert!(needs_refresh(Some(0)), "expired to the second");
        assert!(needs_refresh(Some(-600)), "expired ten minutes ago");
        assert!(needs_refresh(Some(29)), "inside the slack");
        assert!(!needs_refresh(Some(31)));
        assert!(!needs_refresh(Some(900)));
    }

    /// The turn does not leave, and the app does not learn that from the server.
    ///
    /// Nothing goes out at all here: there is neither a token to send nor a refresh cookie to
    /// trade for one, so both the turn and the rescue attempt are round trips whose answer the
    /// jar already holds. What used to happen was the `/ag-ui` request going out bare — a round
    /// trip, and a red line in somebody's transcript, for a question already answered.
    #[tokio::test]
    async fn a_turn_is_not_sent_when_there_is_nothing_to_sign_it_with() {
        let server = MockServer::start().await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client
            .run_turn(
                "cw",
                "t",
                "run_1",
                &[],
                None,
                None,
                None,
                None,
                None,
                |_, _| {},
            )
            .await
            .unwrap_err();
        assert!(error.is_signed_out());

        let paths: Vec<String> = server
            .received_requests()
            .await
            .expect("the recorder is on")
            .iter()
            .map(|request| request.url.path().to_string())
            .collect();
        assert!(paths.is_empty(), "nothing went out at all: {paths:?}");
    }

    /// An access token that has expired out of the jar, with the refresh cookie still there.
    ///
    /// Hiding a turn asks the server to withhold it, and a thread says what it withheld.
    ///
    /// The app cannot keep a deleted turn off another machine by itself: a coworker's replies
    /// are runs the server holds, and every machine reads the thread from there.
    #[tokio::test]
    async fn a_hidden_turn_is_asked_for_by_run_and_comes_back_named_in_the_thread() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/runs/run_1/hide"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads/th_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "threadId": "th_1",
                "runs": [],
                "hiddenRunIds": ["run_1"],
            })))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        client.hide_run("run_1").await.expect("the server takes it");

        let thread = client.replay_thread("th_1", 5).await.expect("the thread");
        assert_eq!(
            thread.hidden_run_ids,
            vec!["run_1".to_string()],
            "so this machine can put its own copy out of sight"
        );
        assert!(thread.runs.is_empty(), "and it is not offered again");
    }

    /// A server that answers with nothing where a list would be is still a thread that reads.
    #[tokio::test]
    async fn a_thread_whose_hidden_list_is_nothing_at_all_still_reads() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads/th_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "threadId": "th_1",
                "runs": [],
                "hiddenRunIds": serde_json::Value::Null,
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let thread = client.replay_thread("th_1", 5).await.expect("the thread");
        assert!(thread.hidden_run_ids.is_empty());
    }

    /// A server that predates hiding says nothing about it, and the thread still reads.
    #[tokio::test]
    async fn a_thread_from_a_server_that_does_not_know_about_hiding_still_reads() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads/th_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "threadId": "th_1",
                "runs": [],
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let thread = client.replay_thread("th_1", 5).await.expect("the thread");
        assert!(thread.hidden_run_ids.is_empty());
        assert!(
            thread.pending_user_messages.is_none(),
            "a server that predates pending follow-ups must not look like an empty queue"
        );
        assert!(
            thread.pending_events.is_none(),
            "and pendingEvents is the same omission"
        );
        assert!(thread.live_pending_messages().is_none());
    }

    /// OpenGrok #171: the thread snapshot carries the live queue beside `runs`, never inside them.
    #[tokio::test]
    async fn a_thread_names_its_pending_follow_ups_beside_the_runs() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads/th_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "threadId": "th_1",
                "runs": [],
                "pendingUserMessages": [{
                    "v": 1,
                    "id": "pum_1",
                    "threadId": "th_1",
                    "content": "send this after the turn",
                    "clientMessageId": "msg_bubble_1",
                    "status": "pending",
                    "createdAtMs": 10,
                    "updatedAtMs": 10
                }],
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let thread = client.replay_thread("th_1", 5).await.expect("the thread");
        let pending = thread.pending_user_messages.expect("the field is present");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "pum_1");
        assert_eq!(pending[0].bubble_id(), "msg_bubble_1");
        assert_eq!(pending[0].content, "send this after the turn");
    }

    /// Empty array is "none pending", not "the server has never heard of this".
    #[tokio::test]
    async fn an_empty_pending_list_on_a_thread_is_none_held() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads/th_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "threadId": "th_1",
                "runs": [],
                "pendingUserMessages": [],
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let thread = client.replay_thread("th_1", 5).await.expect("the thread");
        assert_eq!(
            thread.pending_user_messages.as_deref(),
            Some(&[][..]),
            "so a hydrate can drop synced holds that another machine canceled"
        );
        assert!(thread.pending_events.is_none());
        assert_eq!(thread.live_pending_messages().as_deref(), Some(&[][..]));
    }

    #[tokio::test]
    async fn a_thread_prefers_pending_event_snapshots_over_the_row_list() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads/th_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "threadId": "th_1",
                "runs": [],
                "pendingUserMessages": [{
                    "id": "pum_stale",
                    "content": "from the row list",
                    "clientMessageId": "msg_stale"
                }],
                "pendingEvents": [{
                    "type": "CUSTOM",
                    "name": "pending-user-message",
                    "value": {
                        "v": 1,
                        "op": "snapshot",
                        "threadId": "th_1",
                        "message": {
                            "id": "pum_1",
                            "content": "from the event",
                            "clientMessageId": "msg_1"
                        }
                    }
                }]
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let thread = client.replay_thread("th_1", 5).await.expect("the thread");
        let live = thread.live_pending_messages().expect("events are present");
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].bubble_id(), "msg_1");
        assert_eq!(live[0].content, "from the event");
    }

    // ---- The account's list of threads (opengrok-server#230) --------------------------------

    /// The list is every thread of the bearer's account, so nothing names a coworker. A thread
    /// with no coworker or no title comes as `null`, and reads as having none rather than
    /// failing the page it is on.
    #[tokio::test]
    async fn the_thread_list_asks_for_every_coworker_and_reads_a_null_as_nothing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads"))
            .and(wiremock::matchers::query_param("limit", "50"))
            .and(wiremock::matchers::query_param_is_missing("coworkerId"))
            .and(wiremock::matchers::query_param_is_missing("before"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {
                    "threadId": "cw_1", "coworkerId": "cw_1", "origin": "chat",
                    "title": "Book a table for two", "lastRunId": "run_2",
                    "lastStatus": "finished", "updatedAtMs": 1790000000000i64
                },
                {
                    "threadId": "sch_1", "coworkerId": null, "origin": "schedule",
                    "title": null, "lastRunId": "run_1", "lastStatus": "failed",
                    "updatedAtMs": 1789000000000i64
                }
            ])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let rows = client
            .list_threads(None, None, Some(50))
            .await
            .expect("the list");
        assert_eq!(
            rows[0],
            ThreadListing {
                thread_id: "cw_1".into(),
                coworker_id: Some("cw_1".into()),
                origin: "chat".into(),
                title: Some("Book a table for two".into()),
                last_run_id: "run_2".into(),
                last_status: "finished".into(),
                updated_at_ms: 1_790_000_000_000,
            }
        );
        assert_eq!(rows[1].thread_id, "sch_1");
        assert_eq!(rows[1].coworker_id, None);
        assert_eq!(rows[1].title, None);
        assert_eq!(rows[1].origin, "schedule");
        assert_eq!(rows.len(), 2);
    }

    /// The next page is asked for by the last row's time and id together, and the id arrives as
    /// the server wrote it, whatever letters are in it. A page with nothing on it is an answer.
    #[tokio::test]
    async fn the_next_page_is_asked_for_by_the_last_rows_time_and_id() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads"))
            .and(wiremock::matchers::query_param("before", "1790000000000"))
            .and(wiremock::matchers::query_param("beforeThreadId", "th 1&2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let rows = client
            .list_threads(Some(1_790_000_000_000), Some("th 1&2"), None)
            .await
            .expect("an empty page is still a page");
        assert!(
            rows.is_empty(),
            "an account with no more history, not an error"
        );
    }

    /// A thread id with no time is what the server refuses with a `400`, because answering it
    /// would hand a pager page one again. Refused here, it never leaves.
    #[tokio::test]
    async fn a_thread_id_cursor_with_no_time_is_refused_before_it_leaves() {
        let server = MockServer::start().await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client
            .list_threads(None, Some("cw_1"), None)
            .await
            .unwrap_err();
        assert_eq!(error.status, None, "the server was never asked");
        let paths: Vec<String> = server
            .received_requests()
            .await
            .expect("the recorder is on")
            .iter()
            .map(|request| request.url.path().to_string())
            .collect();
        assert!(paths.is_empty(), "nothing went out at all: {paths:?}");
    }

    /// A store that could not answer is a `503` the caller can tell apart from everything else,
    /// and a session the server does not recognise is the session being gone, as on every other
    /// route.
    #[tokio::test]
    async fn an_unavailable_thread_list_and_a_signed_out_one_are_told_apart() {
        let unavailable = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads"))
            .respond_with(
                ResponseTemplate::new(503)
                    .set_body_json(json!({ "error": "the thread list is unavailable" })),
            )
            .mount(&unavailable)
            .await;
        let client = OpenGrokClient::new(&unavailable.uri()).unwrap();
        let error = client.list_threads(None, None, None).await.unwrap_err();
        assert_eq!(error.status, Some(503));
        assert_eq!(error.message, "the thread list is unavailable");
        assert!(!error.is_signed_out());

        let refused = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(json!({ "error": "sign in first" })),
            )
            .mount(&refused)
            .await;
        let client = OpenGrokClient::new(&refused.uri()).unwrap();
        let error = client.list_threads(None, None, None).await.unwrap_err();
        assert!(error.is_signed_out(), "{error}");
        assert_eq!(error.message, "sign in first");
    }

    /// A row without its time is not a thread from 1970 whose time is also the cursor that ends
    /// the list: the server always sends one, and a page without it is refused as a page.
    #[tokio::test]
    async fn a_thread_row_without_its_time_is_refused() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
                "threadId": "cw_1", "coworkerId": "cw_1", "origin": "chat",
                "title": null, "lastRunId": "run_1", "lastStatus": "finished"
            }])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client.list_threads(None, None, None).await.unwrap_err();
        assert_eq!(error.unreachable(), None, "the server answered: {error}");
        assert!(!error.is_signed_out());
    }

    /// The queue's four routes as the v1 contract writes them. A send queued with a door
    /// carries it (`inferenceSource`, opengrok-server #294), and the row the server answers with
    /// names it back.
    #[tokio::test]
    async fn enqueue_edit_cancel_and_list_pending_follow_the_v1_contract() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/threads/th_1/pending"))
            .and(wiremock::matchers::body_partial_json(serde_json::json!({
                "content": "later",
                "clientMessageId": "msg_1",
                "inferenceSource": "local_proxy"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "v": 1,
                "threadId": "th_1",
                "pendingUserMessage": {
                    "v": 1,
                    "id": "pum_1",
                    "threadId": "th_1",
                    "content": "later",
                    "clientMessageId": "msg_1",
                    "status": "pending",
                    "inferenceSource": "local_proxy"
                },
                "event": {
                    "type": "CUSTOM",
                    "name": "pending-user-message",
                    "value": { "v": 1, "op": "created", "threadId": "th_1" }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/ag-ui/threads/th_1/pending/pum_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "v": 1,
                "threadId": "th_1",
                "pendingUserMessage": {
                    "v": 1,
                    "id": "pum_1",
                    "content": "instead",
                    "clientMessageId": "msg_1",
                    "status": "pending"
                },
                "event": {
                    "type": "CUSTOM",
                    "name": "pending-user-message",
                    "value": {
                        "v": 1,
                        "op": "edited",
                        "threadId": "th_1",
                        "message": {
                            "v": 1,
                            "id": "pum_1",
                            "content": "instead",
                            "clientMessageId": "msg_1",
                            "status": "pending"
                        }
                    }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/ag-ui/threads/th_1/pending/pum_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "v": 1,
                "threadId": "th_1",
                "event": {
                    "type": "CUSTOM",
                    "name": "pending-user-message",
                    "value": { "v": 1, "op": "canceled", "threadId": "th_1" }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads/th_1/pending"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "v": 1,
                "threadId": "th_1",
                "pendingUserMessages": [],
                "pendingEvents": []
            })))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let created = client
            .enqueue_pending_user_message(
                "th_1",
                &crate::opengrok::PendingWrite::enqueue(
                    "later".into(),
                    "msg_1".into(),
                    None,
                    None,
                    None,
                    None,
                    Some(crate::opengrok::InferenceKind::LocalProxy.into()),
                ),
            )
            .await
            .expect("created");
        let created_row = created.row().expect("created row");
        assert_eq!(created_row.id, "pum_1");
        assert_eq!(created_row.bubble_id(), "msg_1");
        assert_eq!(
            created_row.inference_source(),
            Some(crate::opengrok::InferenceKind::LocalProxy.into())
        );
        assert_eq!(
            created.custom().map(|custom| custom.op),
            Some(crate::opengrok::PendingOp::Created)
        );

        let edited = client
            .edit_pending_user_message(
                "th_1",
                "pum_1",
                &crate::opengrok::PendingWrite::content_patch("instead".into()),
            )
            .await
            .expect("edited");
        assert_eq!(edited.row().expect("edited row").content, "instead");
        assert_eq!(
            edited.custom().map(|custom| custom.op),
            Some(crate::opengrok::PendingOp::Edited)
        );

        let canceled = client
            .cancel_pending_user_message("th_1", "pum_1")
            .await
            .expect("canceled");
        assert_eq!(
            canceled.custom().map(|custom| custom.op),
            Some(crate::opengrok::PendingOp::Canceled)
        );
        assert!(canceled.row().is_none(), "canceled omits the message");

        let listed = client
            .list_pending_user_messages("th_1")
            .await
            .expect("listed");
        assert_eq!(listed.v, 1);
        assert!(listed.pending_user_messages.is_empty());
        assert_eq!(listed.pending_events.as_deref(), Some(&[][..]));
        assert!(listed.live_messages().is_empty());

        let requests = server.received_requests().await.expect("the four calls");
        let post: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(
            post,
            json!({
                "v": 1,
                "content": "later",
                "clientMessageId": "msg_1",
                "inferenceSource": "local_proxy",
            })
        );
        let patch: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(patch, json!({ "v": 1, "content": "instead" }));
        assert_eq!(requests[2].method.as_str(), "DELETE");
    }

    /// A 404 on the pending routes is not a verdict about the send: keep the local queue.
    #[tokio::test]
    async fn a_missing_pending_route_is_a_404_the_caller_can_fall_back_from() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads/th_1/pending"))
            .respond_with(ResponseTemplate::new(404).set_body_string("no such thread"))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let error = client
            .list_pending_user_messages("th_1")
            .await
            .expect_err("old OpenGrok");
        assert!(error.is_not_found());
    }

    /// Drain names the queued send so two machines cannot both fire it.
    #[tokio::test]
    async fn a_queued_turn_carries_pending_id_in_forwarded_props() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(
                        "data: {\"type\":\"RUN_FINISHED\",\"runId\":\"r\"}\n\n".to_string(),
                    ),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        client
            .run_turn(
                "cw_1",
                "th_1",
                "run_1",
                &[AguiMessage {
                    id: "msg_1".into(),
                    role: "user".into(),
                    content: "later".into(),
                    tool_call_id: None,
                    reply_to: None,
                    attachments: Vec::new(),
                }],
                None,
                None,
                Some("pum_1"),
                None,
                None,
                |_, _| {},
            )
            .await
            .unwrap();
        let requests = server.received_requests().await.expect("the turn");
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(
            body["forwardedProps"],
            json!({ "coworkerId": "cw_1", "pendingId": "pum_1" })
        );
        assert_eq!(body["messages"][0]["id"], "msg_1");
    }

    /// A retry names the run whose reply it sends again, as `retryOf`, and never a queued send
    /// beside it: beside `pendingId` the server reads no `retryOf`, and fires or refuses the send
    /// as a send (opengrok-server #300, server main 06db932 (#309, after #308), pin b6ca457:
    /// `consume_for_turn` in `crates/opengrok-server/src/agui/pending.rs`). An empty run is no
    /// retry, and a queued send named with it goes as it always has.
    #[tokio::test]
    async fn a_retry_names_the_run_it_retries_and_never_a_queued_send() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(
                        "data: {\"type\":\"RUN_FINISHED\",\"runId\":\"r\"}\n\n".to_string(),
                    ),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        for (run, retry_of) in [("run_2", Some("run_1")), ("run_3", Some(""))] {
            client
                .run_turn(
                    "cw_1",
                    "th_1",
                    run,
                    &[],
                    None,
                    None,
                    Some("pum_1"),
                    retry_of,
                    None,
                    |_, _| {},
                )
                .await
                .unwrap();
        }
        let requests = server.received_requests().await.expect("the turns");
        let props: Vec<Value> = requests
            .iter()
            .map(|request| serde_json::from_slice::<Value>(&request.body).unwrap())
            .map(|body| body["forwardedProps"].clone())
            .collect();
        assert_eq!(
            props,
            [
                json!({ "coworkerId": "cw_1", "retryOf": "run_1" }),
                json!({ "coworkerId": "cw_1", "pendingId": "pum_1" }),
            ]
        );
    }

    /// OpenGrok's 409 for a queued send whose row changed carries the row as it stands now. The
    /// queue knows it by its code, and the person is told the server's sentence: in the shape the
    /// server keeps for the queue's refusals (the code under `error`, the sentence under
    /// `message`), and in the one it writes every other code in (the sentence under `error`, the
    /// code under `code`), so the queue does not hang on which of the two it is sent.
    #[tokio::test]
    async fn a_stale_queued_turn_keeps_the_row_the_server_answered_with() {
        let said = "This queued message changed. Refresh it before sending again.";
        for (error, words) in [
            ("stale-pending-message", json!({ "message": said })),
            (said, json!({ "code": "stale-pending-message" })),
        ] {
            let error = stale_turn(error, words).await;
            assert!(error.is_stale_pending(), "{error:?}");
            assert_eq!(error.code(), Some("stale-pending-message"));
            assert_eq!(error.message, said);
            let custom = error.pending_custom().expect("the row as it stands");
            assert_eq!(custom.op, crate::opengrok::PendingOp::Edited);
            assert_eq!(
                custom.message.map(|row| row.content).as_deref(),
                Some("the laptop's words")
            );
        }
    }

    /// A turn refused as stale, with `error` and the rest of `words` as the body's other fields.
    async fn stale_turn(error: &str, words: Value) -> OpenGrokError {
        let mut body = json!({
                "v": 1,
                "error": error,
                "id": "pum_1",
                "runId": null,
                "event": {
                    "type": "CUSTOM",
                    "timestamp": 1710000000000i64,
                    "name": "pending-user-message",
                    "value": {
                        "v": 1,
                        "op": "edited",
                        "threadId": "th_1",
                        "message": {
                            "v": 1,
                            "id": "pum_1",
                            "threadId": "th_1",
                            "content": "the laptop's words",
                            "clientMessageId": "msg_1",
                            "status": "pending",
                        },
                    },
                },
        });
        if let (Some(body), Some(words)) = (body.as_object_mut(), words.as_object()) {
            body.extend(words.clone());
        }
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(ResponseTemplate::new(409).set_body_json(body))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        client
            .run_turn(
                "cw_1",
                "th_1",
                "run_1",
                &[],
                None,
                None,
                Some("pum_1"),
                None,
                None,
                |_, _| {},
            )
            .await
            .expect_err("refused")
    }

    /// A turn sent under a run id that already has a run is refused with a code and a sentence
    /// beside it: `{"error": sentence, "code": "run-exists"}` from opengrok-server's error-bodies
    /// change on (`agui/routes.rs` `run_taken`, as `fixtures/wire/rest/POST__ag-ui/409-another_account_cannot_take_a_run_by_its_id`
    /// records it), and the code under `error` with the sentence under `message` before it. The
    /// person used to be shown the code, `run-exists`; in either shape they are shown the
    /// sentence, and the code is kept for a caller, and read as none of the queue's words.
    #[tokio::test]
    async fn a_refusal_with_a_code_and_a_sentence_shows_the_sentence() {
        let said = "this run id already has a run; a new turn needs a new run id";
        for body in [
            json!({ "error": "run-exists", "message": said }),
            json!({ "error": said, "code": "run-exists" }),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/ag-ui"))
                .respond_with(ResponseTemplate::new(409).set_body_json(&body))
                .mount(&server)
                .await;
            let client = OpenGrokClient::new(&server.uri()).unwrap();
            put_cookie(&client, &live_session());
            let error = client
                .run_turn(
                    "cw_1",
                    "th_1",
                    "run_1",
                    &[],
                    None,
                    None,
                    None,
                    None,
                    None,
                    |_, _| {},
                )
                .await
                .expect_err("refused");
            assert_eq!(error.status, Some(409));
            assert_eq!(error.message, said, "{body}");
            assert_eq!(error.code(), Some("run-exists"), "{body}");
            assert!(
                !error.is_stale_pending()
                    && !error.is_already_consumed()
                    && !error.is_not_pending()
            );
        }
    }

    /// A 502 or 503 the server writes itself carries its sentence as JSON, and is its verdict
    /// about the request, told apart from one nothing says the server wrote. The box being down
    /// (`POST /recipes/{id}/run`, recorded as the 502 in
    /// `fixtures/wire/rest/POST__recipes__id__run/`) used to read as the server out of reach,
    /// so the recipe page offered it again and reloaded as if the run might have started.
    #[tokio::test]
    async fn a_five_hundred_the_server_wrote_is_its_verdict_and_a_proxys_is_not() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/recipes/rcp_down/run"))
            .respond_with(ResponseTemplate::new(502).set_body_json(json!({
                "error": "the box is unreachable: the stand-in box is down"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/recipes"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({
                "error": "the recipe was not kept: its raw version could not be stored"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/recipes/rcp_proxy/run"))
            .respond_with(
                ResponseTemplate::new(502)
                    .set_body_string("<html><body>502 Bad Gateway</body></html>"),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/recipes/rcp_quiet/run"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();

        let down = client.run_recipe("rcp_down", "cw_1").await.unwrap_err();
        assert_eq!(down.status, Some(502));
        assert_eq!(
            down.message,
            "the box is unreachable: the stand-in box is down"
        );
        assert_eq!(down.failure(), Failure::Verdict, "the server answered");
        let kept = client.create_recipe("Pay", "", &[]).await.unwrap_err();
        assert_eq!(kept.failure(), Failure::Verdict, "{kept:?}");

        for id in ["rcp_proxy", "rcp_quiet"] {
            let lost = client.run_recipe(id, "cw_1").await.unwrap_err();
            assert_eq!(
                lost.unreachable(),
                Some(Unreachable::Server),
                "nothing says the server wrote this: {lost:?}"
            );
        }
    }

    /// This is today's bug end to end. The app looks signed in, has nothing to put in the
    /// header, and used to send the turn regardless. It now trades the refresh cookie for a
    /// token first and the turn goes out carrying it — no banner, no red line, nobody told.
    #[tokio::test]
    async fn an_expired_token_is_refreshed_before_the_turn_rather_than_sent_without_one() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/refresh"))
            .respond_with(
                ResponseTemplate::new(200).append_header("set-cookie", live_session().as_str()),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string("data: {\"type\":\"RUN_FINISHED\",\"runId\":\"r\"}\n\n"),
            )
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        // What the jar looks like after an access cookie's `Max-Age` passes: the refresh cookie
        // is all that is left, and the app is still showing a roster.
        put_cookie(&client, "og_refresh=tok-r; Path=/; Max-Age=3600");
        client
            .run_turn(
                "cw",
                "t",
                "run_1",
                &[],
                None,
                None,
                None,
                None,
                None,
                |_, _| {},
            )
            .await
            .expect("the turn goes out, on a token the app fetched for itself");

        let turn = server
            .received_requests()
            .await
            .expect("the recorder is on")
            .into_iter()
            .find(|request| request.url.path() == "/ag-ui")
            .expect("the turn was sent");
        assert!(
            turn.headers.contains_key("authorization"),
            "and it carried a bearer, which is the whole of the bug: auth_len was 0"
        );
    }

    /// A `401` on a turn is the session, not a verdict about the turn.
    ///
    /// The server's sentence is kept and is not what decides this: the status and the route are.
    /// Matching on the words would tie the app to copy the server is free to rewrite, and this
    /// one has already been rewritten once.
    #[tokio::test]
    async fn a_401_on_a_turn_reads_as_the_session_being_gone() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "error": "this turn names a coworker but says whose it is nowhere — sign in again"
            })))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let error = client
            .run_turn(
                "cw",
                "t",
                "run_1",
                &[],
                None,
                None,
                None,
                None,
                None,
                |_, _| {},
            )
            .await
            .unwrap_err();
        assert!(error.is_signed_out());
        assert_eq!(
            error.unreachable(),
            None,
            "the server answered, so nothing is out of reach and nothing is reconnecting"
        );
        assert!(
            error.message.contains("sign in again"),
            "the server's own words survive: {}",
            error.message
        );
    }

    /// A refusal on a turn with a reason stays a verdict, and still reaches the transcript.
    #[tokio::test]
    async fn a_refusal_on_a_turn_is_still_a_verdict() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(ResponseTemplate::new(402).set_body_json(json!({
                "error": "spend cap reached for this org"
            })))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let error = client
            .run_turn(
                "cw",
                "t",
                "run_1",
                &[],
                None,
                None,
                None,
                None,
                None,
                |_, _| {},
            )
            .await
            .unwrap_err();
        assert!(!error.is_signed_out(), "nobody should be asked to sign in");
        assert_eq!(error.unreachable(), None);
        assert_eq!(error.message, "spend cap reached for this org");
    }

    #[tokio::test]
    async fn login_sets_cookies_and_me_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .and(body_json(json!({"email":"a@b.c","password":"secret"})))
            .respond_with(
                ResponseTemplate::new(200)
                    .append_header(
                        "set-cookie",
                        "og_access=tok-a; HttpOnly; Path=/; SameSite=Lax",
                    )
                    .append_header(
                        "set-cookie",
                        "og_refresh=tok-r; HttpOnly; Path=/; SameSite=Lax",
                    )
                    .set_body_json(json!({"email":"a@b.c"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/account"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "acc_1",
                "email": "a@b.c",
                "firstName": "Ada",
                "lastName": "Lovelace",
                "avatarUrl": null,
                "orgId": "org_1",
                "verified": true,
                "enabled": true,
                "isAdmin": false
            })))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        client.login("a@b.c", "secret").await.unwrap();
        let me = client.me().await.unwrap();
        assert_eq!(me.email, "a@b.c");
        assert_eq!(me.display_name(), "Ada Lovelace");
    }

    #[tokio::test]
    async fn session_file_survives_a_new_client() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(
                ResponseTemplate::new(200)
                    .append_header(
                        "set-cookie",
                        "og_access=tok-a; HttpOnly; Path=/; SameSite=Lax",
                    )
                    .append_header(
                        "set-cookie",
                        "og_refresh=tok-r; HttpOnly; Path=/; SameSite=Lax",
                    ),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/account"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "acc_1",
                "email": "a@b.c",
                "firstName": "Ada",
                "lastName": "Lovelace",
                "avatarUrl": null,
                "orgId": "org_1",
                "verified": true,
                "enabled": true,
                "isAdmin": false
            })))
            .mount(&server)
            .await;

        let dir = std::env::temp_dir().join(format!("nativechat-session-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("opengrok-session.json");
        let client = OpenGrokClient::new(&server.uri())
            .unwrap()
            .with_session_file(path.clone());
        client.login("a@b.c", "secret").await.unwrap();
        assert!(path.exists());

        let restored = OpenGrokClient::new(&server.uri())
            .unwrap()
            .with_session_file(path.clone());
        assert!(restored.load_session());
        let me = restored.me().await.unwrap();
        assert_eq!(me.email, "a@b.c");
        restored.clear_session();
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn login_401_is_distinguishable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error":"bad password"})))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let err = client.login("a@b.c", "nope").await.unwrap_err();
        assert!(err.is_unauthorized());
        assert_eq!(err.message, "bad password");
    }

    #[tokio::test]
    async fn refresh_without_cookie_is_unauthorized() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/refresh"))
            .respond_with(ResponseTemplate::new(401).set_body_string("no session"))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let err = client.refresh().await.unwrap_err();
        assert!(err.is_unauthorized());
    }

    /// Burst after access TTL: two refresh() callers must join one POST.
    /// OpenGrok `/auth/refresh` is one-time rotate today (grace for the
    /// just-rotated-away cookie is shipping and idempotent). NativeChat
    /// single-flight is still required: a second POST 401 used to clear_session.
    #[tokio::test]
    async fn concurrent_refresh_is_single_flight_and_session_survives() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/refresh"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_millis(200))
                    .append_header("set-cookie", live_session().as_str())
                    .append_header("set-cookie", "og_refresh=tok-r2; Path=/; Max-Age=3600"),
            )
            .mount(&server)
            .await;

        let dir = std::env::temp_dir().join(format!("nativechat-refresh-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("opengrok-session.json");
        let client = OpenGrokClient::new(&server.uri())
            .unwrap()
            .with_session_file(path.clone());
        put_cookie(&client, "og_refresh=tok-r; Path=/; Max-Age=3600");
        assert!(client.access_token().is_none());
        assert!(client.has_session());

        let a = client.clone();
        let b = client.clone();
        let (ra, rb) = tokio::join!(a.refresh(), b.refresh());
        ra.expect("first refresh");
        rb.expect("joined refresh");

        let refresh_posts = server
            .received_requests()
            .await
            .expect("the recorder is on")
            .iter()
            .filter(|request| request.url.path() == "/auth/refresh")
            .count();
        assert_eq!(
            refresh_posts, 1,
            "concurrent refresh must join one POST /auth/refresh, got {refresh_posts}"
        );
        assert!(client.has_session(), "session must survive the join");
        assert!(
            client.access_token().is_some(),
            "jar holds the new access cookie"
        );
        assert!(
            path.exists(),
            "save_session kept the file; did not clear_session"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// `ensure_fresh_token` on a burst of requests (idle past access TTL) is
    /// the live path that painted SignedOut. Both `/account` calls join one refresh.
    #[tokio::test]
    async fn concurrent_ensure_fresh_token_joins_one_refresh() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/refresh"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_millis(200))
                    .append_header("set-cookie", live_session().as_str())
                    .append_header("set-cookie", "og_refresh=tok-r2; Path=/; Max-Age=3600"),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/account"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "acc_1",
                "email": "a@b.c",
                "firstName": "Ada",
                "lastName": "Lovelace",
                "avatarUrl": null,
                "orgId": "org_1",
                "verified": true,
                "enabled": true,
                "isAdmin": false
            })))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, "og_refresh=tok-r; Path=/; Max-Age=3600");
        let a = client.clone();
        let b = client.clone();
        let (ma, mb) = tokio::join!(a.me(), b.me());
        ma.expect("first me");
        mb.expect("second me");

        let refresh_posts = server
            .received_requests()
            .await
            .expect("the recorder is on")
            .iter()
            .filter(|request| request.url.path() == "/auth/refresh")
            .count();
        assert_eq!(
            refresh_posts, 1,
            "ensure_fresh_token burst must join one POST /auth/refresh, got {refresh_posts}"
        );
        assert!(client.has_session());
        assert!(client.access_token().is_some());
    }

    #[tokio::test]
    async fn empty_roster_is_empty_vec() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let list = client.list_coworkers().await.unwrap();
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn hire_posts_name() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/coworkers"))
            .and(body_json(json!({"name":"NativeChat"})))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "id": "cw_1",
                "name": "NativeChat",
                "model": "xai/grok-4.6"
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let hired = client.hire("NativeChat", None).await.unwrap();
        assert_eq!(hired.id, "cw_1");
        assert_eq!(hired.model, "xai/grok-4.6");
    }

    /// The Add sheet's title, notes and kind ride along with the login; the reply's new
    /// fields read, and a reply without them still reads.
    #[tokio::test]
    async fn save_site_login_sends_label_notes_and_kind() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/site-logins"))
            .and(body_json(json!({
                "origin": "github.com",
                "username": "ada",
                "label": "Work GitHub",
                "notes": "Security: hardware key",
                "kind": "password",
                "password": "hunter2"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "id": "sl_1",
                "origin": "github.com",
                "username": "ada",
                "label": "Work GitHub",
                "kind": "password",
                "notes": "Security: hardware key",
                "lastUsedAtMs": null,
                "updatedAtMs": 1700000000000i64
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let saved = client
            .save_site_login(
                "github.com",
                "ada",
                "Work GitHub",
                "Security: hardware key",
                "password",
                "hunter2",
            )
            .await
            .unwrap();
        assert_eq!(saved.id, "sl_1");
        assert_eq!(saved.kind, "password");
        assert_eq!(saved.notes, "Security: hardware key");
        assert_eq!(saved.last_used_at_ms, None);
        assert_eq!(saved.updated_at_ms, 1700000000000);

        let older: RemoteSiteLogin = serde_json::from_value(json!({
            "id": "sl_2", "origin": "x.com", "username": "bea"
        }))
        .unwrap();
        assert_eq!(older.kind, "");
        assert_eq!(older.notes, "");
        assert_eq!(older.last_used_at_ms, None);
    }

    /// Only the field that changed is sent; the reply is the row as the server now has it.
    #[tokio::test]
    async fn update_site_login_patches_the_notes_alone() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/site-logins/sl_1"))
            .and(body_json(json!({ "notes": "Security: call first" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "sl_1",
                "origin": "github.com",
                "username": "ada",
                "label": "Work GitHub",
                "kind": "password",
                "notes": "Security: call first",
                "lastUsedAtMs": 1700000000000i64,
                "updatedAtMs": 1700000001000i64
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let updated = client
            .update_site_login(
                "sl_1",
                &SiteLoginUpdate {
                    notes: Some("Security: call first".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.notes, "Security: call first");
        assert_eq!(updated.last_used_at_ms, Some(1700000000000));
    }

    /// A site's icon is its bytes on 200 and nothing on 204 (or on a server without the
    /// route); anything else is the server's own error.
    #[tokio::test]
    async fn site_login_icon_reads_bytes_on_200_and_nothing_on_204() {
        let server = MockServer::start().await;
        let png = b"\x89PNG\r\n\x1a\nnot really a picture".to_vec();
        Mock::given(method("GET"))
            .and(path("/site-logins/icon/github.com"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "image/png")
                    .set_body_bytes(png.clone()),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/site-logins/icon/nowhere.example"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/site-logins/icon/broken.example"))
            .respond_with(ResponseTemplate::new(500).set_body_json(json!({ "error": "no" })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        assert_eq!(
            client.site_login_icon("github.com").await.unwrap(),
            Some(png)
        );
        assert_eq!(
            client.site_login_icon("nowhere.example").await.unwrap(),
            None
        );
        assert_eq!(
            client.site_login_icon("never-asked.example").await.unwrap(),
            None,
            "a server without the route is a site without an icon"
        );
        assert!(client.site_login_icon("broken.example").await.is_err());
    }

    #[test]
    fn sse_collects_text_deltas() {
        let body = concat!(
            "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t\",\"runId\":\"r\"}\n\n",
            "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"m1\",\"role\":\"assistant\"}\n\n",
            "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"Hello\"}\n\n",
            "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\" world\"}\n\n",
            "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"m1\"}\n\n",
            "data: {\"type\":\"RUN_FINISHED\",\"runId\":\"r\"}\n\n",
        );
        assert_eq!(assistant_text_from_sse(body).unwrap(), "Hello world");
    }

    /// The person's words opening a run are not collected as the reply.
    #[test]
    fn sse_leaves_the_persons_words_out_of_the_reply() {
        let body = concat!(
            "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t\",\"runId\":\"r\"}\n\n",
            "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"u1\",\"role\":\"user\"}\n\n",
            "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"u1\",\"delta\":\"Hi there\"}\n\n",
            "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"u1\"}\n\n",
            "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"m1\",\"role\":\"assistant\"}\n\n",
            "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"Hello\"}\n\n",
            "data: {\"type\":\"RUN_FINISHED\",\"runId\":\"r\"}\n\n",
        );
        assert_eq!(assistant_text_from_sse(body).unwrap(), "Hello");
    }

    #[tokio::test]
    async fn run_turn_forwards_sse_frames_as_they_arrive() {
        use std::time::{Duration, Instant};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            socket.set_nodelay(true).unwrap();
            let mut socket = socket;
            let mut buf = vec![0u8; 8192];
            let _ = socket.read(&mut buf).await;
            let frames = [
                "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t\",\"runId\":\"r\"}\n\n",
                "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"m1\",\"role\":\"assistant\"}\n\n",
                "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"Hello\"}\n\n",
                "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\" world\"}\n\n",
                "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"m1\"}\n\n",
                "data: {\"type\":\"RUN_FINISHED\",\"runId\":\"r\"}\n\n",
            ];
            let body: String = frames.concat();
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
            for frame in frames {
                socket.write_all(frame.as_bytes()).await.unwrap();
                socket.flush().await.unwrap();
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        });

        let client = OpenGrokClient::new(&format!("http://{addr}")).unwrap();
        put_cookie(&client, &live_session());
        let first_at = std::sync::Arc::new(std::sync::Mutex::new(None::<Instant>));
        let start = Instant::now();
        let text = client
            .run_turn(
                "cw",
                "t",
                "run_1",
                &[AguiMessage {
                    id: "u1".into(),
                    role: "user".into(),
                    content: "hi".into(),
                    tool_call_id: None,
                    reply_to: None,
                    attachments: Vec::new(),
                }],
                None,
                None,
                None,
                None,
                None,
                {
                    let first_at = first_at.clone();
                    move |event, _| {
                        let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if kind == "TEXT_MESSAGE_CONTENT" {
                            let mut slot = first_at.lock().unwrap();
                            if slot.is_none() {
                                *slot = Some(Instant::now());
                            }
                        }
                    }
                },
            )
            .await
            .unwrap();
        assert_eq!(text, "Hello world");
        let first = first_at.lock().unwrap().expect("saw text");
        let until_first = first.duration_since(start);
        let total = start.elapsed();
        assert!(
            until_first + Duration::from_millis(50) < total,
            "first text at {until_first:?}, stream ended at {total:?} — frames were buffered"
        );
    }

    #[tokio::test]
    async fn buffered_sse_actions_share_arrival_instead_of_timing_callback_work() {
        let server = MockServer::start().await;
        let events = [
            json!({"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"shell"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"c1"}),
            json!({"type":"TOOL_CALL_RESULT","toolCallId":"c1","content":"ok","ok":true}),
            json!({"type":"RUN_FINISHED","runId":"r1"}),
        ];
        let body: String = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect();
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let mut arrivals = Vec::new();
        let mut turn = super::super::gen_ui::TurnAssembler::default();
        client
            .run_turn(
                "cw",
                "t",
                "r1",
                &[],
                None,
                None,
                None,
                None,
                None,
                |event, at| {
                    arrivals.push(at);
                    turn.push_event_at(event, Some(at));
                    // A slow render must not turn parsing of the same delivery into tool execution.
                    std::thread::sleep(std::time::Duration::from_millis(5));
                },
            )
            .await
            .unwrap();
        assert_eq!(arrivals.len(), events.len());
        assert!(arrivals.windows(2).all(|pair| pair[0] == pair[1]));
        let (_, parts) = turn.snapshot();
        assert!(parts.iter().any(
            |part| matches!(part, super::super::ChatPart::Step(step) if step.took_ms.is_none())
        ));
    }

    /// The turn's body is a contract with the server, which reads `forwardedProps` for the
    /// recipe and validates the values against the same declaration the composer read. Both
    /// sides are written apart, so the shape is asserted here rather than agreed in passing.
    /// A tagged message's turn carries its tags where the server reads them: plugins as
    /// `mentionedPlugins`, a card's pick as `pluginAccounts`, tools as `preferTools`
    /// (opengrok-server `mentioned_plugins_from`, `plugin_accounts_from`, `preferred_tools_from`
    /// in `crates/opengrok-server/src/agui/routes.rs`, gol/service-accounts). The words are sent
    /// as they were typed.
    #[tokio::test]
    async fn a_tagged_turn_carries_its_plugins_pick_and_tools_in_forwarded_props() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string("data: {\"type\":\"RUN_FINISHED\",\"runId\":\"r\"}\n\n"),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let message = AguiMessage {
            id: "u1".into(),
            role: "user".into(),
            content: "@cloudflare list my zones with @shell".into(),
            tool_call_id: None,
            reply_to: None,
            attachments: Vec::new(),
        };
        let tags = TurnTags {
            plugins: vec!["cloudflare".into()],
            accounts: [(
                "cloudflare".to_string(),
                [("cloudflare".to_string(), "conn_2".to_string())].into(),
            )]
            .into(),
            tools: vec!["shell".into()],
        };
        client
            .run_turn_tagged(
                ("cw_1", "thread_1", "run_1"),
                &[message],
                (None, None),
                (None, None),
                None,
                &tags,
                |_, _| {},
            )
            .await
            .unwrap();
        let requests = server.received_requests().await.expect("the turn was sent");
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(
            body["forwardedProps"],
            json!({
                "coworkerId": "cw_1",
                "mentionedPlugins": ["cloudflare"],
                "pluginAccounts": {"cloudflare": {"cloudflare": "conn_2"}},
                "preferTools": ["shell"],
            })
        );
        assert_eq!(
            body["messages"][0]["content"],
            "@cloudflare list my zones with @shell"
        );
    }

    #[tokio::test]
    async fn a_turn_carries_the_active_recipe_and_its_values_in_forwarded_props() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(
                        "data: {\"type\":\"RUN_FINISHED\",\"runId\":\"r\"}\n\n".to_string(),
                    ),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let message = AguiMessage {
            id: "u1".into(),
            role: "user".into(),
            content: "find me something".into(),
            tool_call_id: None,
            reply_to: None,
            attachments: Vec::new(),
        };
        let recipe = TurnRecipe {
            id: "rcp_1".to_string(),
            values: serde_json::Map::from_iter([
                ("search_term".to_string(), json!("mundo")),
                ("count".to_string(), json!(5)),
                ("shorts".to_string(), json!(true)),
            ]),
        };
        client
            .run_turn(
                "cw_1",
                "thread_1",
                "run_1",
                &[message],
                Some(&recipe),
                None,
                None,
                None,
                None,
                |_, _| {},
            )
            .await
            .unwrap();

        let requests = server.received_requests().await.expect("the turn was sent");
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(
            body["forwardedProps"],
            json!({
                "coworkerId": "cw_1",
                "recipe": "rcp_1",
                "recipeValues": { "search_term": "mundo", "count": 5, "shorts": true }
            })
        );
        assert_eq!(
            body["messages"][0]["content"], "find me something",
            "a parameter value is not prose: the message stays exactly what was written"
        );
        assert_eq!(
            body["runId"], "run_1",
            "the run is filed under the id the caller minted, which is the only id it still has \
             to ask `GET /ag-ui/runs/{{id}}` with once the stream is gone"
        );

        // No recipe on the turn leaves the props as they were, so an ordinary chat is unchanged.
        client
            .run_turn(
                "cw_1",
                "thread_1",
                "run_2",
                &[AguiMessage {
                    id: "u2".into(),
                    role: "user".into(),
                    content: "hello".into(),
                    tool_call_id: None,
                    reply_to: None,
                    attachments: Vec::new(),
                }],
                None,
                None,
                None,
                None,
                None,
                |_, _| {},
            )
            .await
            .unwrap();
        let requests = server
            .received_requests()
            .await
            .expect("both turns were sent");
        let plain: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(plain["forwardedProps"], json!({ "coworkerId": "cw_1" }));
    }

    /// The other half of that contract, and the whole of what `/name` buys: the skill the
    /// person picked travels as its id on `forwardedProps`, where the server reads it.
    ///
    /// The second turn is the regression guard. Every ordinary chat goes down this path, so a
    /// send with nothing picked has to be the send this client made before any of this existed:
    /// the two bodies are compared whole, which catches a key added anywhere in them and not
    /// only in the props. What it cannot catch is a change to how the body is spelled — both
    /// sides are read back into `Value` and written out again by this same build — and it does
    /// not need to: what is on trial here is what the app puts in the body.
    #[tokio::test]
    async fn a_turn_carries_the_chosen_skill_and_a_turn_without_one_is_unchanged() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(
                        "data: {\"type\":\"RUN_FINISHED\",\"runId\":\"r\"}\n\n".to_string(),
                    ),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        // The name is in the words as well, the way it is after a pick: the chip is text in the
        // message. The server must read the id and never the sentence.
        let said = |id: &str| AguiMessage {
            id: id.to_string(),
            role: "user".into(),
            content: "expense-report file this one".into(),
            tool_call_id: None,
            reply_to: None,
            attachments: Vec::new(),
        };

        client
            .run_turn(
                "cw_1",
                "thread_1",
                "run_1",
                &[said("u1")],
                None,
                Some("skl_1"),
                None,
                None,
                None,
                |_, _| {},
            )
            .await
            .unwrap();
        client
            .run_turn(
                "cw_1",
                "thread_1",
                "run_2",
                &[said("u1")],
                None,
                None,
                None,
                None,
                None,
                |_, _| {},
            )
            .await
            .unwrap();

        let requests = server.received_requests().await.expect("both turns went");
        let with: Value = serde_json::from_slice(&requests[0].body).unwrap();
        let without: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(
            with["forwardedProps"],
            json!({ "coworkerId": "cw_1", "skill": "skl_1" })
        );
        assert_eq!(
            with["messages"][0]["content"], "expense-report file this one",
            "the message stays exactly what was written: the id is a field, not a word"
        );
        assert_eq!(
            without["forwardedProps"],
            json!({ "coworkerId": "cw_1" }),
            "no skill picked leaves the props with nothing in them but the coworker"
        );

        // The whole body, once the one thing that is meant to differ — the run id, minted fresh
        // for every turn — is put back.
        let mut with = with;
        with["forwardedProps"]
            .as_object_mut()
            .expect("props are an object")
            .remove("skill");
        with["runId"] = without["runId"].clone();
        assert_eq!(
            serde_json::to_vec(&with).unwrap(),
            serde_json::to_vec(&without).unwrap(),
            "a turn with no skill on it is the turn this client sent before skills existed"
        );
    }

    #[tokio::test]
    async fn list_models_reads_ids() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "models": [{"id":"xai/grok-4.6@sub"},{"id":"oag/auto"}],
                "note": null
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let cat = client.list_models().await.unwrap();
        assert_eq!(cat.models.len(), 2);
        assert_eq!(cat.models[0].id, "xai/grok-4.6@sub");
    }

    /// The account's time zone reads as opengrok-server #322 (on main since c0bb6ae) writes it
    /// on `GET /account`: left out by a server that keeps none, `null` until set, and the zone
    /// once set. `PUT /account` sends `{timeZone}` alone, and reads the account it is answered
    /// with; a zone the server's database does not know is refused with a 422 in its words, as
    /// its recording has them (`PUT__account/422-an_unknown_time_zone_is_refused_in_words`).
    #[tokio::test]
    async fn the_time_zone_is_read_off_the_account_and_put_alone() {
        let read = |zone: Option<serde_json::Value>| -> Account {
            let mut body = json!({
                "id": "acct_1", "email": "ada@example.com", "firstName": "Ada", "lastName": "",
                "avatarUrl": null, "orgId": null, "verified": true, "enabled": true,
                "isAdmin": false
            });
            if let Some(zone) = zone {
                body["timeZone"] = zone;
            }
            serde_json::from_value(body).expect("an account")
        };
        assert_eq!(read(None).time_zone, None, "a server that keeps none");
        assert_eq!(read(Some(serde_json::Value::Null)).time_zone, Some(None));
        assert_eq!(
            read(Some(json!("Europe/London"))).time_zone,
            Some(Some("Europe/London".to_string()))
        );

        let said = "\"Mars/Olympus_Mons\" is not an IANA time zone this server knows; send one \
                    like \"Europe/London\"";
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/account"))
            .and(body_json(json!({"timeZone": "Asia/Manila"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "acct_1", "email": "ada@example.com", "firstName": "Ada",
                "lastName": "", "avatarUrl": null, "orgId": null, "verified": true,
                "enabled": true, "timeZone": "Asia/Manila", "isAdmin": false
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/account"))
            .and(body_json(json!({"timeZone": "Mars/Olympus_Mons"})))
            .respond_with(ResponseTemplate::new(422).set_body_json(json!({ "error": said })))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let kept = client.set_time_zone("Asia/Manila").await.unwrap();
        assert_eq!(kept.time_zone, Some(Some("Asia/Manila".to_string())));
        let refused = client.set_time_zone("Mars/Olympus_Mons").await.unwrap_err();
        assert_eq!(
            (refused.status, refused.message.as_str(), refused.failure()),
            (Some(422), said, Failure::Verdict)
        );
    }

    /// The account's setting as the contract writes it: `GET` reads it, and a change is one
    /// `PUT` of the kind the server keeps and what changed, answered with the setting as the
    /// server now keeps it. Nothing of the plan on the server's own machine goes with it.
    #[tokio::test]
    async fn the_reply_source_is_read_and_a_put_carries_the_kind_and_what_changed() {
        use crate::opengrok::{InferenceKind, InferenceSourceUpdate, Via};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/account/inference-source"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "kind": "gateway", "baseUrl": null, "localModel": null,
                "healthy": false, "hasApiKey": false
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/account/inference-source"))
            .and(body_json(json!({"kind": "gateway", "via": "mac"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "kind": "gateway", "baseUrl": "http://127.0.0.1:8080",
                "localModel": "gpt-5-codex", "healthy": true, "hasApiKey": true, "via": "mac",
                "relay": {"connected": false, "machineId": null, "machineLabel": null,
                          "localModel": null}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let read = client.inference_source().await.unwrap();
        assert_eq!(
            (read.kind, read.base_url, read.healthy, read.has_api_key),
            (InferenceKind::Gateway, None, false, false)
        );
        let kept = client
            .set_inference_source(&InferenceSourceUpdate {
                kind: InferenceKind::Gateway,
                via: Some(Via::Mac),
                new_bot_default: None,
                plan_fallback: None,
            })
            .await
            .unwrap();
        assert_eq!(kept.default_via(), Some(Via::Mac));
        assert_eq!(
            kept.base_url.as_deref(),
            Some("http://127.0.0.1:8080"),
            "what the server keeps of its own machine stays as it keeps it"
        );
    }

    /// A `PUT` the server will not keep is refused with a 400 and the server's sentence, and the
    /// person is shown that sentence as it was written: a verdict about what was asked, not a
    /// server out of reach.
    #[tokio::test]
    async fn a_refused_put_is_the_servers_words() {
        use crate::opengrok::{InferenceKind, InferenceSourceUpdate, Via};
        let said = "via \"helper\" is not built yet (#293); use \"loopback\" or \"mac\"";
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/account/inference-source"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({ "error": said })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let refused = client
            .set_inference_source(&InferenceSourceUpdate {
                kind: InferenceKind::LocalProxy,
                via: Some(Via::Mac),
                new_bot_default: None,
                plan_fallback: None,
            })
            .await
            .unwrap_err();
        assert_eq!(
            (refused.status, refused.message.as_str(), refused.failure()),
            (Some(400), said, Failure::Verdict)
        );
    }

    /// Both reply-source routes give up by themselves ([`INFERENCE_SOURCE_TIMEOUT`]), as a server
    /// out of reach: a Save that never answered would leave the page's controls dead. The clock
    /// is the test's own, and so is the server (see `a_connection_route_that_does_not_answer_gives_up`).
    #[tokio::test(start_paused = true)]
    async fn a_reply_source_route_that_does_not_answer_gives_up() {
        use crate::opengrok::{InferenceKind, InferenceSourceUpdate};
        let server = MockServer::builder().start().await;
        Mock::given(wiremock::matchers::any())
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({
                        "kind": "gateway", "baseUrl": null, "localModel": null,
                        "healthy": false, "hasApiKey": false
                    }))
                    .set_delay(std::time::Duration::from_secs(25)),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let answers = [
            client.inference_source().await.map(drop),
            client
                .set_inference_source(&InferenceSourceUpdate {
                    kind: InferenceKind::Gateway,
                    via: None,
                    new_bot_default: None,
                    plan_fallback: None,
                })
                .await
                .map(drop),
        ];
        for (at, answer) in answers.into_iter().enumerate() {
            let error = answer.expect_err("a route with no deadline waited for the answer");
            assert_eq!(
                error.failure(),
                Failure::OutOfReach(Unreachable::Server),
                "route {at}: {}",
                error.message
            );
        }
    }

    /// The Bot's door travels as `forwardedProps.inferenceSource`, where the server reads it and
    /// lets it win for this turn: the bare word, or with a way to the plan named, `{"kind",
    /// "via"}`. A turn with no door is the turn this client sent before reply sources existed,
    /// byte for byte.
    #[tokio::test]
    async fn a_turn_carries_the_picked_reply_source_and_a_turn_without_one_is_unchanged() {
        use crate::opengrok::{TurnSource, Via};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(
                        "data: {\"type\":\"RUN_FINISHED\",\"runId\":\"r\"}\n\n".to_string(),
                    ),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let said = || AguiMessage {
            id: "u1".into(),
            role: "user".into(),
            content: "summarise the thread".into(),
            tool_call_id: None,
            reply_to: None,
            attachments: Vec::new(),
        };
        for (run, source) in [
            ("run_1", Some(TurnSource::plan(None))),
            ("run_2", Some(TurnSource::GATEWAY)),
            ("run_3", None),
            ("run_4", Some(TurnSource::plan(Some(Via::Mac)))),
        ] {
            client
                .run_turn(
                    "cw_1",
                    "thread_1",
                    run,
                    &[said()],
                    None,
                    None,
                    None,
                    None,
                    source,
                    |_, _| {},
                )
                .await
                .unwrap();
        }
        let requests = server.received_requests().await.expect("the turns went");
        let bodies: Vec<Value> = requests
            .iter()
            .map(|request| serde_json::from_slice(&request.body).unwrap())
            .collect();
        assert_eq!(
            bodies[0]["forwardedProps"],
            json!({ "coworkerId": "cw_1", "inferenceSource": "local_proxy" })
        );
        assert_eq!(
            bodies[1]["forwardedProps"],
            json!({ "coworkerId": "cw_1", "inferenceSource": "gateway" })
        );
        assert_eq!(
            bodies[2]["forwardedProps"],
            json!({ "coworkerId": "cw_1" }),
            "no pick leaves the account's setting to decide"
        );
        assert_eq!(
            bodies[3]["forwardedProps"],
            json!({
                "coworkerId": "cw_1",
                "inferenceSource": {"kind": "local_proxy", "via": "mac"}
            })
        );
        let mut picked = bodies[0].clone();
        picked["forwardedProps"]
            .as_object_mut()
            .expect("props are an object")
            .remove("inferenceSource");
        picked["runId"] = bodies[2]["runId"].clone();
        assert_eq!(
            serde_json::to_vec(&picked).unwrap(),
            serde_json::to_vec(&bodies[2]).unwrap(),
            "the pick is the only thing it adds to the turn"
        );
    }

    /// A run the person's plan could not answer says why beside its sentence, and the turn's
    /// error keeps both: the sentence for the person, the code for the app to offer the turn
    /// again on the server's keys. The relay's code (opengrok-server PR #298, which the ledger
    /// reads the recorded frames of), and `plan_unavailable` where the person's own setting left
    /// the plan nothing to answer with (server main d6f640e (#307, after #304), pin bf99845, whose
    /// recorded frame the ledger reads too). A run error with no code has none.
    #[tokio::test]
    async fn a_run_error_keeps_its_code_beside_its_sentence() {
        let server = MockServer::start().await;
        let no_proxy = "You chose your own subscription, but no proxy address is set; set one in \
                        your inference source (like http://127.0.0.1:8080), or switch this turn \
                        to the gateway.";
        for (run, frame) in [
            (
                "run_relay",
                json!({"type": "RUN_ERROR", "message": "Your Mac isn't connected.",
                    "code": "relay_offline"}),
            ),
            (
                "run_plan",
                json!({"type": "RUN_ERROR", "message": no_proxy, "code": "plan_unavailable"}),
            ),
            (
                "run_plain",
                json!({"type": "RUN_ERROR", "message": "the model refused"}),
            ),
        ] {
            Mock::given(method("POST"))
                .and(path("/ag-ui"))
                .and(wiremock::matchers::body_partial_json(
                    json!({ "runId": run }),
                ))
                .respond_with(
                    ResponseTemplate::new(200)
                        .insert_header("content-type", "text/event-stream")
                        .set_body_string(format!("data: {frame}\n\n")),
                )
                .mount(&server)
                .await;
        }
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let turn = |run: &'static str| {
            let client = client.clone();
            async move {
                client
                    .run_turn(
                        "cw_1",
                        "thread_1",
                        run,
                        &[],
                        None,
                        None,
                        None,
                        None,
                        None,
                        |_, _| {},
                    )
                    .await
                    .unwrap_err()
            }
        };
        let relay = turn("run_relay").await;
        assert_eq!(
            (relay.message.as_str(), relay.code()),
            ("Your Mac isn't connected.", Some("relay_offline"))
        );
        assert_eq!(
            relay
                .code()
                .and_then(crate::opengrok::RunErrorCode::from_code),
            Some(crate::opengrok::RunErrorCode::RelayOffline)
        );
        let plan = turn("run_plan").await;
        assert_eq!(
            (plan.message.as_str(), plan.code()),
            (no_proxy, Some("plan_unavailable"))
        );
        assert_eq!(
            plan.code()
                .and_then(crate::opengrok::RunErrorCode::from_code),
            Some(crate::opengrok::RunErrorCode::PlanUnavailable)
        );
        let plain = turn("run_plain").await;
        assert_eq!(plain.code(), None);
    }

    /// A Mac already carrying all the calls the server lets one Mac carry at once (16) is refused
    /// a turn in words and no code: `ModelError::Proxy` in opengrok-server's relay broker, not a
    /// relay failure (PR #298). The turn through the Mac ends with the sentence alone, naming no
    /// relay failure, so nothing offers it again on the server's keys.
    #[tokio::test]
    async fn a_mac_carrying_all_it_may_ends_the_turn_in_words_alone() {
        let server = MockServer::start().await;
        let said = "Your Mac is already carrying 16 calls, so this one was not sent; try again \
                    when one finishes.";
        let stream: String = [
            json!({"type": "RUN_STARTED", "threadId": "thread_1", "runId": "run_busy"}),
            json!({"type": "CUSTOM", "name": "opengrok.inferenceSource",
                "value": {"kind": "local_proxy", "via": "mac", "model": "gpt-5.5"}}),
            json!({"type": "RUN_ERROR", "threadId": "thread_1", "runId": "run_busy",
                "message": said}),
        ]
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(stream),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let busy = client
            .run_turn(
                "cw_1",
                "thread_1",
                "run_busy",
                &[],
                None,
                None,
                None,
                None,
                Some(TurnSource::plan(Some(crate::opengrok::Via::Mac))),
                |_, _| {},
            )
            .await
            .unwrap_err();
        assert_eq!(busy.message, said);
        assert_eq!(busy.code(), None);
        assert_eq!(
            busy.code()
                .and_then(crate::opengrok::RunErrorCode::from_code),
            None,
            "no relay failure, so nothing to send on the server's keys"
        );
    }

    /// A fire of a queued send the server holds for the person's Mac is answered 202 with the row
    /// as it stands (opengrok-server PR #298), and no run starts. The turn is not read as a stream
    /// that said nothing: it is held for the Mac, with the server's sentence and the row, still
    /// queued and waiting for the Mac, for the queue to put back. No frame reaches the turn.
    #[tokio::test]
    async fn a_fire_the_server_holds_for_the_mac_is_no_turn() {
        let server = MockServer::start().await;
        let row = json!({
            "v": 1, "id": "pum_1", "threadId": "thread_1", "content": "then this, by my Mac",
            "replyTo": null, "recipeId": null, "recipeValues": null, "skillId": null,
            "clientMessageId": "m2", "status": "pending", "createdAtMs": 1, "updatedAtMs": 1,
            "drainedAtMs": null, "drainedRunId": null,
            "inferenceSource": {"kind": "local_proxy", "via": "mac"},
            "heldFor": "relay_offline"
        });
        let said = "Your Mac isn't connected, so this message stays queued and goes when it \
                    reconnects.";
        Mock::given(method("POST"))
            .and(path("/ag-ui"))
            .respond_with(ResponseTemplate::new(202).set_body_json(json!({
                "v": 1, "id": "pum_1", "heldFor": "relay_offline", "message": said,
                "event": {
                    "type": "CUSTOM", "timestamp": 1, "name": "pending-user-message",
                    "value": {"v": 1, "op": "edited", "threadId": "thread_1", "message": row}
                }
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        let mut frames = 0;
        let held = client
            .run_turn(
                "cw_1",
                "thread_1",
                "run_1",
                &[],
                None,
                None,
                Some("pum_1"),
                None,
                None,
                |_, _| frames += 1,
            )
            .await
            .expect_err("a held send starts no turn");
        assert!(held.is_held_for_mac(), "{held:?}");
        assert_eq!(held.message, said);
        assert_eq!(frames, 0);
        let custom = held.pending_custom().expect("the row as it stands");
        assert_eq!(custom.op, crate::opengrok::PendingOp::Edited);
        let row = custom.message.expect("the row");
        assert_eq!(row.id, "pum_1");
        assert!(row.waits_for_mac());
    }

    #[tokio::test]
    async fn patch_coworker_sends_model_and_role() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/coworkers/cw_1"))
            .and(body_json(json!({
                "model": "xai/grok-4.6@sub",
                "role": "Research, marketing, admin"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "cw_1",
                "model": "xai/grok-4.6@sub",
                "role": "Research, marketing, admin",
                "visibility": "private"
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let updated = client
            .patch_coworker(
                "cw_1",
                &CoworkerPatch {
                    model: Some("xai/grok-4.6@sub".into()),
                    role: Some("Research, marketing, admin".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.model, "xai/grok-4.6@sub");
        assert_eq!(updated.role.as_deref(), Some("Research, marketing, admin"));
    }

    /// A Save that changed the effort carries it as the word, and one that did not leaves the key
    /// off, which the server reads as "leave it alone" (opengrok-server#271). The answer is the
    /// row as the server now keeps it, effort and all.
    #[tokio::test]
    async fn a_patch_carries_the_effort_only_when_it_changed() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/coworkers/cw_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "cw_1",
                "name": "Bob",
                "model": "oag/cheap",
                "effort": "high"
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let changed = client
            .patch_coworker(
                "cw_1",
                &CoworkerPatch {
                    name: Some("Bob".into()),
                    effort: Some("high".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(changed.effort.as_deref(), Some("high"));
        client
            .patch_coworker(
                "cw_1",
                &CoworkerPatch {
                    name: Some("Bob".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let requests = server.received_requests().await.expect("both patches went");
        let bodies: Vec<Value> = requests
            .iter()
            .map(|request| serde_json::from_slice(&request.body).unwrap())
            .collect();
        assert_eq!(
            bodies,
            vec![
                json!({"name": "Bob", "effort": "high"}),
                json!({"name": "Bob"}),
            ]
        );
    }

    /// The server's two refusals of an effort reach the pane as the server words them: a word it
    /// does not know (400, nothing changed), and a coworker shared with the caller, which only its
    /// owner may change (403). Both are verdicts about what was asked, not an outage.
    #[tokio::test]
    async fn a_refused_effort_is_the_servers_sentence() {
        let unknown = "effort must be one of inherit, none, low, medium, high, xhigh, max, ultra";
        let shared = "only the person who hired this coworker can change it; you can hide it \
                      from your own sidebar";
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/coworkers/cw_1"))
            .and(body_json(json!({"effort": "extreme"})))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({"error": unknown})))
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/coworkers/cw_shared"))
            .and(body_json(json!({"effort": "high"})))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({"error": shared})))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        for (id, word, status, said) in [
            ("cw_1", "extreme", 400, unknown),
            ("cw_shared", "high", 403, shared),
        ] {
            let error = client
                .patch_coworker(
                    id,
                    &CoworkerPatch {
                        effort: Some(word.into()),
                        ..Default::default()
                    },
                )
                .await
                .expect_err("the server refused it");
            assert_eq!(error.status, Some(status));
            assert_eq!(error.message, said);
            assert_eq!(error.failure(), Failure::Verdict);
        }
    }

    /// A change in the model picker goes as one PATCH carrying the Bot's door, its model and its
    /// effort, each only when it changed (opengrok-server main d6f640e (#307, after #304), pin
    /// bf99845), and the answer is the row as the server now keeps
    /// it, door and all. A door and a model the allowlist does not take, sent together, are
    /// refused together with a 400 in the server's words, which is what the person is shown: the
    /// sentence the recording holds for that pair.
    #[tokio::test]
    async fn a_picks_patch_carries_the_door_the_model_and_the_effort() {
        use crate::opengrok::{CoworkerSource, InferenceKind};
        let refused = "model: claude-sonnet-4.5 is one of Anthropic's models, and Anthropic's \
                       terms forbid using a consumer subscription through a third-party app; \
                       pick an OpenAI or xAI model, or use the gateway";
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/coworkers/cw_1"))
            .and(body_json(json!({
                "source": "local_proxy",
                "model": "gpt-6-luna--fast",
                "effort": "max"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "cw_1",
                "name": "Ada",
                "model": "gpt-6-luna--fast",
                "effort": "max",
                "source": "local_proxy",
                "visibility": "private"
            })))
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/coworkers/cw_1"))
            .and(body_json(
                json!({"source": "local_proxy", "model": "claude-sonnet-4.5"}),
            ))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({"error": refused})))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let kept = client
            .patch_coworker(
                "cw_1",
                &CoworkerPatch {
                    source: Some(InferenceKind::LocalProxy),
                    model: Some("gpt-6-luna--fast".into()),
                    effort: Some("max".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            (kept.source, kept.model.as_str(), kept.effort.as_deref()),
            (
                CoworkerSource::Kind(InferenceKind::LocalProxy),
                "gpt-6-luna--fast",
                Some("max")
            )
        );
        let error = client
            .patch_coworker(
                "cw_1",
                &CoworkerPatch {
                    source: Some(InferenceKind::LocalProxy),
                    model: Some("claude-sonnet-4.5".into()),
                    ..Default::default()
                },
            )
            .await
            .expect_err("the server refused it");
        assert_eq!(error.status, Some(400));
        assert_eq!(error.message, refused);
        assert_eq!(error.failure(), Failure::Verdict);
    }

    #[tokio::test]
    async fn answer_run_posts_call_id_and_approved() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/runs/run-1/answer"))
            .and(body_json(json!({"call_id":"call-9","approved":true})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "runId": "run-1",
                "callId": "call-9",
                "approved": true,
                "alreadyAnswered": false,
                "continuing": true
            })))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let reply = client.answer_run("run-1", "call-9", true).await.unwrap();
        assert!(!reply.already_answered);
        assert!(reply.continuing);
    }

    #[tokio::test]
    async fn submit_user_form_posts_gateway_entry_id_and_values() {
        use super::super::user_form::{
            FormResolution, UserFormActionReply, UserFormValues, user_form_action_from_http,
        };
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/user-form/submit"))
            .and(body_json(json!({
                "entryId": "e_form",
                "agentId": "cw_1",
                "values": { "email": "ada@example.com", "password": "s3cret-pass" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "kind": "send-message",
                "id": "e_form",
                "message": {
                    "type": "user-form",
                    "formRequest": {
                        "title": "Google account",
                        "fields": [
                            {"id": "email", "label": "Email", "type": "email"},
                            {"id": "password", "label": "Password", "type": "password"}
                        ]
                    }
                },
                "formResolution": "submitted",
                "sharedValues": { "email": "ada@example.com" }
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let mut values = UserFormValues::default();
        values
            .by_id
            .insert("email".into(), "ada@example.com".into());
        values.by_id.insert("password".into(), "s3cret-pass".into());
        let reply = client
            .submit_user_form("e_form", "cw_1", &values, false, None)
            .await
            .unwrap();
        match reply {
            UserFormActionReply::Settled(spec) => {
                assert_eq!(spec.entry_id, "e_form");
                assert_eq!(spec.effective_resolution(), Some(FormResolution::Submitted));
            }
            other => panic!("expected Settled, got {other:?}"),
        }
        let dump = format!("{values:?}");
        assert!(!dump.contains("s3cret-pass"), "{dump}");
        assert_eq!(
            user_form_action_from_http(404, &Value::Null),
            UserFormActionReply::MissingRoute
        );
        assert_eq!(
            user_form_action_from_http(404, &json!({ "error": "form entry missing" })),
            UserFormActionReply::MissingEntry
        );
    }

    #[tokio::test]
    async fn submit_user_form_404_form_entry_missing_is_not_missing_route() {
        use super::super::user_form::UserFormActionReply;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/user-form/submit"))
            .respond_with(
                ResponseTemplate::new(404).set_body_json(json!({ "error": "form entry missing" })),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let reply = client
            .submit_user_form("e_form", "cw_1", &Default::default(), false, None)
            .await
            .unwrap();
        assert_eq!(reply, UserFormActionReply::MissingEntry);
        assert!(!matches!(reply, UserFormActionReply::MissingRoute));
        assert!(!matches!(reply, UserFormActionReply::Settled(_)));
    }

    #[tokio::test]
    async fn submit_user_form_404_is_missing_route_not_submitted() {
        use super::super::user_form::UserFormActionReply;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/user-form/submit"))
            .respond_with(
                ResponseTemplate::new(404).set_body_json(json!({ "error": "no such route" })),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let reply = client
            .submit_user_form("e_form", "cw_1", &Default::default(), false, None)
            .await
            .unwrap();
        assert_eq!(reply, UserFormActionReply::MissingRoute);
        assert!(!matches!(reply, UserFormActionReply::Settled(_)));
    }

    #[tokio::test]
    async fn submit_user_form_200_null_is_not_a_fill() {
        // Classifier reports Empty. After Continue, settle_user_form_http
        // paints Not filled — 200-null is disclosure, not Submitted.
        use super::super::user_form::UserFormActionReply;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/user-form/submit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(Value::Null))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let reply = client
            .submit_user_form("e_form", "cw_1", &Default::default(), false, None)
            .await
            .unwrap();
        assert_eq!(reply, UserFormActionReply::Empty);
    }

    #[tokio::test]
    async fn empty_entry_id_is_not_posted_as_call_id() {
        use super::super::user_form::UserFormActionReply;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/user-form/submit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "formResolution": "submitted"
            })))
            .expect(0)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let reply = client
            .submit_user_form("", "cw_1", &Default::default(), false, None)
            .await
            .unwrap();
        assert_eq!(reply, UserFormActionReply::MissingEntryId);
    }

    #[tokio::test]
    async fn dismiss_user_form_posts_escalated_mode() {
        use super::super::user_form::{UserFormActionReply, UserFormDismissMode};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/user-form/dismiss"))
            .and(body_json(json!({
                "entryId": "e_form",
                "agentId": "cw_1",
                "mode": "escalated"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "kind": "send-message",
                "id": "e_form",
                "message": { "type": "user-form", "formRequest": { "title": "Sign in", "fields": [] } },
                "formResolution": "escalated",
                "widgetDismissed": true,
                "handoffEntryId": "e_hand"
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let reply = client
            .dismiss_user_form("e_form", "cw_1", UserFormDismissMode::Escalated)
            .await
            .unwrap();
        match reply {
            UserFormActionReply::Settled(spec) => {
                assert_eq!(
                    spec.effective_resolution(),
                    None,
                    "escalated is a Computer sibling, not form settle: {:?}",
                    spec.effective_resolution()
                );
                assert_eq!(
                    spec.computer_handoff,
                    Some(super::super::user_form::ComputerHandoffStatus::ActionNeeded)
                );
                assert_eq!(spec.entry_id, "e_form");
                assert_eq!(spec.handoff_entry_id.as_deref(), Some("e_hand"));
            }
            other => panic!("expected Settled, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resolve_box_handoff_posts_handoff_id_not_form_id() {
        use super::super::user_form::{BoxHandoffReply, BoxHandoffResolution};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/box-handoff/resolve"))
            .and(body_json(json!({
                "entryId": "e_hand",
                "agentId": "cw_1",
                "resolution": "handed_back"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "e_hand",
                "boxResolution": "handed_back"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/box-handoff/resolve"))
            .and(body_json(json!({
                "entryId": "e_form",
                "agentId": "cw_1",
                "resolution": "handed_back"
            })))
            // Never answered, because it must never be asked: `expect` is a
            // method on a mounted `Mock`, and a `MockBuilder` only becomes one
            // once it has been given a response.
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let reply = client
            .resolve_box_handoff("e_hand", "cw_1", BoxHandoffResolution::HandedBack)
            .await
            .unwrap();
        assert_eq!(reply, BoxHandoffReply::Settled);
        let skipped = client
            .resolve_box_handoff("", "cw_1", BoxHandoffResolution::HandedBack)
            .await
            .unwrap();
        assert_eq!(skipped, BoxHandoffReply::MissingEntryId);
    }

    /// The route is idempotent, so the status is what is true of the run now rather than an
    /// account of what this call did: a turn that ended a moment before the press answers the
    /// same way one that was still going does.
    #[tokio::test]
    async fn stopping_a_run_posts_to_its_own_route_and_reads_the_status_back() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/runs/run-1/stop"))
            .respond_with(
                ResponseTemplate::new(202)
                    .set_body_json(json!({ "runId": "run-1", "status": "stopped" })),
            )
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let reply = client.stop_run("run-1").await.unwrap();
        assert_eq!(reply.run_id, "run-1");
        assert_eq!(reply.status, "stopped");
    }

    /// The run is not there, or is not ours. Both are `404`, and from the app's side they mean
    /// the same thing - nothing of ours is running under that id - so the caller is the one that
    /// decides whether that is worth saying anything about.
    #[tokio::test]
    async fn stopping_a_run_that_is_not_there_comes_back_as_a_404() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ag-ui/runs/run-gone/stop"))
            .respond_with(
                ResponseTemplate::new(404).set_body_json(json!({ "error": "no such run" })),
            )
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client.stop_run("run-gone").await.unwrap_err();
        assert_eq!(error.status, Some(404));
    }

    #[tokio::test]
    async fn list_approvals_returns_the_waiting_call() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/approvals"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {
                    "runId": "run-1",
                    "threadId": "t1",
                    "callId": "call-9",
                    "tool": "user_machine_shell",
                    "arguments": {"command": "ls"}
                },
                {
                    "runId": "run-2",
                    "threadId": "mcp-cw_1",
                    "callId": "call-10",
                    "tool": "read_file",
                    "arguments": {"path": "/etc/hosts"},
                    "reason": "policy-approval",
                    "why": "Reading a file outside the workspace."
                }
            ])))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let queue = client.list_approvals().await.unwrap();
        assert_eq!(queue.len(), 2);
        assert_eq!(queue[0].call_id, "call-9");
        assert_eq!(queue[0].tool, "user_machine_shell");
        assert_eq!(
            (queue[0].reason.as_deref(), queue[0].why.as_deref()),
            (None, None),
            "a server that sends neither still parses"
        );
        assert_eq!(queue[1].reason.as_deref(), Some("policy-approval"));
        assert_eq!(
            queue[1].why.as_deref(),
            Some("Reading a file outside the workspace.")
        );
    }

    /// The recorded answers, metered and not (opengrok-server wire corpus,
    /// `GET__coworkers__coworker_id__usage/200-…`), read as the Usage card needs them.
    #[tokio::test]
    async fn a_bots_usage_is_read_metered_or_not() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/usage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "metered": true, "note": null, "seat": "api", "keyPrefix": "oag_live_x",
                "window": "month",
                "models": [{"modelId": "oag/cheap", "requests": 2, "inputTokens": 20,
                    "outputTokens": 10, "cacheReadTokens": 5, "cacheWriteTokens": 3,
                    "costUsd": "2.000000", "listUsd": "2.000000", "points": 10000000}],
                "totals": {"requests": 2, "inputTokens": 20, "outputTokens": 10,
                    "cacheReadTokens": 5, "cacheWriteTokens": 3, "costUsd": "2.000000",
                    "listUsd": "2.000000", "points": 10000000}
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_2/usage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "metered": false, "note": "this coworker's key cannot serve",
                "seat": null, "keyPrefix": null, "window": "month", "models": [],
                "totals": {"requests": null, "inputTokens": null, "outputTokens": null,
                    "cacheReadTokens": null, "cacheWriteTokens": null, "costUsd": null,
                    "listUsd": null, "points": null}
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let used = client
            .coworker_usage("cw_1", UsageWindow::Month)
            .await
            .unwrap();
        assert!(used.metered);
        assert_eq!(used.models[0].model_id, "oag/cheap");
        assert_eq!(used.totals.requests, Some(2));
        assert_eq!(
            (
                used.models[0].cache_read_tokens,
                used.models[0].cache_write_tokens
            ),
            (5, 3)
        );
        assert_eq!(
            (
                used.totals.cache_read_tokens,
                used.totals.cache_write_tokens
            ),
            (Some(5), Some(3))
        );
        assert_eq!(used.totals.cost_usd.as_deref(), Some("2.000000"));
        let unmetered = client
            .coworker_usage("cw_2", UsageWindow::Month)
            .await
            .unwrap();
        assert!(!unmetered.metered && unmetered.models.is_empty());
        assert_eq!(unmetered.totals.requests, None);
        assert_eq!(
            unmetered.note.as_deref(),
            Some("this coworker's key cannot serve")
        );
    }

    /// The Usage modal's chips each ask for their own window, in the server's word for it
    /// (opengrok-server `points::WINDOWS`), and the answer names the window it is for.
    #[tokio::test]
    async fn a_bots_usage_is_asked_for_in_the_window_a_chip_names() {
        use wiremock::matchers::query_param;
        let server = MockServer::start().await;
        for window in UsageWindow::ALL {
            Mock::given(method("GET"))
                .and(path("/coworkers/cw_1/usage"))
                .and(query_param("window", window.word()))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "metered": true, "note": null, "seat": "api", "keyPrefix": "oag_live_x",
                    "window": window.word(), "models": [],
                    "totals": {"requests": 0, "inputTokens": 0, "outputTokens": 0,
                        "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUsd": "0.000000",
                        "listUsd": "0.000000", "points": 0}
                })))
                .mount(&server)
                .await;
        }
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let words: Vec<(&str, String)> = {
            let mut asked = Vec::new();
            for window in UsageWindow::ALL {
                let used = client.coworker_usage("cw_1", window).await.unwrap();
                asked.push((window.label(), used.window));
            }
            asked
        };
        assert_eq!(
            words,
            [
                ("24h", "24h".to_string()),
                ("7d", "7d".to_string()),
                ("Month", "month".to_string())
            ]
        );
        assert_eq!(UsageWindow::default(), UsageWindow::Month);
    }

    /// The recorded answer (opengrok-server wire corpus,
    /// `GET__coworkers__coworker_id__tools/200-…`), trimmed to one tool of each kind.
    #[tokio::test]
    async fn a_bots_tools_are_read_as_the_server_lists_them() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/tools"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "tools": [
                    {
                        "name": "shell",
                        "description": "Run a shell command on THIS BOT'S OWN computer.",
                        "kind": "builtin"
                    },
                    {"name": "gmail_api_send", "description": "Send mail.", "kind": "plugin"},
                    {"name": "later_kind", "kind": "connector"}
                ]
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let tools = client.coworker_tools("cw_1").await.unwrap();
        let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
        assert_eq!(names, ["shell", "gmail_api_send", "later_kind"]);
        assert!(tools[0].is_builtin());
        assert!(!tools[1].is_builtin());
        assert!(
            !tools[2].is_builtin() && tools[2].description.is_empty(),
            "a kind this app does not know is not claimed as built in"
        );
    }

    /// A bot on the person's roster that they do not own answers 404 (the recorded
    /// `404-an_org_visible_coworker_…`), which is an answer and not a list.
    #[tokio::test]
    async fn a_bot_the_person_does_not_own_has_no_tool_list() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/tools"))
            .respond_with(ResponseTemplate::new(404).set_body_string("no such coworker"))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client.coworker_tools("cw_1").await.unwrap_err();
        assert_eq!(error.status, Some(404));
    }

    /// A row of `GET /connections` in the shape agreed for opengrok-server#267: camelCase, the
    /// owner adjacently tagged with one `id` key, and no expiry for a token that does not expire.
    fn connection_row(id: &str, loans: &[&str]) -> Value {
        json!({
            "id": id, "connector": "gmail",
            "owner": {"scope": "user", "id": "acct_1"},
            "label": "you@work.com", "loans": loans, "updatedAtMs": 1_790_000_000_000_i64
        })
    }

    /// The list is read in the agreed shape (opengrok-server#267), every owner's scope with it,
    /// and nothing connected is an empty list rather than a failure.
    #[tokio::test]
    async fn a_persons_connections_are_read_in_the_agreed_shape() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/connections"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                connection_row("conn_1", &["cw_1", "cw_2"]),
                {
                    "id": "conn_2", "connector": "github", "owner": {"scope": "bot", "id": "cw_1"},
                    "label": "octo-bot", "loans": [], "updatedAtMs": 1, "expiresAtMs": 2
                },
                {
                    "id": "conn_3", "connector": "weather", "owner": {"scope": "global"},
                    "label": "weather", "loans": [], "updatedAtMs": 1, "expiresAtMs": null
                },
                {
                    "id": "conn_4", "connector": "slack", "owner": {"scope": "org", "id": "org_1"},
                    "label": "Acme Slack", "loans": [], "updatedAtMs": 1
                }
            ])))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let listed = client.list_connections().await.unwrap();
        assert_eq!(listed.len(), 4, "a scope from later does not fail the list");
        assert_eq!(listed[0].owner, ConnectionOwner::User("acct_1".into()));
        assert_eq!(listed[0].loans, ["cw_1", "cw_2"]);
        assert_eq!(
            (listed[0].label.as_str(), listed[0].updated_at_ms),
            ("you@work.com", 1_790_000_000_000)
        );
        assert_eq!(
            listed[0].expires_at_ms, None,
            "no expiry is a token that does not expire"
        );
        assert_eq!(listed[1].owner, ConnectionOwner::Bot("cw_1".into()));
        assert_eq!(listed[1].expires_at_ms, Some(2));
        assert_eq!(listed[2].owner, ConnectionOwner::Global);
        assert_eq!(listed[3].owner, ConnectionOwner::Other);

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/connections"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        assert!(client.list_connections().await.unwrap().is_empty());
    }

    /// Lend and revoke name the Bot as `LendRequest` does, snake_case, and each is answered with
    /// the connection as the list has it (opengrok-server#267, `mutate`), read whole.
    #[tokio::test]
    async fn a_lend_and_a_revoke_name_the_bot_and_read_back_the_row() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/connections/conn_1/lend"))
            .and(body_json(json!({ "coworker_id": "cw_1" })))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(connection_row("conn_1", &["cw_1"])),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/connections/conn_1/revoke"))
            .and(body_json(json!({ "coworker_id": "cw_1" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(connection_row("conn_1", &[])))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let lent = client.lend_connection("conn_1", "cw_1").await.unwrap();
        assert_eq!(
            lent,
            Some(ConnectionView {
                id: "conn_1".into(),
                connector: "gmail".into(),
                owner: ConnectionOwner::User("acct_1".into()),
                label: "you@work.com".into(),
                loans: vec!["cw_1".into()],
                updated_at_ms: 1_790_000_000_000,
                expires_at_ms: None,
                kind: crate::opengrok::ConnectionKind::Oauth,
            })
        );
        let revoked = client.revoke_connection("conn_1", "cw_1").await.unwrap();
        assert!(revoked.is_some_and(|row| row.id == "conn_1" && row.loans.is_empty()));
    }

    /// A 2xx is a change the server took, whatever came with it: a body that is no row (the
    /// reply main writes today, `{id, connector, lentTo, disconnected}`), no body at all, or
    /// something that is not JSON is `None`, which the app answers by reading the list again,
    /// and never an error it would show as a refusal.
    #[tokio::test]
    async fn a_change_the_server_took_is_never_a_refusal() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/connections/conn_1/lend"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "conn_1", "connector": "gmail", "lentTo": ["cw_1"], "disconnected": false
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/connections/conn_1/revoke"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/connections/conn_2/lend"))
            .respond_with(ResponseTemplate::new(200).set_body_string("lent"))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        assert_eq!(
            client.lend_connection("conn_1", "cw_1").await.unwrap(),
            None
        );
        assert_eq!(
            client.revoke_connection("conn_1", "cw_1").await.unwrap(),
            None
        );
        assert_eq!(
            client.lend_connection("conn_2", "cw_1").await.unwrap(),
            None
        );
    }

    /// A disconnect is answered 204 with no body (opengrok-server#267): a disconnected
    /// connection is not listed, so there is no row left to answer with. A 2xx with a body is the
    /// connection gone all the same.
    #[tokio::test]
    async fn a_disconnect_is_taken_from_any_2xx() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/connections/conn_1"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/connections/conn_2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "conn_2", "connector": "gmail", "lentTo": [], "disconnected": true
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        client.disconnect_connection("conn_1").await.unwrap();
        client.disconnect_connection("conn_2").await.unwrap();
    }

    /// A change the server refuses is its verdict, in its words, which these routes write as
    /// `{"error": sentence}` (opengrok-server#267, `refused` in `connections/routes.rs`): the 404
    /// that is somebody else's connection or none at all, and the 409 of a connection that has
    /// been disconnected.
    #[tokio::test]
    async fn a_refused_connection_change_is_the_servers_words() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/connections/conn_theirs/lend"))
            .respond_with(
                ResponseTemplate::new(404).set_body_json(json!({ "error": "no such connection" })),
            )
            .mount(&server)
            .await;
        let disconnected = json!({ "error": "that connection has been disconnected" });
        Mock::given(method("POST"))
            .and(path("/connections/conn_1/revoke"))
            .respond_with(ResponseTemplate::new(409).set_body_json(disconnected.clone()))
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/connections/conn_1"))
            .respond_with(ResponseTemplate::new(409).set_body_json(disconnected))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let theirs = client
            .lend_connection("conn_theirs", "cw_1")
            .await
            .unwrap_err();
        assert_eq!(
            (theirs.status, theirs.message.as_str(), theirs.failure()),
            (Some(404), "no such connection", Failure::Verdict)
        );
        for refused in [
            client
                .revoke_connection("conn_1", "cw_1")
                .await
                .map(drop)
                .unwrap_err(),
            client.disconnect_connection("conn_1").await.unwrap_err(),
        ] {
            assert_eq!(
                (refused.status, refused.message.as_str(), refused.failure()),
                (
                    Some(409),
                    "that connection has been disconnected",
                    Failure::Verdict
                )
            );
        }
    }

    /// Every connection route gives up by itself ([`CONNECTIONS_TIMEOUT`]), as a server out of
    /// reach: while one is out its control is dead, and one that never answered would leave it
    /// dead until the app quits. The test's clock is its own, so the deadline passes as soon as
    /// the request is waiting, and the server's answer, seconds away in real time, is not what
    /// ends it.
    ///
    /// The server is this test's alone rather than one from wiremock's pool: a request still on
    /// its way when the test ends would otherwise land on the next test's mocks.
    #[tokio::test(start_paused = true)]
    async fn a_connection_route_that_does_not_answer_gives_up() {
        let server = MockServer::builder().start().await;
        Mock::given(wiremock::matchers::any())
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!([]))
                    .set_delay(std::time::Duration::from_secs(5)),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let answers = [
            client.list_connections().await.map(drop),
            client.lend_connection("conn_1", "cw_1").await.map(drop),
            client.revoke_connection("conn_1", "cw_1").await.map(drop),
            client.disconnect_connection("conn_1").await,
            client.list_connectors().await.map(drop),
            client.connect_link("gmail", None).await.map(drop),
            client.reconnect_link("conn_1", None).await.map(drop),
            client.rename_connection("conn_1", "Work").await.map(drop),
            client.list_connection_pins().await.map(drop),
            client
                .pin_connection("cw_1", "github", "conn_1")
                .await
                .map(drop),
            client.unpin_connection("cw_1", "github").await,
        ];
        for (at, answer) in answers.into_iter().enumerate() {
            let error = answer.expect_err("a route with no deadline waited for the answer");
            assert_eq!(
                error.failure(),
                Failure::OutOfReach(Unreachable::Server),
                "route {at}: {}",
                error.message
            );
        }
    }

    /// The services on offer are read as `[{name, label}]` (opengrok-server#269, as agreed), a
    /// missing label is no reason to drop the service, and an empty list is a server that offers
    /// none.
    #[tokio::test]
    async fn the_services_a_server_can_connect_are_read() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/connectors"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"name": "gmail", "label": "Gmail"},
                {"name": "github"}
            ])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let offered = client.list_connectors().await.unwrap();
        assert_eq!(
            offered,
            vec![
                Connector {
                    name: "gmail".into(),
                    label: "Gmail".into(),
                    plugin: None
                },
                Connector {
                    name: "github".into(),
                    label: String::new(),
                    plugin: None
                },
            ]
        );

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/connectors"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        assert!(client.list_connectors().await.unwrap().is_empty());
    }

    /// The sign-in page is asked for as JSON with the person's bearer, which is the whole reason
    /// the app asks rather than the browser (opengrok-server#269), and a Bot's own connection
    /// names the Bot.
    #[tokio::test]
    async fn a_connect_link_is_asked_for_with_the_bearer_and_comes_back_as_a_url() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/connections/gmail/authorize"))
            .and(wiremock::matchers::query_param("format", "json"))
            .and(wiremock::matchers::query_param_is_missing("coworker_id"))
            .and(wiremock::matchers::header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s"
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/connections/gmail/authorize"))
            .and(wiremock::matchers::query_param("format", "json"))
            .and(wiremock::matchers::query_param("coworker_id", "cw 1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "url": "https://example.com/a" })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        assert_eq!(
            client.connect_link("gmail", None).await.unwrap(),
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s"
        );
        assert_eq!(
            client.connect_link("gmail", Some("cw 1")).await.unwrap(),
            "https://example.com/a"
        );
    }

    /// Only a web address goes to the browser: the system opens a file or another program for
    /// any other kind of link just as readily, and a link with no scheme of its own is no address
    /// at all. A service this server does not connect is its 404, in its words.
    #[tokio::test]
    async fn a_connect_link_that_is_not_a_web_address_is_refused() {
        let server = MockServer::start().await;
        let not_web = [
            ("file", "file:///Applications/Calculator.app"),
            ("slack", "slack://open?team=T1"),
            ("script", "javascript:alert(document.cookie)"),
            ("relative", "/connections/callback?code=c&state=s"),
        ];
        for (connector, url) in not_web {
            Mock::given(method("GET"))
                .and(path(format!("/connections/{connector}/authorize")))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "url": url })))
                .mount(&server)
                .await;
        }
        Mock::given(method("GET"))
            .and(path("/connections/fax/authorize"))
            .respond_with(
                ResponseTemplate::new(404).set_body_string("no provider is configured for fax"),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        for (connector, url) in not_web {
            let error = client.connect_link(connector, None).await.unwrap_err();
            assert_eq!(
                error.message, "the server's sign-in link is not a web address",
                "{url}"
            );
        }
        let unknown = client.connect_link("fax", None).await.unwrap_err();
        assert_eq!(
            (unknown.status, unknown.message.as_str()),
            (Some(404), "no provider is configured for fax")
        );
    }

    /// The address opened is the one the check read, not the server's text around it: a link
    /// that passes only once its leading whitespace is dropped goes to the browser without it.
    #[tokio::test]
    async fn a_connect_link_is_opened_as_it_was_checked() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/connections/gmail/authorize"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "url": " \t https://accounts.google.com/o/oauth2/v2/auth?state=s"
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        assert_eq!(
            client.connect_link("gmail", None).await.unwrap(),
            "https://accounts.google.com/o/oauth2/v2/auth?state=s"
        );
    }

    /// Several accounts of one service are several rows, each saying how it was signed in to
    /// (opengrok-server #359, agreed shape; branch gol/service-accounts). A row with no kind is
    /// from a server before it, whose only way in was the sign-in page, and a kind from later
    /// does not fail the list.
    #[tokio::test]
    async fn accounts_of_one_service_are_rows_of_their_own_with_their_kind() {
        let server = MockServer::start().await;
        let account = |id: &str, label: &str, kind: Value| {
            let mut row = connection_row(id, &[]);
            row["connector"] = json!("github");
            row["label"] = json!(label);
            if !kind.is_null() {
                row["kind"] = kind;
            }
            row
        };
        Mock::given(method("GET"))
            .and(path("/connections"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                account("conn_1", "GitHub", json!("oauth")),
                account("conn_2", "GitHub 2", json!("token")),
                account("conn_3", "GitHub 3", Value::Null),
                account("conn_4", "GitHub 4", json!("passkey")),
            ])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let listed = client.list_connections().await.unwrap();
        let read: Vec<(&str, ConnectionKind)> = listed
            .iter()
            .map(|row| (row.label.as_str(), row.kind))
            .collect();
        assert_eq!(
            read,
            [
                ("GitHub", ConnectionKind::Oauth),
                ("GitHub 2", ConnectionKind::Token),
                ("GitHub 3", ConnectionKind::Oauth),
                ("GitHub 4", ConnectionKind::Other),
            ]
        );
    }

    /// Reconnect asks for one account's sign-in page with the bearer, in the shape Connect is
    /// answered in, and only a web address comes back (opengrok-server #359, agreed shape; branch
    /// gol/service-accounts).
    #[tokio::test]
    async fn a_reconnect_link_is_asked_for_one_account_and_checked_like_a_connect() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/connections/conn_1/reconnect"))
            .and(wiremock::matchers::query_param("format", "json"))
            .and(wiremock::matchers::query_param_is_missing("coworker_id"))
            .and(wiremock::matchers::header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "url": "https://github.com/login/oauth/authorize?state=s", "expiresAtMs": 1
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/connections/conn_1/reconnect"))
            .and(wiremock::matchers::query_param("coworker_id", "cw 1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "url": "https://example.com/a" })),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/connections/conn_2/reconnect"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "url": "file:///Applications/Calculator.app" })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/connections/conn_3/reconnect"))
            .respond_with(ResponseTemplate::new(422).set_body_json(
                json!({ "error": "a token account has no sign-in page to go back to" }),
            ))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        put_cookie(&client, &live_session());
        assert_eq!(
            client.reconnect_link("conn_1", None).await.unwrap(),
            "https://github.com/login/oauth/authorize?state=s"
        );
        assert_eq!(
            client.reconnect_link("conn_1", Some("cw 1")).await.unwrap(),
            "https://example.com/a"
        );
        assert!(client.reconnect_link("conn_2", None).await.is_err());
        let refused = client.reconnect_link("conn_3", None).await.unwrap_err();
        assert_eq!(
            (refused.status, refused.message.as_str(), refused.failure()),
            (
                Some(422),
                "a token account has no sign-in page to go back to",
                Failure::Verdict
            )
        );
    }

    /// A rename sends only the label and reads back the row; a label the server will not take is
    /// its 422 in its words (opengrok-server #359, agreed shape; branch gol/service-accounts).
    #[tokio::test]
    async fn a_rename_sends_the_label_and_a_refusal_is_the_servers_sentence() {
        let server = MockServer::start().await;
        let mut renamed = connection_row("conn_1", &["cw_1"]);
        renamed["label"] = json!("Work mail");
        Mock::given(method("PATCH"))
            .and(path("/connections/conn_1"))
            .and(body_json(json!({ "label": "Work mail" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(renamed))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/connections/conn_1"))
            .and(body_json(json!({ "label": "" })))
            .respond_with(
                ResponseTemplate::new(422)
                    .set_body_json(json!({ "error": "a label is between 1 and 80 characters" })),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/connections/conn_2"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let row = client
            .rename_connection("conn_1", "Work mail")
            .await
            .unwrap()
            .expect("the row");
        assert_eq!(
            (row.id.as_str(), row.label.as_str()),
            ("conn_1", "Work mail")
        );
        let refused = client.rename_connection("conn_1", "").await.unwrap_err();
        assert_eq!(
            (refused.status, refused.message.as_str(), refused.failure()),
            (
                Some(422),
                "a label is between 1 and 80 characters",
                Failure::Verdict
            )
        );
        assert_eq!(
            client.rename_connection("conn_2", "Home").await.unwrap(),
            None,
            "a 2xx with no row is the rename taken"
        );
    }

    /// The pins are a list of which account each Bot uses for each service; picking one is a PUT
    /// naming the account, answered with the pin, and Ask each time is a DELETE answered 204
    /// (opengrok-server #359, agreed shape; branch gol/service-accounts).
    #[tokio::test]
    async fn pins_are_read_picked_and_taken_away_in_the_agreed_shape() {
        let server = MockServer::start().await;
        let pin = json!({ "coworkerId": "cw_1", "connector": "github", "connectionId": "conn_2" });
        Mock::given(method("GET"))
            .and(path("/connections/pins"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([pin.clone()])))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/pins/github"))
            .and(body_json(json!({ "connectionId": "conn_2" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(pin))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/coworkers/cw_1/pins/github"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let expected = ConnectionPin {
            coworker_id: "cw_1".into(),
            connector: "github".into(),
            connection_id: "conn_2".into(),
        };
        assert_eq!(
            client.list_connection_pins().await.unwrap(),
            vec![expected.clone()]
        );
        assert_eq!(
            client
                .pin_connection("cw_1", "github", "conn_2")
                .await
                .unwrap(),
            Some(expected)
        );
        client.unpin_connection("cw_1", "github").await.unwrap();

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/connections/pins"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        assert!(
            client.list_connection_pins().await.unwrap().is_empty(),
            "no pins is every Bot asking each time"
        );
    }

    /// An account the server will not pin is its 422 in its words, which the picker shows, and so
    /// is a refused Ask each time (opengrok-server #359, agreed shape; branch
    /// gol/service-accounts).
    #[tokio::test]
    async fn a_refused_pin_is_the_servers_sentence() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/pins/github"))
            .respond_with(
                ResponseTemplate::new(422)
                    .set_body_json(json!({ "error": "conn_9 is not one of your github accounts" })),
            )
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/coworkers/cw_9/pins/github"))
            .respond_with(
                ResponseTemplate::new(404).set_body_json(json!({ "error": "no such coworker" })),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let refused = client
            .pin_connection("cw_1", "github", "conn_9")
            .await
            .unwrap_err();
        assert_eq!(
            (refused.status, refused.message.as_str(), refused.failure()),
            (
                Some(422),
                "conn_9 is not one of your github accounts",
                Failure::Verdict
            )
        );
        let refused = client.unpin_connection("cw_9", "github").await.unwrap_err();
        assert_eq!(
            (refused.status, refused.message.as_str()),
            (Some(404), "no such coworker")
        );
    }

    /// A ceiling in the shape agreed for opengrok-server#268: the server's own tools, a plugin
    /// with its label, words and connector, `user_machine_shell` unavailable with no machine
    /// enrolled, and an enabled plugin the server no longer loads, with nothing but its name; and
    /// the version these rows are.
    fn a_ceiling() -> Value {
        json!({"tools": [
            {
                "name": "shell",
                "kind": "builtin",
                "enabled": true,
                "description": "Run a shell command on THIS BOT'S OWN computer."
            },
            {"name": "read_file", "kind": "builtin", "enabled": false, "description": "Read a file."},
            {
                "name": "user_machine_shell",
                "kind": "builtin",
                "enabled": false,
                "available": false,
                "description": "Run a shell command on the person's own machine."
            },
            {
                "name": "gmail",
                "kind": "plugin",
                "enabled": true,
                "label": "Gmail",
                "description": "Read and send mail.",
                "connector": "gmail"
            },
            {"name": "old_crm", "kind": "plugin", "enabled": true, "available": false}
        ], "version": 7})
    }

    #[tokio::test]
    async fn a_bots_ceiling_is_read_as_the_server_gives_it() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/ceiling"))
            .respond_with(ResponseTemplate::new(200).set_body_json(a_ceiling()))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let ceiling = client.coworker_ceiling("cw_1").await.unwrap();
        let names: Vec<&str> = ceiling.tools.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "shell",
                "read_file",
                "user_machine_shell",
                "gmail",
                "old_crm"
            ]
        );
        assert_eq!(ceiling.version, Some(7));
        let shell = &ceiling.tools[0];
        assert!(shell.is_builtin() && shell.enabled && shell.is_available());
        assert_eq!(
            shell.description.as_deref(),
            Some("Run a shell command on THIS BOT'S OWN computer.")
        );
        assert!(!ceiling.tools[1].enabled && ceiling.tools[1].is_available());
        let enrolled = &ceiling.tools[2];
        assert!(
            enrolled.is_builtin() && !enrolled.is_available(),
            "no machine runs commands, so the server could not offer it"
        );
        let gmail = &ceiling.tools[3];
        assert_eq!(gmail.kind, CeilingKind::Plugin);
        assert_eq!(
            (gmail.label.as_deref(), gmail.connector.as_deref()),
            (Some("Gmail"), Some("gmail"))
        );
        let gone = &ceiling.tools[4];
        assert!(gone.enabled && !gone.is_available());
        assert_eq!(
            (&gone.label, &gone.description, &gone.connector),
            (&None, &None, &None),
            "a plugin the server no longer loads may have nothing but its name"
        );
    }

    /// An empty ceiling is a ceiling; a body with no list at all is not one, and a row that does
    /// not say whether it is enabled cannot be sent back as it stands. A kind the app does not
    /// know is filed with the plugins, and a `null` availability is an absent one. A body with no
    /// version, as a server older than it sends, is read all the same.
    #[test]
    fn a_ceiling_reads_only_in_its_own_shape() {
        let read = |body: Value| serde_json::from_value::<CoworkerCeiling>(body);
        assert_eq!(read(json!({"tools": []})).unwrap().tools, Vec::new());
        assert!(read(json!({})).is_err(), "no tools array");
        assert!(
            read(json!({"tools": [{"name": "shell", "kind": "builtin"}]})).is_err(),
            "a row with no enabled"
        );
        assert!(
            read(json!({"tools": [{"name": "shell", "enabled": true}]})).is_err(),
            "a row with no kind"
        );
        let later = read(json!({"tools": [
            {"name": "x", "kind": "connector", "enabled": false, "available": null}
        ]}))
        .unwrap();
        assert_eq!(later.tools[0].kind, CeilingKind::Plugin);
        assert!(!later.tools[0].is_builtin() && later.tools[0].is_available());

        assert_eq!(
            read(json!({"tools": []})).unwrap().version,
            None,
            "versionless"
        );
        assert_eq!(
            read(json!({"tools": [], "version": null})).unwrap().version,
            None
        );
        assert_eq!(
            read(json!({"tools": [], "version": 12})).unwrap().version,
            Some(12)
        );
    }

    /// A switch sends the whole ceiling as it should now be, with the version of the rows it was
    /// built from, and takes what the server answers, which is the whole ceiling again. `[]` is
    /// sent as a list, since it means no tools at all, and rows that came with no version are
    /// sent back with none: the body carries no `version` at all rather than a `null`.
    #[tokio::test]
    async fn setting_a_ceiling_sends_every_name_and_its_version() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/ceiling"))
            .and(body_json(
                json!({"enabled": ["shell", "gmail", "old_crm"], "version": 6}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(a_ceiling()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/ceiling"))
            .and(body_json(json!({"enabled": []})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"tools": [
                {"name": "shell", "kind": "builtin", "enabled": false}
            ]})))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let sent: Vec<String> = ["shell", "gmail", "old_crm"].map(String::from).to_vec();
        let answer = client
            .set_coworker_ceiling("cw_1", &sent, Some(6))
            .await
            .unwrap();
        assert_eq!(answer.tools.len(), 5);
        assert!(answer.tools[3].enabled);
        assert_eq!(answer.version, Some(7), "the answer is the next version");
        let nothing = client
            .set_coworker_ceiling("cw_1", &[], None)
            .await
            .unwrap();
        assert!(!nothing.tools[0].enabled);
        assert_eq!(nothing.version, None, "a versionless answer is read");
    }

    /// A name the server does not list is refused with its own sentence, a stale version with
    /// its sentence and its code, and a bot the person does not own is a 404 to a read and to a
    /// write alike, in the server's shape. A server without the route answers 404 too, with
    /// nothing in it, and that is not the server saying anything about the bot.
    #[tokio::test]
    async fn a_refused_ceiling_keeps_the_servers_words() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/ceiling"))
            .respond_with(
                ResponseTemplate::new(422)
                    .set_body_json(json!({"error": "no tool or plugin named nope"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_3/ceiling"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({
                "error": "the tools changed since you looked",
                "code": "ceiling-changed"
            })))
            .mount(&server)
            .await;
        for verb in ["GET", "PUT"] {
            Mock::given(method(verb))
                .and(path("/coworkers/cw_2/ceiling"))
                .respond_with(
                    ResponseTemplate::new(404).set_body_json(json!({"error": "no such coworker"})),
                )
                .mount(&server)
                .await;
            Mock::given(method(verb))
                .and(path("/coworkers/cw_4/ceiling"))
                .respond_with(ResponseTemplate::new(404))
                .mount(&server)
                .await;
        }
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let unknown = client
            .set_coworker_ceiling("cw_1", &["nope".to_string()], Some(7))
            .await
            .unwrap_err();
        assert_eq!(unknown.status, Some(422));
        assert_eq!(unknown.message, "no tool or plugin named nope");
        assert_eq!(unknown.failure(), Failure::Verdict);

        let changed = client
            .set_coworker_ceiling("cw_3", &["shell".to_string()], Some(6))
            .await
            .unwrap_err();
        assert!(changed.is_ceiling_changed());
        assert_eq!(changed.message, "the tools changed since you looked");

        let read = client.coworker_ceiling("cw_2").await.unwrap_err();
        let write = client
            .set_coworker_ceiling("cw_2", &["shell".to_string()], None)
            .await
            .unwrap_err();
        for refused in [read, write] {
            assert_eq!(refused.status, Some(404));
            assert_eq!(refused.message, "no such coworker");
            assert_eq!(refused.failure(), Failure::Verdict);
            assert!(refused.written_by_opengrok());
        }
        let read = client.coworker_ceiling("cw_4").await.unwrap_err();
        let write = client
            .set_coworker_ceiling("cw_4", &["shell".to_string()], None)
            .await
            .unwrap_err();
        for missing in [read, write] {
            assert_eq!(missing.status, Some(404));
            assert!(
                !missing.written_by_opengrok(),
                "an empty 404 is a route this server does not have"
            );
        }
    }

    /// A read or a write of the ceiling that is not answered in time is a request nobody knows
    /// the answer to, like one that never reached the server, and not a verdict with a status.
    #[tokio::test]
    async fn a_ceiling_request_out_of_time_is_out_of_reach() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/ceiling"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(a_ceiling())
                    .set_delay(std::time::Duration::from_secs(2)),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let late = client
            .ceiling_within(
                reqwest::Method::PUT,
                "cw_1",
                Some(&json!({"enabled": ["shell"], "version": 7})),
                std::time::Duration::from_millis(100),
            )
            .await
            .unwrap_err();
        assert_eq!(late.status, None);
        assert_eq!(late.unreachable(), Some(Unreachable::Server));
        assert!(
            CEILING_TIMEOUT >= std::time::Duration::from_secs(10)
                && CEILING_TIMEOUT <= std::time::Duration::from_secs(30),
            "long enough for a slow server, short enough that a lost answer frees the card"
        );
    }

    /// A bot's skills in the shape agreed for opengrok-server#270: two of the owner's own, one
    /// attached and one not, a colleague's attached, and one of the owner's that is switched off
    /// in Settings → Skills and still attached; and the version these rows are.
    fn some_skills() -> Value {
        json!({"skills": [
            {"id": "sk_triage", "name": "triage", "description": "Sort the inbox.\nThen reply.",
                "scope": "mine", "attached": true, "enabled": true},
            {"id": "sk_draft", "name": "draft", "description": "Write a first draft.",
                "scope": "mine", "attached": false, "enabled": true},
            {"id": "sk_review", "name": "review", "description": "The team's review checklist.",
                "scope": "org", "attached": true, "enabled": true},
            {"id": "sk_old", "name": "old-notes", "description": "Last year's notes.",
                "scope": "mine", "attached": true, "enabled": false}
        ], "version": 4})
    }

    #[tokio::test]
    async fn a_bots_skills_are_read_as_the_server_gives_them() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/skills"))
            .respond_with(ResponseTemplate::new(200).set_body_json(some_skills()))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let skills = client.coworker_skills("cw_1").await.unwrap();
        let ids: Vec<&str> = skills.skills.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ids, ["sk_triage", "sk_draft", "sk_review", "sk_old"]);
        assert_eq!(skills.version, Some(4));
        let triage = &skills.skills[0];
        assert_eq!(
            (triage.name.as_str(), triage.description.as_str()),
            ("triage", "Sort the inbox.\nThen reply.")
        );
        assert!(triage.attached && triage.enabled && triage.scope == BotSkillScope::Mine);
        assert!(!skills.skills[1].attached);
        let review = &skills.skills[2];
        assert_eq!(review.scope, BotSkillScope::Org, "a colleague's");
        let old = &skills.skills[3];
        assert!(
            old.attached && !old.enabled,
            "switched off, still listed and still attached"
        );
    }

    /// An empty list is a bot with no skills to attach; a body with no list at all is not one,
    /// and a row that does not say whether it is attached, whether it is switched on, or whose it
    /// is cannot be drawn or sent back as it stands. A scope the app does not know is filed with
    /// the organization's rather than claimed as the owner's, a `null` description is none, and a
    /// body with no version is read all the same.
    #[test]
    fn a_bots_skills_read_only_in_their_own_shape() {
        let read = |body: Value| serde_json::from_value::<CoworkerSkills>(body);
        let row = |drop: &str| {
            let mut row = json!({"id": "sk_1", "name": "triage", "description": "",
                "scope": "mine", "attached": true, "enabled": true});
            row.as_object_mut().unwrap().remove(drop);
            json!({ "skills": [row] })
        };
        assert_eq!(read(json!({"skills": []})).unwrap().skills, Vec::new());
        assert!(read(json!({})).is_err(), "no skills array");
        for field in ["id", "name", "scope", "attached", "enabled"] {
            assert!(read(row(field)).is_err(), "a row with no {field}");
        }
        assert_eq!(
            read(row("description")).unwrap().skills[0].description,
            "",
            "a row with no description has no words"
        );
        let later = read(json!({"skills": [
            {"id": "sk_1", "name": "triage", "description": null, "scope": "shared",
                "attached": false, "enabled": true}
        ]}))
        .unwrap();
        assert_eq!(later.skills[0].scope, BotSkillScope::Org);
        assert_eq!(later.skills[0].description, "");
        assert_eq!(later.version, None, "versionless");
        assert_eq!(
            read(json!({"skills": [], "version": 0})).unwrap().version,
            Some(0)
        );
    }

    /// A switch sends every id the set should hold once it is taken, with the version of the rows
    /// it was built from, and takes what the server answers, which is the whole set again. `[]` is
    /// sent as a list, since it means no skills at all, and rows that came with no version are
    /// sent back with none: the body carries no `version` at all rather than a `null`.
    #[tokio::test]
    async fn setting_a_bots_skills_sends_every_id_and_its_version() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/skills"))
            .and(body_json(
                json!({"attached": ["sk_triage", "sk_review", "sk_old"], "version": 4}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json({
                let mut answer = some_skills();
                answer["version"] = json!(5);
                answer
            }))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/skills"))
            .and(body_json(json!({"attached": []})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"skills": [
                {"id": "sk_triage", "name": "triage", "description": "", "scope": "mine",
                    "attached": false, "enabled": true}
            ]})))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let sent: Vec<String> = ["sk_triage", "sk_review", "sk_old"]
            .map(String::from)
            .to_vec();
        let answer = client
            .set_coworker_skills("cw_1", &sent, Some(4))
            .await
            .unwrap();
        assert_eq!(answer.skills.len(), 4);
        assert_eq!(answer.version, Some(5), "the answer is the next version");
        let nothing = client.set_coworker_skills("cw_1", &[], None).await.unwrap();
        assert!(!nothing.skills[0].attached);
        assert_eq!(nothing.version, None, "a versionless answer is read");
    }

    /// Every refusal keeps the server's words: an id the rows do not list and a set past the cap
    /// (422), a stale version with its code (409), a withdrawn grant (403), and a bot the person
    /// does not own, a 404 in the server's shape to a read and to a write alike. A server without
    /// the route answers 404 too, with nothing in it, and that is not the server saying anything
    /// about the bot.
    #[tokio::test]
    async fn a_refused_skills_change_keeps_the_servers_words() {
        let server = MockServer::start().await;
        let refuse = |status: u16, body: Value| ResponseTemplate::new(status).set_body_json(body);
        for (id, answer) in [
            ("cw_1", refuse(422, json!({"error": "no skill sk_gone"}))),
            (
                "cw_2",
                refuse(
                    422,
                    json!({"error": "a coworker takes at most 20 skills, and this is 21"}),
                ),
            ),
            (
                "cw_3",
                refuse(
                    409,
                    json!({"error": "the skills changed since you looked", "code": "skills-changed"}),
                ),
            ),
            (
                "cw_4",
                refuse(
                    403,
                    json!({"error": "your grant to this coworker was withdrawn"}),
                ),
            ),
        ] {
            Mock::given(method("PUT"))
                .and(path(format!("/coworkers/{id}/skills")))
                .respond_with(answer)
                .mount(&server)
                .await;
        }
        for verb in ["GET", "PUT"] {
            Mock::given(method(verb))
                .and(path("/coworkers/cw_5/skills"))
                .respond_with(refuse(404, json!({"error": "no such coworker"})))
                .mount(&server)
                .await;
            Mock::given(method(verb))
                .and(path("/coworkers/cw_6/skills"))
                .respond_with(ResponseTemplate::new(404))
                .mount(&server)
                .await;
        }
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let put = |id: &'static str| {
            let client = client.clone();
            async move {
                client
                    .set_coworker_skills(id, &["sk_triage".to_string()], Some(4))
                    .await
                    .unwrap_err()
            }
        };

        let gone = put("cw_1").await;
        assert_eq!(
            (gone.status, gone.message.as_str()),
            (Some(422), "no skill sk_gone")
        );
        assert_eq!(gone.failure(), Failure::Verdict);
        let full = put("cw_2").await;
        assert_eq!(
            (full.status, full.message.as_str()),
            (
                Some(422),
                "a coworker takes at most 20 skills, and this is 21"
            )
        );
        let changed = put("cw_3").await;
        assert!(changed.is_skills_changed());
        assert_eq!(changed.message, "the skills changed since you looked");
        let withdrawn = put("cw_4").await;
        assert_eq!(
            (withdrawn.status, withdrawn.message.as_str()),
            (Some(403), "your grant to this coworker was withdrawn")
        );

        let read = client.coworker_skills("cw_5").await.unwrap_err();
        for refused in [read, put("cw_5").await] {
            assert_eq!(refused.status, Some(404));
            assert_eq!(refused.message, "no such coworker");
            assert_eq!(refused.failure(), Failure::Verdict);
            assert!(refused.written_by_opengrok());
        }
        let read = client.coworker_skills("cw_6").await.unwrap_err();
        for missing in [read, put("cw_6").await] {
            assert_eq!(missing.status, Some(404));
            assert!(
                !missing.written_by_opengrok(),
                "an empty 404 is a route this server does not have"
            );
        }
    }

    /// A read or a write of a bot's skills that is not answered in time is a request nobody knows
    /// the answer to, like one that never reached the server, and not a verdict with a status.
    #[tokio::test]
    async fn a_skills_request_out_of_time_is_out_of_reach() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/skills"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(some_skills())
                    .set_delay(std::time::Duration::from_secs(2)),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let late = client
            .skills_within(
                reqwest::Method::PUT,
                "cw_1",
                Some(&json!({"attached": ["sk_triage"], "version": 4})),
                std::time::Duration::from_millis(100),
            )
            .await
            .unwrap_err();
        assert_eq!(late.status, None);
        assert_eq!(late.unreachable(), Some(Unreachable::Server));
    }

    /// A type with parameters or capitals is sent as the plain lowercase type the server reads.
    #[test]
    fn a_file_type_is_sent_plain() {
        assert_eq!(super::upload_mime("IMAGE/PNG"), "image/png");
        assert_eq!(
            super::upload_mime(" text/plain; charset=utf-8"),
            "text/plain"
        );
    }

    /// A file over the server's cap is refused here with the server's own sentence.
    #[tokio::test]
    async fn a_file_over_the_cap_is_refused_before_it_is_sent() {
        let client = OpenGrokClient::new("http://127.0.0.1:9").unwrap();
        let big = vec![0u8; super::MAX_ATTACHMENT_BYTES + 1];
        let error = client
            .upload_attachment("th_1", "big.png", "image/png", &big)
            .await
            .unwrap_err();
        assert_eq!(error.status, Some(413));
        assert!(error.message.contains("25 MiB"), "{}", error.message);
    }

    /// A name the server would refuse is cleaned rather than losing the upload.
    #[test]
    fn a_file_name_the_server_refuses_is_cleaned() {
        assert_eq!(super::upload_filename("q3 \"final\".pdf"), "q3 _final_.pdf");
        assert_eq!(super::upload_filename("a\u{2028}b\tc"), "a_b_c");
        assert_eq!(super::upload_filename("报告.pdf"), "报告.pdf");
        assert_eq!(super::upload_filename(" "), "file");
    }

    /// An upload goes as the server's `POST /artifacts` body with `kind: "attachment"` and the
    /// conversation's thread, and its row answers with the `art_` id (opengrok-server#259).
    #[tokio::test]
    async fn an_attachment_uploads_and_answers_its_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/artifacts"))
            .and(wiremock::matchers::body_partial_json(json!({
                "kind": "attachment",
                "mime": "text/plain",
                "filename": "q3 _final_.txt",
                "base64": "aGk=",
                "threadId": "th_1"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "art_1", "accountId": "acct_1", "kind": "attachment",
                "mime": "text/plain", "filename": "notes.txt", "sizeBytes": 2,
                "recipeId": null, "runId": null, "stepIndex": null, "threadId": "th_1",
                "meta": {}, "createdAtMs": 1, "deletedAtMs": null
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let file = client
            .upload_attachment(
                "th_1",
                "q3 \"final\".txt",
                "Text/Plain; charset=utf-8",
                b"hi",
            )
            .await
            .unwrap();
        assert_eq!((file.id.as_str(), file.size_bytes), ("art_1", 2));
    }

    /// A refused upload keeps the server's sentence: a 400 for a kind of file it does not take.
    #[tokio::test]
    async fn a_refused_upload_says_why() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/artifacts"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_string("only images, videos, PDFs and text files are accepted"),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client
            .upload_attachment("th_1", "a.zip", "application/zip", b"x")
            .await
            .unwrap_err();
        assert_eq!(error.status, Some(400));
        assert!(error.message.contains("PDFs"), "{}", error.message);
    }

    /// The thread's files, each with the message it rode on; one uploaded and never sent has no
    /// `meta.messageId` and is left out.
    #[tokio::test]
    async fn a_threads_sent_files_carry_their_message() {
        let server = MockServer::start().await;
        let row = |id: &str, meta: serde_json::Value| {
            json!({
                "id": id, "accountId": "acct_1", "kind": "attachment",
                "mime": "image/png", "filename": "s.png", "sizeBytes": 9,
                "recipeId": null, "runId": null, "stepIndex": null, "threadId": "th_1",
                "meta": meta, "createdAtMs": 1, "deletedAtMs": null
            })
        };
        Mock::given(method("GET"))
            .and(path("/artifacts"))
            .and(wiremock::matchers::query_param("threadId", "th_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                row("art_1", json!({"messageId": "msg_1"})),
                row("art_2", json!({}))
            ])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let sent = client.sent_attachments("th_1").await.unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            (sent[0].file.id.as_str(), sent[0].message_id.as_str()),
            ("art_1", "msg_1")
        );
    }

    #[tokio::test]
    async fn coworker_computer_reads_vnc_url() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/computer"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "agentId": "cw_1",
                "state": "running",
                "vncUrl": "http://127.0.0.1:6080/vnc.html"
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let status = client.coworker_computer("cw_1").await.unwrap();
        assert_eq!(status.state, "running");
        assert_eq!(status.vnc_url(), Some("http://127.0.0.1:6080/vnc.html"));
        assert!(
            !status.is_egress_tunnel_available,
            "omitted isEgressTunnelAvailable defaults false"
        );
        assert!(status.box_egress_ready().is_none());
    }

    /// The standing choice arrives in the local-exec words; an older server sends nothing and
    /// a word this build does not know must not be read as a Never.
    #[test]
    fn coworker_computer_reads_the_egress_policy_or_none() {
        let older: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running"
        }))
        .unwrap();
        assert_eq!(older.egress_policy, None);
        for (word, mode) in [
            ("bypass", LocalExecMode::Always),
            ("ask", LocalExecMode::Ask),
            ("never", LocalExecMode::Never),
        ] {
            let status: CoworkerComputer = serde_json::from_value(json!({
                "agentId": "cw_1",
                "state": "running",
                "egressPolicy": word
            }))
            .unwrap();
            assert_eq!(status.egress_policy, Some(mode), "{word}");
        }
        let odd: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running",
            "egressPolicy": "sometimes"
        }))
        .unwrap();
        assert_eq!(odd.egress_policy, None, "an unknown word hides the control");
    }

    /// Why the server could not give a bot a computer rides on its status, as the corpus records
    /// it for a hire whose box could not be made: the code, the words and the stamp, as sent.
    /// The pane reads it off any status that names no box, whether no box could be made
    /// (`absent`, as on the owner's server with no Local VM image) or its provider cannot be
    /// reached (`stopped`, `unknown`). Beside a box it is a takeover's note, and a healthy box's
    /// status carries none.
    #[test]
    fn coworker_computer_reads_why_the_server_could_not_give_one() {
        let recorded = |recording: &str| -> CoworkerComputer {
            let fixture: Value = serde_json::from_str(recording).expect("the recording");
            serde_json::from_value(fixture["body"].clone()).expect("the status")
        };
        let refused = recorded(include_str!(
            "../../fixtures/wire/rest/GET__coworkers__coworker_id__computer/200-a_hosted_hire_whose_ascii_create_fails_records_why_and_makes_no_box.json"
        ));
        assert_eq!(refused.state, "absent");
        assert_eq!(
            refused.computer_error,
            Some(ComputerError {
                code: "quota_exceeded".into(),
                message: "the box refused: 429 {\"error\":\"box creation rate limit reached: \
                          https://api.box.ascii.dev/v1/boxes?key=«redacted»\"}"
                    .into(),
                updated_at_ms: 1_790_000_000_000,
            })
        );
        assert_eq!(refused.why_no_computer(), refused.computer_error.as_ref());

        let image_missing = "the box refused: 125 Unable to find image 'grok-box:local' locally \
                             … pull access denied for grok-box";
        for state in ["absent", "stopped", "unknown"] {
            let status: CoworkerComputer = serde_json::from_value(json!({
                "agentId": "cw_1",
                "state": state,
                "vncUrl": null,
                "computerError": {
                    "code": "provider_error",
                    "message": image_missing,
                    "updatedAtMs": 1_790_000_000_000_i64
                },
                "isEgressTunnelAvailable": false
            }))
            .unwrap();
            assert_eq!(
                status.why_no_computer().map(|error| error.message.as_str()),
                Some(image_missing),
                "{state}"
            );
        }

        let takeover = recorded(include_str!(
            "../../fixtures/wire/rest/GET__coworkers__coworker_id__computer/200-a_self_hosted_takeover_keeps_the_fallback_and_says_so.json"
        ));
        assert_eq!(
            takeover
                .computer_error
                .as_ref()
                .map(|error| error.code.as_str()),
            Some("invalid_key")
        );
        assert_eq!(takeover.why_no_computer(), None, "a computer was given");

        let healthy = recorded(include_str!(
            "../../fixtures/wire/rest/GET__coworkers__coworker_id__computer/200-a_healthy_local_vm_does_not_wear_another_scopes_failure.json"
        ));
        assert_eq!(healthy.computer_error, None);
        assert_eq!(healthy.why_no_computer(), None);
    }

    #[tokio::test]
    async fn set_egress_policy_puts_the_stored_word() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/computer/egress-policy"))
            .and(body_json(json!({ "mode": "never" })))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        client
            .set_egress_policy("cw_1", LocalExecMode::Never)
            .await
            .expect("204 is success");
    }

    /// Always on the tunnel's card goes out as `bypass`. On an organization's shared computer
    /// only the admin may write it, and a member's 403 comes back with its status and the
    /// server's sentence, which is what the card reads to say why.
    #[tokio::test]
    async fn set_egress_policy_sends_bypass_and_keeps_a_members_refusal() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_own/computer/egress-policy"))
            .and(body_json(json!({ "mode": "bypass" })))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_org/computer/egress-policy"))
            .and(body_json(json!({ "mode": "bypass" })))
            .respond_with(
                ResponseTemplate::new(403)
                    .set_body_string("only the organization's admin may do that"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        client
            .set_egress_policy("cw_own", LocalExecMode::Always)
            .await
            .expect("204 is success");
        let refused = client
            .set_egress_policy("cw_org", LocalExecMode::Always)
            .await
            .expect_err("a member may not set the organization's computer's choice");
        assert_eq!(refused.status, Some(403));
        assert_eq!(refused.message, "only the organization's admin may do that");
    }

    #[test]
    fn coworker_computer_reads_egress_tunnel_flag() {
        let off: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running"
        }))
        .unwrap();
        assert!(!off.is_egress_tunnel_available);
        assert!(!off.egress_tunnel_ready());
        assert!(!off.box_egress_provisioned());
        assert!(off.box_egress_ready().is_none());
        let on: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running",
            "isEgressTunnelAvailable": true
        }))
        .unwrap();
        assert!(on.is_egress_tunnel_available);
        assert!(
            !on.box_egress_provisioned(),
            "host isEgressTunnelAvailable is not box provisioned"
        );
        assert!(on.box_egress_ready().is_none());
        let nested: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running",
            "egress_tunnel": { "ready": true }
        }))
        .unwrap();
        assert!(!nested.is_egress_tunnel_available);
        assert!(nested.egress_tunnel_ready());
        assert_eq!(nested.box_egress_ready(), Some(true));
        let nested_off: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running",
            "egressTunnel": { "ready": false }
        }))
        .unwrap();
        assert_eq!(nested_off.box_egress_ready(), Some(false));
        assert!(!nested_off.egress_tunnel_ready());
        let enabled_only: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running",
            "egress_tunnel": { "enabled": true }
        }))
        .unwrap();
        assert_eq!(
            enabled_only.egress_tunnel.as_ref().and_then(|t| t.enabled),
            Some(true)
        );
        assert!(
            !enabled_only.box_egress_provisioned(),
            "egress_tunnel.enabled is not ready"
        );
        let dedicated: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running",
            "shareScope": "dedicated",
            "egress_tunnel": { "ready": true, "enabled": false }
        }))
        .unwrap();
        assert_eq!(dedicated.share_scope, Some(BoxShareScope::Dedicated));
        assert!(dedicated.box_egress_provisioned());
        assert_eq!(
            dedicated.egress_tunnel.as_ref().and_then(|t| t.enabled),
            Some(false)
        );
        let grouped: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running",
            "shareScope": "group",
            "groupId": "grp_1",
            "egress_tunnel": { "ready": true }
        }))
        .unwrap();
        assert_eq!(grouped.share_scope, Some(BoxShareScope::Group));
        assert_eq!(grouped.group_id(), Some("grp_1"));
        let url_obj: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running",
            "egress_tunnel": { "url": "ws://127.0.0.1:8790" }
        }))
        .unwrap();
        assert!(
            url_obj.egress_tunnel_ready(),
            "a box tunnel URL is ready even without ready:true"
        );
        let url_str: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running",
            "egressTunnel": "ws://127.0.0.1:8790"
        }))
        .unwrap();
        assert!(url_str.egress_tunnel_ready());
        let stale_by_digest: CoworkerComputer = serde_json::from_value(json!({
            "agentId": "cw_1",
            "state": "running",
            "image": { "running": "old", "latest": "new" }
        }))
        .unwrap();
        assert!(stale_by_digest.image_stale());
        assert!(host_egress_tunnel_enabled(
            &json!({ "egressTunnelEnabled": true })
        ));
        assert!(!host_egress_tunnel_enabled(
            &json!({ "egressTunnelEnabled": false })
        ));
        assert!(!host_egress_tunnel_enabled(&json!({})));
        assert_eq!(host_egress_tunnel_flag(&json!({})), None);
        assert_eq!(
            host_egress_tunnel_flag(&json!({ "egressTunnelEnabled": false })),
            Some(false)
        );
    }

    #[tokio::test]
    async fn host_settings_read_the_record_and_its_availability() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/host-settings"))
            .and(wiremock::matchers::query_param("coworker", "cw_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "egressTunnelEnabled": true,
                "egressTunnelAvailable": true,
                "hasSeenOnboarding": true
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/ag-ui/host-settings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "egressTunnelEnabled": false,
                "egressTunnelAvailable": false
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let settings = client.host_settings(Some("cw_1")).await.unwrap();
        assert!(host_egress_tunnel_enabled(&settings));
        assert_eq!(host_egress_tunnel_available(&settings), Some(true));
        let after = client
            .patch_host_settings(None, &json!({ "egressTunnelEnabled": false }))
            .await
            .unwrap();
        assert_eq!(host_egress_tunnel_flag(&after), Some(false));
        assert_eq!(host_egress_tunnel_available(&after), Some(false));
        assert_eq!(
            host_egress_tunnel_available(&json!({})),
            None,
            "a host that did not send the key must not flip the toggle"
        );
        assert_eq!(host_settings_path(None), "/ag-ui/host-settings");
        assert_eq!(host_settings_path(Some("")), "/ag-ui/host-settings");
        assert_eq!(
            host_settings_path(Some("cw_1")),
            "/ag-ui/host-settings?coworker=cw_1"
        );
    }

    /// The old door's 401 was the shared host bearer and not the session; on the AG-UI door a
    /// 401 that survives one refresh is the session, like everywhere else.
    #[tokio::test]
    async fn host_settings_401_is_the_session() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/host-settings"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(json!({ "error": "sign in first" })),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client.host_settings(None).await.unwrap_err();
        assert_eq!(error.status, Some(401));
        assert!(error.is_signed_out());
    }

    #[tokio::test]
    async fn ensure_coworker_computer_posts_and_reads_the_status() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/coworkers/cw_1/computer"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "agentId": "cw_1",
                "state": "running",
                "vncUrl": "http://127.0.0.1:6080/vnc.html"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let status = client.ensure_coworker_computer("cw_1").await.unwrap();
        assert_eq!(status.vnc_url(), Some("http://127.0.0.1:6080/vnc.html"));
    }

    /// A server without the endpoint is a state the app must recognise, not a crash.
    #[tokio::test]
    async fn coworker_computer_reports_a_missing_endpoint_as_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/computer"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client.coworker_computer("cw_1").await.unwrap_err();
        assert_eq!(error.status, Some(404));
    }

    #[tokio::test]
    async fn a_box_without_a_screen_has_no_vnc_url() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/computer"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "agentId": "cw_1",
                "state": "running",
                "vncUrl": null
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let status = client.coworker_computer("cw_1").await.unwrap();
        assert_eq!(status.vnc_url(), None);
    }

    #[test]
    fn latest_queued_approval_is_the_last_for_that_thread() {
        let queue = vec![
            QueuedApproval {
                run_id: "r1".into(),
                thread_id: "t1".into(),
                call_id: "old".into(),
                tool: "user_machine_shell".into(),
                arguments: json!({"command": "ls"}),
                reason: None,
                why: None,
            },
            QueuedApproval {
                run_id: "r2".into(),
                thread_id: "t2".into(),
                call_id: "other".into(),
                tool: "user_machine_shell".into(),
                arguments: json!({"command": "pwd"}),
                reason: None,
                why: None,
            },
            QueuedApproval {
                run_id: "r3".into(),
                thread_id: "t1".into(),
                call_id: "new".into(),
                tool: "user_machine_shell".into(),
                arguments: json!({"command": "uname"}),
                reason: None,
                why: None,
            },
        ];
        let latest = QueuedApproval::latest_for_conversation(&queue, "t1").unwrap();
        assert_eq!(latest.call_id, "new");
        assert!(QueuedApproval::latest_for_conversation(&queue, "missing").is_none());
    }

    #[test]
    fn local_exec_mode_round_trips_grok_settings_words() {
        assert_eq!(LocalExecMode::from_stored("ask").as_stored(), "ask");
        assert_eq!(LocalExecMode::from_stored("bypass"), LocalExecMode::Always);
        assert_eq!(LocalExecMode::Always.as_stored(), "bypass");
        assert_eq!(LocalExecMode::from_stored("never"), LocalExecMode::Never);
        assert_eq!(LocalExecMode::from_stored(""), LocalExecMode::Never);
        assert_eq!(LocalExecMode::Always.label(), "Always allow");
        assert_eq!(LocalExecMode::Ask.label(), "Ask every time");
        assert_eq!(LocalExecMode::Never.label(), "Never allow");
    }

    #[tokio::test]
    async fn list_computers_skips_revoked_and_reads_mode() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/local-exec/daemon"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "machines": [
                    {"machineId": "mac_live", "label": "NativeChat on this Mac", "revoked": false, "connected": true},
                    {"machineId": "mac_dead", "label": "old", "revoked": true}
                ]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/local-exec/policy"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"mode": "bypass"})))
            .mount(&server)
            .await;

        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let computers = client.list_computers().await.unwrap();
        assert_eq!(computers.len(), 1);
        assert_eq!(computers[0].machine_id, "mac_live");
        assert_eq!(computers[0].mode, LocalExecMode::Always);
        assert!(computers[0].online);
    }

    /// A computer's row carries its own relay switch and whether the server holds its relay stream
    /// now, beside what it always carried (opengrok-server #342 (main 2136ffc), `row` in
    /// `crates/opengrok-server/src/local_exec.rs`): every field as the server writes it,
    /// and a row from a server before the switch, which has neither key, reads as switched on and
    /// not relaying. The roster carries both on, for each computer's card, and leaves a revoked
    /// computer out, as it always did: the server refuses to switch one (409 `revoked`), so a card
    /// for it would have nothing to offer.
    #[tokio::test]
    async fn a_computers_row_says_its_relay_switch_and_whether_it_relays_now() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/local-exec/daemon"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "machines": [
                    {"machineId": "mac_1", "label": "Ada's MacBook", "enrolledAtMs": 1790000000000_i64,
                     "revoked": false, "connected": true, "relayEnabled": true, "relaying": true},
                    {"machineId": "mac_2", "label": "Studio", "enrolledAtMs": 1790000000001_i64,
                     "revoked": false, "connected": false, "relayEnabled": false, "relaying": false},
                    {"machineId": "mac_3", "label": "Old server's", "revoked": false,
                     "connected": false},
                    {"machineId": "mac_4", "label": "Revoked", "enrolledAtMs": 1790000000002_i64,
                     "revoked": true, "connected": false, "relayEnabled": true, "relaying": false}
                ]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/local-exec/policy"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"mode": "ask"})))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();

        let rows = client.list_daemons().await.unwrap();
        let said: Vec<(&str, bool, bool)> = rows
            .iter()
            .map(|row| (row.machine_id.as_str(), row.relay_enabled, row.relaying))
            .collect();
        assert_eq!(
            said,
            [
                ("mac_1", true, true),
                ("mac_2", false, false),
                ("mac_3", true, false),
                ("mac_4", true, false)
            ],
            "a row with neither key reads on and not relaying"
        );
        assert!(rows[3].revoked, "the list says which are revoked");
        let said: Vec<(&str, bool, bool)> = said.into_iter().take(3).collect();

        let computers = client.list_computers().await.unwrap();
        let carried: Vec<(&str, bool, bool)> = computers
            .iter()
            .map(|computer| {
                (
                    computer.machine_id.as_str(),
                    computer.relay_enabled,
                    computer.relaying,
                )
            })
            .collect();
        assert_eq!(carried, said, "the roster carries them for the cards");
    }

    /// A computer's relay switch is one PATCH of `{relayEnabled}` to that computer's id, the same
    /// for any computer of the account, and the server answers the computer's row as it stands
    /// after: switched off, no longer relaying. Nothing else is in the body.
    #[tokio::test]
    async fn a_computers_relay_switch_is_a_patch_of_relay_enabled_and_answers_its_row() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/local-exec/daemon/mac_2"))
            .and(body_json(json!({ "relayEnabled": false })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "machineId": "mac_2", "label": "Studio", "enrolledAtMs": 1790000000001_i64,
                "revoked": false, "connected": true, "relayEnabled": false, "relaying": false
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/local-exec/daemon/mac_2"))
            .and(body_json(json!({ "relayEnabled": true })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "machineId": "mac_2", "label": "Studio", "enrolledAtMs": 1790000000001_i64,
                "revoked": false, "connected": true, "relayEnabled": true, "relaying": true
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();

        let off = client.switch_computer_relay("mac_2", false).await.unwrap();
        assert_eq!(
            (off.machine_id.as_str(), off.relay_enabled, off.relaying),
            ("mac_2", false, false)
        );
        let on = client.switch_computer_relay("mac_2", true).await.unwrap();
        assert_eq!((on.relay_enabled, on.relaying), (true, true));
    }

    /// What the server refuses a switch with is read as its words and its code, each as the server
    /// writes them (`switch_relay` in opengrok-server #342 (main 2136ffc)): another account's
    /// computer and one nobody enrolled
    /// are the same 404 `not_found`, a revoked one 409 `revoked`, and a body without a true or
    /// false 400 `bad_request`. An id with a slash in it cannot turn the route into another.
    #[tokio::test]
    async fn a_refused_relay_switch_reads_the_servers_words_and_code() {
        let server = MockServer::start().await;
        for (id, status, words, code) in [
            (
                "mac_theirs",
                404,
                "no computer of yours has that id",
                "not_found",
            ),
            (
                "mac_old",
                409,
                "this computer was revoked; enrol it again to use it",
                "revoked",
            ),
            (
                "mac_odd",
                400,
                "relayEnabled must be true or false",
                "bad_request",
            ),
        ] {
            Mock::given(method("PATCH"))
                .and(path(format!("/local-exec/daemon/{id}")))
                .respond_with(
                    ResponseTemplate::new(status)
                        .set_body_json(json!({ "error": words, "code": code })),
                )
                .expect(1)
                .mount(&server)
                .await;
            let client = OpenGrokClient::new(&server.uri()).unwrap();
            let refused = client.switch_computer_relay(id, false).await.unwrap_err();
            assert_eq!(refused.status, Some(status), "{id}");
            assert_eq!(refused.message, words, "{id}");
            assert_eq!(refused.code(), Some(code), "{id}");
            assert!(refused.written_by_opengrok(), "{id}");
        }
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let odd = client
            .switch_computer_relay("../account", true)
            .await
            .unwrap_err();
        assert!(
            odd.status.is_some(),
            "an id that is not a path is a refusal, never another route's answer"
        );
        let asked: Vec<String> = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|request| request.url.path().to_string())
            .collect();
        assert_eq!(
            asked.last().map(String::as_str),
            Some("/local-exec/daemon/..%2Faccount"),
            "{asked:?}"
        );
    }

    /// Always on the local shell's card posts one rule for the command on it. A rule the server
    /// will not keep comes back as a 422 whose body is the reason, and the reason is what the
    /// card shows (opengrok-server `add_rule` in `crates/opengrok-server/src/local_exec.rs`).
    #[tokio::test]
    async fn a_standing_rule_names_its_command_and_a_refusal_reads_back_why() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/local-exec/policy/rule"))
            .and(body_json(
                json!({ "machineId": "mac_1", "kind": "allow", "pattern": "ls -la" }),
            ))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/local-exec/policy/rule"))
            .and(body_json(
                json!({ "machineId": "mac_1", "kind": "allow", "pattern": "sudo ls" }),
            ))
            .respond_with(
                ResponseTemplate::new(422).set_body_string("sudo cannot be a standing allow"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();

        client
            .add_local_exec_rule("mac_1", "allow", "ls -la")
            .await
            .unwrap();
        let refused = client
            .add_local_exec_rule("mac_1", "allow", "sudo ls")
            .await
            .unwrap_err();

        assert_eq!(refused.status, Some(422));
        assert_eq!(refused.message, "sudo cannot be a standing allow");
    }

    /// The listing Settings → Computer draws this Mac's rules from, body for body as
    /// opengrok-server `policy_listing` writes it: both lists in the server's order, and each
    /// allow the gate can never match named again in `inert` with the server's reason (#246).
    #[tokio::test]
    async fn a_policy_lists_both_kinds_of_rule_and_the_allows_that_never_match() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/local-exec/policy"))
            .and(wiremock::matchers::query_param("machine", "mac_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "machineId": "mac_1",
                "mode": "ask",
                "allow": ["ls -la", "sudo ls"],
                "deny": ["rm -rf /tmp/x"],
                "inert": [{ "pattern": "sudo ls", "reason": "sudo cannot be a standing allow" }]
            })))
            .expect(2)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();

        let policy = client.local_exec_policy("mac_1").await.unwrap();

        assert_eq!(
            policy,
            LocalExecPolicy {
                machine_id: "mac_1".into(),
                mode: "ask".into(),
                allow: vec!["ls -la".into(), "sudo ls".into()],
                deny: vec!["rm -rf /tmp/x".into()],
                inert: vec![InertRule {
                    pattern: "sudo ls".into(),
                    reason: "sudo cannot be a standing allow".into(),
                }],
            }
        );
        // The roster reads the mode off the same listing.
        assert_eq!(client.local_exec_mode("mac_1").await.unwrap(), "ask");
    }

    /// A server from before #246 names no inert allows, which reads as every allow being in
    /// effect rather than as a listing that could not be read.
    #[tokio::test]
    async fn a_policy_from_before_inert_rules_has_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/local-exec/policy"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "machineId": "mac_1",
                "mode": "ask",
                "allow": ["ls -la"],
                "deny": []
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();

        let policy = client.local_exec_policy("mac_1").await.unwrap();

        assert_eq!(policy.allow, vec!["ls -la".to_string()]);
        assert!(policy.inert.is_empty());
    }

    /// Remove sends back exactly what the listing gave, as the body opengrok-server
    /// `remove_rule` reads (`RuleBody`: `{machineId, kind, pattern}`), and a store that failed
    /// comes back with the server's own sentence.
    #[tokio::test]
    async fn removing_a_rule_names_it_exactly_and_a_failure_reads_back_why() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/local-exec/policy/rule"))
            .and(body_json(
                json!({ "machineId": "mac_1", "kind": "deny", "pattern": "rm -rf /tmp/x" }),
            ))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/local-exec/policy/rule"))
            .and(body_json(
                json!({ "machineId": "mac_1", "kind": "allow", "pattern": "ls -la" }),
            ))
            .respond_with(ResponseTemplate::new(500).set_body_string("could not remove the rule"))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();

        client
            .remove_local_exec_rule("mac_1", "deny", "rm -rf /tmp/x")
            .await
            .unwrap();
        let failed = client
            .remove_local_exec_rule("mac_1", "allow", "ls -la")
            .await
            .unwrap_err();

        assert_eq!(failed.status, Some(500));
        assert_eq!(failed.message, "could not remove the rule");
    }

    fn computer(
        machine_id: &str,
        label: &str,
        this_machine: bool,
        online: bool,
        mode: LocalExecMode,
    ) -> ConnectedComputer {
        ConnectedComputer {
            machine_id: machine_id.into(),
            label: label.into(),
            mode,
            this_machine,
            online,
            relay_enabled: true,
            relaying: false,
            folded: Vec::new(),
        }
    }

    #[test]
    fn collapse_roster_keeps_one_row_for_duplicate_machine_id() {
        let collapsed = collapse_computer_roster(vec![
            computer(
                "mac_1",
                "NativeChat on this Mac",
                false,
                false,
                LocalExecMode::Always,
            ),
            computer(
                "mac_1",
                "NativeChat on this Mac",
                true,
                true,
                LocalExecMode::Never,
            ),
        ]);
        assert_eq!(collapsed.len(), 1);
        assert!(collapsed[0].this_machine);
        assert!(collapsed[0].online);
        assert_eq!(collapsed[0].mode, LocalExecMode::Never);
        assert!(
            collapsed[0].folded.is_empty(),
            "one enrolment, listed twice"
        );
    }

    /// The stale enrolments' ids stay with the live row they fold into, each once, whichever
    /// order the server lists them in, for its relay switch to move them too.
    #[test]
    fn collapse_roster_drops_stale_enrol_with_the_same_label() {
        let label = "NativeChat on uriahs-MacBook-Pro.local";
        let collapsed = collapse_computer_roster(vec![
            computer("mac_stale", label, false, false, LocalExecMode::Always),
            computer("mac_live", label, true, true, LocalExecMode::Never),
            computer("mac_stale", label, false, false, LocalExecMode::Always),
            computer("mac_older", label, false, false, LocalExecMode::Ask),
        ]);
        assert_eq!(collapsed.len(), 1);
        assert_eq!(collapsed[0].machine_id, "mac_live");
        assert!(collapsed[0].this_machine);
        assert_eq!(collapsed[0].mode, LocalExecMode::Never);
        assert_eq!(collapsed[0].folded, ["mac_stale", "mac_older"]);
    }

    #[test]
    fn collapse_roster_prefers_online_when_neither_is_this_machine() {
        let label = "NativeChat on uriahs-MacBook-Pro.local";
        let collapsed = collapse_computer_roster(vec![
            computer("mac_off", label, false, false, LocalExecMode::Always),
            computer("mac_on", label, false, true, LocalExecMode::Never),
        ]);
        assert_eq!(collapsed.len(), 1);
        assert_eq!(collapsed[0].machine_id, "mac_on");
        assert!(collapsed[0].online);
        assert_eq!(collapsed[0].folded, ["mac_off"]);
    }

    #[test]
    fn collapse_roster_keeps_distinct_labels() {
        let collapsed = collapse_computer_roster(vec![
            computer(
                "mac_a",
                "NativeChat on office.local",
                false,
                true,
                LocalExecMode::Ask,
            ),
            computer(
                "mac_b",
                "NativeChat on home.local",
                false,
                true,
                LocalExecMode::Ask,
            ),
        ]);
        assert_eq!(collapsed.len(), 2);
        assert!(collapsed.iter().all(|computer| computer.folded.is_empty()));
    }

    #[test]
    fn recipe_step_round_trips_its_op_tag() {
        let steps = vec![
            RecipeStep::Click {
                x: 412,
                y: 88,
                button: Some(json!("left")),
            },
            RecipeStep::DoubleClick { x: 1, y: 2 },
            RecipeStep::Drag {
                x1: 1,
                y1: 2,
                x2: 3,
                y2: 4,
            },
            RecipeStep::Type {
                text: "example.com".into(),
            },
            RecipeStep::Key {
                key: "Return".into(),
            },
            RecipeStep::Scroll {
                x: 10,
                y: 20,
                dx: 0,
                dy: -120,
            },
            RecipeStep::Wait { ms: 500 },
        ];
        let json = serde_json::to_value(&steps).unwrap();
        assert_eq!(json[0]["op"], "click");
        assert_eq!(json[1]["op"], "double_click");
        assert_eq!(json[6], json!({"op": "wait", "ms": 500}));
        let back: Vec<RecipeStep> = serde_json::from_value(json).unwrap();
        assert_eq!(back, steps);
        assert_eq!(back[0].describe(), "click (412, 88)");
        assert_eq!(back[1].describe(), "double-click (1, 2)");
        assert_eq!(back[3].describe(), "type \"example.com\"");
        assert_eq!(back[4].describe(), "key Return");
        assert_eq!(back[6].describe(), "wait 500 ms");
        let right: RecipeStep =
            serde_json::from_value(json!({"op": "click", "x": 1, "y": 2, "button": "right"}))
                .unwrap();
        assert_eq!(right.describe(), "click (1, 2) button right");
    }

    #[test]
    fn recipe_summary_reads_camel_case_and_the_share_state() {
        let summary: RecipeSummary = serde_json::from_value(json!({
            "id": "rcp_1",
            "ownerId": "acc_2",
            "orgId": "org_1",
            "name": "Open the mail",
            "description": null,
            "screen": {"width": 1280, "height": 800},
            "createdAtMs": 1,
            "updatedAtMs": 2,
            "deletedAtMs": null,
            "latestVersion": 2,
            "relation": "invited",
            "shareState": "pending"
        }))
        .unwrap();
        assert_eq!(summary.relation, RecipeRelation::Invited);
        assert_eq!(summary.share_state, Some(RecipeShareState::Pending));
        assert!(summary.is_pending_invite());
        assert!(!summary.is_mine());
        assert_eq!(summary.description, "");
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["ownerId"], "acc_2");
        assert_eq!(json["latestVersion"], 2);
        assert_eq!(json["relation"], "invited");
        assert_eq!(json["shareState"], "pending");
        let back: RecipeSummary = serde_json::from_value(json).unwrap();
        assert_eq!(back, summary);

        // A relation this client has no word for is "none", not a failed list.
        let odd: RecipeSummary =
            serde_json::from_value(json!({"id": "rcp_2", "relation": "custodian"})).unwrap();
        assert_eq!(odd.relation, RecipeRelation::None);
        assert_eq!(odd.screen, RecipeScreen::default());
        assert!(
            odd.parameters.is_empty(),
            "a server that names no parameters asks for nothing, rather than failing to list"
        );
    }

    /// The declaration exactly as `GET /recipes` sends it. A fixture written from memory is how
    /// a shape drifts apart between two repos without either noticing, so this one is the
    /// server's own keys and nothing else.
    #[test]
    fn a_summary_carries_the_parameters_the_server_declares() {
        let summary: RecipeSummary = serde_json::from_value(json!({
            "id": "rcp_1",
            "name": "youtube",
            "parameters": [
                { "name": "search_term", "description": "What to search YouTube for",
                  "required": true, "kind": "text", "default": null, "values": null }
            ]
        }))
        .unwrap();
        let [search_term] = &summary.parameters[..] else {
            panic!("the one declared parameter is read");
        };
        assert_eq!(search_term.name, "search_term");
        assert_eq!(search_term.description, "What to search YouTube for");
        assert!(search_term.required);
        assert_eq!(search_term.kind, RecipeParameterKind::Text);
        assert_eq!(search_term.default, None);
        assert_eq!(search_term.allowed(), None);

        // Round-trip, so what this client would send back reads as what it was sent.
        let json = serde_json::to_value(&summary.parameters).unwrap();
        assert_eq!(json[0]["name"], "search_term");
        assert_eq!(json[0]["kind"], "text");
        assert_eq!(json[0]["required"], true);
        assert!(json[0]["default"].is_null());
        assert!(json[0]["values"].is_null());
        let back: Vec<RecipeParameter> = serde_json::from_value(json).unwrap();
        assert_eq!(back, summary.parameters);

        // The other two kinds, a default sent as the thing itself, and a narrowed set.
        let rest: Vec<RecipeParameter> = serde_json::from_value(json!([
            { "name": "count", "description": "", "required": false, "kind": "number",
              "default": 5, "values": null },
            { "name": "shorts", "description": "", "required": false, "kind": "boolean",
              "default": false, "values": null },
            { "name": "lang", "description": "", "required": true, "kind": "text",
              "default": null, "values": ["en", "es"] },
            { "name": "mystery", "description": "", "required": false, "kind": "colour",
              "default": null, "values": null }
        ]))
        .unwrap();
        assert_eq!(rest[0].kind, RecipeParameterKind::Number);
        assert_eq!(rest[0].default.as_deref(), Some("5"));
        assert_eq!(rest[1].kind, RecipeParameterKind::Boolean);
        assert_eq!(rest[1].default.as_deref(), Some("false"));
        assert_eq!(
            rest[2].allowed(),
            Some(&["en".to_string(), "es".to_string()][..])
        );
        assert_eq!(
            rest[3].kind,
            RecipeParameterKind::Text,
            "a kind this client has no word for leaves a field that can still be typed into"
        );
    }

    #[test]
    fn a_version_declares_what_it_needs_told_whichever_half_of_the_row_it_is_on() {
        let beside: RecipeVersion = serde_json::from_value(json!({
            "version": 2, "kind": "filtered", "createdAtMs": 2,
            "parameters": [{"name": "search_term", "required": true, "kind": "text"}],
            "body": {"steps": []}
        }))
        .unwrap();
        assert_eq!(beside.declared().len(), 1);
        assert_eq!(beside.declared()[0].name, "search_term");

        let inside: RecipeVersion = serde_json::from_value(json!({
            "version": 2, "kind": "filtered", "createdAtMs": 2,
            "body": {"steps": [], "parameters": [
                {"name": "search_term", "required": true, "kind": "text"}
            ]}
        }))
        .unwrap();
        assert_eq!(inside.declared(), beside.declared());

        // A version taught before parameters existed declares nothing, and reads as it always
        // did rather than failing.
        let older: RecipeVersion =
            serde_json::from_value(json!({"version": 1, "kind": "raw", "body": {"events": 3}}))
                .unwrap();
        assert!(older.declared().is_empty());
        assert_eq!(older.event_count(), 3);
    }

    #[test]
    fn a_value_is_checked_against_the_kind_and_sent_as_that_kind() {
        let number: RecipeParameter =
            serde_json::from_value(json!({"name": "count", "required": true, "kind": "number"}))
                .unwrap();
        assert_eq!(number.reject("12"), None);
        assert_eq!(number.reject("-1.5"), None);
        assert_eq!(
            number.reject("ten").as_deref(),
            Some("count takes a number, and \"ten\" is not one.")
        );
        assert_eq!(number.encode("12"), json!(12));
        assert_eq!(number.encode("1.5"), json!(1.5));

        let flag: RecipeParameter =
            serde_json::from_value(json!({"name": "shorts", "kind": "boolean"})).unwrap();
        assert_eq!(flag.reject("yes"), None);
        assert_eq!(
            flag.reject("maybe").as_deref(),
            Some("shorts is a yes or a no, so pick one.")
        );
        assert_eq!(flag.encode("yes"), json!(true));
        assert_eq!(flag.encode("false"), json!(false));

        let lang: RecipeParameter =
            serde_json::from_value(json!({"name": "lang", "kind": "text", "values": ["en", "es"]}))
                .unwrap();
        assert_eq!(lang.reject("es"), None);
        assert_eq!(
            lang.reject("fr").as_deref(),
            Some("lang takes one of: en, es."),
            "a refusal that does not say what is allowed leaves the person guessing"
        );
        assert_eq!(
            lang.encode("ES"),
            json!("es"),
            "case is not what they are choosing between, so the declared spelling goes"
        );

        let free: RecipeParameter =
            serde_json::from_value(json!({"name": "search_term", "kind": "text"})).unwrap();
        assert_eq!(free.reject("anything at all"), None);
        assert_eq!(free.encode("mundo"), json!("mundo"));
    }

    #[test]
    fn a_raw_version_reads_the_tape_the_server_sends() {
        // The server sends the count under `events` and the tape under `tape`, cut at a cap.
        let sent: RecipeVersion = serde_json::from_value(json!({
            "version": 1, "kind": "raw", "createdAtMs": 1,
            "body": {"events": 3100, "truncated": true, "tape": [
                {"kind": "down", "x": 640, "y": 60, "button": 0, "at": 1000},
                {"kind": "keydown", "key": "e", "code": "KeyE", "at": 1900}
            ]}
        }))
        .unwrap();
        assert_eq!(sent.event_count(), 3100, "the count is the whole tape's");
        assert_eq!(sent.tape_events().map(<[_]>::len), Some(2));
        assert!(sent.tape_truncated());

        // A body that puts the events under `events` instead reads the same way.
        let inline: RecipeVersion = serde_json::from_value(json!({
            "version": 1, "kind": "raw", "createdAtMs": 1,
            "body": {"events": [{"kind": "up", "x": 1, "y": 2, "at": 5}]}
        }))
        .unwrap();
        assert_eq!(inline.event_count(), 1);
        assert_eq!(inline.tape_events().map(<[_]>::len), Some(1));
        assert!(!inline.tape_truncated());

        // And a count alone still says how much was taped, with no tape to show.
        let counted: RecipeVersion = serde_json::from_value(json!({
            "version": 1, "kind": "raw", "createdAtMs": 1, "body": {"events": 14}
        }))
        .unwrap();
        assert_eq!(counted.event_count(), 14);
        assert!(counted.tape_events().is_none());
    }

    #[test]
    fn recipe_detail_reads_versions_shares_grants_runs_and_bots() {
        let detail: RecipeDetail = serde_json::from_value(json!({
            "recipe": {"id": "rcp_1", "ownerId": "acc_1", "name": "Mail", "relation": "mine", "latestVersion": 2},
            "versions": [
                {"version": 1, "kind": "raw", "note": null, "createdBy": "acc_1", "createdAtMs": 1, "body": {"events": 312}},
                {"version": 2, "kind": "filtered", "note": null, "createdBy": null, "createdAtMs": 2,
                 "body": {"steps": [{"op": "click", "x": 1, "y": 2, "button": "left"}, {"op": "wait", "ms": 200}], "stop_on_error": true, "screenshot": null}}
            ],
            // Exactly the shape the server sends: its row structs are camelCase too, and a
            // snake_case fixture here let every grant, share and run bind to nothing at all.
            "shares": [{"recipeId": "rcp_1", "scope": "org", "scopeId": "org_1", "grantedBy": "acc_1", "grantedAtMs": 3, "acceptedAtMs": null, "declinedAtMs": null}],
            "grants": [{"recipeId": "rcp_1", "coworkerId": "cw_1", "grantedBy": "acc_1", "grantedAtMs": 4}],
            "runs": [{"id": "rrun_1", "recipeId": "rcp_1", "version": 2, "coworkerId": "cw_1", "runId": "run_1", "ok": false, "stoppedAt": 1,
                      "receipt": {"ok": false, "ran": 1, "stopped_at": 1, "steps": [{"ok": true}, {"ok": false, "error": "nothing at (5, 5)"}]}, "atMs": 5}],
            "myBots": [{"id": "cw_1", "name": "Bob"}]
        }))
        .unwrap();
        assert_eq!(detail.versions[0].event_count(), 312);
        assert!(!detail.versions[0].is_runnable());
        assert_eq!(detail.runnable_version().map(|v| v.version), Some(2));
        assert_eq!(detail.versions[1].body.steps.len(), 2);
        assert_eq!(detail.shares[0].state_label(), "pending");
        assert!(detail.is_granted("cw_1"));
        assert!(!detail.is_granted("cw_2"));
        assert_eq!(detail.bot_name("cw_1"), "Bob");
        assert_eq!(detail.bot_name("cw_2"), "cw_2");
        assert_eq!(detail.runs[0].stopped_at, Some(1));
        assert_eq!(detail.runs[0].coworker_id, "cw_1");
        assert_eq!(detail.runs[0].at_ms, 5);
        assert_eq!(
            detail.runs[0].id, "rrun_1",
            "the history names a row by this"
        );
        assert_eq!(
            detail.runs[0].receipt_steps(),
            vec![(true, None), (false, Some("nothing at (5, 5)".to_string()))]
        );
        assert_eq!(
            detail.runs[0].error().as_deref(),
            Some("nothing at (5, 5)"),
            "a run's reason is the first step that gave one"
        );
        assert_eq!(detail.shares[0].scope_id, "org_1");
        assert!(
            detail.versions[0].tape_events().is_none(),
            "a count is not a tape"
        );
    }

    /// A workflow's detail, as opengrok-server `recipes.rs` `detail_body` sends it (recorded in
    /// `fixtures/wire/rest/GET__recipes__id_/200-a_workflow_walk_survives_its_caller_hanging_up-2`):
    /// its version's body is the decision tree, whose `steps` are named branches rather than a
    /// sequence. The detail used to fail to read over that one field, taking the history, the
    /// grants and the bots down with it; now the tree is a version with no tape steps and the
    /// rest reads as it always did.
    #[tokio::test]
    async fn a_workflows_detail_reads_its_tree_as_no_tape_steps() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/recipes/rcp_tree"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "recipe": {"id": "rcp_tree", "ownerId": "acct_1", "name": "Month end",
                           "latestVersion": 1, "relation": "mine", "kind": "workflow",
                           "parameters": []},
                "versions": [{
                    "version": 1, "kind": "workflow", "note": "the tree as written",
                    "createdBy": "acct_1", "createdAtMs": 1,
                    "body": {
                        "workflow": 1, "start": "export", "parameters": [],
                        "budget": {"steps": 40, "seconds": 600},
                        "steps": {
                            "export": {"do": "run", "recipe": "rcp_export", "then": "done"},
                            "done": {"do": "stop", "say": "", "outcome": "done"}
                        }
                    }
                }],
                "shares": [], "grants": [],
                "runs": [{"id": "rrun_1", "recipeId": "rcp_tree", "version": 1,
                          "coworkerId": "cw_1", "runId": "rrun_1", "ok": true,
                          "stoppedAt": null, "atMs": 2, "leaseUntilMs": null,
                          "state": "finished", "artifacts": [],
                          "receipt": {"ok": true, "outcome": "done", "steps": 2,
                                      "trail": [{"do": "stop", "step": "done"}]}}],
                "myBots": [{"id": "cw_1", "name": "Ada"}]
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let detail = client
            .recipe("rcp_tree")
            .await
            .expect("a workflow's detail reads");
        assert!(detail.recipe.is_workflow());
        assert_eq!(detail.versions[0].kind, "workflow");
        assert!(
            detail.versions[0].body.steps.is_empty(),
            "a tree is not a tape"
        );
        assert_eq!(detail.runs[0].id, "rrun_1");
        assert!(detail.runs[0].is_over());
        assert_eq!(detail.bot_name("cw_1"), "Ada");

        // Only a workflow's version carries a tree. Any other version's steps are a tape, read
        // strictly: an object there, a step this client cannot read, or steps that are neither
        // is a tape it would show and play wrong.
        for kind in ["filtered", "edited", "raw", ""] {
            let tree: Result<RecipeVersion, _> = serde_json::from_value(json!({
                "version": 2, "kind": kind,
                "body": {"steps": {"done": {"do": "stop", "outcome": "done"}}}
            }));
            assert!(tree.is_err(), "a tree under a {kind:?} version is an error");
        }
        let odd: Result<RecipeVersion, _> = serde_json::from_value(json!({
            "version": 2, "kind": "edited", "body": {"steps": [{"op": "teleport"}]}
        }));
        assert!(odd.is_err(), "an unreadable tape step is an error");
        let neither: Result<RecipeVersion, _> =
            serde_json::from_value(json!({"version": 2, "kind": "edited", "body": {"steps": 3}}));
        assert!(neither.is_err(), "steps that are neither a tape nor a tree");
        let tape: RecipeVersion = serde_json::from_value(json!({
            "version": 2, "kind": "filtered", "body": {"steps": [{"op": "wait", "ms": 5}]}
        }))
        .expect("a tape reads");
        assert_eq!(tape.body.steps, vec![RecipeStep::Wait { ms: 5 }]);
    }

    /// Run rows exactly as `GET /recipes/{id}` sends them since opengrok-server #217: the
    /// stored row, camelCase, with `state` and `artifacts` put beside it. A run is written down
    /// before the box is asked, so a running row carries `ok: false` and a placeholder receipt.
    #[test]
    fn a_run_row_says_whether_it_is_still_playing() {
        let runs: Vec<RecipeRun> = serde_json::from_value(json!([
            {"id": "rrun_3", "recipeId": "rcp_1", "version": 2, "coworkerId": "cw_1", "runId": "rrun_3",
             "ok": false, "stoppedAt": null, "receipt": {"ok": false, "running": true}, "atMs": 9,
             "leaseUntilMs": 60009, "state": "running", "artifacts": []},
            {"id": "rrun_2", "recipeId": "rcp_1", "version": 2, "coworkerId": "cw_1", "runId": "rrun_2",
             "ok": true, "stoppedAt": null,
             "receipt": {"ok": true, "ran": 3, "stopped_at": null, "steps": [{"ok": true}, {"ok": true}, {"ok": true}]},
             "atMs": 7, "leaseUntilMs": null, "state": "finished",
             "artifacts": [{"id": "art_1", "kind": "screenshot", "mime": "image/png", "stepIndex": 0, "sizeBytes": 10, "meta": {}}]},
            {"id": "rrun_1", "recipeId": "rcp_1", "version": 2, "coworkerId": "cw_1", "runId": "rrun_1",
             "ok": false, "stoppedAt": null, "receipt": {"ok": false, "running": true}, "atMs": 5,
             "leaseUntilMs": 60005, "state": "interrupted", "artifacts": []},
            // A server from before the lease names no state: it wrote a run down once it was over.
            {"id": "rrun_0", "recipeId": "rcp_1", "version": 2, "coworkerId": "cw_1",
             "ok": false, "stoppedAt": 1, "receipt": {"ok": false, "ran": 1, "error": "nothing at (5, 5)"}, "atMs": 3},
            {"id": "rrun_9", "state": "a word from the future"},
            {"id": "rrun_8", "state": null},
        ]))
        .unwrap();

        let running = &runs[0];
        assert!(running.is_running());
        assert!(
            !running.is_over(),
            "a running row has not come to anything yet"
        );
        assert!(
            !running.ok,
            "and it says so with `ok: false`, which is not a failure"
        );
        assert_eq!(running.error(), None);

        let finished = &runs[1];
        assert!(finished.is_over() && !finished.is_running() && !finished.is_interrupted());
        assert_eq!(finished.ran_count(), Some(3));

        let interrupted = &runs[2];
        assert!(interrupted.is_interrupted());
        assert!(interrupted.is_over());
        assert!(!interrupted.is_running());

        let old = &runs[3];
        assert_eq!(old.state, "");
        assert!(old.is_over() && !old.is_running());
        assert_eq!(old.ran_count(), Some(1));
        assert_eq!(old.error().as_deref(), Some("nothing at (5, 5)"));

        assert!(
            !runs[4].is_over() && !runs[4].is_running(),
            "a word this client does not know is not taken for an ending"
        );
        assert!(runs[5].is_over(), "null reads as no state at all");
    }

    #[test]
    fn a_raw_version_takes_the_tape_or_its_count() {
        let with_tape: RecipeVersion = serde_json::from_value(json!({
            "version": 1,
            "kind": "raw",
            "body": {"events": [
                {"kind": "down", "x": 640, "y": 60, "button": 1, "at": 1000},
                {"kind": "keydown", "key": "e", "code": "KeyE", "at": 2200},
            ]},
        }))
        .unwrap();
        assert_eq!(with_tape.event_count(), 2);
        let events = with_tape.tape_events().expect("the tape itself");
        assert_eq!(events[0].button, 1);
        assert_eq!(events[1].key, "e");
        assert_eq!(events[1].at, 2200);

        let counted: RecipeVersion =
            serde_json::from_value(json!({"version": 1, "kind": "raw", "body": {"events": 14}}))
                .unwrap();
        assert_eq!(counted.event_count(), 14);
        assert!(counted.tape_events().is_none());

        // A shape this client has no word for leaves the version readable, not unparsable.
        let odd: RecipeVersion = serde_json::from_value(
            json!({"version": 1, "kind": "raw", "body": {"events": {"total": 14}}}),
        )
        .unwrap();
        assert_eq!(odd.event_count(), 0);
        assert!(odd.tape_events().is_none());
    }

    #[test]
    fn share_target_serialises_its_scope() {
        assert_eq!(
            serde_json::to_value(RecipeShareTarget::Org).unwrap(),
            json!({"scope": "org"})
        );
        assert_eq!(
            serde_json::to_value(RecipeShareTarget::Account {
                email: "a@b.c".into()
            })
            .unwrap(),
            json!({"scope": "account", "email": "a@b.c"})
        );
    }

    #[test]
    fn thin_tape_keeps_one_move_per_forty_ms_and_every_other_event() {
        let event = |kind: &str, at: i64| json!({"kind": kind, "x": 1, "y": 1, "at": at});
        let tape = vec![
            event("down", 0),
            event("move", 5),
            event("move", 20),
            event("move", 44),
            event("move", 45),
            event("up", 46),
            event("move", 90),
            event("keydown", 91),
        ];
        let thin = thin_tape(&tape);
        let kept: Vec<(&str, i64)> = thin
            .iter()
            .map(|e| (e["kind"].as_str().unwrap(), e["at"].as_i64().unwrap()))
            .collect();
        assert_eq!(
            kept,
            vec![
                ("down", 0),
                ("move", 5),
                ("move", 45),
                ("up", 46),
                ("move", 90),
                ("keydown", 91),
            ]
        );
        assert!(thin_tape(&[]).is_empty());
    }

    #[tokio::test]
    async fn create_recipe_refuses_an_upload_over_the_limit_before_sending() {
        // Nothing listens here; the refusal must come from the size check, not the socket.
        let client = OpenGrokClient::new("http://127.0.0.1:9").unwrap();
        let big = "x".repeat(RECIPE_UPLOAD_LIMIT + 1);
        let error = client
            .create_recipe(
                "Big",
                "",
                &[json!({"kind": "keydown", "key": big, "at": 0})],
            )
            .await
            .unwrap_err();
        assert!(error.message.contains("5 MB"), "{}", error.message);
    }

    #[tokio::test]
    async fn list_recipes_sends_the_filter_and_reads_the_rows() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/recipes"))
            .and(wiremock::matchers::query_param("filter", "shared"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "recipes": [{"id": "rcp_1", "ownerId": "acc_2", "name": "Mail", "relation": "shared", "shareState": "accepted", "latestVersion": 3}]
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let list = client.list_recipes(Some("shared")).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Mail");
        assert_eq!(list[0].relation, RecipeRelation::Shared);
        assert_eq!(list[0].latest_version, 3);
    }

    #[tokio::test]
    async fn list_schedules_asks_for_one_coworker_and_reads_both_kinds() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/schedules"))
            .and(wiremock::matchers::query_param("coworker", "cw_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {
                    "id": "sch_1", "coworkerId": "cw_1", "kind": "cron", "cron": "0 9 * * *",
                    "prompt": "Read the inbox", "name": "Morning post", "active": true,
                    "nextDueMs": 1717000000000i64, "somethingNew": "ignored"
                },
                {
                    "id": "sch_2", "coworkerId": "cw_1", "kind": "webhook", "cron": null,
                    "prompt": "Deal with it", "active": false,
                    "webhook": {
                        "url": "https://og.example/hooks/sch_2",
                        "key": "og_live_abc",
                        "header": "Authorization: Bearer og_live_abc"
                    }
                }
            ])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let rows = client.list_schedules("cw_1").await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].kind, ScheduleKind::Cron);
        assert_eq!(rows[0].cron.as_deref(), Some("0 9 * * *"));
        assert_eq!(rows[0].name.as_deref(), Some("Morning post"));
        assert!(rows[0].active);
        assert_eq!(rows[1].kind, ScheduleKind::Webhook);
        assert_eq!(rows[1].cron, None);
        assert_eq!(
            rows[1].webhook.as_ref().map(|hook| hook.key.as_str()),
            Some("og_live_abc"),
            "the key is on the listing, not only on the create"
        );
    }

    /// A server that ignores `?coworker=` must not put another bot's routines under this one.
    #[tokio::test]
    async fn a_row_for_another_coworker_is_dropped() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/schedules"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"id": "sch_1", "coworkerId": "cw_1", "kind": "cron", "cron": "* * * * *", "prompt": "mine", "active": true},
                {"id": "sch_2", "coworkerId": "cw_2", "kind": "cron", "cron": "* * * * *", "prompt": "theirs", "active": true}
            ])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let rows = client.list_schedules("cw_1").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "sch_1");
    }

    #[tokio::test]
    async fn create_schedule_sends_the_cron_line_and_the_name() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/schedules"))
            .and(body_json(json!({
                "coworkerId": "cw_1",
                "prompt": "Read the inbox",
                "kind": "cron",
                "name": "Morning post",
                "cron": "0 9 * * *"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "id": "sch_1", "coworkerId": "cw_1", "kind": "cron", "cron": "0 9 * * *",
                "prompt": "Read the inbox", "name": "Morning post", "active": true
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let row = client
            .create_schedule(&NewSchedule {
                coworker_id: "cw_1".into(),
                kind: ScheduleKind::Cron,
                prompt: "Read the inbox".into(),
                name: "Morning post".into(),
                cron: Some("0 9 * * *".into()),
            })
            .await
            .unwrap();
        assert_eq!(row.id, "sch_1");
        assert!(row.active);
    }

    /// A webhook is created with no clock at all, and the answer carries the minted URL and key.
    #[tokio::test]
    async fn create_schedule_asks_for_a_webhook_without_a_cron_line() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/schedules"))
            .and(body_json(json!({
                "coworkerId": "cw_1",
                "prompt": "Deal with it",
                "kind": "webhook"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "id": "sch_2", "coworkerId": "cw_1", "kind": "webhook", "cron": null,
                "prompt": "Deal with it", "active": true,
                "webhook": {
                    "url": "https://og.example/hooks/sch_2",
                    "key": "og_live_abc",
                    "header": "Authorization: Bearer og_live_abc"
                }
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let row = client
            .create_schedule(&NewSchedule {
                coworker_id: "cw_1".into(),
                kind: ScheduleKind::Webhook,
                prompt: "Deal with it".into(),
                name: String::new(),
                cron: None,
            })
            .await
            .unwrap();
        let hook = row.webhook.unwrap();
        assert_eq!(hook.url, "https://og.example/hooks/sch_2");
        assert_eq!(hook.header, "Authorization: Bearer og_live_abc");
    }

    /// A routine's zone is read off its row as the server keeps it (opengrok-server #316, #334, on
    /// main 8e7387f), and a server from before zones sends none. A create and an edit from this app
    /// name no zone, so a new routine takes the account's and an edited one keeps its own.
    #[tokio::test]
    async fn a_routines_zone_is_read_off_its_row_and_never_sent() {
        let row = json!({
            "id": "sch_1", "coworkerId": "cw_1", "kind": "cron", "cron": "0 0 9 * * MON-FRI",
            "prompt": "post the standup", "name": "Standup", "active": true,
            "tz": "Asia/Manila"
        });
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/schedules"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                row.clone(),
                {
                    "id": "sch_2", "coworkerId": "cw_1", "kind": "cron", "cron": "0 0 8 * * *",
                    "prompt": "write it", "active": true
                }
            ])))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/schedules"))
            .respond_with(ResponseTemplate::new(201).set_body_json(row.clone()))
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/schedules/sch_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(row))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let rows = client.list_schedules("cw_1").await.unwrap();
        assert_eq!(rows[0].tz.as_deref(), Some("Asia/Manila"));
        assert_eq!(rows[1].tz, None, "a server before zones");
        let made = client
            .create_schedule(&NewSchedule {
                coworker_id: "cw_1".into(),
                kind: ScheduleKind::Cron,
                prompt: "post the standup".into(),
                name: "Standup".into(),
                cron: Some("0 9 * * MON-FRI".into()),
            })
            .await
            .unwrap();
        assert_eq!(made.tz.as_deref(), Some("Asia/Manila"), "the account's");
        client
            .edit_schedule(
                "sch_1",
                &ScheduleEdit {
                    cron: Some("0 10 * * MON-FRI".into()),
                    ..ScheduleEdit::default()
                },
            )
            .await
            .unwrap();
        let sent: Vec<Value> = server
            .received_requests()
            .await
            .expect("the recorder is on")
            .iter()
            .filter(|request| request.method.as_str() != "GET")
            .map(|request| serde_json::from_slice(&request.body).expect("a JSON body"))
            .collect();
        assert_eq!(sent.len(), 2, "a create and an edit");
        for body in &sent {
            assert!(body.get("tz").is_none(), "no zone named: {body}");
        }
    }

    /// An edit sends only what the person changed: an absent field keeps what the routine has
    /// on the server, so a rename never resends the prompt, and the row that comes back is the
    /// routine as it now is.
    #[tokio::test]
    async fn an_edit_sends_only_the_fields_that_changed() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/schedules/sch_1"))
            .and(body_json(json!({ "name": "Standup" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "sch_1", "coworkerId": "cw_1", "kind": "cron", "cron": "0 0 9 * * 1",
                "name": "Standup", "prompt": "weekly report", "active": true
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let row = client
            .edit_schedule(
                "sch_1",
                &ScheduleEdit {
                    name: Some("Standup".into()),
                    ..ScheduleEdit::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(row.name.as_deref(), Some("Standup"));
        assert_eq!(row.cron.as_deref(), Some("0 0 9 * * 1"));
        assert!(ScheduleEdit::default().is_empty());
    }

    /// Test run is the server's: a 202 and the id of the run it started, which the history
    /// then lists as a person's.
    #[tokio::test]
    async fn a_test_run_is_started_by_the_server_and_named_by_it() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/schedules/sch_1/run"))
            .respond_with(
                ResponseTemplate::new(202)
                    .set_body_json(json!({ "accepted": true, "runId": "run_9" })),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/schedules/sch_busy/run"))
            .respond_with(
                ResponseTemplate::new(429)
                    .set_body_json(json!({ "error": "too many runs going at once" })),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        assert_eq!(client.run_schedule_now("sch_1").await.unwrap(), "run_9");
        let refused = client.run_schedule_now("sch_busy").await.unwrap_err();
        assert!(
            refused.message.contains("too many runs"),
            "the server's sentence, not a guess: {}",
            refused.message
        );
    }

    /// The history says what set each run off and where it got to. A running run has not ended,
    /// and a word this client has never heard is still a run it lists.
    #[tokio::test]
    async fn a_routines_history_names_the_cause_and_the_status() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/schedules/sch_1/runs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "runId": "run_3", "cause": "manual", "status": "running",
                  "startedAtMs": 3000, "endedAtMs": null },
                { "runId": "run_2", "cause": "webhook", "status": "ok",
                  "startedAtMs": 2000, "endedAtMs": 2500 },
                { "runId": "run_1", "cause": "clock", "status": "error",
                  "startedAtMs": 1000, "endedAtMs": 1200 },
                { "runId": "run_0", "cause": "somethingnew", "status": "waiting",
                  "startedAtMs": 500, "endedAtMs": null }
            ])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let runs = client.schedule_runs("sch_1").await.unwrap();
        // A line as the history reads it: the run, what set it off, where it got to, its end.
        type Line<'a> = (
            Option<&'a str>,
            RunCause,
            Option<ScheduleRunStatus>,
            Option<i64>,
        );
        let read: Vec<Line> = runs
            .iter()
            .map(|run| {
                (
                    run.run_id.as_deref(),
                    run.cause,
                    run.status,
                    run.ended_at_ms,
                )
            })
            .collect();
        assert_eq!(
            read,
            vec![
                (
                    Some("run_3"),
                    RunCause::Manual,
                    Some(ScheduleRunStatus::Running),
                    None
                ),
                (
                    Some("run_2"),
                    RunCause::Webhook,
                    Some(ScheduleRunStatus::Ok),
                    Some(2500)
                ),
                (
                    Some("run_1"),
                    RunCause::Clock,
                    Some(ScheduleRunStatus::Error),
                    Some(1200)
                ),
                (
                    Some("run_0"),
                    RunCause::Other,
                    Some(ScheduleRunStatus::Waiting),
                    None
                ),
            ]
        );
        assert!(
            runs.iter().all(|run| !run.is_skipped()),
            "every line is a run"
        );
    }

    /// A firing the server skipped, because the Bot answers on its person's own plan and the plan
    /// could not answer (opengrok-server #316, #334, on main 8e7387f), is a line of the history
    /// with no run, no status and no start, beside its own time, the code and the server's
    /// sentence. It reads as a skip, in its order among the runs, and leaves the runs beside it as
    /// they were.
    #[tokio::test]
    async fn a_skipped_firing_is_a_line_of_the_history_with_no_run() {
        let said = "Skipped: your computer was off, so your plan couldn't answer";
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/schedules/sch_1/runs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "runId": null, "cause": "clock", "status": null, "startedAtMs": null,
                  "endedAtMs": null, "at": 3000, "state": "skipped", "skipped": "relay_offline",
                  "reason": said },
                { "runId": "run_1", "cause": "manual", "status": "ok",
                  "startedAtMs": 1000, "endedAtMs": 1200 }
            ])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let runs = client.schedule_runs("sch_1").await.unwrap();
        assert_eq!(runs.len(), 2);
        let skip = &runs[0];
        assert!(skip.is_skipped());
        assert_eq!(
            (
                skip.run_id.as_deref(),
                skip.cause,
                skip.status,
                skip.at,
                skip.skipped.as_deref(),
                skip.reason.as_deref()
            ),
            (
                None,
                RunCause::Clock,
                None,
                Some(3000),
                Some("relay_offline"),
                Some(said)
            )
        );
        assert!(!runs[1].is_skipped());
        assert_eq!(runs[1].run_id.as_deref(), Some("run_1"));
    }

    /// A run a Bot started with its `run_routine` tool (opengrok-server #337, built in #342) is a
    /// line of the history with `cause: "bot"` and `by: {coworkerId, name}`, and so is a firing a
    /// Bot's press set off that the plan could not answer; every other line has `by: null`, or, from
    /// a server before it, none at all, and is read as it always was.
    #[tokio::test]
    async fn a_run_a_bot_started_names_the_bot_in_the_history() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/schedules/sch_1/runs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "runId": "run_4", "cause": "bot", "status": "ok", "startedAtMs": 4000,
                  "endedAtMs": 4500, "by": { "coworkerId": "cw_luna", "name": "Luna" } },
                { "runId": null, "cause": "bot", "status": null, "startedAtMs": null,
                  "endedAtMs": null, "at": 3000, "state": "skipped", "skipped": "proxy_down",
                  "reason": "Skipped: your plan's proxy didn't answer",
                  "by": { "coworkerId": "cw_luna", "name": "Luna" } },
                { "runId": "run_2", "cause": "manual", "status": "ok", "startedAtMs": 2000,
                  "endedAtMs": 2500, "by": null },
                { "runId": "run_1", "cause": "clock", "status": "ok", "startedAtMs": 1000,
                  "endedAtMs": 1200 }
            ])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let runs = client.schedule_runs("sch_1").await.unwrap();
        let read: Vec<(RunCause, Option<(&str, &str)>)> = runs
            .iter()
            .map(|run| {
                (
                    run.cause,
                    run.by
                        .as_ref()
                        .map(|by| (by.coworker_id.as_str(), by.name.as_str())),
                )
            })
            .collect();
        assert_eq!(
            read,
            vec![
                (RunCause::Bot, Some(("cw_luna", "Luna"))),
                (RunCause::Bot, Some(("cw_luna", "Luna"))),
                (RunCause::Manual, None),
                (RunCause::Clock, None),
            ]
        );
        assert!(runs[1].is_skipped() && !runs[0].is_skipped());
    }

    /// Run it now while the Bot's plan cannot answer is the server's 409 with the skip's code and
    /// its sentence (opengrok-server #316, #334, on main 8e7387f: `run_schedule_now`), which is
    /// what the person is told; the code says the firing was kept as skipped. The 409 for a retired
    /// coworker names no code, and is no skip.
    #[tokio::test]
    async fn run_now_on_a_plan_that_cannot_answer_is_refused_as_a_skip() {
        let said = "Skipped: your computer was off, so your plan couldn't answer";
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/schedules/sch_1/run"))
            .respond_with(
                ResponseTemplate::new(409)
                    .set_body_json(json!({ "error": said, "code": "relay_offline" })),
            )
            .mount(&server)
            .await;
        let retired = "this routine's coworker is no longer hired; hand it to another coworker";
        Mock::given(method("POST"))
            .and(path("/schedules/sch_2/run"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({ "error": retired })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let skipped = client.run_schedule_now("sch_1").await.unwrap_err();
        assert!(skipped.is_skipped_firing(), "{skipped:?}");
        assert_eq!(skipped.message, said, "the server's sentence, not its code");
        assert_eq!(skipped.code(), Some("relay_offline"));
        let retired = client.run_schedule_now("sch_2").await.unwrap_err();
        assert!(!retired.is_skipped_firing(), "{retired:?}");
    }

    /// A thread id is the server's to choose, so it goes into a path as one segment: a `/` or
    /// `?` in it cannot reach another route.
    #[tokio::test]
    async fn a_thread_id_is_one_segment_of_the_path() {
        assert_eq!(path_segment("sched_01a0-e27a"), "sched_01a0-e27a");
        assert_eq!(path_segment("a/b?c#d e"), "a%2Fb%3Fc%23d%20e");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/threads/a%2Fb"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "runs": [] })))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        client.replay_thread("a/b", 5).await.unwrap();
    }

    #[tokio::test]
    async fn pause_and_resume_post_to_the_schedule() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/schedules/sch_1/pause"))
            .respond_with(ResponseTemplate::new(200).set_body_string(""))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/schedules/sch_1/resume"))
            .respond_with(ResponseTemplate::new(200).set_body_string(""))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        client.pause_schedule("sch_1").await.unwrap();
        client.resume_schedule("sch_1").await.unwrap();
        let paths: Vec<String> = server
            .received_requests()
            .await
            .expect("the recorder is on")
            .iter()
            .map(|request| request.url.path().to_string())
            .collect();
        assert_eq!(paths, ["/schedules/sch_1/pause", "/schedules/sch_1/resume"]);
    }

    #[tokio::test]
    async fn delete_schedule_keeps_the_servers_refusal() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/schedules/sch_1"))
            .respond_with(ResponseTemplate::new(404).set_body_string("No such schedule."))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client.delete_schedule("sch_1").await.unwrap_err();
        assert_eq!(error.status, Some(404));
        assert_eq!(error.message, "No such schedule.");
    }

    /// An opengrok-server from before the one that can edit a routine, run it now and list what
    /// it ran (opengrok-server 18656e3, `autonomy/routes.rs`) answers the three the way axum
    /// answers what it has no route for: `GET …/runs` and `POST …/run` with an empty 404, and
    /// `PATCH /schedules/{id}`, a path it has for `DELETE` only, with an empty 405. Each reads as
    /// the route missing, which is a fact about the server and not about the routine.
    #[tokio::test]
    async fn an_older_server_without_the_routine_routes_says_so_by_its_empty_answers() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/schedules/sch_1/runs"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/schedules/sch_1"))
            .respond_with(ResponseTemplate::new(405))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/schedules/sch_1/run"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();

        let runs = client.schedule_runs("sch_1").await.unwrap_err();
        assert!(runs.route_missing(), "{runs}");
        assert!(runs.said_nothing(), "nothing the server wrote: {runs}");
        let edit = client
            .edit_schedule(
                "sch_1",
                &ScheduleEdit {
                    cron: Some("* * * * *".into()),
                    ..ScheduleEdit::default()
                },
            )
            .await
            .unwrap_err();
        assert!(edit.route_missing(), "{edit}");
        let run = client.run_schedule_now("sch_1").await.unwrap_err();
        assert!(run.route_missing(), "{run}");
    }

    /// The server's own 404 for a routine it does not have (or will not show this person) is
    /// plain text, `no such schedule` (`owned_schedule`): its words, about the routine, on a
    /// route it has. An empty 500 says nothing, and is still no missing route.
    #[tokio::test]
    async fn a_404_with_the_servers_words_is_about_the_routine_and_not_a_missing_route() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/schedules/sch_gone/run"))
            .respond_with(ResponseTemplate::new(404).set_body_string("no such schedule"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/schedules/sch_1/runs"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();

        let gone = client.run_schedule_now("sch_gone").await.unwrap_err();
        assert!(!gone.route_missing(), "{gone}");
        assert!(!gone.said_nothing());
        assert_eq!(gone.message, "no such schedule");
        let broken = client.schedule_runs("sch_1").await.unwrap_err();
        assert!(broken.said_nothing(), "{broken}");
        assert!(
            !broken.route_missing(),
            "a 500 is not a route the server lacks"
        );
    }

    #[tokio::test]
    async fn rotating_a_key_answers_with_the_new_one() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/schedules/sch_2/rotate-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "sch_2", "coworkerId": "cw_1", "kind": "webhook", "cron": null,
                "prompt": "Deal with it", "active": true,
                "webhook": {
                    "url": "https://og.example/hooks/sch_2",
                    "key": "og_live_xyz",
                    "header": "Authorization: Bearer og_live_xyz"
                }
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let row = client.rotate_webhook_key("sch_2").await.unwrap();
        assert_eq!(row.webhook.unwrap().key, "og_live_xyz");
    }

    /// Rotating the key of a schedule that has no key is a 409, and the sentence is the
    /// server's: the app has nothing truer to say about it.
    #[tokio::test]
    async fn rotating_a_cron_schedule_is_the_servers_refusal() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/schedules/sch_1/rotate-key"))
            .respond_with(
                ResponseTemplate::new(409).set_body_string("This schedule has no webhook key."),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client.rotate_webhook_key("sch_1").await.unwrap_err();
        assert_eq!(error.status, Some(409));
        assert_eq!(error.message, "This schedule has no webhook key.");
    }

    #[tokio::test]
    async fn recipe_errors_carry_the_servers_sentence() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/recipes/rcp_1/share"))
            .respond_with(
                ResponseTemplate::new(403).set_body_string("Only the owner can share a recipe."),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client
            .share_recipe("rcp_1", &RecipeShareTarget::Org)
            .await
            .unwrap_err();
        assert_eq!(error.status, Some(403));
        assert_eq!(error.message, "Only the owner can share a recipe.");
    }

    /// Run asks not to wait, and the `202` is what opengrok-server #217 answers that with: the
    /// run's id, before the box has done anything. The mock only answers a request that carries
    /// the preference, so a run sent without it fails here.
    #[tokio::test]
    async fn a_run_asks_not_to_wait_and_takes_the_run_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/recipes/rcp_1/run"))
            .and(wiremock::matchers::header("prefer", "respond-async"))
            .and(body_json(json!({ "coworkerId": "cw_1" })))
            .respond_with(
                ResponseTemplate::new(202)
                    .insert_header("preference-applied", "respond-async")
                    .set_body_json(json!({
                        "recipe": "rcp_1", "version": 2, "runId": "rrun_1", "state": "running",
                    })),
            )
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let answer = client.run_recipe("rcp_1", "cw_1").await.unwrap();
        assert_eq!(
            answer,
            RunRecipeResponse::Async(AsyncRunResponse {
                run_id: "rrun_1".to_string()
            })
        );
    }

    /// A server that waits for the run before it answers — any from before #217, which never
    /// heard of the preference — still gets its outcome read the way it always was, though the
    /// request asked not to wait.
    #[tokio::test]
    async fn a_server_that_waits_still_answers_with_the_outcome() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/recipes/rcp_1/run"))
            .and(wiremock::matchers::header("prefer", "respond-async"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "recipe": "rcp_1", "version": 2, "runId": "rrun_1", "ok": true, "ran": 3,
                "stoppedAt": null, "error": null, "image": null, "artifacts": [],
                "artifactsMissed": [],
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let Ok(RunRecipeResponse::Sync(outcome)) = client.run_recipe("rcp_1", "cw_1").await else {
            panic!("a 200 is the outcome itself");
        };
        assert!(outcome.ok);
        assert_eq!(outcome.version, 2);
        assert_eq!(outcome.ran_count(), Some(3));
    }

    /// One run per bot at a time. The sentence is the server's, and it goes to the person as it
    /// came: since opengrok-server #246 the run holding the bot may be one played from chat.
    #[tokio::test]
    async fn a_bot_already_playing_a_recipe_is_the_servers_refusal() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/recipes/rcp_1/run"))
            .respond_with(ResponseTemplate::new(409).set_body_string(
                "this bot is already playing a recipe; wait for that run to finish",
            ))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client.run_recipe("rcp_1", "cw_1").await.unwrap_err();
        assert_eq!(error.status, Some(409));
        assert_eq!(
            error.message,
            "this bot is already playing a recipe; wait for that run to finish"
        );
        assert_eq!(error.failure(), Failure::Verdict);
        assert!(!error.history_missed());
    }

    /// A `503` with `historyMissed` is a run that PLAYED and was not written down. Its body is the
    /// receipt with the sentence beside it, and the receipt's own `error` is about a step: read
    /// the general way, the page would have said that step's error as the reason, or shown the
    /// whole JSON. Any other `503` is a refusal like the rest.
    #[tokio::test]
    async fn a_run_that_played_but_was_not_written_down_says_so_in_the_servers_words() {
        let server = MockServer::start().await;
        let missed =
            "the run played but could not be written to the recipe's history: pool timed out";
        Mock::given(method("POST"))
            .and(path("/recipes/rcp_1/run"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({
                "recipe": "rcp_1", "version": 2, "runId": "rrun_1", "ok": false, "ran": 2,
                "stoppedAt": 2, "error": "nothing at (5, 5)", "image": null, "artifacts": [],
                "artifactsMissed": [], "historyMissed": missed,
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/recipes/rcp_2/run"))
            .respond_with(ResponseTemplate::new(503).set_body_string(
                "the run could not be written down, so nothing was played: pool timed out",
            ))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();

        let played = client.run_recipe("rcp_1", "cw_1").await.unwrap_err();
        assert!(played.history_missed());
        assert_eq!(played.status, Some(503));
        assert_eq!(played.message, missed);
        assert_eq!(
            played.failure(),
            Failure::Verdict,
            "the server answered, and said what happened"
        );

        let refused = client.run_recipe("rcp_2", "cw_1").await.unwrap_err();
        assert!(!refused.history_missed());
        assert_eq!(
            refused.message,
            "the run could not be written down, so nothing was played: pool timed out"
        );
    }

    /// The listing is the rows themselves, and the scope word goes on the query. A `source` this
    /// client has no name for must leave the row readable rather than fail the whole listing.
    #[tokio::test]
    async fn list_skills_sends_the_scope_and_reads_the_rows() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/skills"))
            .and(wiremock::matchers::query_param("filter", "mine"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {
                    "id": "skl_1", "name": "expense-report",
                    "description": "How we file expenses", "source": "uploaded",
                    "updatedAtMs": 1717000000000i64, "versionCount": 2, "draft": false,
                    "enabled": true
                },
                {
                    "id": "skl_2", "name": "new-hire", "description": null,
                    "source": "a word from the future", "versionCount": 0, "draft": true
                }
            ])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let rows = client.list_skills(Some("mine")).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "expense-report");
        assert_eq!(rows[0].source, SkillSource::Uploaded);
        assert_eq!(rows[0].version_count, 2);
        assert!(!rows[0].draft);
        assert_eq!(rows[1].description, "");
        assert_eq!(
            rows[1].source,
            SkillSource::Authored,
            "an unknown source is still a skill somebody has"
        );
        assert!(rows[1].draft);
        assert!(
            rows[1].enabled,
            "a server that does not mention the switch has not switched anything off"
        );
    }

    /// Written here: the prose goes up whole, frontmatter and all, and the word on it says a
    /// person wrote it rather than a recording.
    #[tokio::test]
    async fn create_skill_sends_the_prose_and_says_who_wrote_it() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/skills"))
            .and(body_json(json!({
                "name": "expense-report",
                "source": "authored",
                "description": "How we file expenses",
                "body": "---\nname: expense-report\n---\n\nAsk for the receipt first.",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "skl_1", "name": "expense-report",
                "description": "How we file expenses", "source": "authored",
                "updatedAtMs": 1717000000000i64, "versionCount": 1, "draft": false,
                "enabled": true, "version": 1, "files": [],
                "body": "Ask for the receipt first."
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let detail = client
            .create_skill(&NewSkill {
                name: "expense-report".into(),
                description: "How we file expenses".into(),
                body: "---\nname: expense-report\n---\n\nAsk for the receipt first.".into(),
                source: SkillSource::Authored,
                files: Vec::new(),
            })
            .await
            .unwrap();
        assert_eq!(detail.skill.id, "skl_1");
        assert_eq!(detail.version, 1);
        assert_eq!(
            detail.body, "Ask for the receipt first.",
            "the detail carries the prose with its frontmatter taken off"
        );
    }

    /// An upload is the same door with the bundle on it: base64 in a JSON body, as `/artifacts`
    /// does it, and the source says so even when the folder held nothing but a `SKILL.md`.
    #[tokio::test]
    async fn upload_skill_sends_its_files_as_base64() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/skills"))
            .and(body_json(json!({
                "name": "expense-report",
                "source": "uploaded",
                "body": "Ask for the receipt first.",
                "files": [{"path": "reference/rates.csv", "bytes": "b2ssIGhpCg=="}],
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "skl_1", "name": "expense-report", "description": "", "source": "uploaded",
                "updatedAtMs": 1717000000000i64, "versionCount": 1, "draft": false,
                "enabled": true, "version": 1, "body": "Ask for the receipt first.",
                "files": [{"path": "reference/rates.csv", "bytes": "b2ssIGhpCg=="}]
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let detail = client
            .create_skill(&NewSkill {
                name: "expense-report".into(),
                description: String::new(),
                body: "Ask for the receipt first.".into(),
                source: SkillSource::Uploaded,
                files: vec![SkillFile {
                    path: "reference/rates.csv".into(),
                    bytes: "b2ssIGhpCg==".into(),
                }],
            })
            .await
            .unwrap();
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].path, "reference/rates.csv");
        assert_eq!(
            detail.files[0].bytes, "b2ssIGhpCg==",
            "the bundle comes back the way it went up, so a person can see what they uploaded"
        );
    }

    /// A tape goes up as itself and comes back as prose. The words the sheet was given ride
    /// with it, and what lands is switched off: a model wrote it and nobody has read it.
    #[tokio::test]
    async fn create_skill_from_tape_sends_the_recording_and_reads_a_skill_that_is_off() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/skills/from-tape"))
            .and(body_json(json!({
                "coworkerId": "cw_1",
                "name": "invoice-lookup",
                "description": "how we find one",
                "screen": { "width": 1280, "height": 800 },
                "raw": [{"kind": "down", "button": 0, "x": 4, "y": 9, "at": 0}],
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "skl_7", "name": "invoice-lookup", "description": "how we find one",
                "source": "taught", "updatedAtMs": 1717000000000i64, "versionCount": 1,
                "draft": false, "enabled": false, "version": 1, "files": [],
                "body": "Open the billing tab, then search the invoice number."
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let detail = client
            .create_skill_from_tape(
                "cw_1",
                "invoice-lookup",
                "how we find one",
                &[json!({"kind": "down", "button": 0, "x": 4, "y": 9, "at": 0})],
            )
            .await
            .unwrap();
        assert_eq!(detail.skill.id, "skl_7");
        assert_eq!(
            detail.skill.source,
            SkillSource::Taught,
            "the server's own word for prose a model wrote from a recording"
        );
        assert_eq!(detail.version, 1);
        assert_eq!(detail.skill.version_count, 1);
        assert!(!detail.skill.draft, "a lesson with prose in it is no draft");
        assert!(
            !detail.skill.enabled,
            "born switched off: nobody has read it, so nothing may use it"
        );
        assert!(
            detail.skill.approved_at_ms.is_none(),
            "and never approved, which is what tells it from a skill somebody read and then \
             switched off"
        );
        assert_eq!(
            detail.body, "Open the billing tab, then search the invoice number.",
            "the prose is what the model wrote, and it is what comes back"
        );
    }

    /// Neither word is required, and neither is sent empty: the server mints a name and writes a
    /// description itself, and `""` would be asking it to keep an empty one instead.
    #[tokio::test]
    async fn create_skill_from_tape_leaves_out_the_words_nobody_typed() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/skills/from-tape"))
            .and(body_json(json!({
                "coworkerId": "cw_1",
                "screen": { "width": 1280, "height": 800 },
                "raw": [],
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "skl_8", "name": "taught-1a2b3c4d", "description": "What was done here.",
                "source": "taught", "updatedAtMs": 1717000000000i64, "versionCount": 1,
                "draft": false, "enabled": false, "version": 1, "files": [], "body": "Steps."
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let detail = client
            .create_skill_from_tape("cw_1", "   ", "", &[])
            .await
            .unwrap();
        assert_eq!(
            detail.skill.name, "taught-1a2b3c4d",
            "the name the server minted is the name the person is told"
        );
    }

    /// Six ways this one route says no, and every one of them is a sentence written to be read
    /// by a person. None of them may be swallowed and none may be reworded: the `502` in
    /// particular names which of four things the model did, and "something went wrong" would
    /// throw away the only part anybody can act on.
    #[tokio::test]
    async fn every_refusal_from_the_tape_route_keeps_the_servers_own_sentence() {
        for (status, sentence) in [
            (
                502,
                "Your bot would not write this one down: the recording shows a password being \
                 typed, and it will not keep one in a lesson.",
            ),
            (
                504,
                "Your bot did not finish reading the recording in time. Teach a shorter task.",
            ),
            (409, "You already have a skill called invoice-lookup."),
            (404, "No coworker cw_9 belongs to you."),
            (
                400,
                "A skill's name is what you type after a slash: lowercase letters, digits and \
                 dashes.",
            ),
            (
                413,
                "That description is 4001 characters; 4000 is the most.",
            ),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/skills/from-tape"))
                .respond_with(ResponseTemplate::new(status).set_body_string(sentence))
                .mount(&server)
                .await;
            let client = OpenGrokClient::new(&server.uri()).unwrap();
            let error = client
                .create_skill_from_tape("cw_1", "invoice-lookup", "", &[])
                .await
                .unwrap_err();
            assert_eq!(error.status, Some(status));
            assert_eq!(
                error.message, sentence,
                "a {status} has to reach the person as the server worded it"
            );
        }
    }

    /// A `502` from this route is not what a `502` means anywhere else in this client. Nothing
    /// else the app talks to answers one itself, so `read_error` reads them all as something in
    /// front of OpenGrok that could not reach it; THIS route answers its own, and what it means
    /// is that the model ran and produced nothing that can be kept. Read as a hop that failed,
    /// it would be offered a Try again that waits ninety seconds for the identical answer.
    #[tokio::test]
    async fn the_tape_routes_own_five_hundreds_are_verdicts_and_not_a_hop_that_failed() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/skills/from-tape"))
            .respond_with(ResponseTemplate::new(502).set_body_string(
                "Your bot would not write this one down: the recording shows a password.",
            ))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client
            .create_skill_from_tape("cw_1", "", "", &[])
            .await
            .unwrap_err();
        assert_eq!(error.status, Some(502));
        assert_eq!(
            error.failure(),
            Failure::Verdict,
            "a decision about this recording: the same bytes earn it again"
        );

        // What is genuinely out of reach keeps its kind. OpenGrok saying it could not get to the
        // model gateway is a state — nothing ran — and that tape is worth sending again.
        let away = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/skills/from-tape"))
            .respond_with(
                ResponseTemplate::new(502).set_body_string("the model gateway is unreachable"),
            )
            .mount(&away)
            .await;
        let client = OpenGrokClient::new(&away.uri()).unwrap();
        let error = client
            .create_skill_from_tape("cw_1", "", "", &[])
            .await
            .unwrap_err();
        assert_eq!(error.failure(), Failure::OutOfReach(Unreachable::Gateway));
        assert_eq!(
            error.message, "the model gateway is unreachable",
            "and the sentence is untouched either way"
        );
    }

    /// The one request this client gives a deadline of its own, because it is the one that waits
    /// on a model rather than on a database. Shorter than the server's own 60 seconds and a call
    /// the server was about to answer becomes a client-side failure with nothing in it to read.
    #[test]
    fn writing_a_lesson_is_given_longer_than_the_servers_own_bound() {
        assert!(
            SKILL_FROM_TAPE_TIMEOUT > std::time::Duration::from_secs(60),
            "the server waits 60 seconds on the model; this must outlast it"
        );
    }

    /// The body cap is the server's and so is the sentence about it: it names the limit and what
    /// arrived, and both have to reach the person rather than a word of our own.
    #[tokio::test]
    async fn an_over_long_body_comes_back_in_the_servers_own_words() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/skills"))
            .respond_with(ResponseTemplate::new(413).set_body_string(
                "the skill body is 8007 characters, over the 8000 allowed — a skill shares one \
                 system message with the coworker's own role",
            ))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let error = client
            .create_skill(&NewSkill {
                name: "too-long".into(),
                body: "x".repeat(8007),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(error.status, Some(413));
        assert!(error.message.contains("8000"), "{}", error.message);
        assert!(error.message.contains("8007"), "{}", error.message);
    }

    /// A field nobody edited is not in the JSON at all, or a blank description field would wipe
    /// the one the row has.
    #[tokio::test]
    async fn update_skill_sends_only_what_changed() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/skills/skl_1"))
            .and(body_json(json!({ "enabled": false })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "skl_1", "name": "expense-report", "description": "How we file expenses",
                "source": "authored", "updatedAtMs": 1717000000000i64, "versionCount": 1,
                "draft": false, "enabled": false, "approvedAtMs": 1717000000001i64,
                "version": 1, "body": "Ask first.", "files": []
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let detail = client
            .update_skill(
                "skl_1",
                &SkillPatch {
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(!detail.skill.enabled);
        assert_eq!(
            detail.skill.approved_at_ms,
            Some(1717000000001),
            "switched off again, and still stamped: the reading happened and is not unsaid"
        );
        assert_eq!(detail.skill.description, "How we file expenses");
    }

    #[tokio::test]
    async fn a_new_version_is_the_prose_the_note_and_where_it_came_from() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/skills/skl_1/versions"))
            .and(body_json(json!({
                "body": "Ask for the receipt first, then the date.",
                "kind": "uploaded",
                "note": "the date too",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "version": 2, "kind": "uploaded", "createdAtMs": 1717000000000i64,
                "note": "the date too"
            })))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        // The word goes up with it: left off, a bundle that is one lone SKILL.md comes back
        // recorded as something somebody typed here.
        let version = client
            .add_skill_version(
                "skl_1",
                "Ask for the receipt first, then the date.",
                "the date too",
                SkillSource::Uploaded,
                &[],
            )
            .await
            .unwrap();
        assert_eq!(version.version, 2);
        assert_eq!(version.kind, SkillSource::Uploaded);
        assert_eq!(version.note, "the date too");
    }

    /// 204 and nothing to read. A skill the server never heard of is the server's sentence, not
    /// a silent success.
    #[tokio::test]
    async fn delete_skill_takes_the_empty_answer_and_keeps_a_refusal() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/skills/skl_1"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/skills/skl_9"))
            .respond_with(ResponseTemplate::new(404).set_body_string("no such skill"))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        client.delete_skill("skl_1").await.unwrap();
        let error = client.delete_skill("skl_9").await.unwrap_err();
        assert_eq!(error.status, Some(404));
        assert_eq!(error.message, "no such skill");
    }

    /// The detail is the row with the prose and the bundle added to it, read as one object. A
    /// server from before the switch existed says nothing about `enabled`, and every skill on it
    /// is on: reading that silence as "off" would switch off a whole library nobody touched.
    #[test]
    fn a_detail_is_the_row_and_the_prose_together() {
        let detail: SkillDetail = serde_json::from_value(json!({
            "id": "skl_1", "name": "expense-report", "description": "How we file expenses",
            "source": "uploaded", "updatedAtMs": 1717000000000i64, "versionCount": 2,
            "draft": false, "version": 2, "body": "Ask for the receipt first.",
            "files": [{"path": "reference/rates.csv", "bytes": "b2ssIGhpCg=="}]
        }))
        .expect("the row and the prose are one object on the wire");
        assert_eq!(detail.skill.name, "expense-report");
        assert_eq!(detail.skill.source, SkillSource::Uploaded);
        assert_eq!(detail.version, 2);
        assert_eq!(detail.files[0].path, "reference/rates.csv");
        assert!(detail.skill.enabled);
        assert!(
            detail.skill.approved_at_ms.is_none(),
            "a server from before the stamp existed has approved nothing, and must not read as \
             having approved everything at the epoch"
        );
    }

    /// The chip on a row names where the prose came from, and says nothing at all about one
    /// somebody wrote here: every skill would otherwise wear a label that tells nothing apart.
    #[test]
    fn only_a_skill_from_somewhere_else_wears_a_chip() {
        assert_eq!(SkillSource::Authored.chip(), None);
        assert_eq!(SkillSource::Uploaded.chip(), Some("Uploaded"));
        assert_eq!(SkillSource::Taught.chip(), Some("Taught"));
        assert_eq!(SkillSource::Taught.word(), "taught");
    }

    /// A login's Bots, one Bot's switch for it, and a Bot's logins are three small calls.
    #[tokio::test]
    async fn a_saved_login_is_shared_with_a_bot_by_one_switch() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/site-logins/sl_1/bots"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"bots": ["cw_1"]})))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/site-logins/sl_1/bots/cw_2"))
            .and(body_json(json!({"shared": true})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/site-logins"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"logins": ["sl_1"]})))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        assert_eq!(client.site_login_bots("sl_1").await.unwrap(), ["cw_1"]);
        client
            .set_site_login_shared("sl_1", "cw_2", true)
            .await
            .unwrap();
        assert_eq!(client.logins_shared_with("cw_1").await.unwrap(), ["sl_1"]);
    }

    /// The check before Touch ID reads why a saved login cannot be used, and giving a Bot its own
    /// computer is one PUT.
    #[tokio::test]
    async fn a_saved_login_is_checked_and_a_bot_can_get_its_own_computer() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/saved-login"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "usable": false, "reason": "shared-computer", "ownComputer": false
            })))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/own-computer"))
            .and(body_json(json!({ "on": true })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ownComputer": true})))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let check = client.saved_login_check("cw_1").await.unwrap();
        assert!(!check.usable);
        assert_eq!(check.reason.as_deref(), Some("shared-computer"));
        client.set_own_computer("cw_1", true).await.unwrap();
    }

    /// One plugin skill is switched by plugin and name, and its page reads the text the list
    /// leaves out.
    #[tokio::test]
    async fn a_plugin_skill_is_listed_read_and_switched_for_one_bot() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/plugin-skills"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "skills": [
                { "plugin": "demo", "skill": "triage", "description": "Triage safely", "on": false }
            ]})))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/coworkers/cw_1/plugin-skills/demo/triage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "plugin": "demo", "skill": "triage", "description": "", "on": true, "body": "Read it."
            })))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/plugin-skills"))
            .and(body_json(
                json!({ "plugin": "demo", "skill": "triage", "on": true }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let listed = client.plugin_skills("cw_1").await.unwrap();
        assert_eq!(listed[0].skill, "triage");
        assert!(!listed[0].on);
        assert_eq!(listed[0].body, None);
        let page = client.plugin_skill("cw_1", "demo", "triage").await.unwrap();
        assert_eq!(page.body.as_deref(), Some("Read it."));
        client
            .set_plugin_skill("cw_1", "demo", "triage", true)
            .await
            .unwrap();
    }

    /// A choice is the tool and the word, put to the Bot's own route. The server's 409 when the
    /// ceiling moved meanwhile comes back as its sentence, so the dialog can say why nothing changed.
    #[tokio::test]
    async fn a_tool_choice_is_put_and_a_refusal_is_kept() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/tool-mode"))
            .and(body_json(
                json!({ "tool": "delete_routine", "mode": "always" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/coworkers/cw_1/tool-mode"))
            .and(body_json(json!({ "tool": "shell", "mode": "never" })))
            .respond_with(ResponseTemplate::new(409).set_body_string("the ceiling changed"))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        client
            .set_tool_mode("cw_1", "delete_routine", "always")
            .await
            .unwrap();
        let error = client
            .set_tool_mode("cw_1", "shell", "never")
            .await
            .unwrap_err();
        assert_eq!(error.status, Some(409));
        assert_eq!(error.message, "the ceiling changed");
    }
}

/// The request an answer was for, `GET /coworkers/cw_1/usage`, kept on the response by
/// `send_json_within` so an error read from it later can name it.
#[derive(Clone)]
struct SentAs(String);

fn sent_as(response: &reqwest::Response) -> Option<String> {
    response
        .extensions()
        .get::<SentAs>()
        .map(|sent| sent.0.clone())
}
