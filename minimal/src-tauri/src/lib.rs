mod storage;

pub use storage::{
    Book, Chapter, DraftJournal, JournalEntry, Library, LibraryStore, StoreError, Version,
};

#[cfg(feature = "desktop")]
mod desktop {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };
    use tauri::{Emitter, Manager, State};
    use tauri_plugin_dialog::DialogExt;

    type StoreState = Mutex<LibraryStore>;
    struct ExitState(AtomicBool);

    fn locked<T>(
        state: State<'_, StoreState>,
        action: impl FnOnce(&LibraryStore) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let store = state.lock().map_err(|_| StoreError::new("LOCK_POISONED", "The library is busy after an internal error. Restart NEO Minimal to safely reopen it."))?;
        action(&store)
    }

    #[tauri::command]
    async fn load_library(state: State<'_, StoreState>) -> Result<Library, StoreError> {
        locked(state, LibraryStore::load_library)
    }

    #[tauri::command]
    async fn save_book(book: Book, state: State<'_, StoreState>) -> Result<Book, StoreError> {
        locked(state, |store| store.save_book(book))
    }

    #[tauri::command]
    async fn trash_book(id: String, state: State<'_, StoreState>) -> Result<(), StoreError> {
        locked(state, |store| store.trash_book(&id))
    }

    #[tauri::command]
    async fn list_versions(
        book_id: String,
        state: State<'_, StoreState>,
    ) -> Result<Vec<Version>, StoreError> {
        locked(state, |store| store.list_versions(&book_id))
    }

    #[tauri::command]
    async fn read_version(
        book_id: String,
        version_id: String,
        state: State<'_, StoreState>,
    ) -> Result<Book, StoreError> {
        locked(state, |store| store.read_version(&book_id, &version_id))
    }

    #[tauri::command]
    async fn read_draft_journal(
        state: State<'_, StoreState>,
    ) -> Result<Option<DraftJournal>, StoreError> {
        locked(state, LibraryStore::read_draft_journal)
    }

    #[tauri::command]
    async fn write_draft_journal(
        journal: DraftJournal,
        state: State<'_, StoreState>,
    ) -> Result<(), StoreError> {
        locked(state, |store| store.write_draft_journal(journal))
    }

    #[tauri::command]
    fn finish_exit(app: tauri::AppHandle, state: State<'_, ExitState>) {
        state.0.store(true, Ordering::SeqCst);
        app.exit(0);
    }

    #[tauri::command]
    async fn export_manuscript(
        app: tauri::AppHandle,
        title: String,
        content: String,
    ) -> Result<bool, StoreError> {
        if content.len() > 40 * 1024 * 1024 {
            return Err(StoreError::new(
                "INVALID_INPUT",
                "An export must be smaller than 40 MB.",
            ));
        }
        let safe_title: String = title
            .chars()
            .filter(|c| {
                !c.is_control()
                    && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            })
            .take(100)
            .collect();
        let stem = safe_title.trim().trim_matches('.');
        let filename = format!("{}.md", if stem.is_empty() { "Manuscript" } else { stem });
        tauri::async_runtime::spawn_blocking(move || {
            let chosen = app
                .dialog()
                .file()
                .set_title("Export manuscript")
                .set_file_name(filename)
                .add_filter("Markdown manuscript", &["md"])
                .blocking_save_file();
            let Some(chosen) = chosen else {
                return Ok(false);
            };
            let path = chosen.into_path().map_err(|e| {
                StoreError::new(
                    "INVALID_INPUT",
                    format!("This export location is not a local file: {e}"),
                )
            })?;
            storage::export_text(&path, &content)?;
            Ok(true)
        })
        .await
        .map_err(|e| StoreError::new("IO", format!("The export task could not finish: {e}")))?
    }

    pub fn run() {
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .menu(|app| {
                let menu = tauri::menu::Menu::default(app)?;
                #[cfg(target_os = "macos")]
                {
                    use tauri::menu::{AboutMetadata, MenuItem, PredefinedMenuItem, Submenu};
                    // macOS predefined Quit calls NSApplication terminate:
                    // directly, bypassing the asynchronous frontend save barrier.
                    let quit = MenuItem::with_id(
                        app,
                        "neo-quit",
                        "Quit NEO Minimal",
                        true,
                        Some("CmdOrCtrl+Q"),
                    )?;
                    let application = Submenu::with_items(
                        app,
                        "NEO Minimal",
                        true,
                        &[
                            &PredefinedMenuItem::about(
                                app,
                                None,
                                Some(AboutMetadata {
                                    name: Some("NEO Minimal".into()),
                                    version: Some(app.package_info().version.to_string()),
                                    ..Default::default()
                                }),
                            )?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::services(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::hide(app, None)?,
                            &PredefinedMenuItem::hide_others(app, None)?,
                            &PredefinedMenuItem::show_all(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &quit,
                        ],
                    )?;
                    menu.remove_at(0)?;
                    menu.insert(&application, 0)?;
                }
                Ok(menu)
            })
            .on_menu_event(|app, event| {
                if event.id().as_ref() == "neo-quit" {
                    let _ = app.emit("neo-request-exit", ());
                }
            })
            .setup(|app| {
                let root = match std::env::var_os("NEO_MINIMAL_DATA_DIR") {
                    Some(path) => std::path::PathBuf::from(path),
                    None => app.path().app_data_dir()?,
                };
                app.manage(Mutex::new(LibraryStore::open(root)?));
                app.manage(ExitState(AtomicBool::new(false)));
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                load_library,
                save_book,
                trash_book,
                list_versions,
                read_version,
                read_draft_journal,
                write_draft_journal,
                finish_exit,
                export_manuscript
            ])
            .build(tauri::generate_context!())
            .expect("NEO Minimal could not start")
            .run(|app, event| {
                if let tauri::RunEvent::ExitRequested { api, .. } = event {
                    let approved = app.state::<ExitState>().0.load(Ordering::SeqCst);
                    // The close button already passed the frontend save barrier if
                    // the last window has been destroyed. Cmd+Q still has a window.
                    if !approved && !app.webview_windows().is_empty() {
                        api.prevent_exit();
                        let _ = app.emit("neo-request-exit", ());
                    }
                }
            });
    }
}

#[cfg(feature = "desktop")]
pub use desktop::run;
