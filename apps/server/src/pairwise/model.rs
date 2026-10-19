//! Personal preferences: L2-regularized Davidson (Bradley–Terry with ties).
//! The fixed draw weight is one: equally strong titles have equal win/draw/loss
//! probabilities. A fixed prior avoids overfitting a user's first few decisions.
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    Left,
    Right,
    Tie,
}

#[derive(Clone, Debug)]
pub(super) struct Comparison {
    pub left: String,
    pub right: String,
    pub outcome: Outcome,
}

#[derive(Debug)]
pub(super) struct Rating {
    pub id: String,
    pub score: Option<f64>,
    pub comparisons: usize,
    pub provisional: bool,
    pub rank: Option<usize>,
}

struct Fit<'a> {
    ids: Vec<&'a str>,
    strengths: Vec<f64>,
    counts: Vec<usize>,
    roots: Vec<usize>,
    pairs: HashSet<(usize, usize)>,
}

fn root(parents: &[usize], mut i: usize) -> usize {
    while parents[i] != i {
        i = parents[i];
    }
    i
}

fn probabilities(difference: f64) -> (f64, f64) {
    // Divide all three Davidson weights by their largest log weight.
    let half = difference * 0.5;
    let maximum = half.abs();
    let left = (half - maximum).exp();
    let right = (-half - maximum).exp();
    let tie = (-maximum).exp();
    let total = left + right + tie;
    (left / total, tie / total)
}

fn fit<'a>(ids: &'a [String], comparisons: &[Comparison]) -> Fit<'a> {
    let mut names: Vec<&str> = ids.iter().map(String::as_str).collect();
    names.sort_unstable();
    names.dedup();
    let index: HashMap<&str, usize> = names.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    // Latest decision per unordered pair is authoritative, even for callers that
    // have not already collapsed their event history.
    let mut latest = HashMap::new();
    for comparison in comparisons {
        let (Some(&left), Some(&right)) = (
            index.get(comparison.left.as_str()),
            index.get(comparison.right.as_str()),
        ) else {
            continue;
        };
        if left == right {
            continue;
        }
        let target = match comparison.outcome {
            Outcome::Left => 1.0,
            Outcome::Right => 0.0,
            Outcome::Tie => 0.5,
        };
        let (a, b, target) = if left < right {
            (left, right, target)
        } else {
            (right, left, 1.0 - target)
        };
        latest.insert((a, b), target);
    }
    let mut edges: Vec<_> = latest
        .iter()
        .map(|(&(a, b), &target)| (a, b, target))
        .collect();
    edges.sort_unstable_by_key(|&(a, b, _)| (a, b));
    let mut counts = vec![0; names.len()];
    let mut roots: Vec<_> = (0..names.len()).collect();
    let mut sizes = vec![1; names.len()];
    for &(a, b, _) in &edges {
        counts[a] += 1;
        counts[b] += 1;
        let ra = root(&roots, a);
        let rb = root(&roots, b);
        if ra != rb {
            let (small, large) = if sizes[ra] < sizes[rb] {
                (ra, rb)
            } else {
                (rb, ra)
            };
            roots[small] = large;
            sizes[large] += sizes[small];
        }
    }
    roots = (0..names.len()).map(|i| root(&roots, i)).collect();
    let mut strengths = vec![0.0; names.len()];
    // Concave penalized log likelihood; damped diagonal Newton iterations.
    // O(120 * observed pairs), with no all-pairs matrix or unbounded convergence.
    for _ in 0..120 {
        let mut gradient: Vec<_> = strengths.iter().map(|s| -0.5 * s).collect();
        let mut curvature = vec![0.5; names.len()];
        for &(a, b, target) in &edges {
            let (win, tie) = probabilities(strengths[a] - strengths[b]);
            let expected = win + 0.5 * tie;
            let variance = win + 0.25 * tie - expected * expected;
            gradient[a] += target - expected;
            gradient[b] -= target - expected;
            curvature[a] += variance;
            curvature[b] += variance;
        }
        let mut maximum: f64 = 0.0;
        for i in 0..strengths.len() {
            let step = (0.5 * gradient[i] / curvature[i]).clamp(-1.0, 1.0);
            strengths[i] += step;
            maximum = maximum.max(step.abs());
        }
        if maximum < 1e-8 {
            break;
        }
    }
    Fit {
        ids: names,
        strengths,
        counts,
        roots,
        pairs: latest.into_keys().collect(),
    }
}

pub(super) fn rank(ids: &[String], comparisons: &[Comparison]) -> Vec<Rating> {
    let fit = fit(ids, comparisons);
    let observed: Vec<_> = (0..fit.ids.len()).filter(|&i| fit.counts[i] > 0).collect();
    let disconnected = observed
        .first()
        .is_some_and(|&first| observed.iter().any(|&i| fit.roots[i] != fit.roots[first]));
    // Exact through 512 ranked titles. Larger libraries use a deterministic,
    // evenly spaced reference sample: O(n * 512), not quadratic storage/work.
    let reference: Vec<_> = if observed.len() <= 512 {
        observed.clone()
    } else {
        (0..512)
            .map(|i| observed[i * observed.len() / 512])
            .collect()
    };
    let mut ordered = observed.clone();
    ordered.sort_by(|&a, &b| {
        fit.strengths[b]
            .total_cmp(&fit.strengths[a])
            .then_with(|| fit.ids[a].cmp(fit.ids[b]))
    });
    let positions: HashMap<_, _> = ordered
        .into_iter()
        .enumerate()
        .map(|(position, i)| (i, position + 1))
        .collect();
    (0..fit.ids.len())
        .map(|i| {
            let opponents: Vec<_> = reference.iter().copied().filter(|&j| j != i).collect();
            let score = if fit.counts[i] == 0 || opponents.is_empty() {
                None
            } else {
                Some(
                    opponents
                        .iter()
                        .map(|&j| {
                            let (win, tie) = probabilities(fit.strengths[i] - fit.strengths[j]);
                            100.0 * (win + 0.5 * tie)
                        })
                        .sum::<f64>()
                        / opponents.len() as f64,
                )
            };
            Rating {
                id: fit.ids[i].to_owned(),
                score,
                comparisons: fit.counts[i],
                provisional: disconnected || fit.counts[i] < 3.min(fit.ids.len().saturating_sub(1)),
                rank: positions.get(&i).copied(),
            }
        })
        .collect()
}

fn random(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e3779b97f4a7c15);
    let mut value = *state;
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
    value ^ (value >> 31)
}

pub(super) fn choose_pair(
    ids: &[String],
    comparisons: &[Comparison],
    recent: &[[String; 2]],
    seed: u64,
) -> Option<[String; 2]> {
    let fit = fit(ids, comparisons);
    if fit.ids.len() < 2 {
        return None;
    }
    let mut state = seed;
    let mut priority: Vec<_> = (0..fit.ids.len())
        .map(|i| (i, random(&mut state)))
        .collect();
    priority.sort_by_key(|&(i, jitter)| (fit.counts[i], jitter));
    // Always include the least-covered titles, plus a rotating random sample
    // to refine established positions without scanning all possible pairs.
    let mut pool: Vec<_> = priority.iter().take(32).map(|&(i, _)| i).collect();
    for _ in 0..64 {
        pool.push((random(&mut state) % fit.ids.len() as u64) as usize);
    }
    pool.sort_unstable();
    pool.dedup();
    let mut best = None;
    let mut best_value = f64::NEG_INFINITY;
    for (offset, &a) in pool.iter().enumerate() {
        for &b in &pool[offset + 1..] {
            let recent_pair = recent.iter().any(|pair| {
                (pair[0] == fit.ids[a] && pair[1] == fit.ids[b])
                    || (pair[1] == fit.ids[a] && pair[0] == fit.ids[b])
            });
            let coverage = 8.0 / (1.0 + fit.counts[a] as f64) + 8.0 / (1.0 + fit.counts[b] as f64);
            let connection = if fit.roots[a] != fit.roots[b] {
                4.0
            } else {
                0.0
            };
            let closeness = 2.0 / (1.0 + (fit.strengths[a] - fit.strengths[b]).abs());
            let value = coverage + connection + closeness
                - if fit.pairs.contains(&(a, b)) {
                    0.75
                } else {
                    0.0
                }
                - if recent_pair { 100.0 } else { 0.0 }
                + (random(&mut state) % 1000) as f64 / 10000.0;
            if value > best_value {
                best_value = value;
                best = Some((a, b));
            }
        }
    }
    best.map(|(a, b)| {
        if random(&mut state) & 1 == 0 {
            [fit.ids[a].to_owned(), fit.ids[b].to_owned()]
        } else {
            [fit.ids[b].to_owned(), fit.ids[a].to_owned()]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ids() -> Vec<String> {
        ["a", "b", "c", "d"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    }
    fn vote(a: &str, b: &str, outcome: Outcome) -> Comparison {
        Comparison {
            left: a.into(),
            right: b.into(),
            outcome,
        }
    }
    #[test]
    fn ties_are_symmetric() {
        let result = rank(&ids(), &[vote("a", "b", Outcome::Tie)]);
        assert!((result[0].score.unwrap() - 50.0).abs() < 1e-7);
        assert_eq!(result[0].score, result[1].score);
        assert!(result[2].score.is_none());
        assert!(result[2].rank.is_none());
    }
    #[test]
    fn preferences_and_reversed_input_agree() {
        let a = rank(
            &ids(),
            &[vote("a", "b", Outcome::Left), vote("a", "c", Outcome::Left)],
        );
        let mut reversed = ids();
        reversed.reverse();
        let b = rank(
            &reversed,
            &[
                vote("c", "a", Outcome::Right),
                vote("b", "a", Outcome::Right),
            ],
        );
        assert!(a[0].score.unwrap() > a[1].score.unwrap());
        for (a, b) in a.iter().zip(&b) {
            assert_eq!(a.id, b.id);
            assert!((a.score.unwrap_or(0.0) - b.score.unwrap_or(0.0)).abs() < 1e-9);
        }
    }
    #[test]
    fn cycles_and_all_wins_stay_finite() {
        for comparisons in [
            vec![
                vote("a", "b", Outcome::Left),
                vote("b", "c", Outcome::Left),
                vote("c", "a", Outcome::Left),
            ],
            vec![
                vote("a", "b", Outcome::Left),
                vote("a", "c", Outcome::Left),
                vote("a", "d", Outcome::Left),
            ],
        ] {
            for rating in rank(&ids(), &comparisons) {
                if let Some(score) = rating.score {
                    assert!(score.is_finite() && (0.0..=100.0).contains(&score));
                }
            }
        }
    }
    #[test]
    fn disconnected_groups_are_provisional() {
        assert!(rank(
            &ids(),
            &[
                vote("a", "b", Outcome::Left),
                vote("c", "d", Outcome::Right)
            ]
        )
        .iter()
        .all(|rating| rating.provisional));
    }
    #[test]
    fn small_libraries_can_finish_their_available_comparisons() {
        let names = ids();
        let two = rank(&names[..2], &[vote("a", "b", Outcome::Left)]);
        assert!(two.iter().all(|rating| !rating.provisional));
        let three = rank(
            &names[..3],
            &[
                vote("a", "b", Outcome::Left),
                vote("b", "c", Outcome::Left),
                vote("a", "c", Outcome::Left),
            ],
        );
        assert!(three.iter().all(|rating| !rating.provisional));
        let large: Vec<_> = (0..100).map(|i| format!("title{i}")).collect();
        assert!(rank(&large, &[vote("title0", "title1", Outcome::Left)])
            .iter()
            .all(|rating| rating.provisional));
    }
    #[test]
    fn exact_cycle_ties_use_stable_title_id_order() {
        let result = rank(
            &ids(),
            &[
                vote("a", "b", Outcome::Left),
                vote("b", "c", Outcome::Left),
                vote("c", "a", Outcome::Left),
            ],
        );
        assert_eq!(result[0].rank, Some(1));
        assert_eq!(result[1].rank, Some(2));
        assert_eq!(result[2].rank, Some(3));
        for rating in &result[..3] {
            assert!((rating.score.unwrap() - 50.0).abs() < 1e-9);
        }
    }
    #[test]
    fn latest_pair_replaces_old_vote_and_invalid_edges_are_ignored() {
        let result = rank(
            &ids(),
            &[
                vote("a", "b", Outcome::Left),
                vote("b", "a", Outcome::Left),
                vote("a", "a", Outcome::Left),
                vote("a", "missing", Outcome::Left),
            ],
        );
        assert_eq!(result[0].comparisons, 1);
        assert!(result[1].score > result[0].score);
    }
    #[test]
    fn sampler_avoids_recent_and_covers_unseen() {
        let decisions = vec![vote("a", "b", Outcome::Left)];
        let recent = vec![["a".into(), "b".into()]];
        for seed in 0..20 {
            let pair = choose_pair(&ids(), &decisions, &recent, seed).unwrap();
            assert_ne!(pair[0], pair[1]);
            assert!(pair.contains(&"c".to_owned()) || pair.contains(&"d".to_owned()));
            assert!(pair.iter().all(|id| ids().contains(id)));
        }
        assert!(choose_pair(&[], &[], &[], 0).is_none());
        assert!(choose_pair(&["a".into()], &[], &[], 0).is_none());
        assert!(choose_pair(&["a".into(), "b".into()], &decisions, &recent, 0).is_some());
    }
}
