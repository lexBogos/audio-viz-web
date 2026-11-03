//! Built-in presets are compiled into the binary; custom ones are loaded from disk.

use anyhow::{Context, Result, bail};
use std::path::PathBuf;

pub const PRELUDE: &str = include_str!("../shaders/prelude.wgsl");

pub const BUILTIN: &[(&str, &str)] = &[
    ("nebula", include_str!("../shaders/presets/nebula.wgsl")),
    ("orb", include_str!("../shaders/presets/orb.wgsl")),
    ("horizon", include_str!("../shaders/presets/horizon.wgsl")),
    ("gyroid", include_str!("../shaders/presets/gyroid.wgsl")),
    ("warp", include_str!("../shaders/presets/warp.wgsl")),
    ("ink", include_str!("../shaders/presets/ink.wgsl")),
    ("rings", include_str!("../shaders/presets/rings.wgsl")),
    ("flow", include_str!("../shaders/presets/flow.wgsl")),
    ("tunnel", include_str!("../shaders/presets/tunnel.wgsl")),
    ("aurora", include_str!("../shaders/presets/aurora.wgsl")),
    ("radial", include_str!("../shaders/presets/radial.wgsl")),
    ("kaleido", include_str!("../shaders/presets/kaleido.wgsl")),
    ("waves", include_str!("../shaders/presets/waves.wgsl")),
];

#[derive(Clone, Debug)]
pub enum Preset {
    Builtin(usize),
    File(PathBuf),
}

impl Preset {
    pub fn resolve(name: &str, shader: Option<PathBuf>) -> Result<Self> {
        if let Some(path) = shader {
            return Ok(Preset::File(path));
        }
        match BUILTIN.iter().position(|(n, _)| *n == name) {
            Some(i) => Ok(Preset::Builtin(i)),
            None => bail!("unknown preset '{name}', available: {}", names().join(", ")),
        }
    }

    pub fn name(&self) -> String {
        match self {
            Preset::Builtin(i) => BUILTIN[*i].0.to_string(),
            Preset::File(p) => p.display().to_string(),
        }
    }

    /// Full WGSL module: shared prelude + preset body.
    pub fn source(&self) -> Result<String> {
        let body = match self {
            Preset::Builtin(i) => BUILTIN[*i].1.to_string(),
            Preset::File(p) => std::fs::read_to_string(p).with_context(|| format!("cannot read {}", p.display()))?,
        };
        Ok(format!("{PRELUDE}\n{body}"))
    }

    pub fn cycle(&self, step: isize) -> Self {
        let i = match self {
            Preset::Builtin(i) => *i as isize,
            Preset::File(_) => -1,
        };
        Preset::Builtin((i + step).rem_euclid(BUILTIN.len() as isize) as usize)
    }
}

pub fn names() -> Vec<&'static str> {
    BUILTIN.iter().map(|(n, _)| *n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(name: &str, src: &str) {
        let module = wgpu::naga::front::wgsl::parse_str(src).unwrap_or_else(|e| panic!("{name}: {}", e.emit_to_string(src)));
        wgpu::naga::valid::Validator::new(Default::default(), wgpu::naga::valid::Capabilities::all())
            .validate(&module)
            .unwrap_or_else(|e| panic!("{name}: {}", e.emit_to_string(src)));
    }

    /// Every shader must compile, so a broken one fails here rather than at runtime.
    #[test]
    fn shaders_compile() {
        for i in 0..BUILTIN.len() {
            let p = Preset::Builtin(i);
            check(&p.name(), &p.source().unwrap());
        }
        check("post", include_str!("../shaders/post.wgsl"));
        check("nv12", include_str!("../shaders/nv12.wgsl"));
    }
}
