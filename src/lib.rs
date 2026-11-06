//! Browser build: renderer, presets and analysis compiled to wasm.
//! The page decodes and plays the track with Web Audio and calls `render` every
//! animation frame with the playback position; everything else runs here, on the
//! visitor's GPU through WebGPU.
//!
//! The page owns what the browser does better (decoding, text rasterization with
//! any font, image decoding, encoding with WebCodecs); this module owns the look
//! over time (keyframes, scenes), audio-driven motion and every GPU pass.
//!
//! `gpu`, `analysis`, `presets`, `animation` and `shaders/` are copies of the desktop
//! app's files, kept separate so the two versions don't depend on each other.

// The copied modules still carry desktop-only parts (shader files, helpers).
#![allow(dead_code, unused_imports)]

mod analysis;
mod animation;
mod gpu;
mod presets;

use std::rc::Rc;

use analysis::Analysis;
use animation::Animation;
use gpu::{FrameInfo, Gpu, LAYER_SLOTS, Look, Motion, Nv12, Renderer, TextState, Uniforms};
use presets::{BUILTIN, Preset};
use wasm_bindgen::prelude::*;

/// Same analysis rate as the desktop preview.
const ANALYSIS_FPS: f64 = 60.0;
/// Floats per text-layer slot passed from the page: rect x0 y0 x1 y1, alpha, shift x y, wipe.
const LAYER_FLOATS: usize = 8;

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// Look control by its name (the same names as the desktop options); colors are
/// addressed per channel, e.g. `ring_color.1`.
fn look_field<'a>(l: &'a mut Look, name: &str) -> Option<&'a mut f32> {
    Some(match name {
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
        "bg_brightness" => &mut l.bg_brightness,
        "viz_opacity" => &mut l.viz_opacity,
        "bg_pulse" => &mut l.bg_pulse,
        "cover_size" => &mut l.cover_size,
        "cover_pulse" => &mut l.cover_pulse,
        "ring" => &mut l.ring,
        "shake" => &mut l.shake,
        "punch" => &mut l.punch,
        "flash" => &mut l.flash,
        "glitch" => &mut l.glitch,
        "vhs" => &mut l.vhs,
        "bar" => &mut l.bar,
        "ring_color.0" => &mut l.ring_color[0],
        "ring_color.1" => &mut l.ring_color[1],
        "ring_color.2" => &mut l.ring_color[2],
        "bar_color.0" => &mut l.bar_color[0],
        "bar_color.1" => &mut l.bar_color[1],
        "bar_color.2" => &mut l.bar_color[2],
        _ => return None,
    })
}

fn unknown(name: &str) -> JsValue {
    JsValue::from_str(&format!("unknown look control '{name}'"))
}

/// Text-layer slots from the page's flat array.
fn parse_layers(raw: &[f32]) -> Vec<TextState> {
    raw.chunks_exact(LAYER_FLOATS)
        .take(LAYER_SLOTS)
        .map(|c| TextState { rect: [c[0], c[1], c[2], c[3]], alpha: c[4], shift: [c[5], c[6]], wipe: c[7] })
        .collect()
}

fn rgba_image(rgba: &[u8], w: u32, h: u32) -> Result<image::RgbaImage, JsValue> {
    image::RgbaImage::from_raw(w, h, rgba.to_vec()).ok_or_else(|| JsValue::from_str("image bytes don't match its size"))
}

/// Everything that decides how a frame looks, apart from the track and the text
/// layer. Exports take a copy, so editing during an export doesn't change it.
#[derive(Clone)]
struct Project {
    look: Look,
    anim: Animation,
    /// Preset before the first scene.
    preset: usize,
    /// Scene starts (seconds) and their presets, sorted by time.
    scenes: Vec<(f64, usize)>,
    scene_fade: f64,
    background: Option<Rc<image::RgbaImage>>,
    cover: Option<Rc<image::RgbaImage>>,
    circle: bool,
}

impl Default for Project {
    fn default() -> Self {
        Project { look: Look::default(), anim: Animation::default(), preset: 0, scenes: vec![], scene_fade: 1.5, background: None, cover: None, circle: false }
    }
}

impl Project {
    fn look_at(&self, t: f64) -> Look {
        self.anim.at(&self.look, t)
    }

    /// Index of the scene playing at `t` (None = before the first one).
    fn scene_index(&self, t: f64) -> Option<usize> {
        self.scenes.partition_point(|(s, _)| *s <= t).checked_sub(1)
    }

    fn presets_used(&self) -> Vec<usize> {
        let mut v: Vec<usize> = std::iter::once(self.preset).chain(self.scenes.iter().map(|s| s.1)).collect();
        v.sort_unstable();
        v.dedup();
        v
    }
}

/// Serialized form of the GPU-side project (presets by name, so files survive
/// preset list changes). Images, texts and export settings are saved by the page.
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(default)]
struct ProjectData {
    look: Look,
    keys: Vec<(f64, Look)>,
    preset: String,
    scenes: Vec<(f64, String)>,
    scene_fade: f64,
    circle: bool,
}

fn preset_index(name: &str) -> usize {
    BUILTIN.iter().position(|(n, _)| *n == name).unwrap_or(0)
}

/// A renderer plus the pipeline id of each preset it has compiled.
struct Stage {
    renderer: Renderer,
    pipes: Vec<Option<usize>>,
}

impl Stage {
    fn new(gpu: &Gpu, format: wgpu::TextureFormat, size: (u32, u32), p: &Project) -> Result<Stage, JsValue> {
        let src = Preset::Builtin(p.preset).source().map_err(js_err)?;
        let renderer = Renderer::new(gpu, &src, format, size).map_err(js_err)?;
        let mut stage = Stage { renderer, pipes: vec![None; BUILTIN.len()] };
        stage.apply_images(p);
        for preset in p.presets_used() {
            stage.pipe(preset)?;
        }
        Ok(stage)
    }

    fn apply_images(&mut self, p: &Project) {
        self.renderer.set_background(p.background.as_deref());
        self.renderer.set_circle(p.circle, p.cover.as_deref());
    }

    /// Pipeline id of a preset, compiled on first use.
    fn pipe(&mut self, preset: usize) -> Result<usize, JsValue> {
        let preset = preset % BUILTIN.len();
        if let Some(id) = self.pipes[preset] {
            return Ok(id);
        }
        let src = Preset::Builtin(preset).source().map_err(js_err)?;
        let id = self.renderer.pipeline(&src).map_err(js_err)?;
        self.pipes[preset] = Some(id);
        Ok(id)
    }
}

type Track = Rc<(Analysis, f64)>;

/// Per-frame inputs from the page besides the time.
struct FrameArgs<'a> {
    frame: u64,
    fade: f32,
    /// Position for the progress bar, 0..1; None = through the whole track.
    progress: Option<f32>,
    layers: &'a [TextState],
}

/// Records one frame of `p` into `enc`, compositing into `out`.
fn encode_frame(
    stage: &mut Stage,
    motion: &mut Motion,
    p: &Project,
    track: Option<&Track>,
    t: Option<f64>,
    wall: f64,
    args: &FrameArgs,
    enc: &mut wgpu::CommandEncoder,
    out: &wgpu::TextureView,
) -> Result<(), JsValue> {
    let size = stage.renderer.size();
    let (u, look, progress, scene, blend) = match (track, t) {
        (Some(track), Some(t)) => {
            let (analysis, duration) = (&track.0, track.1);
            let f = motion.track(analysis, t, &|x| p.look_at(x));
            let progress = args.progress.unwrap_or((t / duration) as f32);
            let (from, to) = animation::scene_at(&p.preset, &p.scenes, t, p.scene_fade);
            let scene = Some(stage.pipe(*from)?);
            let blend = match to {
                Some((to, k)) => Some((stage.pipe(*to)?, k)),
                None => None,
            };
            (Uniforms::new(&f, size, motion.time(), progress), p.look_at(t).at_time(t), progress, scene, blend)
        }
        _ => {
            let f = motion.idle(wall, &p.look);
            let scene = Some(stage.pipe(p.preset)?);
            (Uniforms::new(&f, size, motion.time(), 0.0), p.look.at_time(wall), 0.0, scene, None)
        }
    };
    let info = FrameInfo { frame: args.frame, fade: args.fade, progress, layers: args.layers, scene, blend };
    stage.renderer.encode(enc, out, &u, &look, &info);
    Ok(())
}

/// Resolves a promise once `buf` is mapped for reading (or rejects on failure).
fn mapped(buf: &wgpu::Buffer, on_ready: impl FnOnce(&wgpu::Buffer) -> JsValue + 'static) -> js_sys::Promise {
    let b = buf.clone();
    let mut on_ready = Some(on_ready);
    js_sys::Promise::new(&mut |resolve, reject| {
        let b = b.clone();
        let on_ready = on_ready.take();
        buf.slice(..).map_async(wgpu::MapMode::Read, move |res| {
            let _ = match (res, on_ready) {
                (Ok(()), Some(f)) => resolve.call1(&JsValue::NULL, &f(&b)),
                (Ok(()), None) => resolve.call0(&JsValue::NULL),
                (Err(e), _) => reject.call1(&JsValue::NULL, &js_err(e)),
            };
        });
    })
}

/// Offscreen render for video export: its own renderer at the export size, so the
/// preview keeps its own, plus NV12 conversion and a ring of readback buffers.
struct Export {
    stage: Stage,
    nv12: Nv12,
    staging: Vec<wgpu::Buffer>,
    motion: Motion,
    project: Project,
    track: Track,
    size: (u32, u32),
}

#[wasm_bindgen]
pub struct Viz {
    gpu: Gpu,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    stage: Stage,
    motion: Motion,
    track: Option<Track>,
    project: Project,
    frame: u64,
    export: Option<Export>,
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
        let project = Project::default();
        let stage = Stage::new(&gpu, format, size, &project)?;
        Ok(Viz { gpu, surface, config, stage, motion: Motion::default(), track: None, project, frame: 0, export: None })
    }

    /// Names of the built-in presets, in order.
    pub fn presets() -> Vec<String> {
        BUILTIN.iter().map(|(n, _)| n.to_string()).collect()
    }

    /// Largest texture side the GPU allows (caps the export size).
    pub fn max_size(&self) -> u32 {
        self.gpu.device.limits().max_texture_dimension_2d
    }

    /// Analyses a decoded track (mono samples). Returns its duration in seconds.
    pub fn load(&mut self, mono: &[f32], sample_rate: u32) -> f64 {
        let analysis = analysis::analyze(mono, sample_rate, ANALYSIS_FPS);
        let duration = mono.len() as f64 / sample_rate as f64;
        self.track = Some(Rc::new((analysis, duration)));
        self.motion = Motion::default();
        duration
    }

    // ---- presets and scenes ----

    /// Sets the preset playing at `t`: the scene's own when `t` is inside a scene,
    /// otherwise the base preset. Compiles it now, so playback doesn't stutter later.
    pub fn set_preset(&mut self, index: usize, t: Option<f64>) -> Result<(), JsValue> {
        let index = index % BUILTIN.len();
        self.stage.pipe(index)?;
        match t.and_then(|t| self.project.scene_index(t)) {
            Some(i) => self.project.scenes[i].1 = index,
            None => self.project.preset = index,
        }
        Ok(())
    }

    /// Preset playing at `t` (the base one without `t`).
    pub fn preset_at(&self, t: Option<f64>) -> usize {
        match t.and_then(|t| self.project.scene_index(t)) {
            Some(i) => self.project.scenes[i].1,
            None => self.project.preset,
        }
    }

    /// Starts a scene at `t` (or retargets one within 50 ms) with `preset`. Returns its index.
    pub fn add_scene(&mut self, t: f64, preset: usize) -> Result<usize, JsValue> {
        let preset = preset % BUILTIN.len();
        self.stage.pipe(preset)?;
        let s = &mut self.project.scenes;
        if let Some(i) = s.iter().position(|(st, _)| (st - t).abs() < 0.05) {
            s[i].1 = preset;
            return Ok(i);
        }
        let i = s.partition_point(|(st, _)| *st < t);
        s.insert(i, (t, preset));
        Ok(i)
    }

    pub fn remove_scene(&mut self, i: usize) {
        if i < self.project.scenes.len() {
            self.project.scenes.remove(i);
        }
    }

    /// Moves scene `i` to `t`, keeping the order; returns its new index.
    pub fn move_scene(&mut self, i: usize, t: f64) -> usize {
        let s = &mut self.project.scenes;
        if i >= s.len() {
            return i;
        }
        let (_, p) = s.remove(i);
        let j = s.partition_point(|(st, _)| *st < t);
        s.insert(j, (t.max(0.0), p));
        j
    }

    pub fn clear_scenes(&mut self) {
        self.project.scenes.clear();
    }

    pub fn scene_times(&self) -> Vec<f64> {
        self.project.scenes.iter().map(|s| s.0).collect()
    }

    pub fn scene_presets(&self) -> Vec<u32> {
        self.project.scenes.iter().map(|s| s.1 as u32).collect()
    }

    /// Crossfade length between scenes, seconds.
    pub fn set_scene_fade(&mut self, seconds: f64) {
        self.project.scene_fade = seconds.max(0.0);
    }

    /// Look, keyframes, presets and scenes as JSON.
    pub fn project_json(&self) -> String {
        let p = &self.project;
        let data = ProjectData {
            look: p.look,
            keys: p.anim.keys.iter().map(|k| (k.t, k.look)).collect(),
            preset: BUILTIN[p.preset].0.into(),
            scenes: p.scenes.iter().map(|(t, i)| (*t, BUILTIN[*i].0.to_string())).collect(),
            scene_fade: p.scene_fade,
            circle: p.circle,
        };
        serde_json::to_string(&data).unwrap_or_default()
    }

    /// Restores what `project_json` saved (images stay as they are).
    pub fn load_project_json(&mut self, json: &str) -> Result<(), JsValue> {
        let d: ProjectData = serde_json::from_str(json).map_err(js_err)?;
        let p = &mut self.project;
        p.look = d.look;
        p.anim.keys = d.keys.into_iter().map(|(t, look)| animation::Key { t, look }).collect();
        p.anim.keys.sort_by(|a, b| a.t.total_cmp(&b.t));
        p.preset = preset_index(&d.preset);
        p.scenes = d.scenes.iter().map(|(t, n)| (*t, preset_index(n))).collect();
        p.scenes.sort_by(|a, b| a.0.total_cmp(&b.0));
        p.scene_fade = if d.scene_fade > 0.0 { d.scene_fade } else { 1.5 };
        p.circle = d.circle;
        for preset in p.presets_used() {
            self.stage.pipe(preset)?;
        }
        self.stage.renderer.set_circle(self.project.circle, self.project.cover.as_deref());
        Ok(())
    }

    // ---- look and keyframes ----

    /// Sets a look control. Without keyframes (or without `t`) it changes the whole
    /// track; with keyframes it edits the look at `t`, adding a key there.
    pub fn set_look(&mut self, name: &str, value: f32, t: Option<f64>) -> Result<(), JsValue> {
        let p = &mut self.project;
        match t {
            Some(t) if !p.anim.keys.is_empty() => {
                let mut look = p.look_at(t);
                *look_field(&mut look, name).ok_or_else(|| unknown(name))? = value;
                p.anim.insert(t, look);
            }
            _ => *look_field(&mut p.look, name).ok_or_else(|| unknown(name))? = value,
        }
        Ok(())
    }

    /// Value of a look control at `t` (keyframes applied), or of the base look.
    pub fn look_value(&self, name: &str, t: Option<f64>) -> Result<f32, JsValue> {
        let mut look = match t {
            Some(t) => self.project.look_at(t),
            None => self.project.look,
        };
        Ok(*look_field(&mut look, name).ok_or_else(|| unknown(name))?)
    }

    /// Adds a keyframe at `t` holding the look currently seen there. Returns its index.
    pub fn add_key(&mut self, t: f64) -> usize {
        let look = self.project.look_at(t);
        self.project.anim.insert(t, look)
    }

    pub fn remove_key(&mut self, i: usize) {
        let keys = &mut self.project.anim.keys;
        if i < keys.len() {
            // The last key's look becomes the static look again.
            let k = keys.remove(i);
            if keys.is_empty() {
                self.project.look = k.look;
            }
        }
    }

    /// Moves key `i` to `t`; returns its new index.
    pub fn move_key(&mut self, i: usize, t: f64) -> usize {
        if i >= self.project.anim.keys.len() {
            return i;
        }
        self.project.anim.move_key(i, t.max(0.0))
    }

    /// Removes every key, keeping the look seen at `t` as the static one.
    pub fn clear_keys(&mut self, t: f64) {
        self.project.look = self.project.look_at(t);
        self.project.anim.keys.clear();
    }

    pub fn key_times(&self) -> Vec<f64> {
        self.project.anim.keys.iter().map(|k| k.t).collect()
    }

    // ---- images ----

    /// Background image (RGBA), or remove it with an empty slice.
    pub fn set_background(&mut self, rgba: &[u8], w: u32, h: u32) -> Result<(), JsValue> {
        self.project.background = if rgba.is_empty() { None } else { Some(Rc::new(rgba_image(rgba, w, h)?)) };
        self.stage.renderer.set_background(self.project.background.as_deref());
        Ok(())
    }

    /// Center circle on/off and its picture (square RGBA; empty slice = dark disc).
    pub fn set_circle(&mut self, on: bool, rgba: &[u8], size: u32) -> Result<(), JsValue> {
        self.project.circle = on;
        self.project.cover = if rgba.is_empty() { None } else { Some(Rc::new(rgba_image(rgba, size, size)?)) };
        self.stage.renderer.set_circle(on, self.project.cover.as_deref());
        Ok(())
    }

    /// Text layer of the preview, RGBA at the canvas size; empty slice removes it.
    pub fn set_overlay(&mut self, rgba: &[u8], w: u32, h: u32) -> Result<(), JsValue> {
        if rgba.is_empty() {
            self.stage.renderer.clear_overlay();
        } else if (w, h) == self.stage.renderer.size() && rgba.len() == (w * h * 4) as usize {
            self.stage.renderer.update_overlay((w, h), rgba);
        }
        Ok(())
    }

    // ---- preview ----

    pub fn resize(&mut self, width: u32, height: u32) {
        let (w, h) = (width.max(1), height.max(1));
        if (w, h) == (self.config.width, self.config.height) {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.gpu.device, &self.config);
        // A text layer of the old size would no longer line up; the page sends a new one.
        self.stage.renderer.clear_overlay();
        self.stage.renderer.resize((w, h));
    }

    /// Draws one preview frame. `t` is the track position in seconds (None without a
    /// track); `wall` is a free-running clock for the idle animation; `fade` dims the
    /// frame (fragment fades); `progress` is for the progress bar (NaN = whole track);
    /// `layers` are the text-layer slots (8 floats each).
    pub fn render(&mut self, t: Option<f64>, wall: f64, fade: f32, progress: f32, layers: &[f32]) -> Result<(), JsValue> {
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Outdated | wgpu::SurfaceError::Lost) => {
                self.surface.configure(&self.gpu.device, &self.config);
                return Ok(());
            }
            Err(_) => return Ok(()),
        };
        let layers = parse_layers(layers);
        let args = FrameArgs { frame: self.frame, fade, progress: (!progress.is_nan()).then_some(progress), layers: &layers };
        let view = frame.texture.create_view(&Default::default());
        let mut enc = self.gpu.device.create_command_encoder(&Default::default());
        encode_frame(&mut self.stage, &mut self.motion, &self.project, self.track.as_ref(), t, wall, &args, &mut enc, &view)?;
        self.gpu.queue.submit([enc.finish()]);
        frame.present();
        self.frame += 1;
        Ok(())
    }

    // ---- export ----

    /// Prepares an export of `width`x`height` (width % 4 == 0, height % 2 == 0) with a
    /// copy of the current project; `overlay` is its text layer (RGBA at that size, or
    /// empty); `ring` readback buffers let frames overlap. Returns one NV12 frame's size.
    pub fn export_start(&mut self, width: u32, height: u32, ring: usize, overlay: &[u8]) -> Result<u32, JsValue> {
        let track = self.track.clone().ok_or_else(|| JsValue::from_str("no track loaded"))?;
        if width % 4 != 0 || height % 2 != 0 {
            return Err(JsValue::from_str("export size must have width % 4 == 0 and height % 2 == 0"));
        }
        let size = (width, height);
        let project = self.project.clone();
        let mut stage = Stage::new(&self.gpu, gpu::OUTPUT, size, &project)?;
        if !overlay.is_empty() {
            stage.renderer.update_overlay(size, overlay);
        }
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
        self.export = Some(Export { stage, nv12, staging, motion: Motion::default(), project, track, size });
        Ok(bytes as u32)
    }

    /// Renders export frame `index` at track time `t` into readback buffer `slot`.
    /// The promise resolves once the NV12 bytes can be read with `export_read`.
    pub fn export_frame(&mut self, index: u32, t: f64, slot: usize, fade: f32, progress: f32, layers: &[f32]) -> Result<js_sys::Promise, JsValue> {
        let ex = self.export.as_mut().ok_or_else(|| JsValue::from_str("export not started"))?;
        let buf = ex.staging.get(slot).ok_or_else(|| JsValue::from_str("bad slot"))?.clone();
        let layers = parse_layers(layers);
        let args = FrameArgs { frame: index as u64, fade, progress: Some(progress), layers: &layers };
        let mut enc = self.gpu.device.create_command_encoder(&Default::default());
        encode_frame(&mut ex.stage, &mut ex.motion, &ex.project, Some(&ex.track), Some(t), 0.0, &args, &mut enc, &ex.nv12.view)?;
        ex.nv12.encode(&mut enc);
        enc.copy_buffer_to_buffer(&ex.nv12.buffer, 0, &buf, 0, Nv12::frame_bytes(ex.size));
        self.gpu.queue.submit([enc.finish()]);
        Ok(mapped(&buf, |_| JsValue::NULL))
    }

    /// Copies the mapped NV12 frame of `slot` into `out` and frees the slot.
    pub fn export_read(&mut self, slot: usize, out: &mut [u8]) -> Result<(), JsValue> {
        let ex = self.export.as_ref().ok_or_else(|| JsValue::from_str("export not started"))?;
        let buf = ex.staging.get(slot).ok_or_else(|| JsValue::from_str("bad slot"))?;
        let ok = {
            let data = buf.slice(..).get_mapped_range();
            let ok = out.len() == data.len();
            if ok {
                out.copy_from_slice(&data);
            }
            ok
        };
        buf.unmap();
        if ok { Ok(()) } else { Err(JsValue::from_str("output buffer has the wrong size")) }
    }

    /// Frees the export's GPU resources (after finishing or cancelling).
    pub fn export_end(&mut self) {
        self.export = None;
    }

    /// One frame at `width`x`height` as RGBA bytes (for PNG), rendered offscreen with
    /// the current project at track time `t`. Resolves to a Uint8Array.
    pub fn snapshot(&mut self, width: u32, height: u32, t: f64, fade: f32, progress: f32, layers: &[f32], overlay: &[u8]) -> Result<js_sys::Promise, JsValue> {
        let size = (width.max(1), height.max(1));
        let mut stage = Stage::new(&self.gpu, gpu::OUTPUT, size, &self.project)?;
        if !overlay.is_empty() {
            stage.renderer.update_overlay(size, overlay);
        }
        let tex = self.gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("snapshot"),
            size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: gpu::OUTPUT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = tex.create_view(&Default::default());
        let row = (size.0 * 4).div_ceil(256) * 256;
        let buf = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("snapshot"),
            size: row as u64 * size.1 as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let layers = parse_layers(layers);
        let args = FrameArgs { frame: 0, fade, progress: (!progress.is_nan()).then_some(progress), layers: &layers };
        let mut motion = Motion::default();
        let mut enc = self.gpu.device.create_command_encoder(&Default::default());
        let tt = self.track.as_ref().map(|_| t);
        encode_frame(&mut stage, &mut motion, &self.project, self.track.as_ref(), tt, t, &args, &mut enc, &view)?;
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(size.1) } },
            wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        );
        self.gpu.queue.submit([enc.finish()]);
        let (w, h) = size;
        Ok(mapped(&buf, move |b| {
            let out = js_sys::Uint8Array::new_with_length(w * h * 4);
            {
                let data = b.slice(..).get_mapped_range();
                for y in 0..h {
                    let src = &data[(y * row) as usize..(y * row + w * 4) as usize];
                    out.subarray(y * w * 4, (y + 1) * w * 4).copy_from(src);
                }
            }
            b.unmap();
            out.into()
        }))
    }

    /// Adapter name, for the status line. Browsers often hide it for privacy.
    pub fn describe(&self) -> String {
        let info = self.gpu.adapter.get_info();
        if info.name.is_empty() { "WebGPU".into() } else { format!("{} (WebGPU)", info.name) }
    }
}
