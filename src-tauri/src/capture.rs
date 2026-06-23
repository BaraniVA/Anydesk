use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use image::codecs::jpeg::JpegEncoder;
use image::DynamicImage;
use screenshots::Screen;
use std::sync::Mutex;

static CACHED_SCREEN: Mutex<Option<Screen>> = Mutex::new(None);

fn get_primary_screen() -> Result<Screen, String> {
    let mut cache = CACHED_SCREEN.lock().map_err(|e| format!("Mutex lock error: {}", e))?;
    if cache.is_none() {
        let screens = Screen::all().map_err(|e| format!("Screen::all() error: {}", e))?;
        if screens.is_empty() {
            return Err("No screens detected".to_string());
        }
        *cache = Some(screens[0]);
    }
    Ok(cache.as_ref().unwrap().clone())
}

#[tauri::command]
pub fn capture_frame() -> Result<String, String> {
    let screen = get_primary_screen()?;
    let image = screen.capture().map_err(|e| format!("Screen::capture() error: {}", e))?;
    
    // Convert RGBA to RGB (JPEG doesn't support alpha channel)
    let mut dynamic_img = DynamicImage::ImageRgba8(image);
    
    // Resize if wider than 1280px to keep JPEG under WebRTC data channel
    // message size limits (~256KB). Preserves aspect ratio.
    let max_width = 1280;
    if dynamic_img.width() > max_width {
        dynamic_img = dynamic_img.resize(
            max_width,
            u32::MAX, // height auto-calculated from aspect ratio
            image::imageops::FilterType::Nearest, // fastest filter
        );
    }
    
    let rgb_img = dynamic_img.to_rgb8();
    
    // Encode to JPEG at quality 50 for fast streaming
    let mut jpeg_bytes = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 50);
    DynamicImage::ImageRgb8(rgb_img)
        .write_with_encoder(encoder)
        .map_err(|e| format!("JPEG encode error: {}", e))?;
        
    // Return base64 encoded JPEG bytes
    Ok(BASE64_STANDARD.encode(&jpeg_bytes))
}

#[tauri::command]
pub fn get_screen_size() -> Result<(u32, u32), String> {
    let screen = get_primary_screen()?;
    Ok((screen.display_info.width, screen.display_info.height))
}
