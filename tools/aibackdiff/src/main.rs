use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    sync::{
        LazyLock,
        mpsc::{self, Receiver},
    },
    thread,
};

use anyhow::{Context, Result, bail};
use eframe::egui::{self, Color32, RichText};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;

static BREAK_TAGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>|</p>|</h[1-6]>|</li>|</tr>|</table>").unwrap());
static ALL_TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static TURN_MARKERS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Your prompt:|Search's response:").unwrap());
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+\n").unwrap());
static EXTRA_NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
static TITLE_SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

fn default_aimode_database_path() -> String {
    let Some(home) = env::var_os("HOME") else {
        return String::new();
    };
    let current = PathBuf::from(&home).join(".config/aibackman/aimode.db");
    if current.exists() {
        return current.display().to_string();
    }
    let legacy = PathBuf::from(home).join(".config/chatgpt/aimode.db");
    if legacy.exists() {
        return legacy.display().to_string();
    }
    current.display().to_string()
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Clone, Debug)]
struct Chat {
    id: String,
    title: String,
    created_at: f64,
    messages: Vec<Message>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ChangeKind {
    AddedChat,
    MissingChat,
    MessagesAdded,
    MessagesMissing,
    MessagesChanged,
    Unchanged,
}

impl ChangeKind {
    fn label(self) -> &'static str {
        match self {
            Self::AddedChat => "Chat added",
            Self::MissingChat => "Chat missing",
            Self::MessagesAdded => "New messages",
            Self::MessagesMissing => "Messages missing",
            Self::MessagesChanged => "Messages changed",
            Self::Unchanged => "In both",
        }
    }

    fn color(self) -> Color32 {
        match self {
            Self::AddedChat | Self::MessagesAdded => Color32::from_rgb(42, 155, 91),
            Self::MissingChat | Self::MessagesMissing => Color32::from_rgb(210, 75, 75),
            Self::MessagesChanged => Color32::from_rgb(210, 145, 35),
            Self::Unchanged => Color32::from_rgb(42, 155, 91),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct MessageChange {
    position: usize,
    role: String,
    content: String,
}

#[derive(Clone, Debug, Serialize)]
struct ModifiedMessage {
    position: usize,
    role: String,
    baseline_content: String,
    comparison_content: String,
}

#[derive(Clone, Debug, Serialize)]
struct ChatChange {
    kind: ChangeKind,
    title: String,
    baseline_id: Option<String>,
    comparison_id: Option<String>,
    baseline_messages: usize,
    comparison_messages: usize,
    match_score: Option<i32>,
    added_messages: Vec<MessageChange>,
    removed_messages: Vec<MessageChange>,
    modified_messages: Vec<ModifiedMessage>,
}

#[derive(Clone, Debug, Default, Serialize)]
struct Summary {
    baseline_chats: usize,
    comparison_chats: usize,
    chats_in_both: usize,
    unchanged_chats: usize,
    added_chats: usize,
    missing_chats: usize,
    chats_with_new_messages: usize,
    chats_with_missing_messages: usize,
    chats_with_modified_messages: usize,
    added_messages: usize,
    removed_messages: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
struct Report {
    baseline_label: String,
    comparison_label: String,
    summary: Summary,
    changes: Vec<ChatChange>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Filter {
    AllChanges,
    AddedChats,
    MissingChats,
    NewMessages,
    MissingMessages,
    ModifiedMessages,
    Unchanged,
}

impl Filter {
    fn label(self) -> &'static str {
        match self {
            Self::AllChanges => "All chats",
            Self::AddedChats => "Added chats",
            Self::MissingChats => "Missing chats",
            Self::NewMessages => "New messages",
            Self::MissingMessages => "Missing messages",
            Self::ModifiedMessages => "Modified messages",
            Self::Unchanged => "In both",
        }
    }

    fn includes(self, kind: ChangeKind) -> bool {
        match self {
            Self::AllChanges => true,
            Self::AddedChats => kind == ChangeKind::AddedChat,
            Self::MissingChats => kind == ChangeKind::MissingChat,
            Self::NewMessages => kind == ChangeKind::MessagesAdded,
            Self::MissingMessages => kind == ChangeKind::MessagesMissing,
            Self::ModifiedMessages => kind == ChangeKind::MessagesChanged,
            Self::Unchanged => kind == ChangeKind::Unchanged,
        }
    }
}

struct CompareFinished {
    result: std::result::Result<Report, String>,
}

struct AiBackdiffApp {
    baseline_path: String,
    comparison_path: String,
    report: Option<Report>,
    selected: Option<usize>,
    filter: Filter,
    search: String,
    status: String,
    compare_rx: Option<Receiver<CompareFinished>>,
}

impl Default for AiBackdiffApp {
    fn default() -> Self {
        let baseline_path = default_aimode_database_path();
        Self {
            baseline_path,
            comparison_path: String::new(),
            report: None,
            selected: None,
            filter: Filter::AllChanges,
            search: String::new(),
            status: "Choose two databases or Takeout backups to compare.".to_owned(),
            compare_rx: None,
        }
    }
}

impl AiBackdiffApp {
    fn google_backups_dialog() -> rfd::FileDialog {
        let dialog = rfd::FileDialog::new();
        let preferred = Path::new("/home/lewis/Desktop/backups/Google");
        if preferred.is_dir() {
            dialog.set_directory(preferred)
        } else {
            dialog
        }
    }

    fn begin_compare(&mut self) {
        let baseline_path = self.baseline_path.trim().to_owned();
        let comparison_path = self.comparison_path.trim().to_owned();
        if baseline_path.is_empty() || comparison_path.is_empty() {
            self.status = "Both paths are required.".to_owned();
            return;
        }

        let (tx, rx) = mpsc::channel();
        self.compare_rx = Some(rx);
        self.status = "Loading and comparing sources...".to_owned();
        self.report = None;
        self.selected = None;
        thread::spawn(move || {
            let result = compare_paths(Path::new(&baseline_path), Path::new(&comparison_path))
                .map_err(|error| format!("{error:#}"));
            let _ = tx.send(CompareFinished { result });
        });
    }

    fn poll_compare(&mut self, ctx: &egui::Context) {
        let Some(rx) = &self.compare_rx else {
            return;
        };
        match rx.try_recv() {
            Ok(finished) => {
                self.compare_rx = None;
                match finished.result {
                    Ok(report) => {
                        let changed = report
                            .changes
                            .iter()
                            .filter(|change| change.kind != ChangeKind::Unchanged)
                            .count();
                        self.status = format!("Comparison complete: {changed} changed chats.");
                        self.report = Some(report);
                    }
                    Err(error) => self.status = error,
                }
            }
            Err(mpsc::TryRecvError::Empty) => ctx.request_repaint(),
            Err(mpsc::TryRecvError::Disconnected) => {
                self.compare_rx = None;
                self.status = "The comparison worker stopped unexpectedly.".to_owned();
            }
        }
    }

    fn export_report(&mut self) {
        let Some(report) = &self.report else {
            return;
        };
        let Some(path) = rfd::FileDialog::new()
            .set_file_name("aibackdiff-report.json")
            .add_filter("JSON report", &["json"])
            .save_file()
        else {
            return;
        };
        match serde_json::to_string_pretty(report)
            .context("failed to serialize report")
            .and_then(|data| fs::write(&path, data).context("failed to write report"))
        {
            Ok(()) => self.status = format!("Saved report to {}", path.display()),
            Err(error) => self.status = format!("{error:#}"),
        }
    }

    fn show_paths(&mut self, ui: &mut egui::Ui) {
        ui.label("Baseline source");
        ui.add(
            egui::TextEdit::singleline(&mut self.baseline_path)
                .desired_width(f32::INFINITY)
                .hint_text("SQLite database, Takeout JSON, or extracted Takeout directory"),
        );
        ui.horizontal(|ui| {
            if ui.button("Baseline folder...").clicked()
                && let Some(path) = Self::google_backups_dialog().pick_folder()
            {
                self.baseline_path = path.display().to_string();
            }
            if ui.button("Use aimode.db default").clicked() {
                self.baseline_path = default_aimode_database_path();
            }
        });
        ui.add_space(8.0);

        ui.label("Comparison source");
        ui.add(
            egui::TextEdit::singleline(&mut self.comparison_path)
                .desired_width(f32::INFINITY)
                .hint_text("SQLite database, Takeout JSON, or extracted Takeout directory"),
        );
        ui.horizontal(|ui| {
            if ui.button("Comparison folder...").clicked()
                && let Some(path) = Self::google_backups_dialog().pick_folder()
            {
                self.comparison_path = path.display().to_string();
            }
        });

        ui.horizontal(|ui| {
            let running = self.compare_rx.is_some();
            if ui
                .add_enabled(!running, egui::Button::new("Compare sources"))
                .clicked()
            {
                self.begin_compare();
            }
            if ui
                .add_enabled(
                    self.report.is_some(),
                    egui::Button::new("Export JSON report"),
                )
                .clicked()
            {
                self.export_report();
            }
            if running {
                ui.spinner();
            }
            ui.label(&self.status);
        });
    }

    fn show_summary(&self, ui: &mut egui::Ui, summary: &Summary) {
        ui.horizontal_wrapped(|ui| {
            summary_badge(ui, "Baseline chats", summary.baseline_chats, Color32::GRAY);
            summary_badge(
                ui,
                "Comparison chats",
                summary.comparison_chats,
                Color32::GRAY,
            );
            summary_badge(ui, "In both", summary.chats_in_both, Color32::GRAY);
            summary_badge(
                ui,
                "Added chats",
                summary.added_chats,
                ChangeKind::AddedChat.color(),
            );
            summary_badge(
                ui,
                "Missing chats",
                summary.missing_chats,
                ChangeKind::MissingChat.color(),
            );
            summary_badge(
                ui,
                "Chats with new messages",
                summary.chats_with_new_messages,
                ChangeKind::MessagesAdded.color(),
            );
            summary_badge(
                ui,
                "Chats with missing messages",
                summary.chats_with_missing_messages,
                ChangeKind::MessagesMissing.color(),
            );
            summary_badge(
                ui,
                "Chats with modified messages",
                summary.chats_with_modified_messages,
                ChangeKind::MessagesChanged.color(),
            );
        });
    }

    fn show_results(&mut self, ui: &mut egui::Ui) {
        let Some(report) = &self.report else {
            ui.centered_and_justified(|ui| {
                ui.label("No comparison report yet.");
            });
            return;
        };

        self.show_summary(ui, &report.summary);
        ui.separator();
        ui.horizontal(|ui| {
            egui::ComboBox::from_id_salt("filter")
                .selected_text(self.filter.label())
                .show_ui(ui, |ui| {
                    for filter in [
                        Filter::AllChanges,
                        Filter::AddedChats,
                        Filter::MissingChats,
                        Filter::NewMessages,
                        Filter::MissingMessages,
                        Filter::ModifiedMessages,
                        Filter::Unchanged,
                    ] {
                        ui.selectable_value(&mut self.filter, filter, filter.label());
                    }
                });
            ui.add(
                egui::TextEdit::singleline(&mut self.search)
                    .hint_text("Search chat titles")
                    .desired_width(300.0),
            );
        });
        ui.separator();

        let search = self.search.to_lowercase();
        let visible: Vec<usize> = report
            .changes
            .iter()
            .enumerate()
            .filter(|(_, change)| self.filter.includes(change.kind))
            .filter(|(_, change)| {
                search.is_empty() || change.title.to_lowercase().contains(&search)
            })
            .map(|(index, _)| index)
            .collect();

        ui.columns(2, |columns| {
            egui::ScrollArea::vertical()
                .id_salt("chat-list")
                .show(&mut columns[0], |ui| {
                    for index in visible {
                        let change = &report.changes[index];
                        let selected = self.selected == Some(index);
                        let label = format!(
                            "{}  {}  ({} -> {}){}",
                            change.kind.label(),
                            change.title,
                            change.baseline_messages,
                            change.comparison_messages,
                            change_preview(
                                change,
                                &report.baseline_label,
                                &report.comparison_label
                            )
                        );
                        if ui
                            .selectable_label(
                                selected,
                                RichText::new(label).color(change.kind.color()),
                            )
                            .clicked()
                        {
                            self.selected = Some(index);
                        }
                    }
                });

            egui::ScrollArea::vertical()
                .id_salt("chat-detail")
                .show(&mut columns[1], |ui| {
                    let Some(index) = self.selected else {
                        ui.label("Select a chat to inspect its message changes.");
                        return;
                    };
                    let Some(change) = report.changes.get(index) else {
                        return;
                    };
                    show_change_detail(
                        ui,
                        change,
                        &report.baseline_label,
                        &report.comparison_label,
                    );
                });
        });
    }
}

impl eframe::App for AiBackdiffApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_compare(ctx);
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("AIBackdiff");
            ui.label("Compare AI archive databases and official backups.");
            ui.add_space(8.0);
            self.show_paths(ui);
            ui.separator();
            self.show_results(ui);
        });
    }
}

fn summary_badge(ui: &mut egui::Ui, label: &str, value: usize, color: Color32) {
    egui::Frame::group(ui.style()).show(ui, |ui| {
        ui.vertical(|ui| {
            ui.label(RichText::new(value.to_string()).strong().color(color));
            ui.small(label);
        });
    });
}

fn change_preview(change: &ChatChange, baseline_label: &str, comparison_label: &str) -> String {
    if let Some(message) = change.modified_messages.first() {
        return format!(
            "  | modified #{} {}: {} \"{}\" / {} \"{}\"",
            message.position,
            message.role,
            baseline_label,
            short_text(&message.baseline_content, 42),
            comparison_label,
            short_text(&message.comparison_content, 42)
        );
    }
    if let Some(message) = change.added_messages.first() {
        return format!(
            "  | first new #{} {}: \"{}\"",
            message.position,
            message.role,
            short_text(&message.content, 55)
        );
    }
    if let Some(message) = change.removed_messages.first() {
        return format!(
            "  | first missing #{} {}: \"{}\"",
            message.position,
            message.role,
            short_text(&message.content, 55)
        );
    }
    String::new()
}

fn short_text(value: &str, max_chars: usize) -> String {
    let normalized = comparison_content(value);
    let mut characters = normalized.chars();
    let preview: String = characters.by_ref().take(max_chars).collect();
    if characters.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

fn show_change_detail(
    ui: &mut egui::Ui,
    change: &ChatChange,
    baseline_label: &str,
    comparison_label: &str,
) {
    ui.heading(&change.title);
    ui.label(RichText::new(change.kind.label()).color(change.kind.color()));
    ui.label(format!(
        "Messages: {} {} -> {} {}",
        baseline_label, change.baseline_messages, comparison_label, change.comparison_messages
    ));
    if let Some(score) = change.match_score {
        ui.small(format!("Conservative match score: {score}"));
    }
    if change.baseline_messages == change.comparison_messages
        && !change.modified_messages.is_empty()
    {
        ui.small(
            "The message count is equal, but one or more message strings differ at the same positions.",
        );
    }
    if !change.added_messages.is_empty() {
        ui.separator();
        ui.strong(
            RichText::new(format!("Added in {comparison_label}"))
                .color(ChangeKind::MessagesAdded.color()),
        );
        for message in &change.added_messages {
            message_card(ui, "+", message, ChangeKind::MessagesAdded.color());
        }
    }
    if !change.removed_messages.is_empty() {
        ui.separator();
        ui.strong(
            RichText::new(format!(
                "Present in {baseline_label}, missing from {comparison_label}"
            ))
            .color(ChangeKind::MessagesMissing.color()),
        );
        for message in &change.removed_messages {
            message_card(ui, "-", message, ChangeKind::MessagesMissing.color());
        }
    }
    if !change.modified_messages.is_empty() {
        ui.separator();
        ui.strong(
            RichText::new("Same message position, different content")
                .color(ChangeKind::MessagesChanged.color()),
        );
        for message in &change.modified_messages {
            modified_message_card(ui, message, baseline_label, comparison_label);
        }
    }
    if change.kind == ChangeKind::Unchanged {
        ui.separator();
        ui.label("The normalized user and assistant message sequences are identical.");
    }
}

fn modified_message_card(
    ui: &mut egui::Ui,
    message: &ModifiedMessage,
    baseline_label: &str,
    comparison_label: &str,
) {
    egui::Frame::group(ui.style()).show(ui, |ui| {
        ui.label(
            RichText::new(format!("#{} {} modified", message.position, message.role))
                .strong()
                .color(ChangeKind::MessagesChanged.color()),
        );
        ui.strong(baseline_label);
        ui.label(&message.baseline_content);
        ui.strong(comparison_label);
        ui.label(&message.comparison_content);
    });
    ui.add_space(4.0);
}

fn message_card(ui: &mut egui::Ui, marker: &str, message: &MessageChange, color: Color32) {
    egui::Frame::group(ui.style()).show(ui, |ui| {
        ui.label(
            RichText::new(format!("{marker} #{} {}", message.position, message.role))
                .strong()
                .color(color),
        );
        ui.label(&message.content);
    });
    ui.add_space(4.0);
}

struct LoadedSource {
    label: String,
    chats: Vec<Chat>,
}

fn compare_paths(baseline_path: &Path, comparison_path: &Path) -> Result<Report> {
    let baseline = load_source(baseline_path)?;
    let comparison = load_source(comparison_path)?;
    Ok(build_report(
        baseline.chats,
        comparison.chats,
        baseline.label,
        comparison.label,
    ))
}

fn load_source(path: &Path) -> Result<LoadedSource> {
    if !path.exists() {
        bail!("Source path not found: {}", path.display());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("source");
    if is_sqlite_file(path)? {
        return Ok(LoadedSource {
            label: format!("Database ({name})"),
            chats: load_database(path)?,
        });
    }
    Ok(LoadedSource {
        label: format!("Takeout ({name})"),
        chats: load_takeout(path)?,
    })
}

fn is_sqlite_file(path: &Path) -> Result<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    let bytes = fs::read(path).with_context(|| format!("failed to inspect {}", path.display()))?;
    Ok(bytes.starts_with(b"SQLite format 3\0"))
}

fn load_database(path: &Path) -> Result<Vec<Chat>> {
    if !path.is_file() {
        bail!("Database file not found: {}", path.display());
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("failed to open database {}", path.display()))?;
    let mut conversations = connection.prepare(
        "SELECT id, COALESCE(title, ''), COALESCE(created_at, updated_at, 0)
         FROM conversations
         ORDER BY COALESCE(updated_at, created_at, 0), title, id",
    )?;
    let mut messages = connection.prepare(
        "SELECT role, content
         FROM messages
         WHERE conversation_id = ?1 AND role IN ('user', 'assistant')
         ORDER BY created_at, id",
    )?;

    let rows = conversations.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, f64>(2)?,
        ))
    })?;
    let mut chats = Vec::new();
    for row in rows {
        let (id, title, created_at) = row?;
        let message_rows = messages.query_map([&id], |row| {
            Ok(Message {
                role: row.get(0)?,
                content: normalize_content(&row.get::<_, String>(1)?),
            })
        })?;
        let collected: Vec<Message> = message_rows
            .filter_map(|row| row.ok())
            .filter(|message| !message.content.is_empty())
            .collect();
        chats.push(Chat {
            id,
            title: normalize_title(&title),
            created_at,
            messages: collected,
        });
    }
    Ok(chats)
}

fn load_takeout(path: &Path) -> Result<Vec<Chat>> {
    if !path.exists() {
        bail!("Takeout path not found: {}", path.display());
    }
    let mut files = Vec::new();
    collect_json_files(path, &mut files)?;
    if files.is_empty() {
        bail!("No JSON files found under {}", path.display());
    }

    let mut chats = Vec::new();
    for file in files {
        let raw = fs::read_to_string(&file)
            .with_context(|| format!("failed to read {}", file.display()))?;
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(entries) = value.as_array() else {
            continue;
        };
        for (entry_index, entry) in entries.iter().enumerate() {
            let header = entry.get("header").and_then(Value::as_str).unwrap_or("");
            if !header.is_empty() && header != "AI Mode" {
                continue;
            }
            let html = entry
                .get("safeHtmlItem")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("html"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let messages = extract_turns(html);
            if messages.is_empty() {
                continue;
            }
            let title = entry
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("AI Mode Chat");
            let time = entry.get("time").and_then(Value::as_str).unwrap_or("");
            chats.push(Chat {
                id: format!("{}:{entry_index}", file.display()),
                title: normalize_title(title),
                created_at: parse_iso_timestamp(time),
                messages,
            });
        }
    }
    if chats.is_empty() {
        bail!(
            "No AI Mode conversations could be parsed from {}",
            path.display()
        );
    }
    Ok(chats)
}

fn collect_json_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    if path.is_file() {
        files.push(path.to_owned());
        return Ok(());
    }
    for entry in fs::read_dir(path).with_context(|| format!("failed to read {}", path.display()))? {
        let entry = entry?;
        let child = entry.path();
        if child.is_dir() {
            collect_json_files(&child, files)?;
        } else if child.extension().and_then(|value| value.to_str()) == Some("json") {
            files.push(child);
        }
    }
    Ok(())
}

fn extract_turns(html: &str) -> Vec<Message> {
    let with_breaks = BREAK_TAGS.replace_all(html, "\n");
    let without_tags = ALL_TAGS.replace_all(&with_breaks, "");
    let plain = html_escape::decode_html_entities(&without_tags);
    let markers: Vec<_> = TURN_MARKERS.find_iter(&plain).collect();
    markers
        .iter()
        .enumerate()
        .filter_map(|(index, marker)| {
            let content_start = marker.end();
            let content_end = markers
                .get(index + 1)
                .map(|next| next.start())
                .unwrap_or(plain.len());
            let content = normalize_content(&plain[content_start..content_end]);
            if content.is_empty() {
                return None;
            }
            Some(Message {
                role: if marker.as_str().starts_with("Your prompt:") {
                    "user".to_owned()
                } else {
                    "assistant".to_owned()
                },
                content,
            })
        })
        .collect()
}

fn normalize_content(value: &str) -> String {
    let value = value.replace('\u{00a0}', " ").replace('\r', "");
    let value = WHITESPACE.replace_all(&value, "\n");
    EXTRA_NEWLINES.replace_all(&value, "\n\n").trim().to_owned()
}

fn normalize_title(value: &str) -> String {
    let title = TITLE_SPACES.replace_all(value, " ").trim().to_owned();
    let title = title
        .strip_prefix("Searched for ")
        .unwrap_or(&title)
        .trim()
        .to_owned();
    if title.is_empty() {
        "AI Mode Chat".to_owned()
    } else {
        title
    }
}

fn parse_iso_timestamp(value: &str) -> f64 {
    let Some(date_and_time) = value.strip_suffix('Z') else {
        return 0.0;
    };
    let Some((date, time)) = date_and_time.split_once('T') else {
        return 0.0;
    };
    let mut date_parts = date.split('-').filter_map(|part| part.parse::<i64>().ok());
    let (Some(year), Some(month), Some(day)) =
        (date_parts.next(), date_parts.next(), date_parts.next())
    else {
        return 0.0;
    };
    let time = time.split('.').next().unwrap_or(time);
    let mut time_parts = time.split(':').filter_map(|part| part.parse::<i64>().ok());
    let (Some(hour), Some(minute), Some(second)) =
        (time_parts.next(), time_parts.next(), time_parts.next())
    else {
        return 0.0;
    };
    let days = days_from_civil(year, month, day);
    (days * 86_400 + hour * 3_600 + minute * 60 + second) as f64
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn build_report(
    baseline: Vec<Chat>,
    comparison: Vec<Chat>,
    baseline_label: String,
    comparison_label: String,
) -> Report {
    let baseline_count = baseline.len();
    let comparison_count = comparison.len();
    let mut matched_db = HashSet::new();
    let mut matched_takeout = HashSet::new();
    let mut matches = Vec::new();

    let mut exact_buckets: HashMap<Vec<(String, String)>, Vec<usize>> = HashMap::new();
    for (index, chat) in baseline.iter().enumerate() {
        exact_buckets
            .entry(comparison_transcript(&chat.messages))
            .or_default()
            .push(index);
    }
    for (takeout_index, chat) in comparison.iter().enumerate() {
        let transcript = comparison_transcript(&chat.messages);
        let Some(candidates) = exact_buckets.get(&transcript) else {
            continue;
        };
        let Some(&database_index) = candidates.iter().find(|index| !matched_db.contains(*index))
        else {
            continue;
        };
        matched_db.insert(database_index);
        matched_takeout.insert(takeout_index);
        matches.push((database_index, takeout_index, None));
    }

    let mut candidates = Vec::new();
    for (database_index, database_chat) in baseline.iter().enumerate() {
        if matched_db.contains(&database_index) {
            continue;
        }
        for (takeout_index, takeout_chat) in comparison.iter().enumerate() {
            if matched_takeout.contains(&takeout_index) {
                continue;
            }
            if let Some(score) = match_score(database_chat, takeout_chat) {
                candidates.push((
                    score,
                    (database_chat.created_at - takeout_chat.created_at).abs() as i64,
                    database_index,
                    takeout_index,
                ));
            }
        }
    }
    candidates.sort_by_key(|(score, delta, _, _)| (-score, *delta));
    for (score, _, database_index, takeout_index) in candidates {
        if matched_db.contains(&database_index) || matched_takeout.contains(&takeout_index) {
            continue;
        }
        matched_db.insert(database_index);
        matched_takeout.insert(takeout_index);
        matches.push((database_index, takeout_index, Some(score)));
    }

    let mut changes = Vec::new();
    for (database_index, takeout_index, score) in matches {
        let database_chat = &baseline[database_index];
        let takeout_chat = &comparison[takeout_index];
        let (added_messages, removed_messages, modified_messages) =
            message_diff(&database_chat.messages, &takeout_chat.messages);
        let kind = match (
            added_messages.is_empty(),
            removed_messages.is_empty(),
            modified_messages.is_empty(),
        ) {
            (true, true, true) => ChangeKind::Unchanged,
            (false, true, true) => ChangeKind::MessagesAdded,
            (true, false, true) => ChangeKind::MessagesMissing,
            _ => ChangeKind::MessagesChanged,
        };
        changes.push(ChatChange {
            kind,
            title: takeout_chat.title.clone(),
            baseline_id: Some(database_chat.id.clone()),
            comparison_id: Some(takeout_chat.id.clone()),
            baseline_messages: database_chat.messages.len(),
            comparison_messages: takeout_chat.messages.len(),
            match_score: score,
            added_messages,
            removed_messages,
            modified_messages,
        });
    }
    for (index, chat) in comparison.iter().enumerate() {
        if !matched_takeout.contains(&index) {
            changes.push(ChatChange {
                kind: ChangeKind::AddedChat,
                title: chat.title.clone(),
                baseline_id: None,
                comparison_id: Some(chat.id.clone()),
                baseline_messages: 0,
                comparison_messages: chat.messages.len(),
                match_score: None,
                added_messages: all_message_changes(&chat.messages),
                removed_messages: Vec::new(),
                modified_messages: Vec::new(),
            });
        }
    }
    for (index, chat) in baseline.iter().enumerate() {
        if !matched_db.contains(&index) {
            changes.push(ChatChange {
                kind: ChangeKind::MissingChat,
                title: chat.title.clone(),
                baseline_id: Some(chat.id.clone()),
                comparison_id: None,
                baseline_messages: chat.messages.len(),
                comparison_messages: 0,
                match_score: None,
                added_messages: Vec::new(),
                removed_messages: all_message_changes(&chat.messages),
                modified_messages: Vec::new(),
            });
        }
    }
    changes.sort_by(|left, right| {
        change_order(left.kind)
            .cmp(&change_order(right.kind))
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
    });

    let summary = Summary {
        baseline_chats: baseline_count,
        comparison_chats: comparison_count,
        chats_in_both: changes
            .iter()
            .filter(|change| {
                !matches!(change.kind, ChangeKind::AddedChat | ChangeKind::MissingChat)
            })
            .count(),
        unchanged_chats: changes
            .iter()
            .filter(|change| change.kind == ChangeKind::Unchanged)
            .count(),
        added_chats: changes
            .iter()
            .filter(|change| change.kind == ChangeKind::AddedChat)
            .count(),
        missing_chats: changes
            .iter()
            .filter(|change| change.kind == ChangeKind::MissingChat)
            .count(),
        chats_with_new_messages: changes
            .iter()
            .filter(|change| change.kind == ChangeKind::MessagesAdded)
            .count(),
        chats_with_missing_messages: changes
            .iter()
            .filter(|change| change.kind == ChangeKind::MessagesMissing)
            .count(),
        chats_with_modified_messages: changes
            .iter()
            .filter(|change| change.kind == ChangeKind::MessagesChanged)
            .count(),
        added_messages: changes
            .iter()
            .map(|change| change.added_messages.len())
            .sum(),
        removed_messages: changes
            .iter()
            .map(|change| change.removed_messages.len())
            .sum(),
    };
    Report {
        baseline_label,
        comparison_label,
        summary,
        changes,
    }
}

fn match_score(database: &Chat, takeout: &Chat) -> Option<i32> {
    let same_title = database.title.eq_ignore_ascii_case(&takeout.title);
    let database_user = first_role(database, "user");
    let takeout_user = first_role(takeout, "user");
    let same_user = !database_user.is_empty()
        && comparison_content(database_user) == comparison_content(takeout_user);
    let delta = (database.created_at - takeout.created_at).abs();
    if !(same_user || same_title && delta <= 604_800.0) {
        return None;
    }

    let mut score = 0;
    if same_title {
        score += 45;
    }
    if same_user {
        score += 35;
    }
    let database_assistant = first_role(database, "assistant");
    let takeout_assistant = first_role(takeout, "assistant");
    if !database_assistant.is_empty()
        && comparison_content(database_assistant) == comparison_content(takeout_assistant)
    {
        score += 10;
    }
    if database.messages.len() == takeout.messages.len() {
        score += 5;
    }
    score += if delta <= 60.0 {
        25
    } else if delta <= 3_600.0 {
        15
    } else if delta <= 86_400.0 {
        8
    } else if delta <= 604_800.0 {
        3
    } else {
        0
    };
    (score >= 45).then_some(score)
}

fn first_role<'a>(chat: &'a Chat, role: &str) -> &'a str {
    chat.messages
        .iter()
        .find(|message| message.role == role)
        .map(|message| message.content.as_str())
        .unwrap_or("")
}

fn comparison_content(value: &str) -> String {
    TITLE_SPACES.replace_all(value, " ").trim().to_owned()
}

fn messages_equal(left: &Message, right: &Message) -> bool {
    left.role == right.role
        && comparison_content(&left.content) == comparison_content(&right.content)
}

fn comparison_transcript(messages: &[Message]) -> Vec<(String, String)> {
    messages
        .iter()
        .map(|message| (message.role.clone(), comparison_content(&message.content)))
        .collect()
}

fn message_diff(
    database: &[Message],
    takeout: &[Message],
) -> (Vec<MessageChange>, Vec<MessageChange>, Vec<ModifiedMessage>) {
    if database.len() == takeout.len() {
        let modified = database
            .iter()
            .zip(takeout)
            .enumerate()
            .filter(|(_, (database_message, takeout_message))| {
                !messages_equal(database_message, takeout_message)
            })
            .map(
                |(index, (database_message, takeout_message))| ModifiedMessage {
                    position: index + 1,
                    role: if database_message.role == takeout_message.role {
                        database_message.role.clone()
                    } else {
                        format!("{} -> {}", database_message.role, takeout_message.role)
                    },
                    baseline_content: database_message.content.clone(),
                    comparison_content: takeout_message.content.clone(),
                },
            )
            .collect();
        return (Vec::new(), Vec::new(), modified);
    }

    let rows = database.len() + 1;
    let columns = takeout.len() + 1;
    let mut lcs = vec![0usize; rows * columns];
    for database_index in (0..database.len()).rev() {
        for takeout_index in (0..takeout.len()).rev() {
            let cell = database_index * columns + takeout_index;
            lcs[cell] = if messages_equal(&database[database_index], &takeout[takeout_index]) {
                1 + lcs[(database_index + 1) * columns + takeout_index + 1]
            } else {
                lcs[(database_index + 1) * columns + takeout_index]
                    .max(lcs[database_index * columns + takeout_index + 1])
            };
        }
    }

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let (mut database_index, mut takeout_index) = (0, 0);
    while database_index < database.len() && takeout_index < takeout.len() {
        if messages_equal(&database[database_index], &takeout[takeout_index]) {
            database_index += 1;
            takeout_index += 1;
        } else if lcs[database_index * columns + takeout_index + 1]
            >= lcs[(database_index + 1) * columns + takeout_index]
        {
            added.push(to_message_change(takeout_index, &takeout[takeout_index]));
            takeout_index += 1;
        } else {
            removed.push(to_message_change(database_index, &database[database_index]));
            database_index += 1;
        }
    }
    while takeout_index < takeout.len() {
        added.push(to_message_change(takeout_index, &takeout[takeout_index]));
        takeout_index += 1;
    }
    while database_index < database.len() {
        removed.push(to_message_change(database_index, &database[database_index]));
        database_index += 1;
    }
    (added, removed, Vec::new())
}

fn all_message_changes(messages: &[Message]) -> Vec<MessageChange> {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| to_message_change(index, message))
        .collect()
}

fn to_message_change(index: usize, message: &Message) -> MessageChange {
    MessageChange {
        position: index + 1,
        role: message.role.clone(),
        content: message.content.clone(),
    }
}

fn change_order(kind: ChangeKind) -> usize {
    match kind {
        ChangeKind::AddedChat => 0,
        ChangeKind::MissingChat => 1,
        ChangeKind::MessagesAdded => 2,
        ChangeKind::MessagesMissing => 3,
        ChangeKind::MessagesChanged => 4,
        ChangeKind::Unchanged => 5,
    }
}

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("AIBackdiff")
            .with_inner_size([1280.0, 820.0])
            .with_min_inner_size([900.0, 600.0]),
        ..Default::default()
    };
    eframe::run_native(
        "AIBackdiff",
        options,
        Box::new(|_| Ok(Box::<AiBackdiffApp>::default())),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> Message {
        Message {
            role: role.to_owned(),
            content: content.to_owned(),
        }
    }

    #[test]
    fn extracts_takeout_turns() {
        let messages =
            extract_turns("<p>Your prompt: Hello &amp; hi</p><p>Search's response: Answer</p>");
        assert_eq!(
            messages,
            vec![
                message("user", "Hello & hi"),
                message("assistant", "Answer")
            ]
        );
    }

    #[test]
    fn message_diff_finds_insertions_and_removals() {
        let database = vec![
            message("user", "one"),
            message("assistant", "old"),
            message("user", "three"),
        ];
        let takeout = vec![
            message("user", "one"),
            message("assistant", "new"),
            message("user", "three"),
            message("assistant", "four"),
        ];
        let (added, removed, modified) = message_diff(&database, &takeout);
        assert_eq!(added.len(), 2);
        assert_eq!(added[0].content, "new");
        assert_eq!(added[1].content, "four");
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].content, "old");
        assert!(modified.is_empty());
    }

    #[test]
    fn normalizes_takeout_titles_and_content() {
        assert_eq!(normalize_title(" Searched for  test   chat "), "test chat");
        assert_eq!(normalize_content("line  \r\n\n\nnext"), "line\n\nnext");
    }

    #[test]
    fn report_classifies_added_removed_and_updated_chats() {
        let database = vec![
            Chat {
                id: "changed".to_owned(),
                title: "Changed".to_owned(),
                created_at: 100.0,
                messages: vec![message("user", "start"), message("assistant", "old")],
            },
            Chat {
                id: "removed".to_owned(),
                title: "Removed".to_owned(),
                created_at: 200.0,
                messages: vec![message("user", "gone")],
            },
        ];
        let takeout = vec![
            Chat {
                id: "changed-takeout".to_owned(),
                title: "Changed".to_owned(),
                created_at: 100.0,
                messages: vec![
                    message("user", "start"),
                    message("assistant", "old"),
                    message("user", "new"),
                ],
            },
            Chat {
                id: "added".to_owned(),
                title: "Added".to_owned(),
                created_at: 300.0,
                messages: vec![message("user", "new chat")],
            },
        ];

        let report = build_report(
            database,
            takeout,
            "Database".to_owned(),
            "Takeout".to_owned(),
        );
        assert_eq!(report.summary.added_chats, 1);
        assert_eq!(report.summary.missing_chats, 1);
        assert_eq!(report.summary.chats_with_new_messages, 1);
        assert_eq!(report.summary.added_messages, 2);
        assert_eq!(report.summary.removed_messages, 1);
    }

    #[test]
    fn title_only_match_requires_a_close_timestamp() {
        let database = Chat {
            id: "db".to_owned(),
            title: "Repeated title".to_owned(),
            created_at: 0.0,
            messages: vec![message("user", "first")],
        };
        let takeout = Chat {
            id: "takeout".to_owned(),
            title: "Repeated title".to_owned(),
            created_at: 700_000.0,
            messages: vec![message("user", "different")],
        };
        assert_eq!(match_score(&database, &takeout), None);
    }

    #[test]
    fn whitespace_only_message_differences_are_unchanged() {
        let database = vec![message("assistant", "one\n\ntwo")];
        let takeout = vec![message("assistant", "one two")];
        let (added, missing, modified) = message_diff(&database, &takeout);
        assert!(added.is_empty());
        assert!(missing.is_empty());
        assert!(modified.is_empty());
    }

    #[test]
    fn equal_length_content_differences_are_modified_not_new() {
        let database = vec![message("assistant", "old wording")];
        let takeout = vec![message("assistant", "new wording")];
        let (added, missing, modified) = message_diff(&database, &takeout);
        assert!(added.is_empty());
        assert!(missing.is_empty());
        assert_eq!(modified.len(), 1);
    }

    #[test]
    fn compares_two_takeout_backups() {
        let unique = format!(
            "aibackdiff-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let baseline_path = env::temp_dir().join(format!("{unique}-baseline.json"));
        let comparison_path = env::temp_dir().join(format!("{unique}-comparison.json"));
        fs::write(
            &baseline_path,
            r#"[{"header":"AI Mode","title":"Test","time":"2026-01-01T00:00:00Z","safeHtmlItem":[{"html":"Your prompt: hello Search's response: first"}]}]"#,
        )
        .unwrap();
        fs::write(
            &comparison_path,
            r#"[{"header":"AI Mode","title":"Test","time":"2026-01-01T00:00:00Z","safeHtmlItem":[{"html":"Your prompt: hello Search's response: first Your prompt: next"}]}]"#,
        )
        .unwrap();

        let report = compare_paths(&baseline_path, &comparison_path).unwrap();
        assert!(report.baseline_label.starts_with("Takeout"));
        assert!(report.comparison_label.starts_with("Takeout"));
        assert_eq!(report.summary.chats_with_new_messages, 1);
        assert_eq!(report.summary.added_messages, 1);

        fs::remove_file(baseline_path).unwrap();
        fs::remove_file(comparison_path).unwrap();
    }
}
