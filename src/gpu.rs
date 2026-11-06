//! GPU renderer: preset scene pass -> bloom (1/4 res) -> composite into any target.

use crate::analysis::{Analysis, BANDS, Frame};
use anyhow::{Result, anyhow};
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

pub const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

pub struct Gpu {
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

impl Gpu {
    pub fn new(instance: wgpu::Instance, surface: Option<&wgpu::Surface>) -> Result<Self> {
        pollster::block_on(async {
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: surface,
                    force_fallback_adapter: false,
                })
                .await?;
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("audio-viz"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
                    memory_hints: wgpu::MemoryHints::Performance,
                    trace: wgpu::Trace::Off,
                })
                .await?;
            Ok(Gpu { adapter, device, queue })
        })
    }

    pub fn headless() -> Result<Self> {
        Self::new(wgpu::Instance::new(&wgpu::InstanceDescriptor::default()), None)
    }

    pub fn describe(&self) -> String {
        let i = self.adapter.get_info();
        format!("{} ({:?})", i.name, i.backend)
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Uniforms {
    res: [f32; 2],
    time: f32,
    progress: f32,
    bass: f32,
    mid: f32,
    high: f32,
    level: f32,
    beat: f32,
    energy: f32,
    bass_acc: f32,
    seed: f32,
    spectrum: [[f32; 4]; BANDS / 4],
    /// Center circle: radius (fraction of height), bar length, on (0/1), unused.
    ring: [f32; 4],
    ring_color: [f32; 4],
}

impl Uniforms {
    /// The same frame for a target of another size.
    pub fn with_res(mut self, (w, h): (u32, u32)) -> Self {
        self.res = [w as f32, h as f32];
        self
    }

    pub fn new(f: &Frame, size: (u32, u32), time: f32, progress: f32) -> Self {
        let mut spectrum = [[0.0; 4]; BANDS / 4];
        for (i, v) in f.spectrum.iter().enumerate() {
            spectrum[i / 4][i % 4] = *v;
        }
        Uniforms {
            res: [size.0 as f32, size.1 as f32],
            time,
            progress,
            bass: f.bass,
            mid: f.mid,
            high: f.high,
            level: f.level,
            beat: f.beat,
            energy: f.energy,
            bass_acc: f.bass_acc,
            seed: 0.0,
            spectrum,
            ring: [0.0; 4],
            ring_color: [0.0; 4],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct PostParams {
    res: [f32; 2],
    bloom_texel: [f32; 2],
    bloom: f32,
    vignette: f32,
    grain: f32,
    aberration: f32,
    frame: f32,
    srgb_target: f32,
    threshold: f32,
    exposure: f32,
    saturation: f32,
    hue: f32,
    fade: f32,
    bass: f32,
    bg_scale: [f32; 2],
    bg_brightness: f32,
    viz_opacity: f32,
    bg_pulse: f32,
    overlay: f32,
    has_background: f32,
    beat: f32,
    shake: f32,
    punch: f32,
    flash: f32,
    cover: f32,
    cover_radius: f32,
    text_count: f32,
    /// The text arrays below start on a 16-byte boundary, as in WGSL.
    _pad: [f32; 2],
    glitch: f32,
    vhs: f32,
    bar: f32,
    bar_pos: f32,
    bar_color: [f32; 3],
    mix: f32,
    text_rect: [[f32; 4]; LAYER_SLOTS],
    text_state: [[f32; 4]; LAYER_SLOTS],
}

/// Captions that can be animated individually; the UI allows this many.
pub const MAX_TEXTS: usize = 8;
/// Areas of the text layer drawn separately: the captions plus the logo.
pub const LAYER_SLOTS: usize = 10;

/// Everything about one frame besides the audio features and the look.
pub struct FrameInfo<'a> {
    pub frame: u64,
    /// Overall fade, 1 = full, 0 = black.
    pub fade: f32,
    /// Position in the exported fragment, 0..1 (progress bar).
    pub progress: f32,
    /// Areas of the text layer: captions, then the logo.
    pub layers: &'a [TextState],
    /// Preset pipeline (from `Renderer::pipeline`); None = the base preset.
    pub scene: Option<usize>,
    /// Crossfade into another pipeline, 0..1.
    pub blend: Option<(usize, f32)>,
}

/// Per-frame state of one caption in the text layer.
#[derive(Clone, Copy, Debug, Default)]
pub struct TextState {
    /// Area of the caption in the text layer, pixels: x0, y0, x1, y1.
    pub rect: [f32; 4],
    pub alpha: f32,
    /// Where the caption is drawn relative to its place, pixels.
    pub shift: [f32; 2],
    /// Left-to-right reveal, 0..1 (1 = fully shown).
    pub wipe: f32,
}

/// Look controls, set from the command line or the app sliders.
/// In the app they can also change over the track (see `animation`).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Look {
    /// Exposure in stops.
    pub exposure: f32,
    pub saturation: f32,
    /// Hue rotation in degrees.
    pub hue: f32,
    /// Continuous hue rotation during playback, turns per minute (negative = backwards).
    pub hue_spin: f32,
    /// Motion speed multiplier.
    pub speed: f32,
    /// Multiplier for how strongly visuals react to the audio.
    pub reactivity: f32,
    pub bloom: f32,
    pub vignette: f32,
    pub grain: f32,
    pub aberration: f32,
    /// Background image brightness (only used when an image is set).
    pub bg_brightness: f32,
    /// Opacity of the visualization over the background image.
    pub viz_opacity: f32,
    /// How much the background zooms with the bass.
    pub bg_pulse: f32,
    /// Center circle radius, % of the frame height.
    pub cover_size: f32,
    /// How much the circle grows with the bass.
    pub cover_pulse: f32,
    /// Length of the spectrum bars around the circle (0 = only the outline).
    pub ring: f32,
    /// Ring color, linear RGB.
    pub ring_color: [f32; 3],
    /// Camera shake on beats.
    pub shake: f32,
    /// Zoom kick on beats.
    pub punch: f32,
    /// White flash on beats.
    pub flash: f32,
    /// Digital glitch on beats: torn slices, split colors.
    pub glitch: f32,
    /// Old tape look: scanlines, color bleed, wobble.
    pub vhs: f32,
    /// Track progress bar thickness (0 = off).
    pub bar: f32,
    pub bar_color: [f32; 3],
}

impl Default for Look {
    fn default() -> Self {
        Look {
            exposure: 0.0,
            saturation: 1.0,
            hue: 0.0,
            hue_spin: 0.0,
            speed: 1.0,
            reactivity: 1.0,
            bloom: 0.8,
            vignette: 0.4,
            grain: 0.025,
            aberration: 0.3,
            bg_brightness: 0.8,
            viz_opacity: 1.0,
            bg_pulse: 0.3,
            cover_size: 18.0,
            cover_pulse: 0.5,
            ring: 1.0,
            ring_color: [1.0, 0.45, 0.75],
            shake: 0.0,
            punch: 0.0,
            flash: 0.0,
            glitch: 0.0,
            vhs: 0.0,
            bar: 0.0,
            bar_color: [1.0, 1.0, 1.0],
        }
    }
}

impl Look {
    /// Blend between two looks, `k` in 0..1.
    pub fn lerp(&self, b: &Look, k: f32) -> Look {
        let l = |x: f32, y: f32| x + (y - x) * k;
        Look {
            exposure: l(self.exposure, b.exposure),
            saturation: l(self.saturation, b.saturation),
            hue: l(self.hue, b.hue),
            hue_spin: l(self.hue_spin, b.hue_spin),
            speed: l(self.speed, b.speed),
            reactivity: l(self.reactivity, b.reactivity),
            bloom: l(self.bloom, b.bloom),
            vignette: l(self.vignette, b.vignette),
            grain: l(self.grain, b.grain),
            aberration: l(self.aberration, b.aberration),
            bg_brightness: l(self.bg_brightness, b.bg_brightness),
            viz_opacity: l(self.viz_opacity, b.viz_opacity),
            bg_pulse: l(self.bg_pulse, b.bg_pulse),
            cover_size: l(self.cover_size, b.cover_size),
            cover_pulse: l(self.cover_pulse, b.cover_pulse),
            ring: l(self.ring, b.ring),
            ring_color: std::array::from_fn(|i| l(self.ring_color[i], b.ring_color[i])),
            shake: l(self.shake, b.shake),
            punch: l(self.punch, b.punch),
            flash: l(self.flash, b.flash),
            glitch: l(self.glitch, b.glitch),
            vhs: l(self.vhs, b.vhs),
            bar: l(self.bar, b.bar),
            bar_color: std::array::from_fn(|i| l(self.bar_color[i], b.bar_color[i])),
        }
    }

    /// The look as rendered at track time `t`: the hue spin added on top.
    pub fn at_time(&self, t: f64) -> Look {
        let turns = self.hue_spin as f64 * t / 60.0;
        Look { hue: self.hue + (turns.fract() * 360.0) as f32, ..*self }
    }

    /// Applies reactivity to the audio features of a frame.
    /// 0 = calm (features flatten to a neutral level), 1 = as analysed,
    /// 2 = punchy (more contrast between hits and the rest, higher peaks).
    pub fn shape(&self, mut f: Frame) -> Frame {
        let k = self.reactivity.max(0.0);
        let over = (k - 1.0).max(0.0);
        let (calm, gamma, gain) = (k.min(1.0), 1.0 + 1.2 * over, 1.0 + 0.6 * over);
        // Soft knee above 1.0 instead of a hard clamp, so peaks still differ.
        let knee = |x: f32| if x > 1.0 { 1.0 + 0.5 * ((x - 1.0) / 0.5).tanh() } else { x };
        let level = |v: f32| knee(0.3 + (v.powf(gamma) * gain - 0.3) * calm);
        f.bass = level(f.bass);
        f.mid = level(f.mid);
        f.high = level(f.high);
        f.level = level(f.level);
        for s in &mut f.spectrum {
            *s = level(*s);
        }
        f.beat = knee(f.beat * calm * (1.0 + 0.8 * over));
        f
    }
}

/// Musical clocks for the shaders. Motion is integrated step by step with the
/// current speed, so the speed slider changes how fast the scene moves rather
/// than jumping it to another place. A seek replays the clocks from the start,
/// so the same moment always looks the same in the preview and in the export.
#[derive(Default)]
pub struct Motion {
    t: Option<f64>,
    energy: f64,
    bass: f64,
    time: f64,
}

impl Motion {
    /// Features of `analysis` at `t` seconds, shaped by the look at that time
    /// (`look_at`, which may change over the track), with the clocks advanced to `t`.
    pub fn track(&mut self, analysis: &Analysis, t: f64, look_at: &dyn Fn(f64) -> Look) -> Frame {
        let look = look_at(t);
        let f = look.shape(analysis.at(t));
        match self.t.map(|p| t - p) {
            Some(dt) if (-0.05..0.25).contains(&dt) => self.step(&f, dt.max(0.0), &look),
            _ => {
                *self = Motion::default();
                let step = 1.0 / analysis.fps;
                let n = ((t * analysis.fps) as usize).min(analysis.frames.len());
                for (k, frame) in analysis.frames[..n].iter().enumerate() {
                    let l = look_at(k as f64 * step);
                    self.step(&l.shape(*frame), step, &l);
                }
                self.step(&f, (t - n as f64 * step).max(0.0), &look);
            }
        }
        self.t = Some(t);
        self.apply(f)
    }

    /// Calm stand-in signal for when no track is loaded.
    pub fn idle(&mut self, t: f64, look: &Look) -> Frame {
        let f = look.shape(Frame { level: 0.25, mid: 0.4, ..Frame::SILENT });
        let dt = self.t.map_or(0.0, |p| (t - p).clamp(0.0, 0.25));
        self.step(&f, dt, look);
        self.t = Some(t);
        self.apply(f)
    }

    /// Speed-scaled seconds, for presets that animate on plain time.
    pub fn time(&self) -> f32 {
        self.time as f32
    }

    fn step(&mut self, f: &Frame, dt: f64, look: &Look) {
        let dt = dt * look.speed.max(0.0) as f64;
        // Louder passages and onsets push the scene forward faster.
        self.energy += (0.25 + f.level + 0.6 * f.beat) as f64 * dt;
        self.bass += f.bass as f64 * dt;
        self.time += dt;
    }

    fn apply(&self, mut f: Frame) -> Frame {
        f.energy = self.energy as f32;
        f.bass_acc = self.bass as f32;
        f
    }
}

/// Static textures composited in the post pass.
struct Layers {
    background: wgpu::TextureView,
    bg_size: Option<(u32, u32)>,
    overlay: wgpu::TextureView,
    /// Texture behind `overlay`, kept so text edits can be written in place.
    overlay_tex: Option<wgpu::Texture>,
    has_overlay: bool,
    cover: wgpu::TextureView,
    has_cover: bool,
    /// Center circle (cover and/or spectrum ring) shown.
    circle: bool,
}

struct Targets {
    size: (u32, u32),
    scene: wgpu::TextureView,
    /// The two presets of a scene crossfade, mixed into `scene`.
    scene_x: wgpu::TextureView,
    scene_y: wgpu::TextureView,
    bg_mix: wgpu::BindGroup,
    bg_down: wgpu::BindGroup,
    bg_blur_h: wgpu::BindGroup,
    bg_blur_v: wgpu::BindGroup,
    bg_post: wgpu::BindGroup,
    bloom_a: wgpu::TextureView,
    bloom_b: wgpu::TextureView,
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    scene_layout: wgpu::PipelineLayout,
    /// Compiled presets by source hash; scenes switch between them.
    pipelines: Vec<(u64, wgpu::RenderPipeline)>,
    base: usize,
    mix: wgpu::RenderPipeline,
    scene_bg: wgpu::BindGroup,
    uniform_buf: wgpu::Buffer,
    post_bgl: wgpu::BindGroupLayout,
    post_buf: wgpu::Buffer,
    sampler: wgpu::Sampler,
    down: wgpu::RenderPipeline,
    blur_h: wgpu::RenderPipeline,
    blur_v: wgpu::RenderPipeline,
    post: wgpu::RenderPipeline,
    srgb_target: bool,
    layers: Layers,
    targets: Targets,
}

impl Renderer {
    pub fn new(gpu: &Gpu, preset_src: &str, out_format: wgpu::TextureFormat, size: (u32, u32)) -> Result<Self> {
        let device = gpu.device.clone();
        let uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("uniforms"),
            size: size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let scene_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("scene"),
            entries: &[uniform_entry(0)],
        });
        let scene_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("scene"),
            layout: &scene_bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform_buf.as_entire_binding() }],
        });
        let scene_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("scene"),
            bind_group_layouts: &[&scene_bgl],
            push_constant_ranges: &[],
        });
        let base_pipeline = build_scene_pipeline(&device, &scene_layout, preset_src)?;

        let tex_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let post_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("post"),
            entries: &[
                tex_entry(0),
                tex_entry(1),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                uniform_entry(3),
                tex_entry(4),
                tex_entry(5),
                tex_entry(6),
            ],
        });
        let post_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("post"),
            bind_group_layouts: &[&post_bgl],
            push_constant_ranges: &[],
        });
        let post_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("post"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/post.wgsl").into()),
        });
        let mk = |entry: &str, format| fullscreen_pipeline(&device, &post_layout, &post_module, entry, format);
        let (down, blur_h, blur_v) = (mk("fs_down", HDR), mk("fs_blur_h", HDR), mk("fs_blur_v", HDR));
        let post = mk("fs_post", out_format);
        let mix = mk("fs_mix", HDR);

        let post_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("post params"),
            size: size_of::<PostParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("linear"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let empty = |label| upload_rgba(&device, &gpu.queue, label, &image::RgbaImage::new(1, 1), wgpu::TextureFormat::Rgba8Unorm);
        let layers = Layers {
            background: empty("background"),
            bg_size: None,
            overlay: empty("overlay"),
            overlay_tex: None,
            has_overlay: false,
            cover: empty("cover"),
            has_cover: false,
            circle: false,
        };
        let targets = Targets::new(&device, &post_bgl, &sampler, &post_buf, &layers, size);

        Ok(Renderer {
            device,
            queue: gpu.queue.clone(),
            scene_layout,
            pipelines: vec![(source_hash(preset_src), base_pipeline)],
            base: 0,
            mix,
            scene_bg,
            uniform_buf,
            post_bgl,
            post_buf,
            sampler,
            down,
            blur_h,
            blur_v,
            post,
            srgb_target: out_format.is_srgb(),
            layers,
            targets,
        })
    }

    /// Swap the preset shader; on a compile error the old one stays active.
    pub fn set_preset(&mut self, src: &str) -> Result<()> {
        self.base = self.pipeline(src)?;
        Ok(())
    }

    /// Id of the base preset's pipeline.
    pub fn base(&self) -> usize {
        self.base
    }

    /// Id of the compiled pipeline for a preset source, compiling it on first use.
    pub fn pipeline(&mut self, src: &str) -> Result<usize> {
        let h = source_hash(src);
        if let Some(i) = self.pipelines.iter().position(|(k, _)| *k == h) {
            return Ok(i);
        }
        let p = build_scene_pipeline(&self.device, &self.scene_layout, src)?;
        self.pipelines.push((h, p));
        Ok(self.pipelines.len() - 1)
    }

    pub fn resize(&mut self, size: (u32, u32)) {
        if size != self.targets.size {
            self.rebuild_targets(size);
        }
    }

    pub fn size(&self) -> (u32, u32) {
        self.targets.size
    }

    fn rebuild_targets(&mut self, size: (u32, u32)) {
        self.targets = Targets::new(&self.device, &self.post_bgl, &self.sampler, &self.post_buf, &self.layers, size);
    }

    /// Image shown behind the visualization (cover-fit), or None to remove it.
    pub fn set_background(&mut self, img: Option<&image::RgbaImage>) {
        let empty = image::RgbaImage::new(1, 1);
        self.layers.background =
            upload_rgba(&self.device, &self.queue, "background", img.unwrap_or(&empty), wgpu::TextureFormat::Rgba8UnormSrgb);
        self.layers.bg_size = img.map(|i| i.dimensions());
        self.rebuild_targets(self.targets.size);
    }

    /// Text layer; must match the target size pixel for pixel.
    pub fn set_overlay(&mut self, img: Option<&image::RgbaImage>) {
        let empty = image::RgbaImage::new(1, 1);
        self.layers.overlay =
            upload_rgba(&self.device, &self.queue, "overlay", img.unwrap_or(&empty), wgpu::TextureFormat::Rgba8Unorm);
        self.layers.has_overlay = img.is_some();
        self.layers.overlay_tex = None;
        self.rebuild_targets(self.targets.size);
    }

    /// Text layer from raw RGBA bytes (`size` must match the target). When a layer of
    /// the same size is already bound it is overwritten in place, without rebuilding
    /// the render targets, so typing a caption stays cheap.
    pub fn update_overlay(&mut self, size: (u32, u32), rgba: &[u8]) {
        let extent = wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 };
        let same = self.layers.has_overlay && self.layers.overlay_tex.as_ref().is_some_and(|t| (t.width(), t.height()) == size);
        if !same {
            let tex = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("overlay"),
                size: extent,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            self.layers.overlay = tex.create_view(&Default::default());
            self.layers.overlay_tex = Some(tex);
        }
        let tex = self.layers.overlay_tex.as_ref().unwrap();
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            rgba,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * size.0), rows_per_image: Some(size.1) },
            extent,
        );
        if !same {
            self.layers.has_overlay = true;
            self.rebuild_targets(self.targets.size);
        }
    }

    /// Removes the text layer.
    pub fn clear_overlay(&mut self) {
        if self.layers.has_overlay {
            self.set_overlay(None);
        }
    }

    /// Center circle: `on` shows it (spectrum ring around it), `cover` is drawn
    /// inside it (square image, see `overlay::square_cover`), or a dark disc without one.
    pub fn set_circle(&mut self, on: bool, cover: Option<&image::RgbaImage>) {
        let empty = image::RgbaImage::new(1, 1);
        self.layers.cover = upload_rgba(&self.device, &self.queue, "cover", cover.unwrap_or(&empty), wgpu::TextureFormat::Rgba8UnormSrgb);
        self.layers.has_cover = cover.is_some();
        self.layers.circle = on;
        self.rebuild_targets(self.targets.size);
    }

    /// Record all passes for one frame into `enc`, compositing into `out`.
    /// `fade` scales the final image (1 = full, 0 = black).
    #[allow(clippy::too_many_arguments)]
    pub fn encode(
        &self,
        enc: &mut wgpu::CommandEncoder,
        out: &wgpu::TextureView,
        u: &Uniforms,
        look: &Look,
        info: &FrameInfo,
    ) {
        let (frame, fade, texts) = (info.frame, info.fade, info.layers);
        let (w, h) = self.targets.size;
        let (bw, bh) = bloom_size(self.targets.size);
        // Cover-fit: scale UVs so the image fills the frame without stretching.
        let bg_scale = match self.layers.bg_size {
            Some((iw, ih)) => {
                let (ta, ia) = (w as f32 / h as f32, iw as f32 / ih as f32);
                if ta > ia { [1.0, ia / ta] } else { [ta / ia, 1.0] }
            }
            None => [1.0, 1.0],
        };
        // The circle breathes with the bass and kicks on beats.
        let radius = look.cover_size / 100.0 * (1.0 + look.cover_pulse * (0.12 * u.bass + 0.08 * u.beat));
        let p = PostParams {
            res: [w as f32, h as f32],
            bloom_texel: [1.0 / bw as f32, 1.0 / bh as f32],
            bloom: look.bloom,
            vignette: look.vignette,
            grain: look.grain,
            aberration: look.aberration * 0.05,
            frame: (frame % 4096) as f32,
            srgb_target: if self.srgb_target { 1.0 } else { 0.0 },
            threshold: 0.3,
            exposure: look.exposure.exp2(),
            saturation: look.saturation,
            hue: look.hue.to_radians(),
            fade,
            bass: u.bass,
            bg_scale,
            bg_brightness: if self.layers.bg_size.is_some() { look.bg_brightness } else { 0.0 },
            viz_opacity: if self.layers.bg_size.is_some() { look.viz_opacity } else { 1.0 },
            bg_pulse: look.bg_pulse,
            overlay: if self.layers.has_overlay { 1.0 } else { 0.0 },
            has_background: if self.layers.bg_size.is_some() { 1.0 } else { 0.0 },
            beat: u.beat,
            shake: look.shake,
            punch: look.punch,
            flash: look.flash,
            cover: if self.layers.circle && self.layers.has_cover { 1.0 } else { 0.0 },
            cover_radius: radius,
            text_count: texts.len().min(LAYER_SLOTS) as f32,
            _pad: [0.0; 2],
            glitch: look.glitch,
            vhs: look.vhs,
            bar: look.bar,
            bar_pos: info.progress,
            bar_color: look.bar_color,
            mix: info.blend.map_or(0.0, |b| b.1),
            text_rect: std::array::from_fn(|i| texts.get(i).map_or([0.0; 4], |t| t.rect)),
            text_state: std::array::from_fn(|i| texts.get(i).map_or([0.0; 4], |t| [t.alpha, t.shift[0], t.shift[1], t.wipe])),
        };
        let mut u = *u;
        if self.layers.circle {
            u.ring = [radius, look.ring, 1.0, 0.0];
            u.ring_color = [look.ring_color[0], look.ring_color[1], look.ring_color[2], 0.0];
        }
        self.queue.write_buffer(&self.uniform_buf, 0, bytemuck::bytes_of(&u));
        self.queue.write_buffer(&self.post_buf, 0, bytemuck::bytes_of(&p));

        let t = &self.targets;
        let scene = &self.pipelines[info.scene.unwrap_or(self.base).min(self.pipelines.len() - 1)].1;
        match info.blend {
            Some((to, _)) => {
                draw(enc, &t.scene_x, scene, &self.scene_bg);
                draw(enc, &t.scene_y, &self.pipelines[to.min(self.pipelines.len() - 1)].1, &self.scene_bg);
                draw(enc, &t.scene, &self.mix, &t.bg_mix);
            }
            None => draw(enc, &t.scene, scene, &self.scene_bg),
        }
        draw(enc, &t.bloom_a, &self.down, &t.bg_down);
        // Two blur iterations for a wide, soft glow.
        for _ in 0..2 {
            draw(enc, &t.bloom_b, &self.blur_h, &t.bg_blur_h);
            draw(enc, &t.bloom_a, &self.blur_v, &t.bg_blur_v);
        }
        draw(enc, out, &self.post, &t.bg_post);
    }
}

impl Targets {
    fn new(
        device: &wgpu::Device,
        bgl: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        params: &wgpu::Buffer,
        layers: &Layers,
        size: (u32, u32),
    ) -> Self {
        let tex = |label, (w, h): (u32, u32)| {
            device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: HDR,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                })
                .create_view(&Default::default())
        };
        let scene = tex("scene", size);
        let scene_x = tex("scene x", size);
        let scene_y = tex("scene y", size);
        let bloom_a = tex("bloom a", bloom_size(size));
        let bloom_b = tex("bloom b", bloom_size(size));
        let bg = |a: &wgpu::TextureView, b: &wgpu::TextureView| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("post"),
                layout: bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(a) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(b) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(sampler) },
                    wgpu::BindGroupEntry { binding: 3, resource: params.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&layers.background) },
                    wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&layers.overlay) },
                    wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(&layers.cover) },
                ],
            })
        };
        Targets {
            size,
            bg_down: bg(&scene, &scene),
            bg_blur_h: bg(&bloom_a, &scene),
            bg_blur_v: bg(&bloom_b, &scene),
            bg_post: bg(&scene, &bloom_a),
            bg_mix: bg(&scene_x, &scene_y),
            scene,
            scene_x,
            scene_y,
            bloom_a,
            bloom_b,
        }
    }
}

fn upload_rgba(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    img: &image::RgbaImage,
    format: wgpu::TextureFormat,
) -> wgpu::TextureView {
    device
        .create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: img.width(), height: img.height(), depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            img.as_raw(),
        )
        .create_view(&Default::default())
}

fn bloom_size((w, h): (u32, u32)) -> (u32, u32) {
    ((w / 4).max(1), (h / 4).max(1))
}

fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn source_hash(src: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    src.hash(&mut h);
    h.finish()
}

fn build_scene_pipeline(device: &wgpu::Device, layout: &wgpu::PipelineLayout, src: &str) -> Result<wgpu::RenderPipeline> {
    device.push_error_scope(wgpu::ErrorFilter::Validation);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("preset"),
        source: wgpu::ShaderSource::Wgsl(src.into()),
    });
    let pipeline = fullscreen_pipeline(device, layout, &module, "fs", HDR);
    // The browser thread can't block on WebGPU; there errors go to the console.
    #[cfg(target_arch = "wasm32")]
    {
        drop(device.pop_error_scope());
        Ok(pipeline)
    }
    #[cfg(not(target_arch = "wasm32"))]
    match pollster::block_on(device.pop_error_scope()) {
        Some(e) => Err(anyhow!("shader error:\n{e}")),
        None => Ok(pipeline),
    }
}

fn fullscreen_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    module: &wgpu::ShaderModule,
    fs_entry: &str,
    format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(fs_entry),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(fs_entry),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview: None,
        cache: None,
    })
}

fn draw(enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, pipeline: &wgpu::RenderPipeline, bg: &wgpu::BindGroup) {
    let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: None,
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bg, &[]);
    pass.draw(0..3, 0..1);
}

/// Compute pass converting the composited RGBA frame to NV12 in a storage buffer.
pub struct Nv12 {
    pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    pub buffer: wgpu::Buffer,
    pub view: wgpu::TextureView,
    size: (u32, u32),
}

pub const OUTPUT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

impl Nv12 {
    pub fn new(device: &wgpu::Device, (w, h): (u32, u32)) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("output"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: OUTPUT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("nv12"),
            size: Self::frame_bytes((w, h)),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let dims = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("dims"),
            contents: bytemuck::cast_slice(&[w, h, 0, 0]),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("nv12"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/nv12.wgsl").into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("nv12"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("nv12"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: dims.as_entire_binding() },
            ],
        });
        Nv12 { pipeline, bind_group, buffer, view, size: (w, h) }
    }

    pub fn frame_bytes((w, h): (u32, u32)) -> u64 {
        w as u64 * h as u64 * 3 / 2
    }

    pub fn encode(&self, enc: &mut wgpu::CommandEncoder) {
        let (w, h) = self.size;
        let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("nv12"), timestamp_writes: None });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.dispatch_workgroups((w / 4).div_ceil(16), h.div_ceil(16), 1);
    }
}
