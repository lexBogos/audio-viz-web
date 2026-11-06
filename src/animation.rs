//! Settings that change over the track: keyframes of the look, eased in between.

use crate::gpu::Look;

#[derive(Clone, Copy, Debug)]
pub struct Key {
    pub t: f64,
    pub look: Look,
}

/// Keyframes sorted by time. With no keys the look is static.
#[derive(Clone, Default, Debug)]
pub struct Animation {
    pub keys: Vec<Key>,
}

impl Animation {
    /// Look at track time `t`; `base` is used when there are no keys.
    /// Before the first key and after the last one the look holds still.
    pub fn at(&self, base: &Look, t: f64) -> Look {
        let keys = &self.keys;
        if keys.is_empty() {
            return *base;
        }
        let i = keys.partition_point(|k| k.t <= t);
        if i == 0 {
            return keys[0].look;
        }
        if i == keys.len() {
            return keys[i - 1].look;
        }
        let (a, b) = (&keys[i - 1], &keys[i]);
        let k = ((t - a.t) / (b.t - a.t).max(1e-9)).clamp(0.0, 1.0) as f32;
        a.look.lerp(&b.look, k * k * (3.0 - 2.0 * k)) // ease in and out
    }

    /// Index of the key within `tolerance` seconds of `t`, the closest one.
    pub fn near(&self, t: f64, tolerance: f64) -> Option<usize> {
        (0..self.keys.len())
            .filter(|&i| (self.keys[i].t - t).abs() <= tolerance)
            .min_by(|&a, &b| (self.keys[a].t - t).abs().total_cmp(&(self.keys[b].t - t).abs()))
    }

    /// Adds a key (or replaces one at the same moment) and returns its index.
    pub fn insert(&mut self, t: f64, look: Look) -> usize {
        if let Some(i) = self.near(t, 0.01) {
            self.keys[i].look = look;
            return i;
        }
        let i = self.keys.partition_point(|k| k.t < t);
        self.keys.insert(i, Key { t, look });
        i
    }

    /// Moves key `i` to time `t`, keeping the order; returns its new index.
    pub fn move_key(&mut self, i: usize, t: f64) -> usize {
        let key = self.keys.remove(i);
        let j = self.keys.partition_point(|k| k.t < t);
        self.keys.insert(j, Key { t, ..key });
        j
    }

    /// Time of the nearest key strictly after (`dir > 0`) or before `t`.
    pub fn neighbour(&self, t: f64, dir: i32) -> Option<f64> {
        let eps = 0.05;
        if dir > 0 {
            self.keys.iter().map(|k| k.t).find(|&k| k > t + eps)
        } else {
            self.keys.iter().rev().map(|k| k.t).find(|&k| k < t - eps)
        }
    }
}

/// Which preset plays at `t`: the base before the first scene, then each scene's
/// own. During `fade` seconds after a scene starts, returns the preset being
/// left and the one coming in with the crossfade amount 0..1.
pub fn scene_at<'a, T>(base: &'a T, scenes: &'a [(f64, T)], t: f64, fade: f64) -> (&'a T, Option<(&'a T, f32)>) {
    let i = scenes.partition_point(|(s, _)| *s <= t);
    if i == 0 {
        return (base, None);
    }
    let (start, cur) = (&scenes[i - 1].0, &scenes[i - 1].1);
    let prev = if i >= 2 { &scenes[i - 2].1 } else { base };
    if fade > 0.0 && t < start + fade {
        let k = ((t - start) / fade).clamp(0.0, 1.0) as f32;
        return (prev, Some((cur, k * k * (3.0 - 2.0 * k))));
    }
    (cur, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eases_between_keys_and_holds_outside() {
        let mut a = Animation::default();
        let base = Look::default();
        assert_eq!(a.at(&base, 5.0), base);
        a.insert(10.0, Look { hue: 0.0, ..base });
        a.insert(20.0, Look { hue: 100.0, ..base });
        assert_eq!(a.at(&base, 0.0).hue, 0.0);
        assert_eq!(a.at(&base, 15.0).hue, 50.0);
        assert!(a.at(&base, 12.0).hue < 20.0); // eased, not linear
        assert_eq!(a.at(&base, 30.0).hue, 100.0);
        let i = a.move_key(0, 25.0);
        assert_eq!(i, 1);
        assert_eq!(a.keys[0].t, 20.0);
        assert_eq!(a.neighbour(20.0, 1), Some(25.0));
        assert_eq!(a.neighbour(20.0, -1), None);
    }

    #[test]
    fn scenes_switch_with_crossfade() {
        let scenes = vec![(10.0, "b"), (20.0, "c")];
        assert_eq!(scene_at(&"a", &scenes, 5.0, 2.0), (&"a", None));
        let (from, to) = scene_at(&"a", &scenes, 11.0, 2.0);
        assert_eq!((from, to.map(|t| t.0)), (&"a", Some(&"b")));
        assert_eq!(scene_at(&"a", &scenes, 15.0, 2.0), (&"b", None));
        assert_eq!(scene_at(&"a", &scenes, 21.0, 2.0).0, &"b");
        assert_eq!(scene_at(&"a", &scenes, 25.0, 0.0), (&"c", None));
    }
}
