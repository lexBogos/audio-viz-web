//! Offline audio analysis: one pass over the whole track before rendering.
//! Produces per-frame features (bands, levels, beat pulse) that are already
//! normalized to 0..1 for the track and smoothed, so shaders stay simple.

use rustfft::{FftPlanner, num_complex::Complex};

pub const BANDS: usize = 64;
const FFT_SIZE: usize = 2048;

#[derive(Clone, Copy)]
pub struct Frame {
    pub bass: f32,
    pub mid: f32,
    pub high: f32,
    pub level: f32,
    /// Decaying pulse triggered on detected onsets.
    pub beat: f32,
    /// Integral of loudness over time: a "musical clock" that runs faster in loud parts.
    /// Filled in by `gpu::Motion`, which applies the speed setting.
    pub energy: f32,
    /// Integral of bass over time, also filled in by `gpu::Motion`.
    pub bass_acc: f32,
    pub spectrum: [f32; BANDS],
}

pub struct Analysis {
    pub fps: f64,
    pub frames: Vec<Frame>,
}

impl Frame {
    pub const SILENT: Frame = Frame {
        bass: 0.0,
        mid: 0.0,
        high: 0.0,
        level: 0.0,
        beat: 0.0,
        energy: 0.0,
        bass_acc: 0.0,
        spectrum: [0.0; BANDS],
    };
}

impl Analysis {
    /// Features at arbitrary time `t` (seconds), linearly interpolated.
    pub fn at(&self, t: f64) -> Frame {
        let f = (t * self.fps).max(0.0);
        let i = (f.floor() as usize).min(self.frames.len() - 1);
        let j = (i + 1).min(self.frames.len() - 1);
        let k = (f - f.floor()) as f32;
        let (a, b) = (&self.frames[i], &self.frames[j]);
        let l = |x: f32, y: f32| x + (y - x) * k;
        let mut spectrum = [0.0; BANDS];
        for (n, s) in spectrum.iter_mut().enumerate() {
            *s = l(a.spectrum[n], b.spectrum[n]);
        }
        Frame {
            bass: l(a.bass, b.bass),
            mid: l(a.mid, b.mid),
            high: l(a.high, b.high),
            level: l(a.level, b.level),
            beat: l(a.beat, b.beat),
            energy: 0.0,
            bass_acc: 0.0,
            spectrum,
        }
    }
}

struct Raw {
    bands: [f32; BANDS],
    bass: f32,
    mid: f32,
    high: f32,
    rms: f32,
    flux: f32,
}

pub fn analyze(mono: &[f32], sample_rate: u32, fps: f64) -> Analysis {
    let sr = sample_rate as f32;
    let duration = mono.len() as f64 / sample_rate as f64;
    let n_frames = ((duration * fps).ceil() as usize).max(1);
    let dt = (1.0 / fps) as f32;

    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
    let mut scratch = vec![Complex::default(); fft.get_inplace_scratch_len()];
    let mut buf = vec![Complex::default(); FFT_SIZE];
    let hann: Vec<f32> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos())
        .collect();

    let df = sr / FFT_SIZE as f32;
    let half = FFT_SIZE / 2;
    let bin = |f: f32| ((f / df) as usize).min(half - 1);
    let f_max = 16_000f32.min(sr * 0.475);
    let edges: Vec<f32> = (0..=BANDS)
        .map(|i| 30.0 * (f_max / 30.0).powf(i as f32 / BANDS as f32))
        .collect();
    let mean_power = |p: &[f32], f0: f32, f1: f32| {
        let lo = bin(f0);
        let hi = (((f1 / df).ceil() as usize).max(lo + 1)).min(half);
        p[lo..hi].iter().sum::<f32>() / (hi - lo) as f32
    };
    let flux_hi = bin(8_000.0);
    let flux_low = bin(200.0);

    let mut power = vec![0f32; half];
    let mut logmag = vec![0f32; half];
    let mut prev_logmag = vec![0f32; half];
    let mut raw = Vec::with_capacity(n_frames);

    for k in 0..n_frames {
        let center = (k as f64 / fps * sample_rate as f64) as isize;
        let start = center - FFT_SIZE as isize / 2;
        let mut sq = 0f32;
        for (i, c) in buf.iter_mut().enumerate() {
            let idx = start + i as isize;
            let s = if idx >= 0 && (idx as usize) < mono.len() { mono[idx as usize] } else { 0.0 };
            sq += s * s;
            *c = Complex::new(s * hann[i], 0.0);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);

        let norm = 2.0 / FFT_SIZE as f32;
        for i in 0..half {
            let m = buf[i].norm() * norm;
            power[i] = m * m;
            logmag[i] = (1.0 + 1000.0 * m).ln();
        }
        // Spectral flux weighted toward low end: kicks drive the beat pulse.
        let mut fl = 0f32;
        let mut ff = 0f32;
        for i in 1..flux_hi {
            let d = (logmag[i] - prev_logmag[i]).max(0.0);
            ff += d;
            if i < flux_low {
                fl += d;
            }
        }
        std::mem::swap(&mut logmag, &mut prev_logmag);

        let mut bands = [0f32; BANDS];
        for (b, v) in bands.iter_mut().enumerate() {
            *v = mean_power(&power, edges[b], edges[b + 1]);
        }
        raw.push(Raw {
            bands,
            bass: mean_power(&power, 20.0, 150.0),
            mid: mean_power(&power, 150.0, 2_000.0),
            high: mean_power(&power, 2_000.0, 12_000.0),
            rms: (sq / FFT_SIZE as f32).sqrt(),
            flux: 0.7 * fl / flux_low.max(1) as f32 + 0.3 * ff / flux_hi as f32,
        });
    }

    // Map each series from dB into 0..1 using track-relative percentiles,
    // so quiet and loud masters both use the full visual range.
    let db = |p: f32| 10.0 * (p + 1e-12).log10();
    let normalize = |series: Vec<f32>| -> Vec<f32> {
        let (lo, hi) = percentiles(&series, 0.05, 0.98);
        let range = (hi - lo).max(1e-3);
        series.into_iter().map(|v| ((v - lo) / range).clamp(0.0, 1.0)).collect()
    };
    let bass = normalize(raw.iter().map(|r| db(r.bass)).collect());
    let mid = normalize(raw.iter().map(|r| db(r.mid)).collect());
    let high = normalize(raw.iter().map(|r| db(r.high)).collect());
    let level = normalize(raw.iter().map(|r| db(r.rms * r.rms)).collect());
    let bands: Vec<Vec<f32>> = (0..BANDS)
        .map(|b| normalize(raw.iter().map(|r| db(r.bands[b])).collect()))
        .collect();
    let beat = beat_pulse(&raw.iter().map(|r| r.flux).collect::<Vec<_>>(), fps);

    // Fast attack / slow release, expressed as time constants (fps independent).
    let coef = |tau: f32| 1.0 - (-dt / tau).exp();
    let (att, rel) = (coef(0.012), coef(0.14));
    let smooth = |prev: f32, x: f32| prev + (x - prev) * if x > prev { att } else { rel };

    let mut frames = Vec::with_capacity(n_frames);
    let mut s = Frame::SILENT;
    for k in 0..n_frames {
        s.bass = smooth(s.bass, bass[k]);
        s.mid = smooth(s.mid, mid[k]);
        s.high = smooth(s.high, high[k]);
        s.level = smooth(s.level, level[k]);
        for b in 0..BANDS {
            s.spectrum[b] = smooth(s.spectrum[b], bands[b][k]);
        }
        s.beat = beat[k];
        frames.push(s);
    }

    Analysis { fps, frames }
}

/// Onset detection with an adaptive threshold, turned into a decaying pulse.
fn beat_pulse(flux: &[f32], fps: f64) -> Vec<f32> {
    let (_, hi) = percentiles(flux, 0.0, 0.98);
    let f: Vec<f32> = flux.iter().map(|v| v / hi.max(1e-9)).collect();
    let win = (0.3 * fps) as usize;
    let peak = (0.05 * fps).max(1.0) as usize;
    let min_gap = (0.1 * fps).max(1.0) as usize;
    let decay = (-1.0 / (0.18 * fps) as f32).exp();

    let mut out = vec![0f32; f.len()];
    let mut last_onset: Option<usize> = None;
    let mut pulse = 0f32;
    for k in 0..f.len() {
        pulse *= decay;
        let lo = k.saturating_sub(win);
        let hi = (k + win + 1).min(f.len());
        let mean = f[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
        let threshold = mean * 1.4 + 0.08;
        let p_lo = k.saturating_sub(peak);
        let p_hi = (k + peak + 1).min(f.len());
        let is_peak = f[p_lo..p_hi].iter().all(|&v| v <= f[k]);
        let gap_ok = last_onset.is_none_or(|l| k - l >= min_gap);
        if f[k] > threshold && is_peak && gap_ok {
            pulse = pulse.max((f[k] / threshold.max(1e-6) - 0.5).clamp(0.4, 1.0));
            last_onset = Some(k);
        }
        out[k] = pulse;
    }
    out
}

fn percentiles(v: &[f32], lo: f32, hi: f32) -> (f32, f32) {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let at = |q: f32| s[((s.len() - 1) as f32 * q) as usize];
    (at(lo), at(hi))
}
