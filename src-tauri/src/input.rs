use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use std::sync::Mutex;
use crate::capture::get_screen_size;

pub struct EnigoState {
    pub enigo: Mutex<Enigo>,
}

impl EnigoState {
    pub fn new() -> Self {
        let enigo = Enigo::new(&Settings::default()).expect("Failed to initialize Enigo");
        Self {
            enigo: Mutex::new(enigo),
        }
    }
}

fn map_code_to_key(code: &str) -> Option<Key> {
    if code.starts_with("Key") && code.len() == 4 {
        let c = code.chars().nth(3)?.to_ascii_lowercase();
        return Some(Key::Unicode(c));
    }
    if code.starts_with("Digit") && code.len() == 6 {
        let c = code.chars().nth(5)?;
        return Some(Key::Unicode(c));
    }
    match code {
        "Space" => Some(Key::Space),
        "Enter" => Some(Key::Return),
        "Backspace" => Some(Key::Backspace),
        "Tab" => Some(Key::Tab),
        "Escape" => Some(Key::Escape),
        "Delete" => Some(Key::Delete),
        "Insert" => Some(Key::Insert),
        "Home" => Some(Key::Home),
        "End" => Some(Key::End),
        "PageUp" => Some(Key::PageUp),
        "PageDown" => Some(Key::PageDown),
        "ArrowUp" => Some(Key::UpArrow),
        "ArrowDown" => Some(Key::DownArrow),
        "ArrowLeft" => Some(Key::LeftArrow),
        "ArrowRight" => Some(Key::RightArrow),
        "ControlLeft" | "ControlRight" | "Control" => Some(Key::Control),
        "ShiftLeft" | "ShiftRight" | "Shift" => Some(Key::Shift),
        "AltLeft" | "AltRight" | "Alt" => Some(Key::Alt),
        "MetaLeft" | "MetaRight" | "Meta" => Some(Key::Meta),
        "F1" => Some(Key::F1),
        "F2" => Some(Key::F2),
        "F3" => Some(Key::F3),
        "F4" => Some(Key::F4),
        "F5" => Some(Key::F5),
        "F6" => Some(Key::F6),
        "F7" => Some(Key::F7),
        "F8" => Some(Key::F8),
        "F9" => Some(Key::F9),
        "F10" => Some(Key::F10),
        "F11" => Some(Key::F11),
        "F12" => Some(Key::F12),
        "Semicolon" => Some(Key::Unicode(';')),
        "Equal" => Some(Key::Unicode('=')),
        "Comma" => Some(Key::Unicode(',')),
        "Minus" => Some(Key::Unicode('-')),
        "Period" => Some(Key::Unicode('.')),
        "Slash" => Some(Key::Unicode('/')),
        "Backquote" => Some(Key::Unicode('`')),
        "BracketLeft" => Some(Key::Unicode('[')),
        "Backslash" => Some(Key::Unicode('\\')),
        "BracketRight" => Some(Key::Unicode(']')),
        "Quote" => Some(Key::Unicode('\'')),
        _ => {
            if code.len() == 1 {
                code.chars().next().map(Key::Unicode)
            } else {
                None
            }
        }
    }
}

#[tauri::command]
pub fn inject_mouse(
    state: tauri::State<'_, EnigoState>,
    x: f64,
    y: f64,
    event: String,
    button: String,
    delta: i32,
) -> Result<(), String> {
    let mut enigo = state.enigo.lock().map_err(|e| format!("Mutex lock error: {}", e))?;

    // Get screen dimensions to scale normalized 0.0 - 1.0 coordinates
    let (sw, sh) = get_screen_size()?;
    let px = (x * sw as f64).round() as i32;
    let py = (y * sh as f64).round() as i32;

    match event.as_str() {
        "move" => {
            enigo.move_mouse(px, py, Coordinate::Abs).map_err(|e| format!("Mouse move error: {:?}", e))?;
        }
        "down" | "up" => {
            let btn = match button.as_str() {
                "left" => Button::Left,
                "right" => Button::Right,
                "middle" => Button::Middle,
                _ => Button::Left,
            };
            let dir = if event == "down" {
                Direction::Press
            } else {
                Direction::Release
            };
            // Always sync cursor position first to ensure action occurs at target coordinate
            enigo.move_mouse(px, py, Coordinate::Abs).map_err(|e| format!("Mouse move error: {:?}", e))?;
            enigo.button(btn, dir).map_err(|e| format!("Mouse click error: {:?}", e))?;
        }
        "scroll" => {
            // Move cursor to position first
            enigo.move_mouse(px, py, Coordinate::Abs).map_err(|e| format!("Mouse move error: {:?}", e))?;
            // Standardize scrolling direction: delta > 0 is scroll down (negative in enigo), delta < 0 is scroll up
            let scroll_amount = if delta > 0 { -1 } else if delta < 0 { 1 } else { 0 };
            enigo.scroll(scroll_amount, Axis::Vertical).map_err(|e| format!("Mouse scroll error: {:?}", e))?;
        }
        _ => return Err(format!("Unsupported mouse event: {}", event)),
    }

    Ok(())
}

#[tauri::command]
pub fn inject_key(
    state: tauri::State<'_, EnigoState>,
    key: String,
    modifiers: Vec<String>,
    pressed: bool,
) -> Result<(), String> {
    let mut enigo = state.enigo.lock().map_err(|e| format!("Mutex lock error: {}", e))?;
    
    let target_key = match map_code_to_key(&key) {
        Some(k) => k,
        None => return Err(format!("Unknown key code: {}", key)),
    };

    let dir = if pressed {
        Direction::Press
    } else {
        Direction::Release
    };

    // If viewer specifies active modifiers, we press them, press/release the key, and release modifiers.
    // However, if the viewer sends independent keydown/keyup events for modifiers (which it does),
    // they are already simulated in real-time. But to support multi-key combos (like Ctrl+Alt+Del),
    // we can temporarily press active modifiers if they are sent in the modifiers list.
    let mut pressed_mods = Vec::new();
    if pressed {
        for modifier in &modifiers {
            let mod_key = match modifier.as_str() {
                "ctrl" | "control" => Some(Key::Control),
                "alt" => Some(Key::Alt),
                "shift" => Some(Key::Shift),
                "meta" => Some(Key::Meta),
                _ => None,
            };
            if let Some(mk) = mod_key {
                if enigo.key(mk, Direction::Press).is_ok() {
                    pressed_mods.push(mk);
                }
            }
        }
    }

    // Simulate the target key
    enigo.key(target_key, dir).map_err(|e| format!("Key event error: {:?}", e))?;

    // If we temporarily pressed modifiers, release them in reverse order
    if pressed {
        for mk in pressed_mods.into_iter().rev() {
            let _ = enigo.key(mk, Direction::Release);
        }
    }

    Ok(())
}
