//! Browser build: renderer, presets and analysis compiled to wasm.
//! The page decodes and plays the track with Web Audio and calls `render` every
//! animation frame with the playback position; everything else runs here, on the
//! visitor's GPU through WebGPU.
//!
//! `gpu`, `analysis`, `presets` and `shaders/` are copies of the desktop app's
//! files, kept separate so the two versions don't depend on each other.

// The copied modules still carry desktop-only parts (export, NV12, shader files).
#![allow(dead_code, unused_imports)]

mod analysis;
mod gpu;
mod presets;

use analysis::Analysis;
use gpu::{FrameInfo, Gpu, Look, Motion, Nv12, Renderer, Uniforms};
use presets::{BUILTIN, Preset};
use wasm_bindgen::prelude::*;

/// Same analysis rate as the desktop preview.
const ANALYSIS_FPS: f64 = 60.0;

#[wasm_bindgen]
pub struct Viz {
    gpu: Gpu,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer,
    motion: Motion,
    track: Option<(Analysis, f64)>,
    look: Look,
    preset: usize,
    frame: u64,
    export: Option<Export>,
}

/// Offscreen render for video export: its own renderer at the export size, so the
/// preview keeps running, plus NV12 conversion and a ring of readback buffers.
struct Export {
    renderer: Renderer,
    nv12: Nv12,
    staging: Vec<wgpu::Buffer>,
    motion: Motion,
    /// Look captured at the start: slider moves don't change a running export.
    look: Look,
    size: (u32, u32),
}

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen]
impl Viz {
    /// Sets up WebGPU on the canvas. Fails when the browser has no WebGPU.
    pub async fn create(canvas: web_sys::HtmlCanvasElement) -> Result<Viz, JsValue> {
        console_error_panic_hook::set_once();
        let size = (canvas.width().max(1), canvas.height().max(1));
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor { backends: wgpu::Backends::BROWSER_WEBGPU, ..Default::default() });
        let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas)).map_err(js_err)?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .map_err(js_err)?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("audio-viz"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(js_err)?;
        let gpu = Gpu { adapter, device, queue };

        let caps = surface.get_capabilities(&gpu.adapter);
        // Non-sRGB target, as on desktop: the post shader outputs gamma-encoded color.
        let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.0,
            height: size.1,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        };
        surface.configure(&gpu.device, &config);
        let src = Preset::Builtin(0).source().map_err(js_err)?;
        let renderer = Renderer::new(&gpu, &src, format, size).map_err(js_err)?;
        Ok(Viz { gpu, surface, config, renderer, motion: Motion::default(), track: None, look: Look::default(), preset: 0, frame: 0, export: None })
    }

    /// Names of the built-in presets, in order.
    pub fn presets() -> Vec<String> {
        BUILTIN.iter().map(|(n, _)| n.to_string()).collect()
    }

    pub fn set_preset(&mut self, index: usize) -> Result<(), JsValue> {
        let src = Preset::Builtin(index % BUILTIN.len()).source().map_err(js_err)?;
        self.renderer.set_preset(&src).map_err(js_err)?;
        self.preset = index % BUILTIN.len();
        Ok(())
    }

    /// Analyses a decoded track (mono samples). Returns its duration in seconds.
    pub fn load(&mut self, mono: &[f32], sample_rate: u32) -> f64 {
        let analysis = analysis::analyze(mono, sample_rate, ANALYSIS_FPS);
        let duration = mono.len() as f64 / sample_rate as f64;
        self.track = Some((analysis, duration));
        self.motion = Motion::default();
        duration
    }

    /// Sets one look control by its name (the same names as the desktop options).
    pub fn set_look(&mut self, name: &str, value: f32) -> Result<(), JsValue> {
        let l = &mut self.look;
        let field = match name {
            "exposure" => &mut l.exposure,
            "saturation" => &mut l.saturation,
            "hue" => &mut l.hue,
            "hue_spin" => &mut l.hue_spin,
            "speed" => &mut l.speed,
            "reactivity" => &mut l.reactivity,
            "bloom" => &mut l.bloom,
            "vignette" => &mut l.vignette,
            "grain" => &mut l.grain,
            "aberration" => &mut l.aberration,
            "shake" => &mut l.shake,
            "punch" => &mut l.punch,
            "flash" => &mut l.flash,
            "glitch" => &mut l.glitch,
            "vhs" => &mut l.vhs,
            _ => return Err(JsValue::from_str(&format!("unknown look control '{name}'"))),
        };
        *field = value;
        Ok(())
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        let (w, h) = (width.max(1), height.max(1));
        if (w, h) == (self.config.width, self.config.height) {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.gpu.device, &self.config);
        self.renderer.resize((w, h));
    }

    /// Draws one frame. `t` is the track position in seconds (None without a track);
    /// `wall` is a free-running clock in seconds for the idle animation.
    pub fn render(&mut self, t: Option<f64>, wall: f64) {
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Outdated | wgpu::SurfaceError::Lost) => {
                self.surface.configure(&self.gpu.device, &self.config);
                return;
            }
            Err(_) => return,
        };
        let size = self.renderer.size();
        let look = self.look;
        let (u, frame_look, progress) = match (&self.track, t) {
            (Some((analysis, duration)), Some(t)) => {
                let f = self.motion.track(analysis, t, &|_| look);
                let progress = (t / duration) as f32;
                (Uniforms::new(&f, size, self.motion.time(), progress), look.at_time(t), progress)
            }
            _ => {
                let f = self.motion.idle(wall, &look);
                (Uniforms::new(&f, size, self.motion.time(), 0.0), look.at_time(wall), 0.0)
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let mut enc = self.gpu.device.create_command_encoder(&Default::default());
        let info = FrameInfo { frame: self.frame, fade: 1.0, progress, layers: &[], scene: None, blend: None };
        self.renderer.encode(&mut enc, &view, &u, &frame_look, &info);
        self.gpu.queue.submit([enc.finish()]);
        frame.present();
        self.frame += 1;
    }

    /// Prepares an export of `width`x`height` (width % 4 == 0, height % 2 == 0) with
    /// the current preset and look; `ring` readback buffers let frames overlap.
    /// Returns the size of one NV12 frame in bytes.
    pub fn export_start(&mut self, width: u32, height: u32, ring: usize) -> Result<u32, JsValue> {
        if self.track.is_none() {
            return Err(JsValue::from_str("no track loaded"));
        }
        if width % 4 != 0 || height % 2 != 0 {
            return Err(JsValue::from_str("export size must have width % 4 == 0 and height % 2 == 0"));
        }
        let size = (width, height);
        let src = Preset::Builtin(self.preset).source().map_err(js_err)?;
        let renderer = Renderer::new(&self.gpu, &src, gpu::OUTPUT, size).map_err(js_err)?;
        let nv12 = Nv12::new(&self.gpu.device, size);
        let bytes = Nv12::frame_bytes(size);
        let staging = (0..ring.max(1))
            .map(|_| {
                self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("readback"),
                    size: bytes,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            })
            .collect();
        self.export = Some(Export { renderer, nv12, staging, motion: Motion::default(), look: self.look, size });
        Ok(bytes as u32)
    }

    /// Renders export frame `index` at track time `t` into readback buffer `slot`.
    /// The promise resolves once the NV12 bytes can be read with `export_read`.
    pub fn export_frame(&mut self, index: u32, t: f64, slot: usize) -> Result<js_sys::Promise, JsValue> {
        let ex = self.export.as_mut().ok_or_else(|| JsValue::from_str("export not started"))?;
        let (analysis, duration) = self.track.as_ref().ok_or_else(|| JsValue::from_str("no track loaded"))?;
        let buf = ex.staging.get(slot).ok_or_else(|| JsValue::from_str("bad slot"))?;
        let look = ex.look;
        let f = ex.motion.track(analysis, t, &|_| look);
        let progress = (t / duration) as f32;
        let u = Uniforms::new(&f, ex.size, ex.motion.time(), progress);
        let info = FrameInfo { frame: index as u64, fade: 1.0, progress, layers: &[], scene: None, blend: None };
        let mut enc = self.gpu.device.create_command_encoder(&Default::default());
        ex.renderer.encode(&mut enc, &ex.nv12.view, &u, &look.at_time(t), &info);
        ex.nv12.encode(&mut enc);
        enc.copy_buffer_to_buffer(&ex.nv12.buffer, 0, buf, 0, Nv12::frame_bytes(ex.size));
        self.gpu.queue.submit([enc.finish()]);
        Ok(js_sys::Promise::new(&mut |resolve, reject| {
            buf.slice(..).map_async(wgpu::MapMode::Read, move |res| {
                let _ = match res {
                    Ok(()) => resolve.call0(&JsValue::NULL),
                    Err(e) => reject.call1(&JsValue::NULL, &JsValue::from_str(&e.to_string())),
                };
            });
        }))
    }

    /// Copies the mapped NV12 frame of `slot` into `out` and frees the slot.
    pub fn export_read(&mut self, slot: usize, out: &mut [u8]) -> Result<(), JsValue> {
        let ex = self.export.as_ref().ok_or_else(|| JsValue::from_str("export not started"))?;
        let buf = ex.staging.get(slot).ok_or_else(|| JsValue::from_str("bad slot"))?;
        {
            let data = buf.slice(..).get_mapped_range();
            if out.len() != data.len() {
                return Err(JsValue::from_str("output buffer has the wrong size"));
            }
            out.copy_from_slice(&data);
        }
        buf.unmap();
        Ok(())
    }

    /// Frees the export's GPU resources (after finishing or cancelling).
    pub fn export_end(&mut self) {
        self.export = None;
    }

    /// Adapter name, for the status line. Browsers often hide it for privacy.
    pub fn describe(&self) -> String {
        let info = self.gpu.adapter.get_info();
        if info.name.is_empty() { "WebGPU".into() } else { format!("{} (WebGPU)", info.name) }
    }
}
