//! The account's events stream: the server's word, as it happens, that something the app shows
//! has changed (`GET /ag-ui/events`, opengrok-server #348, shaped from its branch
//! account-events-stream @ 85ce00c: `Note` in `crates/opengrok-wire/src/events.rs`, `follow` in
//! `crates/opengrok-events/src/follow.rs`; not recorded yet).
//!
//! Before it, the app heard live only about the turns it started itself, down their own
//! `POST /ag-ui` streams. A run the server started (a routine's clock, a webhook, Test run, a
//! Bot's `run_routine`) reached the open thread and the open Run history only when the person
//! left and came back (hexuria/nativechat#171). The stream carries ids and nothing else, which
//! thread, run, routine and Bot changed, never a word of what was said: the app reads again what
//! a note names, through the doors it already reads those by, so a note dropped or coalesced costs
//! one more read and never a lost message.
//!
//! Frames are SSE: `id: <n>`, `event: <name>`, `data: <one line of JSON>`, and a `: ping` comment
//! every fifteen seconds. The stream is opened again after it drops, with the last id it carried
//! as `Last-Event-ID`, and the server replays what came after it; an id it no longer holds is
//! answered with `reset` first, which has the app read everything again. Ids only go up, and skip:
//! the server sends a burst of a thread's notes as its last, so a gap between two ids is no note
//! lost. The id is kept as the text it came as and handed back, never counted. The stream is the
//! account's, taken from the session, so it is opened with the bearer every other account route
//! goes with, and a `401` goes through the session's own refresh before anything else.

use std::collections::HashSet;
use std::fmt;
use std::time::Duration;

use futures::{Stream, StreamExt};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::client::OpenGrokClient;
use super::error::OpenGrokError;

/// Something was written to a thread: a message, a run's start or end. Sent at the server's commit
/// points, at most about twice a second per thread.
pub(crate) const THREAD_CHANGED: &str = "thread.changed";
/// A run began in a thread.
pub(crate) const RUN_STARTED: &str = "run.started";
/// A run ended, however it ended.
pub(crate) const RUN_FINISHED: &str = "run.finished";
/// A run is parked on a card for the person (`reason`: which card), in a thread the app may not
/// be streaming (opengrok-server #358, `RUN_WAITING` in `crates/opengrok-wire/src/events.rs`).
pub(crate) const RUN_WAITING: &str = "run.waiting";
/// One of a Bot's routines was made, changed, deleted, paused or resumed.
pub(crate) const ROUTINE_CHANGED: &str = "routine.changed";
/// A Bot's computer or its screen changed what it is doing: it started, a restart, reset or update
/// began or ended, or its own screen came up (hexuria/opengrok-server#386, `COMPUTER_CHANGED` in
/// `crates/opengrok-wire/src/events.rs`, branch `gol/screen-status`).
pub(crate) const COMPUTER_CHANGED: &str = "computer.changed";
/// The server could not replay from the id the app resumed with.
pub(crate) const RESET: &str = "reset";

/// Every note this app reads off the stream, by its `event:` name, for the conformance ledger.
#[cfg(test)]
pub(crate) const ACCOUNT_EVENT_NAMES: [&str; 7] = [
    THREAD_CHANGED,
    RUN_STARTED,
    RUN_WAITING,
    RUN_FINISHED,
    ROUTINE_CHANGED,
    COMPUTER_CHANGED,
    RESET,
];

/// The most one line of the stream may hold. A note is a handful of ids; a line past this is not
/// one, and the stream is opened again rather than read without end.
const LINE_BYTES: usize = 64 * 1024;

/// One note off the stream, in the shape opengrok-server's branch account-events-stream @ 85ce00c
/// writes it (`Note` in `crates/opengrok-wire/src/events.rs`), not recorded yet. Ids only: what
/// changed is read again from its own route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountEvent {
    /// Something was written to the thread.
    ThreadChanged {
        thread_id: String,
        coworker_id: String,
        /// The run whose commit made the change, or `None` when no run did (a card the person
        /// settled). Notes the server coalesces keep the latest run, or none where they disagree.
        run_id: Option<String>,
    },
    /// A run began in the thread. The app's own turns are among them: the stream that started a
    /// run hears about it too, and the app knows its own by the run's id.
    RunStarted {
        run_id: String,
        thread_id: String,
        coworker_id: String,
        /// The routine the run is a firing of, when it is one.
        routine_id: Option<String>,
        cause: RunStartCause,
    },
    /// A run ended for good. A run waiting on a card has not, and the server sends only
    /// `thread.changed` for it: nothing here waits for this note to end anything.
    RunFinished {
        run_id: String,
        thread_id: String,
        coworker_id: String,
        routine_id: Option<String>,
        /// How it ended, in the words a routine's run history uses: `ok`, or `error` (a stop is
        /// an `error`). Empty where the note said nothing this client reads as a word.
        state: String,
    },
    /// One of the Bot's routines changed. The Bot is the routine's owner.
    RoutineChanged {
        routine_id: String,
        coworker_id: String,
        change: RoutineChange,
    },
    /// A Bot's computer changed what it is doing. The app reads the computer again for that Bot,
    /// and for any open screen on the same box: Bots that share a computer share its restarts.
    /// `box_id` is `None` when the Bot had no computer at that moment (mid-reset).
    ComputerChanged {
        coworker_id: String,
        box_id: Option<String>,
    },
    /// The server could not replay from the id the app gave it, because it was missing, expired or
    /// unknown: it is the first note of such a stream, and everything is read again.
    Reset,
}

/// What started a run, as `run.started` says it: the words a routine's run history uses, so the
/// app reads one vocabulary (`fired` in opengrok-server's `crates/opengrok-events/src/appended.rs`,
/// branch account-events-stream @ 85ce00c).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStartCause {
    /// A routine's clock.
    Clock,
    /// A person: a routine's Test run, or a monitor run by hand.
    Manual,
    /// A routine's webhook.
    Webhook,
    /// A Bot, with its `run_routine` tool.
    Bot,
    /// A monitor's event.
    Event,
    /// Nothing fired it: a message in the thread, this app's own among them.
    Chat,
    /// A word this client has no name for yet, or none, or not a word at all: still a run that
    /// began.
    #[default]
    #[serde(other)]
    Other,
}

/// What happened to a routine, as `routine.changed` says it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutineChange {
    Created,
    Updated,
    Deleted,
    Paused,
    Resumed,
    /// A word this client has no name for yet, or none: the routine still changed.
    #[default]
    #[serde(other)]
    Other,
}

/// Why a note off the stream was passed over. Neither fails the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Unread {
    /// A name this app has not heard of: a note the server started sending since.
    Unknown,
    /// A name it knows, without the ids that note needs.
    Malformed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadNote {
    thread_id: String,
    coworker_id: String,
    /// Read as `null` when it is missing, as from a server before the field: the thread is read
    /// again for it, which is always safe.
    #[serde(default)]
    run_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunNote {
    run_id: String,
    thread_id: String,
    coworker_id: String,
    #[serde(default)]
    routine_id: Option<String>,
    /// Read as `Other` when it is missing or not a word: the run began whatever started it, and
    /// the thread it began in is read again either way.
    #[serde(default, deserialize_with = "word_or_default")]
    cause: RunStartCause,
    #[serde(default, deserialize_with = "word_or_default")]
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComputerNote {
    coworker_id: String,
    #[serde(default)]
    box_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoutineNote {
    routine_id: String,
    coworker_id: String,
    #[serde(default, deserialize_with = "word_or_default")]
    change: RoutineChange,
}

/// A word a note carries, read as its default when it is `null`, or is not a word this client can
/// read at all: a cause, a state or a change never costs the note, whose ids are what the window
/// reads by.
fn word_or_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default())
}

impl AccountEvent {
    /// The note an event named `name` carries in `data`. A name this app has not heard of is
    /// [`Unread::Unknown`]; one it knows without an id it needs, or with one left blank, is
    /// [`Unread::Malformed`].
    pub fn read(name: &str, data: &str) -> Result<Self, Unread> {
        match name {
            THREAD_CHANGED => {
                let note: ThreadNote = body(data)?;
                ids_given(&[&note.thread_id, &note.coworker_id])?;
                Ok(Self::ThreadChanged {
                    thread_id: note.thread_id,
                    coworker_id: note.coworker_id,
                    run_id: note.run_id.filter(|id| !id.trim().is_empty()),
                })
            }
            RUN_STARTED | RUN_FINISHED => {
                let note: RunNote = body(data)?;
                ids_given(&[&note.run_id, &note.thread_id, &note.coworker_id])?;
                let routine_id = note.routine_id.filter(|id| !id.trim().is_empty());
                Ok(if name == RUN_STARTED {
                    Self::RunStarted {
                        run_id: note.run_id,
                        thread_id: note.thread_id,
                        coworker_id: note.coworker_id,
                        routine_id,
                        cause: note.cause,
                    }
                } else {
                    Self::RunFinished {
                        run_id: note.run_id,
                        thread_id: note.thread_id,
                        coworker_id: note.coworker_id,
                        routine_id,
                        state: note.state,
                    }
                })
            }
            // Read as what it means to this app: the thread has something new to show, the card,
            // so it is read again, as for `thread.changed`. The server sends that note too, and
            // two reads of one thread coalesce; this one carries the run, so the card is never
            // missed when only it arrives.
            RUN_WAITING => {
                let note: RunNote = body(data)?;
                ids_given(&[&note.run_id, &note.thread_id, &note.coworker_id])?;
                Ok(Self::ThreadChanged {
                    thread_id: note.thread_id,
                    coworker_id: note.coworker_id,
                    run_id: Some(note.run_id),
                })
            }
            ROUTINE_CHANGED => {
                let note: RoutineNote = body(data)?;
                ids_given(&[&note.routine_id, &note.coworker_id])?;
                Ok(Self::RoutineChanged {
                    routine_id: note.routine_id,
                    coworker_id: note.coworker_id,
                    change: note.change,
                })
            }
            COMPUTER_CHANGED => {
                let note: ComputerNote = body(data)?;
                ids_given(&[&note.coworker_id])?;
                Ok(Self::ComputerChanged {
                    coworker_id: note.coworker_id,
                    box_id: note.box_id.filter(|id| !id.trim().is_empty()),
                })
            }
            RESET => Ok(Self::Reset),
            _ => Err(Unread::Unknown),
        }
    }
}

fn body<T: DeserializeOwned>(data: &str) -> Result<T, Unread> {
    serde_json::from_str(data).map_err(|_| Unread::Malformed)
}

fn ids_given(ids: &[&str]) -> Result<(), Unread> {
    if ids.iter().any(|id| id.trim().is_empty()) {
        return Err(Unread::Malformed);
    }
    Ok(())
}

/// How the stream waits. The server pings every fifteen seconds, so `quiet` (three missed pings)
/// with neither a note nor a ping is a dead connection, however open it looks. The wait before it
/// is opened again starts at `first_wait` and doubles after each attempt that brings nothing, up to
/// `longest_wait`, with up to `jitter` of it (a fraction) taken off at random, so that every app a
/// restarted server dropped does not knock again in the same instant. A stream that brings
/// anything at all starts the waits over.
#[derive(Debug, Clone, Copy)]
pub struct EventsTimings {
    pub quiet: Duration,
    pub first_wait: Duration,
    pub longest_wait: Duration,
    pub jitter: f64,
}

impl Default for EventsTimings {
    fn default() -> Self {
        Self {
            quiet: Duration::from_secs(45),
            first_wait: Duration::from_secs(1),
            longest_wait: Duration::from_secs(30),
            jitter: 0.5,
        }
    }
}

/// The waits between attempts to open the stream ([`EventsTimings`]).
#[derive(Debug, Clone)]
struct Backoff {
    next: Duration,
}

impl Backoff {
    fn new(timings: &EventsTimings) -> Self {
        Self {
            next: timings.first_wait.min(timings.longest_wait),
        }
    }

    /// The stream brought something: the next wait is the first one again.
    fn reset(&mut self, timings: &EventsTimings) {
        *self = Self::new(timings);
    }

    /// The wait before the next attempt, with `spread` (from 0 up to 1) of the timings' jitter
    /// taken off it; the one after is twice as long, up to the longest.
    fn wait(&mut self, timings: &EventsTimings, spread: f64) -> Duration {
        let base = self.next;
        self.next = base.saturating_mul(2).min(timings.longest_wait);
        let off = timings.jitter.clamp(0.0, 1.0) * spread.clamp(0.0, 1.0);
        base.mul_f64(1.0 - off)
    }
}

/// What the stream tells the window.
#[derive(Debug)]
pub enum EventsNote {
    /// The stream is open, the first time or again after it dropped: whatever it covers is read
    /// again once, since nothing says what was missed in between.
    Opened,
    /// A note off the stream.
    Event(AccountEvent),
    /// The stream dropped, went quiet, or did not open; it is opened again after a wait.
    Lost,
    /// The server does not know who is asking, after the session's own refresh was tried: the
    /// stream stops, and the app's sign-in takes it from there. Knocking again with a session the
    /// server refused would be refused again.
    SignedOut(OpenGrokError),
    /// The server has no such route, being from before #348: the stream stops, and the app works
    /// as it did before there was one.
    Unavailable,
}

/// The running stream. Dropping it stops it: signed out, signed in as somebody else, or the app
/// quitting.
pub struct AccountEvents {
    serving: JoinHandle<()>,
}

impl Drop for AccountEvents {
    fn drop(&mut self) {
        self.serving.abort();
    }
}

impl fmt::Debug for AccountEvents {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AccountEvents")
            .field("running", &!self.serving.is_finished())
            .finish()
    }
}

/// Open the account's events stream and keep it open, on the tokio runtime, until the handle is
/// dropped: what it hears comes out of the receiver, in order.
pub fn start_account_events(
    client: OpenGrokClient,
    timings: EventsTimings,
) -> (AccountEvents, mpsc::UnboundedReceiver<EventsNote>) {
    let (notes, heard) = mpsc::unbounded_channel();
    let serving = tokio::spawn(serve(client, timings, notes));
    (AccountEvents { serving }, heard)
}

async fn serve(
    client: OpenGrokClient,
    timings: EventsTimings,
    notes: mpsc::UnboundedSender<EventsNote>,
) {
    // The id of the last note the stream carried, which the next stream is opened after.
    let mut resume: Option<String> = None;
    let mut backoff = Backoff::new(&timings);
    // What has been said about notes passed over: each kind once, not once a note.
    let mut said: HashSet<(Unread, String)> = HashSet::new();
    loop {
        let opened =
            tokio::time::timeout(timings.quiet, client.open_account_events(resume.as_deref()))
                .await;
        match opened {
            Ok(Err(error)) => match when_refused(&error) {
                Refused::SessionGone => {
                    let _ = notes.send(EventsNote::SignedOut(error));
                    return;
                }
                Refused::NoStream => {
                    let _ = notes.send(EventsNote::Unavailable);
                    return;
                }
                Refused::TryAgain => {}
            },
            // Not answered in time: tried again after a wait.
            Err(_) => {}
            Ok(Ok(response)) => {
                if notes.send(EventsNote::Opened).is_err() {
                    return;
                }
                let mut items = SseEvents::new(response.bytes_stream());
                loop {
                    let item = match tokio::time::timeout(timings.quiet, items.next_item()).await {
                        Ok(Some(Ok(item))) => item,
                        // Quiet past three pings, closed, or broken: gone either way.
                        Err(_) | Ok(None) | Ok(Some(Err(()))) => break,
                    };
                    backoff.reset(&timings);
                    let SseItem::Event { id, name, data } = item else {
                        continue;
                    };
                    if let Some(id) = id {
                        // Kept as it came, never counted: ids skip, and a gap is no note lost.
                        // An empty id is the server taking its place back: the next stream is
                        // opened from nowhere, and starts with `reset`.
                        resume = (!id.is_empty()).then_some(id);
                    }
                    // A note named nothing is SSE's `message`, which this stream never sends.
                    let name = name.unwrap_or_else(|| "message".to_string());
                    match AccountEvent::read(&name, &data) {
                        Ok(event) => {
                            if notes.send(EventsNote::Event(event)).is_err() {
                                return;
                            }
                        }
                        Err(unread) => {
                            if said.insert((unread, name.clone())) {
                                eprintln!(
                                    "NativeChat events: passed over {}",
                                    unread_words(unread, &name)
                                );
                            }
                        }
                    }
                }
            }
        }
        if notes.send(EventsNote::Lost).is_err() {
            return;
        }
        let spread = rand::random_range(0.0..1.0);
        tokio::time::sleep(backoff.wait(&timings, spread)).await;
    }
}

/// What the stream does when the server will not open it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refused {
    /// The session is gone, after its own refresh was tried: the stream stops, and signing in
    /// again starts it.
    SessionGone,
    /// No such route (a bare `404`, or a `405`): a server from before the stream. It stops.
    NoStream,
    /// Anything else, as a store the server could not read (a `503` in its words): the stream is
    /// opened again after a wait.
    TryAgain,
}

/// How the stream takes `error`, the server's refusal to open it.
pub(super) fn when_refused(error: &OpenGrokError) -> Refused {
    if error.is_signed_out() {
        Refused::SessionGone
    } else if error.route_missing() {
        Refused::NoStream
    } else {
        Refused::TryAgain
    }
}

/// The blocks of a stream's body as the stream reads them off the wire (`id`, `event` and `data`
/// of each, comments passed over), for the wire conformance tests to read a recorded body with.
#[cfg(test)]
pub(super) fn blocks_of(text: &str) -> Vec<(Option<String>, Option<String>, String)> {
    let bytes = futures::stream::iter([Ok::<_, reqwest::Error>(text.as_bytes().to_vec())]);
    let mut items = SseEvents::new(bytes);
    let mut blocks = Vec::new();
    futures::executor::block_on(async {
        while let Some(Ok(item)) = items.next_item().await {
            if let SseItem::Event { id, name, data } = item {
                blocks.push((id, name, data));
            }
        }
    });
    blocks
}

/// What is said, once, about a kind of note passed over. Never its data, though that is ids alone.
fn unread_words(unread: Unread, name: &str) -> String {
    match unread {
        Unread::Unknown => format!("a note named {name:?}, which this app does not read"),
        Unread::Malformed => format!("a {name:?} note without the ids it needs"),
    }
}

/// One thing off the stream: an event, or a comment (the server's `: ping`), which says only that
/// the stream is alive.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SseItem {
    Event {
        id: Option<String>,
        name: Option<String>,
        data: String,
    },
    Comment,
}

/// The stream's events, read off the bytes as they come, as the relay's stream is: lines are split
/// on the bytes rather than on text decoded chunk by chunk, so a character cut in two by the
/// network arrives whole. An event is its `id:`, `event:` and `data:` lines up to a blank one; a
/// line starting with `:` is a comment, and any other field is passed over.
struct SseEvents<S> {
    bytes: S,
    buffer: Vec<u8>,
    id: Option<String>,
    name: Option<String>,
    data: Option<String>,
}

impl<S, B> SseEvents<S>
where
    S: Stream<Item = reqwest::Result<B>> + Unpin,
    B: AsRef<[u8]>,
{
    fn new(bytes: S) -> Self {
        Self {
            bytes,
            buffer: Vec::new(),
            id: None,
            name: None,
            data: None,
        }
    }

    /// The next event or comment; `Some(Err(()))` for a stream that broke, and `None` for one that
    /// ended. An event the stream ended in the middle of is not one.
    async fn next_item(&mut self) -> Option<Result<SseItem, ()>> {
        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=end).collect();
                let line = line.strip_suffix(b"\n").unwrap_or(&line);
                let line = line.strip_suffix(b"\r").unwrap_or(line);
                if let Some(item) = self.take_line(&String::from_utf8_lossy(line)) {
                    return Some(Ok(item));
                }
                continue;
            }
            match self.bytes.next().await? {
                Ok(chunk) => {
                    self.buffer.extend_from_slice(chunk.as_ref());
                    if self.buffer.len() > LINE_BYTES {
                        return Some(Err(()));
                    }
                }
                Err(_) => return Some(Err(())),
            }
        }
    }

    fn take_line(&mut self, line: &str) -> Option<SseItem> {
        if line.is_empty() {
            let (id, name, data) = (self.id.take(), self.name.take(), self.data.take());
            if id.is_none() && name.is_none() && data.is_none() {
                return None;
            }
            return Some(SseItem::Event {
                id,
                name,
                data: data.unwrap_or_default(),
            });
        }
        if line.starts_with(':') {
            return Some(SseItem::Comment);
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            // An id with a NUL in it is not one (the SSE spec's own rule).
            "id" if !value.contains('\0') => self.id = Some(value.to_string()),
            "event" => self.name = Some(value.to_string()),
            "data" => match &mut self.data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => self.data = Some(value.to_string()),
            },
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    fn quick() -> EventsTimings {
        EventsTimings {
            quiet: Duration::from_secs(5),
            first_wait: Duration::from_millis(50),
            longest_wait: Duration::from_millis(200),
            jitter: 0.0,
        }
    }

    /// A stream's body: each note as the server frames it, `id`, `event` and one line of `data`.
    fn frames(notes: &[(u64, &str, serde_json::Value)]) -> String {
        notes
            .iter()
            .map(|(id, name, data)| format!("id: {id}\nevent: {name}\ndata: {data}\n\n"))
            .collect()
    }

    fn stream(body: String) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_raw(body, "text/event-stream")
    }

    fn thread_changed(thread: &str) -> serde_json::Value {
        json!({"threadId": thread, "coworkerId": "cw_1", "runId": null})
    }

    /// The next thing the stream tells the window, within a few seconds.
    async fn next(heard: &mut mpsc::UnboundedReceiver<EventsNote>) -> EventsNote {
        tokio::time::timeout(Duration::from_secs(10), heard.recv())
            .await
            .expect("the stream says something")
            .expect("the stream is still running")
    }

    /// Every request the server was asked for the stream, oldest first.
    async fn opens(server: &MockServer) -> Vec<Request> {
        server
            .received_requests()
            .await
            .expect("the recorder is on")
            .into_iter()
            .filter(|request| request.url.path() == "/ag-ui/events")
            .collect()
    }

    /// An access token named `name` whose expiry nothing reads as near (2100), so nothing
    /// refreshes it before it is used. Assembled rather than written down, so the file carries no
    /// string shaped like a credential.
    fn token(name: &str) -> String {
        use base64::Engine as _;
        let part = |json: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
        format!(
            "{}.{}.not-a-signature",
            part(r#"{"alg":"HS256","typ":"JWT"}"#),
            part(&format!(r#"{{"exp":4102444800,"sub":"{name}"}}"#))
        )
    }

    /// A client signed in to `server` by its own login, holding the token named `name`.
    async fn signed_in(server: &MockServer, name: &str) -> OpenGrokClient {
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(
                ResponseTemplate::new(200)
                    .append_header("set-cookie", format!("og_access={}; Path=/", token(name)))
                    .set_body_json(json!({})),
            )
            .mount(server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        client
            .login("ada@example.com", "pw")
            .await
            .expect("signed in");
        client
    }

    fn last_event_id(request: &Request) -> Option<String> {
        request
            .headers
            .get("last-event-id")
            .map(|id| id.to_str().unwrap_or_default().to_string())
    }

    /// Every note of the contract reads as itself; a cause or a change this app has no word for is
    /// still the note; a name this app has not heard of, and a note without the ids it needs, are
    /// passed over and told apart.
    #[test]
    fn every_note_reads_as_the_contract_writes_it() {
        assert_eq!(
            AccountEvent::read(THREAD_CHANGED, &thread_changed("cw_1").to_string()),
            Ok(AccountEvent::ThreadChanged {
                thread_id: "cw_1".into(),
                coworker_id: "cw_1".into(),
                run_id: None,
            })
        );
        let started = json!({"runId": "run_1", "threadId": "sched_1", "coworkerId": "cw_1",
                             "routineId": "sched_1", "cause": "manual"});
        assert_eq!(
            AccountEvent::read(RUN_STARTED, &started.to_string()),
            Ok(AccountEvent::RunStarted {
                run_id: "run_1".into(),
                thread_id: "sched_1".into(),
                coworker_id: "cw_1".into(),
                routine_id: Some("sched_1".into()),
                cause: RunStartCause::Manual,
            })
        );
        for (word, cause) in [
            ("clock", RunStartCause::Clock),
            ("manual", RunStartCause::Manual),
            ("webhook", RunStartCause::Webhook),
            ("bot", RunStartCause::Bot),
            ("event", RunStartCause::Event),
            ("chat", RunStartCause::Chat),
            ("comet", RunStartCause::Other),
        ] {
            let note = json!({"runId": "r", "threadId": "t", "coworkerId": "c", "cause": word});
            assert!(
                matches!(
                    AccountEvent::read(RUN_STARTED, &note.to_string()),
                    Ok(AccountEvent::RunStarted { cause: read, routine_id: None, .. }) if read == cause
                ),
                "{word}"
            );
        }
        let finished = json!({"runId": "run_1", "threadId": "cw_1", "coworkerId": "cw_1",
                              "state": "ok"});
        assert_eq!(
            AccountEvent::read(RUN_FINISHED, &finished.to_string()),
            Ok(AccountEvent::RunFinished {
                run_id: "run_1".into(),
                thread_id: "cw_1".into(),
                coworker_id: "cw_1".into(),
                routine_id: None,
                state: "ok".into(),
            })
        );
        for (word, change) in [
            ("created", RoutineChange::Created),
            ("updated", RoutineChange::Updated),
            ("deleted", RoutineChange::Deleted),
            ("paused", RoutineChange::Paused),
            ("resumed", RoutineChange::Resumed),
            ("renamed", RoutineChange::Other),
        ] {
            let note = json!({"routineId": "sched_1", "coworkerId": "cw_1", "change": word});
            assert_eq!(
                AccountEvent::read(ROUTINE_CHANGED, &note.to_string()),
                Ok(AccountEvent::RoutineChanged {
                    routine_id: "sched_1".into(),
                    coworker_id: "cw_1".into(),
                    change,
                }),
                "{word}"
            );
        }
        assert_eq!(
            AccountEvent::read(
                COMPUTER_CHANGED,
                r#"{"coworkerId":"cw_1","boxId":"og-box-1"}"#
            ),
            Ok(AccountEvent::ComputerChanged {
                coworker_id: "cw_1".into(),
                box_id: Some("og-box-1".into()),
            })
        );
        assert_eq!(
            AccountEvent::read(COMPUTER_CHANGED, r#"{"coworkerId":"cw_1","boxId":null}"#),
            Ok(AccountEvent::ComputerChanged {
                coworker_id: "cw_1".into(),
                box_id: None,
            }),
            "mid-reset the Bot has no computer"
        );
        assert_eq!(
            AccountEvent::read(COMPUTER_CHANGED, r#"{"boxId":"og-box-1"}"#),
            Err(Unread::Malformed)
        );
        assert_eq!(AccountEvent::read(RESET, "{}"), Ok(AccountEvent::Reset));
        assert_eq!(
            AccountEvent::read("roster.changed", "{}"),
            Err(Unread::Unknown),
            "the roster is not in the first version of the stream"
        );
        for (name, data) in [
            (THREAD_CHANGED, json!({"coworkerId": "cw_1"})),
            (
                THREAD_CHANGED,
                json!({"threadId": " ", "coworkerId": "cw_1"}),
            ),
            (
                RUN_STARTED,
                json!({"threadId": "cw_1", "coworkerId": "cw_1"}),
            ),
            (RUN_FINISHED, json!({"runId": "r", "coworkerId": "cw_1"})),
            (
                ROUTINE_CHANGED,
                json!({"coworkerId": "cw_1", "change": "deleted"}),
            ),
            (THREAD_CHANGED, json!("cw_1")),
        ] {
            assert_eq!(
                AccountEvent::read(name, &data.to_string()),
                Err(Unread::Malformed),
                "{name} {data}"
            );
        }
        assert_eq!(
            AccountEvent::read(THREAD_CHANGED, "not json"),
            Err(Unread::Malformed)
        );
    }

    /// `thread.changed` names the run whose commit made the change, `null` when no run did (a card
    /// the person settled); a note without the field, or with a blank one, reads as `null`, for
    /// which the thread is read again, which is always safe.
    #[test]
    fn a_thread_change_names_the_run_that_made_it_or_none() {
        let read =
            |data: serde_json::Value| match AccountEvent::read(THREAD_CHANGED, &data.to_string()) {
                Ok(AccountEvent::ThreadChanged { run_id, .. }) => run_id,
                other => panic!("{data}: {other:?}"),
            };
        assert_eq!(
            read(json!({"threadId": "cw_1", "coworkerId": "cw_1", "runId": "run_1"})).as_deref(),
            Some("run_1")
        );
        assert_eq!(
            read(json!({"threadId": "cw_1", "coworkerId": "cw_1", "runId": null})),
            None
        );
        assert_eq!(
            read(json!({"threadId": "cw_1", "coworkerId": "cw_1"})),
            None,
            "a note without it reads as null"
        );
        assert_eq!(
            read(json!({"threadId": "cw_1", "coworkerId": "cw_1", "runId": " "})),
            None,
            "a blank run is none"
        );
    }

    /// `run.started` says what started the run in the words a routine's run history uses
    /// (opengrok-server branch account-events-stream @ 85ce00c, `fired` in
    /// `crates/opengrok-events/src/appended.rs`): `clock`, `manual`, `webhook` and `bot` for a
    /// routine, `event` and `manual` for a monitor, `chat` for a run nothing fired. `run.finished`
    /// says how it ended, `ok` or `error` (`history_word`). A word this client has no name for,
    /// the first brief's `schedule`, `hook` and `test` among them, and a value that is not a word
    /// at all, never cost the note: its ids are what the window reads by.
    #[test]
    fn a_runs_words_are_the_historys_and_never_cost_the_note() {
        let cause = |cause: serde_json::Value| {
            let note = json!({"runId": "r", "threadId": "t", "coworkerId": "c", "cause": cause});
            match AccountEvent::read(RUN_STARTED, &note.to_string()) {
                Ok(AccountEvent::RunStarted { cause, .. }) => format!("{cause:?}"),
                other => panic!("{note}: {other:?}"),
            }
        };
        for (word, read) in [
            ("clock", "Clock"),
            ("manual", "Manual"),
            ("webhook", "Webhook"),
            ("bot", "Bot"),
            ("event", "Event"),
            ("chat", "Chat"),
            ("schedule", "Other"),
            ("hook", "Other"),
            ("test", "Other"),
            ("comet", "Other"),
        ] {
            assert_eq!(cause(json!(word)), read, "{word}");
        }
        assert_eq!(cause(json!(7)), "Other", "a cause that is not a word");
        assert_eq!(cause(serde_json::Value::Null), "Other");
        let state = |state: serde_json::Value| {
            let note = json!({"runId": "r", "threadId": "t", "coworkerId": "c", "state": state});
            match AccountEvent::read(RUN_FINISHED, &note.to_string()) {
                Ok(AccountEvent::RunFinished { state, .. }) => state,
                other => panic!("{note}: {other:?}"),
            }
        };
        assert_eq!(state(json!("ok")), "ok");
        assert_eq!(state(json!("error")), "error", "a stop is an error");
        assert_eq!(state(json!(7)), "", "a state that is not a word");
        let change = json!({"routineId": "sched_1", "coworkerId": "cw_1", "change": 7});
        assert!(
            matches!(
                AccountEvent::read(ROUTINE_CHANGED, &change.to_string()),
                Ok(AccountEvent::RoutineChanged {
                    change: RoutineChange::Other,
                    ..
                })
            ),
            "a change that is not a word"
        );
    }

    /// The stream's lines are split on the bytes: an event cut across chunks, a character cut in
    /// two, CRLF endings, a comment, a field nobody reads and an event of two `data:` lines all
    /// read as the server meant them; a ping is a comment, and an event the stream ended in the
    /// middle of is not one.
    #[tokio::test]
    async fn the_streams_events_are_read_whole_across_chunks() {
        let text = ": ping\r\nretry: 1000\r\nid: 7\r\nevent: thread.changed\r\n\
                    data: {\"threadId\":\"Zoë 你好\"}\r\n\r\n\
                    : ping\n\nid: 8\nevent: two\ndata: a\ndata: b\n\nid: 9\nevent: cut";
        let chunks: Vec<reqwest::Result<Vec<u8>>> = text
            .as_bytes()
            .chunks(1)
            .map(|chunk| Ok(chunk.to_vec()))
            .collect();
        let mut items = SseEvents::new(futures::stream::iter(chunks));
        assert_eq!(items.next_item().await, Some(Ok(SseItem::Comment)));
        assert_eq!(
            items.next_item().await,
            Some(Ok(SseItem::Event {
                id: Some("7".into()),
                name: Some(THREAD_CHANGED.into()),
                data: "{\"threadId\":\"Zoë 你好\"}".into(),
            }))
        );
        assert_eq!(items.next_item().await, Some(Ok(SseItem::Comment)));
        assert_eq!(
            items.next_item().await,
            Some(Ok(SseItem::Event {
                id: Some("8".into()),
                name: Some("two".into()),
                data: "a\nb".into(),
            }))
        );
        assert_eq!(items.next_item().await, None, "the last event never ended");
    }

    /// The stream is opened with the session's bearer, asking for an event stream. What it carries
    /// comes out in order, after word that it opened: a note named nothing this app reads, and
    /// one without its ids, are passed over, and a ping carries nothing. Ids only go up, and skip
    /// (the server sends a burst of a thread's notes as its last): a gap is no note lost, and asks
    /// for nothing. When the stream ends, the window hears it was lost, and it is opened again
    /// from the last id it carried.
    #[tokio::test]
    async fn the_stream_is_read_in_order_and_opened_again_from_its_last_id() {
        let server = MockServer::start().await;
        let body = format!(
            "{}: ping\n\n{}",
            frames(&[
                (3, THREAD_CHANGED, thread_changed("cw_1")),
                (9, "roster.changed", json!({})),
                (12, THREAD_CHANGED, json!({"coworkerId": "cw_1"})),
            ]),
            frames(&[(
                40,
                ROUTINE_CHANGED,
                json!({"routineId": "sched_1", "coworkerId": "cw_1", "change": "created"})
            )])
        );
        Mock::given(method("GET"))
            .and(path("/ag-ui/events"))
            .respond_with(stream(body))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/events"))
            .respond_with(stream(frames(&[(
                57,
                THREAD_CHANGED,
                thread_changed("cw_2"),
            )])))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let (_running, mut heard) = start_account_events(client, quick());
        assert!(matches!(next(&mut heard).await, EventsNote::Opened));
        assert!(matches!(
            next(&mut heard).await,
            EventsNote::Event(AccountEvent::ThreadChanged { thread_id, .. }) if thread_id == "cw_1"
        ));
        assert!(matches!(
            next(&mut heard).await,
            EventsNote::Event(AccountEvent::RoutineChanged {
                change: RoutineChange::Created,
                ..
            })
        ));
        assert!(matches!(next(&mut heard).await, EventsNote::Lost));
        assert!(matches!(next(&mut heard).await, EventsNote::Opened));
        assert!(matches!(
            next(&mut heard).await,
            EventsNote::Event(AccountEvent::ThreadChanged { thread_id, .. }) if thread_id == "cw_2"
        ));
        let opened = opens(&server).await;
        let first = &opened[0];
        assert_eq!(last_event_id(first), None, "the first stream starts now");
        assert_eq!(
            first.headers.get("accept").unwrap(),
            "text/event-stream",
            "{first:?}"
        );
        assert_eq!(
            last_event_id(&opened[1]).as_deref(),
            Some("40"),
            "the stream is opened again after the last note it carried, read or passed over"
        );
        assert_eq!(opened.len(), 2, "and only when it ended, never for a gap");
    }

    /// A stream opened again from an id the server no longer holds starts with `reset`, whose id is
    /// where the server stands: the window hears it, and the stream after it resumes from there.
    #[tokio::test]
    async fn a_reset_is_heard_and_the_stream_resumes_from_where_it_put_it() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/events"))
            .respond_with(stream(frames(&[(
                40,
                THREAD_CHANGED,
                thread_changed("cw_1"),
            )])))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/events"))
            .and(header("last-event-id", "40"))
            .respond_with(stream(frames(&[(97, RESET, json!({}))])))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/events"))
            .respond_with(stream(String::new()))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let (_running, mut heard) = start_account_events(client, quick());
        tokio::time::timeout(Duration::from_secs(10), async {
            while !matches!(
                next(&mut heard).await,
                EventsNote::Event(AccountEvent::Reset)
            ) {}
            while !matches!(next(&mut heard).await, EventsNote::Opened) {}
        })
        .await
        .expect("the reset is heard, and the stream opened after it");
        let opened = opens(&server).await;
        assert_eq!(last_event_id(&opened[1]).as_deref(), Some("40"));
        assert_eq!(
            last_event_id(&opened[2]).as_deref(),
            Some("97"),
            "after a reset the stream goes on from the server's own place"
        );
    }

    /// A `401` is not knocked on again with the same session: the session's own refresh is asked
    /// first, and the stream opened again with the token it brought, which the server takes.
    #[tokio::test]
    async fn a_refused_stream_refreshes_the_session_and_opens_with_the_new_one() {
        let server = MockServer::start().await;
        let client = signed_in(&server, "old").await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/events"))
            .and(header(
                "authorization",
                format!("Bearer {}", token("old")).as_str(),
            ))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "expired"})))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/events"))
            .and(header(
                "authorization",
                format!("Bearer {}", token("fresh")).as_str(),
            ))
            .respond_with(stream(frames(&[(
                1,
                THREAD_CHANGED,
                thread_changed("cw_1"),
            )])))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/auth/refresh"))
            .respond_with(
                ResponseTemplate::new(200)
                    .append_header(
                        "set-cookie",
                        format!("og_access={}; Path=/", token("fresh")),
                    )
                    .set_body_json(json!({})),
            )
            .mount(&server)
            .await;
        let (_running, mut heard) = start_account_events(client, quick());
        assert!(matches!(next(&mut heard).await, EventsNote::Opened));
        assert!(matches!(
            next(&mut heard).await,
            EventsNote::Event(AccountEvent::ThreadChanged { .. })
        ));
        let asked: Vec<String> = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|request| format!("{} {}", request.method, request.url.path()))
            .collect();
        assert_eq!(
            &asked[..4],
            [
                "POST /auth/login",
                "GET /ag-ui/events",
                "POST /auth/refresh",
                "GET /ag-ui/events"
            ],
            "{asked:?}"
        );
    }

    /// A session the refresh cannot save either is the session gone: the window is told, with the
    /// server's sentence, and the stream is not opened again with it.
    #[tokio::test]
    async fn a_session_the_refresh_cannot_save_stops_the_stream() {
        let server = MockServer::start().await;
        let client = signed_in(&server, "old").await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/events"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "who?"})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/auth/refresh"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(json!({"error": "session expired"})),
            )
            .mount(&server)
            .await;
        let (_running, mut heard) = start_account_events(client, quick());
        match next(&mut heard).await {
            EventsNote::SignedOut(error) => {
                assert!(error.is_signed_out(), "{error:?}");
                assert_eq!(error.message, "who?");
            }
            other => panic!("the session is gone, not {other:?}"),
        }
        let refreshed = |asked: &[Request]| {
            asked
                .iter()
                .filter(|request| request.url.path() == "/auth/refresh")
                .count()
        };
        let asked = server.received_requests().await.unwrap();
        assert!(
            refreshed(&asked) >= 1,
            "the session's refresh was asked first"
        );
        let opened = opens(&server).await.len();
        assert!(
            tokio::time::timeout(Duration::from_millis(600), heard.recv())
                .await
                .is_ok_and(|said| said.is_none()),
            "the stream has stopped"
        );
        assert_eq!(
            opens(&server).await.len(),
            opened,
            "and is not opened again"
        );
    }

    /// A server from before the stream answers its route with a bare `404`: the window is told
    /// there is no stream, and nothing knocks on it again.
    #[tokio::test]
    async fn a_server_without_the_stream_is_not_asked_again() {
        let server = MockServer::start().await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let (_running, mut heard) = start_account_events(client, quick());
        assert!(matches!(next(&mut heard).await, EventsNote::Unavailable));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(opens(&server).await.len(), 1);
    }

    /// Answers a stream with a refusal, noting when each attempt came, on the server's own clock.
    struct Refusing(Arc<Mutex<Vec<Instant>>>);

    impl Respond for Refusing {
        fn respond(&self, _: &Request) -> ResponseTemplate {
            self.0.lock().unwrap().push(Instant::now());
            ResponseTemplate::new(503).set_body_json(json!({"error": "busy"}))
        }
    }

    /// The waits between attempts double from the first to the longest, and no further; a stream
    /// that brings anything starts them over; and the jitter only ever takes off, never more than
    /// its share.
    #[test]
    fn the_waits_double_to_the_longest_and_start_over() {
        let timings = EventsTimings {
            jitter: 0.5,
            ..EventsTimings::default()
        };
        let mut backoff = Backoff::new(&timings);
        let waits: Vec<u64> = (0..7)
            .map(|_| backoff.wait(&timings, 0.0).as_secs())
            .collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 30, 30]);
        backoff.reset(&timings);
        assert_eq!(backoff.wait(&timings, 0.0), Duration::from_secs(1));
        let jittered = backoff.wait(&timings, 0.999);
        assert!(
            jittered > Duration::from_millis(1000) && jittered <= Duration::from_secs(2),
            "half of two seconds off at most: {jittered:?}"
        );
        let mut backoff = Backoff::new(&timings);
        assert_eq!(
            backoff.wait(&timings, 7.0),
            Duration::from_millis(500),
            "a spread past one is one"
        );
    }

    /// The loop waits as the timings say between attempts that bring nothing: each gap at least
    /// the wait before it, which doubles up to the longest.
    #[tokio::test]
    async fn attempts_that_bring_nothing_wait_longer_each_time() {
        let server = MockServer::start().await;
        let at = Arc::new(Mutex::new(Vec::new()));
        Mock::given(method("GET"))
            .and(path("/ag-ui/events"))
            .respond_with(Refusing(Arc::clone(&at)))
            .mount(&server)
            .await;
        let timings = EventsTimings {
            first_wait: Duration::from_millis(100),
            longest_wait: Duration::from_millis(400),
            ..quick()
        };
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let (_running, mut heard) = start_account_events(client, timings);
        for _ in 0..5 {
            assert!(matches!(next(&mut heard).await, EventsNote::Lost));
        }
        let at = at.lock().unwrap().clone();
        let gaps: Vec<Duration> = at.windows(2).map(|pair| pair[1] - pair[0]).collect();
        for (gap, least) in gaps.iter().zip([100, 200, 400, 400]) {
            assert!(
                *gap >= Duration::from_millis(least),
                "a wait of at least {least}ms: {gaps:?}"
            );
        }
    }

    /// A stream that goes quiet past three pings is given up and opened again, however open it
    /// looks; one that pings is left open.
    #[tokio::test]
    async fn a_stream_gone_quiet_is_opened_again() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let opened = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&opened);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let first = counted.fetch_add(1, Ordering::SeqCst) == 0;
                tokio::spawn(async move {
                    let mut asked = [0u8; 4096];
                    let _ = socket.read(&mut asked).await;
                    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\
                                transfer-encoding: chunked\r\n\r\n";
                    let _ = socket.write_all(head.as_bytes()).await;
                    let ping = ": ping\n\n";
                    let chunk = format!("{:x}\r\n{ping}\r\n", ping.len());
                    // The first stream pings, faster than the quiet; every later one says
                    // nothing, holding the connection.
                    for _ in 0..if first { 6 } else { 0 } {
                        let _ = socket.write_all(chunk.as_bytes()).await;
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    tokio::time::sleep(Duration::from_secs(30)).await;
                });
            }
        });
        let timings = EventsTimings {
            quiet: Duration::from_millis(300),
            ..quick()
        };
        let client = OpenGrokClient::new(&format!("http://{address}")).unwrap();
        let started = Instant::now();
        let (_running, mut heard) = start_account_events(client, timings);
        assert!(matches!(next(&mut heard).await, EventsNote::Opened));
        assert!(matches!(next(&mut heard).await, EventsNote::Lost));
        assert!(
            started.elapsed() >= Duration::from_millis(600),
            "a stream that pings is alive: {:?}",
            started.elapsed()
        );
        assert!(matches!(next(&mut heard).await, EventsNote::Opened));
        assert!(matches!(next(&mut heard).await, EventsNote::Lost));
        assert!(opened.load(Ordering::SeqCst) >= 2);
    }

    /// Dropping the handle stops the stream: nothing more is heard, and it is not opened again.
    #[tokio::test]
    async fn dropping_the_handle_stops_the_stream() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ag-ui/events"))
            .respond_with(stream(String::new()))
            .mount(&server)
            .await;
        let client = OpenGrokClient::new(&server.uri()).unwrap();
        let (running, mut heard) = start_account_events(client, quick());
        assert!(matches!(next(&mut heard).await, EventsNote::Opened));
        drop(running);
        tokio::time::timeout(Duration::from_secs(5), async {
            while heard.recv().await.is_some() {}
        })
        .await
        .expect("nothing more is heard once the handle is gone");
        let opened = opens(&server).await.len();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(opens(&server).await.len(), opened);
    }
}
